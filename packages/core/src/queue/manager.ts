import type { Application } from '../application'
import type { CacheRepository } from '../cache/repository'
import type { Logger } from '../logger'
import type { BatchControl, BatchMeta } from './batch'
import type { CloudflareQueueConfig } from './drivers/cloudflare'
import type { RedisQueueConfig } from './drivers/redis'
import type { ProcessResult, QueueCounts, QueueDriver } from './drivers/types'
import type { ChainState, DispatchOptions, DispatchResult, FailedJob, JobContext, JobDefinition, JobMessage, JobMiddleware, QueuedCallback, QueuedJob, UniqueJobOptions } from './job'
import type { PendingBatch, PendingChain, PendingJob, QueueCallback } from './pending'
import type { QueueDriverRegistry } from './registry'
import type { RunState } from './state'
import { CacheManager } from '../cache/manager'
import { traceJobDispatch, traceJobProcess } from '../observability/otel'
import { currentTelemetryScope, runInTelemetryScope } from '../observability/scope'
import { recordTelemetry, telemetryActive } from '../observability/telemetry'
import { RedisManager } from '../redis/manager'
import { getRequestStore } from '../request'
import { tenantQueueKey } from '../tenancy/context'
import { tenancyOf } from '../tenancy/manager'
import { jsonReplacer, parseDuration } from '../utils'
import { Batch, BatchStore } from './batch'
import { cloudflareQueue } from './drivers/cloudflare'
import { memoryQueue } from './drivers/memory'
import { redisQueue } from './drivers/redis'
import { syncQueue } from './drivers/sync'
import { backoffSeconds, isJob } from './job'
import { isPendingJob } from './pending'
import { queueDriverFactory } from './registry'
import { runStates } from './state'

export interface MemoryQueueConfig {
  driver: 'memory'
  /** 本进程消费的并发数，默认 1 */
  concurrency?: number
}

export interface SyncQueueConfig {
  driver: 'sync'
}

/** 其它包注册的驱动（registerQueueDriver + QueueDriverRegistry 声明合并），例如 @hazejs/orm 的 database */
type RegisteredQueueConfig = QueueDriverRegistry[keyof QueueDriverRegistry]

export type QueueConnectionConfig = SyncQueueConfig | MemoryQueueConfig | RedisQueueConfig | CloudflareQueueConfig | RegisteredQueueConfig

export interface QueueBatchConfig {
  /** 批次状态使用的缓存存储（config/cache.ts），默认为 queue 的 store；多进程消费时必须是共享且支持原子操作的存储（redis） */
  store?: string
  /** 批次状态的保留时间，默认 '7d' */
  ttl?: string | number
}

export interface QueueConfig {
  /** 默认连接，默认 memory */
  default: string
  connections: Record<string, QueueConnectionConfig>
  /** 唯一任务的锁与任务中间件（限流、防重叠、异常节流）使用的缓存存储，默认为默认存储；需支持原子操作 */
  store?: string
  /** 批量任务的状态存储 */
  batches?: QueueBatchConfig
  /** 全局任务中间件：每个任务执行前都经过（在任务自己的 middleware 之前） */
  middleware?: JobMiddleware[]
}

export const defaultQueueConfig: QueueConfig = {
  default: 'memory',
  connections: {
    sync: { driver: 'sync' },
    memory: { driver: 'memory' },
  },
}

/** `config/queue.ts` 的默认导出 */
export function defineQueueConfig(config: QueueConfig | (() => QueueConfig)): QueueConfig | (() => QueueConfig) {
  return config
}

export interface WorkOptions {
  connection?: string
  /** 消费的队列（按优先级），默认 ['default'] */
  queues?: string[]
  concurrency?: number
  /** 开发时热替换：每条消息从最新的应用取任务定义 */
  resolve?: () => QueueManager
}

export interface QueueWorker {
  stop: () => Promise<void>
}

export interface DispatchedJob {
  job: string
  payload: unknown
  queue: string
  delay: number
  connection: string
  /** 任务链的剩余部分 */
  chain?: ChainState
  /** 所属批次 ID */
  batch?: string
  /** 作为该批次的回调投递 */
  callbackOf?: string
  /** 唯一任务的键（`<任务名>:<key>`） */
  unique?: string
}

/** Queue.fake() 记录的任务链 */
export interface RecordedChain {
  id: string
  jobs: Array<{ job: string, payload: unknown }>
  connection?: string
  queue?: string
}

/** Queue.fake() 记录的批次（其中的任务不会进入 dispatched，也不会被 drain() 执行） */
export interface RecordedBatch {
  id: string
  name: string
  jobs: Array<{ job: string, payload: unknown }>
  allowFailures: boolean
  cancelled: boolean
  connection?: string
  queue?: string
  then: QueuedCallback[]
  catch: QueuedCallback[]
  finally: QueuedCallback[]
  createdAt: number
}

type JobRef = JobDefinition<any> | PendingJob<any> | string

/** Queue.fake()：记录投递而不执行 */
export class QueueFake {
  readonly dispatched: DispatchedJob[] = []
  /** 因唯一锁被占用而跳过的投递 */
  readonly skipped: DispatchedJob[] = []
  readonly chains: RecordedChain[] = []
  readonly batches: RecordedBatch[] = []
  /** 模拟的唯一锁（drain() 执行后释放） */
  readonly uniqueKeys = new Set<string>()

  constructor(private readonly manager: QueueManager) {}

  #name(job: JobRef): string {
    if (typeof job === 'string')
      return job
    return this.manager.nameOf(isPendingJob(job)
      ? job.definition
      : job)
  }

  #matching(list: DispatchedJob[], job: JobRef, payload?: (payload: any) => boolean): DispatchedJob[] {
    const name = this.#name(job)
    return list.filter(item => item.job === name && (!payload || payload(item.payload)))
  }

  assertDispatched<P>(job: JobDefinition<P> | string, payload?: (payload: P) => boolean): void {
    if (!this.#matching(this.dispatched, job, payload).length)
      throw new Error(`Expected job "${this.#name(job)}" to be dispatched${payload ? ' with a matching payload' : ''}`)
  }

  assertNotDispatched<P>(job: JobDefinition<P> | string, payload?: (payload: P) => boolean): void {
    if (this.#matching(this.dispatched, job, payload).length)
      throw new Error(`Unexpected dispatch of job "${this.#name(job)}"`)
  }

  assertCount(count: number): void {
    if (this.dispatched.length !== count)
      throw new Error(`Expected ${count} dispatched job(s), got ${this.dispatched.length}`)
  }

  /**
   * 断言投递过这样一条任务链：任务名依次相同；传入 `Job.with(payload)` 时还比较载荷（JSON 相等）
   */
  assertChained(jobs: JobRef[]): void {
    const expected = jobs.map(job => ({
      name: this.#name(job),
      payload: isPendingJob(job)
        ? JSON.stringify(job.payload ?? null, jsonReplacer)
        : undefined,
    }))
    const found = this.chains.some(chain => chain.jobs.length === expected.length && chain.jobs.every((item, index) => item.job === expected[index]!.name
      && (expected[index]!.payload === undefined || JSON.stringify(item.payload ?? null, jsonReplacer) === expected[index]!.payload)))
    if (!found)
      throw new Error(`Expected a chain of [${expected.map(item => item.name).join(', ')}] to be dispatched`)
  }

  /** 断言投递过满足条件的批次（不传条件时为至少一个批次） */
  assertBatched(predicate?: (batch: RecordedBatch) => boolean): void {
    if (!this.batches.some(batch => !predicate || predicate(batch)))
      throw new Error(`Expected a batch${predicate ? ' matching the predicate' : ''} to be dispatched`)
  }

  assertBatchCount(count: number): void {
    if (this.batches.length !== count)
      throw new Error(`Expected ${count} batch(es), got ${this.batches.length}`)
  }

  assertNothingBatched(): void {
    if (this.batches.length)
      throw new Error(`Expected no batches, got ${this.batches.length}`)
  }

  /** 断言唯一任务恰好投递了一次（锁被占用时的重复投递被跳过） */
  assertPushedUnique<P>(job: JobDefinition<P> | string, payload?: (payload: P) => boolean): void {
    const matches = this.#matching(this.dispatched, job, payload)
    if (matches.length !== 1 || !matches[0]!.unique) {
      throw new Error(`Expected unique job "${this.#name(job)}" to be dispatched exactly once, got ${matches.length}${matches.length && !matches[0]!.unique
        ? ' (the job is not unique)'
        : ''}`)
    }
  }

  /** 断言有一次投递因唯一锁被占用而跳过 */
  assertSkipped<P>(job: JobDefinition<P> | string, payload?: (payload: P) => boolean): void {
    if (!this.#matching(this.skipped, job, payload).length)
      throw new Error(`Expected a dispatch of unique job "${this.#name(job)}" to be skipped`)
  }

  /**
   * 执行已记录的任务（按投递顺序，忽略延迟），返回执行结果。
   * 执行中投递的任务（任务链的下一个、release() 放回的任务）会再次被记录，可以再调用一次 drain()
   */
  async drain(): Promise<ProcessResult[]> {
    const results: ProcessResult[] = []
    for (const item of this.dispatched.splice(0)) {
      if (item.unique)
        this.uniqueKeys.delete(item.unique)
      results.push(await this.manager.process({
        id: crypto.randomUUID(),
        job: item.job,
        payload: item.payload,
        queue: item.queue,
        attempts: 0,
        dispatchedAt: Date.now(),
        connection: item.connection,
        ...(item.chain && {
          chain: item.chain,
        }),
        ...(item.batch && {
          batch: item.batch,
        }),
        ...(item.callbackOf && {
          callbackOf: item.callbackOf,
        }),
      }, 1))
    }
    return results
  }
}

interface SendExtra {
  chain?: ChainState
  batch?: string
  callbackOf?: string
  /** 不检查唯一锁（批次成员、任务链的后续任务） */
  skipUnique?: boolean
  /** sync 连接上任务失败时是否抛给调用方，默认 true */
  throwOnFailure?: boolean
}

function toJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value ?? null, jsonReplacer))
}

function uniqueOptions<P>(unique: true | UniqueJobOptions<P>): { key?: (payload: P) => string, for: number, until: 'processing' | 'processed' } {
  const options = unique === true
    ? {}
    : unique
  return {
    key: options.key,
    for: parseDuration(options.for ?? '1d'),
    until: options.until ?? 'processed',
  }
}

/** 投递与执行在同一进程的驱动：只有这些连接上可以使用函数回调 */
const IN_PROCESS_DRIVERS = new Set(['sync', 'memory'])

/** 队列管理（应用单例，`inject(QueueManager)`）：任务注册、投递、消费 */
export class QueueManager implements BatchControl {
  readonly #jobs = new Map<string, JobDefinition<any>>()
  readonly #names = new WeakMap<JobDefinition<any>, string>()
  readonly #drivers = new Map<string, QueueDriver>()
  /** 任务链 / 批次的函数回调（只存在于本进程，按 ID 引用） */
  readonly #closures = new Map<string, (...args: any[]) => unknown>()
  /** 已提示过“不支持原子操作”的缓存存储 */
  readonly #warned = new Set<string>()
  #batches: BatchStore | undefined
  #fake: QueueFake | undefined

  constructor(readonly app: Application) {}

  get config(): QueueConfig {
    const config = this.app.config.get<Partial<QueueConfig> | undefined>('queue', undefined)
    return {
      ...defaultQueueConfig,
      ...config,
      connections: {
        ...defaultQueueConfig.connections,
        ...config?.connections,
      },
    }
  }

  /** 注册任务（app/job 自动注册，名字取 defineJob 的 name 或文件名） */
  register(job: JobDefinition<any>, name?: string): this {
    if (!isJob(job))
      throw new TypeError('app/job/*.ts must export default defineJob(...)')
    const jobName = job.name ?? name
    if (!jobName)
      throw new Error('A job needs a name: defineJob({ name }) or a file in app/job')
    this.#jobs.set(jobName, job)
    this.#names.set(job, jobName)
    return this
  }

  jobs(): Map<string, JobDefinition<any>> {
    return new Map(this.#jobs)
  }

  nameOf(job: JobDefinition<any>): string {
    const name = this.#names.get(job) ?? job.name
    if (!name)
      throw new Error('This job is not registered: put it in app/job or give defineJob({ name })')
    return name
  }

  connection(name: string = this.config.default): QueueDriver {
    let driver = this.#drivers.get(name)
    if (!driver) {
      const config = this.config.connections[name]
      if (!config)
        throw new Error(`Queue connection "${name}" is not defined in config/queue.ts`)
      switch (config.driver) {
        case 'sync':
          driver = syncQueue()
          break
        case 'memory': {
          const memory = memoryQueue(name)
          // 进程内队列：首次使用即在本进程消费
          void memory.consume(this.#consumeOptions(['default'], config.concurrency ?? 1))
          driver = memory
          break
        }
        case 'redis':
          driver = redisQueue(config, this.app.container.has(RedisManager)
            ? this.app.make(RedisManager)
            : undefined)
          break
        case 'cloudflare':
          driver = cloudflareQueue(name, config)
          break
        default: {
          // 其它包注册的驱动（@hazejs/orm 的 database 等）
          const type = (config as { driver: string }).driver
          const factory = queueDriverFactory(type)
          if (!factory) {
            throw new Error(`Queue connection "${name}": unknown driver "${type}"${type === 'database'
              ? ' (register databaseProvider() from @hazejs/orm)'
              : ''}`)
          }
          driver = factory(name, config, this.app)
        }
      }
      this.#drivers.set(name, driver)
    }
    return driver
  }

  /** 唯一任务的锁与任务中间件使用的缓存存储（config/queue.ts 的 store，默认为默认存储） */
  cache(): CacheRepository {
    return this.#atomicStore(this.config.store)
  }

  /** 批次状态的存储（config/queue.ts 的 batches） */
  batches(): BatchStore {
    if (!this.#batches) {
      const config = this.config.batches ?? {}
      this.#batches = new BatchStore(this.#atomicStore(config.store ?? this.config.store), parseDuration(config.ttl ?? '7d'))
    }
    return this.#batches
  }

  #atomicStore(name: string | undefined): CacheRepository {
    const repository = this.app.make(CacheManager).store(name)
    if (!repository.store.atomic && !this.#warned.has(repository.name)) {
      this.#warned.add(repository.name)
      this.app.logger.warn(`Queue: cache store "${repository.name}" (driver "${repository.store.driver}") is not atomic; unique jobs, job middleware and batch counters need an atomic store such as redis (set store / batches.store in config/queue.ts)`)
    }
    return repository
  }

  #definition(job: JobDefinition<any> | string): { definition: JobDefinition<any>, name: string } {
    const definition = typeof job === 'string'
      ? this.#jobs.get(job)
      : job
    if (!definition)
      throw new Error(`Unknown job "${String(job)}"`)
    return {
      definition,
      name: typeof job === 'string'
        ? job
        : this.nameOf(definition),
    }
  }

  /** 投递任务（job 为定义或已注册的任务名），返回任务 ID（唯一任务被跳过时为持有锁的任务 ID） */
  async dispatch<P>(job: JobDefinition<P> | string, payload: P, options: DispatchOptions = {}): Promise<string> {
    const { definition, name } = this.#definition(job)
    return (await this.#send(definition, name, payload, options)).id
  }

  /** 投递 `Job.with(payload)`，返回 `{ id, skipped }` */
  dispatchPending(job: PendingJob<any>): Promise<DispatchResult> {
    return this.#send(job.definition, this.nameOf(job.definition), job.payload, job.options)
  }

  async #send(definition: JobDefinition<any>, name: string, payload: unknown, options: DispatchOptions = {}, extra: SendExtra = {}): Promise<DispatchResult> {
    const queue = options.queue ?? definition.queue ?? 'default'
    const connection = options.connection ?? definition.connection ?? this.config.default
    const delay = options.delay === undefined
      ? 0
      : parseDuration(options.delay)
    const unique = definition.unique && !extra.skipUnique
      ? uniqueOptions(definition.unique)
      : undefined
    const uniqueId = unique
      ? `${name}:${unique.key?.(payload) ?? ''}`
      : undefined
    if (this.#fake) {
      const record: DispatchedJob = {
        job: name,
        payload,
        queue,
        delay,
        connection,
        ...(extra.chain && {
          chain: extra.chain,
        }),
        ...(extra.batch && {
          batch: extra.batch,
        }),
        ...(extra.callbackOf && {
          callbackOf: extra.callbackOf,
        }),
        ...(uniqueId !== undefined && {
          unique: uniqueId,
        }),
      }
      if (uniqueId !== undefined) {
        if (this.#fake.uniqueKeys.has(uniqueId)) {
          this.#fake.skipped.push(record)
          return { id: '', skipped: true }
        }
        this.#fake.uniqueKeys.add(uniqueId)
      }
      this.#fake.dispatched.push(record)
      return {
        id: crypto.randomUUID(),
        skipped: false,
      }
    }
    const message: JobMessage & { tries: number } = {
      id: crypto.randomUUID(),
      job: name,
      payload: toJson(payload),
      queue,
      attempts: 0,
      dispatchedAt: Date.now(),
      tries: definition.tries ?? 1,
      connection,
    }
    if (extra.chain)
      message.chain = extra.chain
    if (extra.batch)
      message.batch = extra.batch
    if (extra.callbackOf)
      message.callbackOf = extra.callbackOf
    // 可观测性：追踪上下文与投递时的请求 ID 随消息传递，worker 中接续同一条链路
    const context = this.#messageContext(message)
    if (context)
      message.context = context
    // 多租户：携带当前租户 ID，worker 中恢复租户上下文
    const tenant = tenantQueueKey()
    if (tenant)
      message.context = { ...message.context, tenant }
    // 唯一任务：以消息 ID 为持有者取锁（键带当前租户前缀），锁被占用时跳过本次投递
    if (unique) {
      const cache = this.cache()
      const lock = cache.lock(`queue:unique:${uniqueId}`, unique.for, message.id)
      if (!(await lock.get()))
        return { id: await cache.store.get(lock.key) ?? '', skipped: true }
      message.unique = { store: cache.name, key: lock.key, until: unique.until }
    }
    if (telemetryActive()) {
      recordTelemetry('job.dispatched', {
        id: message.id,
        job: name,
        queue,
        connection,
        delay,
        payload: message.payload,
        ...(message.chain && {
          chain: message.chain.id,
        }),
        ...(message.batch && {
          batch: message.batch,
        }),
      })
    }
    try {
      const driver = this.connection(connection)
      if (driver.driver === 'sync') {
        const result = await this.process(message, 1)
        if ((result.status === 'failed' || result.status === 'retry') && extra.throwOnFailure !== false)
          throw result.error
        return { id: message.id, skipped: false }
      }
      await driver.push(message, delay)
    }
    catch (error) {
      // 没能进入队列：释放唯一锁
      if (message.unique)
        await this.#releaseUnique(message).catch(() => {})
      throw error
    }
    return { id: message.id, skipped: false }
  }

  /** 待投递任务 → 消息中的任务引用（defaults 为任务链 / 批次的默认连接与队列） */
  #queued(job: PendingJob<any>, defaults: { connection?: string, queue?: string } = {}): QueuedJob {
    if (!isPendingJob(job))
      throw new TypeError('Expected a pending job: use Job.with(payload)')
    const queue = job.options.queue ?? defaults.queue
    const connection = job.options.connection ?? defaults.connection
    return {
      job: this.nameOf(job.definition),
      payload: toJson(job.payload),
      ...(job.options.delay !== undefined && {
        delay: parseDuration(job.options.delay),
      }),
      ...(queue && {
        queue,
      }),
      ...(connection && {
        connection,
      }),
    }
  }

  /** 任务引用实际使用的连接名 */
  #connectionOf(job: QueuedJob): string {
    return job.connection ?? this.#jobs.get(job.job)?.connection ?? this.config.default
  }

  /**
   * 回调 → 可放进消息的引用：任务引用照常序列化；函数登记在本进程，
   * 只允许所有相关任务都在 sync / memory 连接上（否则执行任务的 worker 进程拿不到这个函数）
   */
  #callbacks(callbacks: QueueCallback<any[]>[], connections: string[]): QueuedCallback[] {
    return callbacks.map((callback) => {
      if (isPendingJob(callback))
        return this.#queued(callback)
      if (typeof callback !== 'function')
        throw new TypeError('A queue callback must be a function or a pending job (Job.with(payload))')
      if (!this.#fake) {
        const remote = connections.find(name => !IN_PROCESS_DRIVERS.has(this.config.connections[name]?.driver ?? ''))
        if (remote) {
          throw new Error(`Queue connection "${remote}" (${this.config.connections[remote]?.driver ?? 'unknown'} driver) cannot run function callbacks: functions cannot be serialized into the queue and the worker runs in another process. Pass a job reference instead, e.g. .catch(Cleanup.with(payload))`)
        }
      }
      const id = crypto.randomUUID()
      this.#closures.set(id, callback)
      return { closure: id }
    })
  }

  #forgetCallbacks(...lists: Array<QueuedCallback[] | undefined>): void {
    for (const callback of lists.flat()) {
      if (callback && 'closure' in callback)
        this.#closures.delete(callback.closure)
    }
  }

  /** 执行回调：函数直接调用，任务引用投递（失败只记日志） */
  async #invoke(callbacks: QueuedCallback[] | undefined, args: unknown[], logger: Logger, callbackOf?: string): Promise<void> {
    for (const callback of callbacks ?? []) {
      try {
        if ('closure' in callback) {
          const fn = this.#closures.get(callback.closure)
          if (!fn) {
            logger.warn('Queue callback function is not available in this process (function callbacks only work on sync / memory connections)')
            continue
          }
          await fn(...args)
        }
        else {
          const { definition } = this.#definition(callback.job)
          await this.#send(definition, callback.job, callback.payload, {
            delay: callback.delay,
            queue: callback.queue,
            connection: callback.connection,
          }, { callbackOf, throwOnFailure: false })
        }
      }
      catch (error) {
        logger.error('Queue callback failed', error)
      }
    }
  }

  /**
   * 投递任务链：先投递第一个任务，剩余任务随消息传递，前一个成功后才投递下一个；
   * 某个任务最终失败时丢弃剩余任务并执行 catch
   */
  async dispatchChain(chain: PendingChain): Promise<DispatchResult> {
    const defaults = { connection: chain.connection, queue: chain.queue }
    const jobs = chain.jobs.map(job => this.#queued(job, defaults))
    const [first] = chain.jobs
    const id = crypto.randomUUID()
    const state: ChainState = {
      id,
      jobs: jobs.slice(1),
    }
    if (chain.catchCallbacks.length)
      state.catch = this.#callbacks(chain.catchCallbacks, jobs.map(job => this.#connectionOf(job)))
    this.#fake?.chains.push({
      id,
      jobs: jobs.map(job => ({ job: job.job, payload: job.payload })),
      ...(chain.connection && {
        connection: chain.connection,
      }),
      ...(chain.queue && {
        queue: chain.queue,
      }),
    })
    const head = jobs[0]!
    const result = await this.#send(first!.definition, head.job, first!.payload, {
      delay: head.delay,
      queue: head.queue,
      connection: head.connection,
    }, { chain: state })
    if (result.skipped)
      this.#forgetCallbacks(state.catch)
    return { ...result, chainId: id }
  }

  /** 投递批次：先写入状态与总数，再投递各任务 */
  async dispatchBatch(pending: PendingBatch): Promise<Batch> {
    const defaults = { connection: pending.connection, queue: pending.queue }
    const jobs = pending.jobs.map(job => ({
      job,
      queued: this.#queued(job, defaults),
    }))
    const connections = jobs.map(({ queued }) => this.#connectionOf(queued))
    const id = crypto.randomUUID()
    const meta: BatchMeta = {
      id,
      name: pending.batchName,
      createdAt: Date.now(),
      allowFailures: pending.failuresAllowed,
      ...(pending.connection && {
        connection: pending.connection,
      }),
      ...(pending.queue && {
        queue: pending.queue,
      }),
      then: this.#callbacks(pending.callbacks.then, connections),
      catch: this.#callbacks(pending.callbacks.catch, connections),
      finally: this.#callbacks(pending.callbacks.finally, connections),
    }
    if (this.#fake) {
      this.#fake.batches.push({
        id,
        name: meta.name,
        jobs: jobs.map(({ queued }) => ({ job: queued.job, payload: queued.payload })),
        allowFailures: meta.allowFailures,
        cancelled: false,
        connection: meta.connection,
        queue: meta.queue,
        then: meta.then!,
        catch: meta.catch!,
        finally: meta.finally!,
        createdAt: meta.createdAt,
      })
      return (await this.findBatch(id))!
    }
    await this.batches().create(meta, jobs.length)
    for (const { job, queued } of jobs) {
      await this.#send(job.definition, queued.job, job.payload, {
        delay: queued.delay,
        queue: queued.queue,
        connection: queued.connection,
      }, { batch: id, skipUnique: true, throwOnFailure: false })
    }
    // 空批次：立即完成
    if (!jobs.length)
      await this.#finishBatch(id, this.app.logger)
    return (await this.findBatch(id))!
  }

  /** 读取批次（不存在或已过期时为 undefined） */
  async findBatch(id: string): Promise<Batch | undefined> {
    if (this.#fake) {
      const record = this.#fake.batches.find(batch => batch.id === id)
      return record && new Batch({
        id: record.id,
        name: record.name,
        createdAt: record.createdAt,
        allowFailures: record.allowFailures,
      }, {
        total: record.jobs.length,
        done: 0,
        failed: 0,
        failedJobIds: [],
        cancelledAt: record.cancelled
          ? record.createdAt
          : undefined,
        finishedAt: undefined,
      }, this)
    }
    const state = await this.batches().read(id)
    return state && new Batch(state.meta, state.counters, this)
  }

  /** 取消批次（Batch.cancel()） */
  async cancelBatch(id: string): Promise<void> {
    if (this.#fake) {
      const record = this.#fake.batches.find(batch => batch.id === id)
      if (record)
        record.cancelled = true
      return
    }
    await this.batches().cancel(id)
  }

  /** 向批次追加任务（Batch.add()），批次已结束时抛错 */
  async addToBatch(id: string, jobs: PendingJob<any>[]): Promise<Batch> {
    if (this.#fake) {
      const record = this.#fake.batches.find(batch => batch.id === id)
      if (!record)
        throw new Error(`Batch "${id}" not found`)
      const defaults = { connection: record.connection, queue: record.queue }
      record.jobs.push(...jobs.map((job) => {
        const queued = this.#queued(job, defaults)
        return { job: queued.job, payload: queued.payload }
      }))
      return (await this.findBatch(id))!
    }
    const state = await this.batches().read(id)
    if (!state)
      throw new Error(`Batch "${id}" not found (it may have expired)`)
    if (state.counters.finishedAt !== undefined)
      throw new Error(`Batch "${id}" has already finished`)
    const defaults = { connection: state.meta.connection, queue: state.meta.queue }
    const queued = jobs.map(job => ({
      job,
      queued: this.#queued(job, defaults),
    }))
    // 先增加总数再投递：新任务结束前 done 不可能达到总数
    await this.batches().grow(id, queued.length)
    for (const item of queued) {
      await this.#send(item.job.definition, item.queued.job, item.job.payload, {
        delay: item.queued.delay,
        queue: item.queued.queue,
        connection: item.queued.connection,
      }, { batch: id, skipUnique: true, throwOnFailure: false })
    }
    return (await this.findBatch(id))!
  }

  /**
   * 执行一条消息：成功返回 ok；release() 放回返回 released；失败且还有次数返回 retry（含退避秒数）；
   * 最后一次失败时调用任务的 failed() 并返回 failed。
   * 唯一锁的释放、任务链的下一个任务、批次计数与 release() 的重新投递都在这里完成，所有驱动通用
   */
  async process(message: JobMessage, attempt: number): Promise<ProcessResult> {
    if (!telemetryActive())
      return traceJobProcess(message, attempt, () => this.#processInTenant(message, attempt))
    const startTime = Date.now()
    const started = performance.now()
    const scope = { requestId: message.context?.requestId, jobId: message.id }
    const result = await runInTelemetryScope(scope, () => traceJobProcess(message, attempt, () => this.#processInTenant(message, attempt)))
    runInTelemetryScope(scope, () => recordTelemetry('job.processed', {
      id: message.id,
      job: message.job,
      queue: message.queue,
      attempt,
      status: result.status,
      startTime,
      duration: performance.now() - started,
      ...(message.chain && {
        chain: message.chain.id,
      }),
      ...(message.batch && {
        batch: message.batch,
      }),
      ...((result.status === 'retry' || result.status === 'failed') && {
        error: String((result.error as Error)?.stack ?? result.error),
      }),
    }))
    return result
  }

  /** 追踪上下文（启用 OpenTelemetry 时）与请求 ID（有遥测监听者时） */
  #messageContext(message: JobMessage): Record<string, string> | undefined {
    const trace = traceJobDispatch(message.job, message.queue, message.id)
    const scope = currentTelemetryScope()
    const requestId = !telemetryActive()
      ? undefined
      : scope
        ? scope.requestId
        : getRequestStore()?.ctx.requestId
    if (!requestId) {
      return trace && Object.keys(trace).length
        ? trace
        : undefined
    }
    return { ...trace, requestId }
  }

  /** 按消息携带的租户 ID 恢复租户上下文（没有时以无租户执行，租户已不存在时任务失败） */
  #processInTenant(message: JobMessage, attempt: number): Promise<ProcessResult> {
    return tenancyOf(this.app).runForMessage(message, () => this.#process(message, attempt)).catch((error: unknown): ProcessResult => ({ status: 'failed', error }))
  }

  async #process(message: JobMessage, attempt: number): Promise<ProcessResult> {
    const definition = this.#jobs.get(message.job)
    const logger = this.app.logger.child({ job: message.job, jobId: message.id, attempt })
    if (!definition) {
      const error = new Error(`Unknown job "${message.job}"`)
      logger.error('Job failed', error)
      const result: ProcessResult = { status: 'failed', error }
      await this.#settle(message, result, attempt, logger)
      return result
    }
    // 唯一任务（unique until processing）：开始执行即释放锁，之后可以再投递
    if (message.unique?.until === 'processing')
      await this.#releaseUnique(message).catch(error => logger.error('Failed to release the unique job lock', error))
    const batchId = message.batch ?? message.callbackOf
    const batch = batchId
      ? await this.findBatch(batchId).catch((error: unknown) => {
          logger.error('Failed to read the job batch', error)
          return undefined
        })
      : undefined
    const controller = new AbortController()
    const state: RunState = {}
    const context: JobContext = {
      id: message.id,
      name: message.job,
      attempt,
      queue: message.queue,
      logger,
      app: this.app,
      signal: controller.signal,
      release: (delay = 0) => {
        state.released = parseDuration(delay)
      },
      batch: () => batch,
    }
    runStates.set(context, state)
    // 批次已取消：跳过尚未执行的任务（计为已结束）
    if (message.batch && batch?.cancelled) {
      logger.debug('Batch cancelled, skipping job')
      const result: ProcessResult = { status: 'ok' }
      await this.#settle(message, result, attempt, logger, 'skipped')
      return result
    }
    const tries = definition.tries ?? 1
    const timeout = definition.timeout === undefined
      ? undefined
      : parseDuration(definition.timeout) * 1000
    let timer: ReturnType<typeof setTimeout> | undefined
    let result: ProcessResult
    try {
      // 执行次数已用完（例如 worker 崩溃后被重新领取的任务）：不再执行
      if (attempt > tries)
        throw new Error(`Job "${message.job}" has been attempted too many times (${attempt - 1}/${tries}); the worker may have crashed or timed out`)
      // 中间件：全局（config/queue.ts）在前，任务自己的在后，最内层为 handle
      const middleware = [
        ...(this.config.middleware ?? []),
        ...(definition.middleware ?? []),
      ]
      const pipeline = (index: number): Promise<unknown> => index < middleware.length
        ? Promise.resolve(middleware[index]!(message.payload, context, () => pipeline(index + 1)))
        : Promise.resolve(definition.handle(message.payload, context))
      const run = pipeline(0)
      await (timeout === undefined
        ? run
        : Promise.race([
            run,
            new Promise((_, reject) => {
              timer = setTimeout(() => {
                controller.abort()
                reject(new Error(`Job "${message.job}" timed out after ${timeout / 1000}s`))
              }, timeout)
            }),
          ]))
      result = state.released === undefined
        ? { status: 'ok' }
        : { status: 'released', delay: state.released }
    }
    catch (error) {
      if (attempt < tries) {
        const delay = state.retryDelay ?? backoffSeconds(definition.backoff, attempt)
        logger.warn(`Job attempt ${attempt}/${tries} failed, retrying in ${delay}s`, error)
        result = { status: 'retry', delay, error }
      }
      else {
        logger.error(`Job failed after ${attempt} attempt(s)`, error)
        try {
          await definition.failed?.(message.payload, error, context)
        }
        catch (hookError) {
          logger.error('Job failed() hook threw', hookError)
        }
        result = { status: 'failed', error }
      }
    }
    finally {
      clearTimeout(timer)
    }
    await this.#settle(message, result, attempt, logger)
    return result
  }

  /**
   * 一次执行结束后的收尾（仍在任务的租户与追踪上下文中，后续投递会携带它们）：
   * - released：重新投递（不消耗次数）；retry：交给驱动重试；
   * - ok / failed：释放唯一锁（until processed）、推进或终止任务链、记录批次进度
   */
  async #settle(message: JobMessage, result: ProcessResult, attempt: number, logger: Logger, outcome?: 'skipped'): Promise<void> {
    try {
      if (result.status === 'retry')
        return
      if (result.status === 'released') {
        await this.#repush(message, attempt, result.delay, logger)
        return
      }
      if (message.unique?.until === 'processed')
        await this.#releaseUnique(message)
      const ok = result.status === 'ok'
      const error = result.status === 'failed'
        ? result.error
        : undefined
      if (message.chain)
        await this.#continueChain(message.chain, ok, error, logger)
      if (message.batch)
        await this.#recordBatch(message.batch, message.id, outcome ?? (ok ? 'processed' : 'failed'), error, logger)
    }
    catch (error) {
      logger.error('Failed to finish the job (unique lock, chain or batch)', error)
    }
  }

  /** 释放唯一锁（只有持有者，即这条消息，才能释放） */
  async #releaseUnique(message: JobMessage): Promise<void> {
    const unique = message.unique
    if (!unique)
      return
    await this.app.make(CacheManager).store(unique.store).store.deleteIf(unique.key, message.id)
  }

  /** release()：放回同一连接，执行次数不变（drivers 据 attempts 计算下一次的 attempt） */
  async #repush(message: JobMessage, attempt: number, delay: number, logger: Logger): Promise<void> {
    const next: JobMessage = {
      ...message,
      attempts: attempt - 1,
      releases: (message.releases ?? 0) + 1,
    }
    const connection = message.connection ?? this.config.default
    if (this.#fake) {
      this.#fake.dispatched.push({
        job: message.job,
        payload: message.payload,
        queue: message.queue,
        delay,
        connection,
        ...(message.chain && {
          chain: message.chain,
        }),
        ...(message.batch && {
          batch: message.batch,
        }),
      })
      return
    }
    const driver = this.connection(connection)
    if (driver.driver === 'sync') {
      logger.warn('Job released on the sync connection, which cannot run it later: the job is dropped')
      return
    }
    await driver.push(next, delay)
    logger.debug(`Job released back onto the queue, available in ${delay}s`)
  }

  async #continueChain(chain: ChainState, ok: boolean, error: unknown, logger: Logger): Promise<void> {
    if (!ok) {
      // 最终失败：丢弃剩余任务，执行 catch
      if (chain.jobs.length)
        logger.warn(`Chain stopped: ${chain.jobs.length} remaining job(s) dropped`)
      await this.#invoke(chain.catch, [error], logger)
      this.#forgetCallbacks(chain.catch)
      return
    }
    const [next, ...rest] = chain.jobs
    if (!next) {
      this.#forgetCallbacks(chain.catch)
      return
    }
    const { definition } = this.#definition(next.job)
    await this.#send(definition, next.job, next.payload, {
      delay: next.delay,
      queue: next.queue,
      connection: next.connection,
    }, {
      chain: { ...chain, jobs: rest },
      skipUnique: true,
      throwOnFailure: false,
    })
  }

  async #recordBatch(id: string, jobId: string, outcome: 'processed' | 'failed' | 'skipped', error: unknown, logger: Logger): Promise<void> {
    if (this.#fake)
      return
    const store = this.batches()
    const { done, total, firstFailure } = await store.record(id, outcome, jobId)
    if (firstFailure) {
      const state = await store.read(id)
      if (state) {
        // 不允许失败：取消批次，尚未执行的任务将被跳过
        if (!state.meta.allowFailures)
          await store.cancel(id)
        const batch = await this.findBatch(id)
        await this.#invoke(state.meta.catch, [batch, error], logger, id)
      }
    }
    if (done >= total)
      await this.#finishBatch(id, logger)
  }

  /** 全部任务结束：以 add 写入完成标记，只有成功写入的 worker 执行 then / finally */
  async #finishBatch(id: string, logger: Logger): Promise<void> {
    const store = this.batches()
    if (!(await store.finish(id)))
      return
    const state = await store.read(id)
    if (!state)
      return
    const batch = new Batch(state.meta, state.counters, this)
    if (!batch.failed && !batch.cancelled)
      await this.#invoke(state.meta.then, [batch], logger, id)
    await this.#invoke(state.meta.finally, [batch], logger, id)
    this.#forgetCallbacks(state.meta.then, state.meta.catch, state.meta.finally)
  }

  #consumeOptions(queues: string[], concurrency: number, resolve: () => QueueManager = () => this): Parameters<QueueDriver['consume']>[0] {
    return {
      queues,
      concurrency,
      process: (message, attempt) => resolve().process(message, attempt),
      backoff: (message, attempt) => backoffSeconds(resolve().#jobs.get(message.job)?.backoff, attempt),
      tries: message => resolve().#jobs.get(message.job)?.tries ?? 1,
    }
  }

  /** 开始消费（haze queue:work / worker.mjs queue） */
  async work(options: WorkOptions = {}): Promise<QueueWorker> {
    const driver = this.connection(options.connection)
    const stop = await driver.consume(this.#consumeOptions(options.queues ?? ['default'], options.concurrency ?? 1, options.resolve))
    return { stop }
  }

  failed(connection?: string): Promise<FailedJob[]> {
    return this.connection(connection).failed()
  }

  retry(id?: string, connection?: string): Promise<number> {
    return this.connection(connection).retry(id)
  }

  forget(id: string, connection?: string): Promise<boolean> {
    return this.connection(connection).forget(id)
  }

  flush(connection?: string): Promise<number> {
    return this.connection(connection).flush()
  }

  /** 积压统计；驱动不支持时返回 undefined */
  async counts(connection?: string): Promise<QueueCounts | undefined> {
    return this.connection(connection).counts?.()
  }

  /** 等待 memory 连接上的任务全部完成（测试中使用） */
  async idle(connection?: string): Promise<void> {
    const driver = this.connection(connection) as QueueDriver & { idle?: () => Promise<void> }
    await driver.idle?.()
  }

  /** 改为记录投递而不执行，返回断言工具 */
  fake(): QueueFake {
    this.#fake = new QueueFake(this)
    return this.#fake
  }

  restore(): void {
    this.#fake = undefined
  }

  /**
   * Cloudflare Queues 的消费入口（Worker 的 queue() 调用）：
   * 成功 ack；可重试时 retry({ delaySeconds })；最终失败调用 failed() 后 ack；
   * release() 放回的任务以新消息重新发送（attempts 记在消息体中），原消息 ack。
   */
  async handleBatch(batch: { messages: Array<{ body: unknown, attempts: number, ack: () => void, retry: (options?: { delaySeconds?: number }) => void }> }): Promise<void> {
    await Promise.all(batch.messages.map(async (message) => {
      const body = message.body as JobMessage
      const result = await this.process(body, (body.attempts ?? 0) + message.attempts)
      if (result.status === 'retry') {
        message.retry(result.delay > 0
          ? {
              delaySeconds: Math.ceil(result.delay),
            }
          : undefined)
      }
      else {
        message.ack()
      }
    }))
  }

  async close(): Promise<void> {
    await Promise.all([
      ...this.#drivers.values(),
    ].map(driver => driver.close()))
    this.#drivers.clear()
  }
}
