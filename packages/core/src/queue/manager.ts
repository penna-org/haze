import type { Application } from '../application'
import type { CloudflareQueueConfig } from './drivers/cloudflare'
import type { RedisQueueConfig } from './drivers/redis'
import type { ProcessResult, QueueCounts, QueueDriver } from './drivers/types'
import type { DispatchOptions, FailedJob, JobContext, JobDefinition, JobMessage } from './job'
import { MaintenanceManager } from '../maintenance/manager'
import { traceJobDispatch, traceJobProcess } from '../observability/otel'
import { currentTelemetryScope, runInTelemetryScope } from '../observability/scope'
import { recordTelemetry, telemetryActive } from '../observability/telemetry'
import { RedisManager } from '../redis/manager'
import { getRequestStore } from '../request'
import { tenantQueueKey } from '../tenancy/context'
import { tenancyOf } from '../tenancy/manager'
import { jsonReplacer, parseDuration } from '../utils'
import { cloudflareQueue } from './drivers/cloudflare'
import { memoryQueue } from './drivers/memory'
import { redisQueue } from './drivers/redis'
import { syncQueue } from './drivers/sync'
import { backoffSeconds, isJob } from './job'

export interface MemoryQueueConfig {
  driver: 'memory'
  /** 本进程消费的并发数，默认 1 */
  concurrency?: number
}

export interface SyncQueueConfig {
  driver: 'sync'
}

export type QueueConnectionConfig = SyncQueueConfig | MemoryQueueConfig | RedisQueueConfig | CloudflareQueueConfig

export interface QueueConfig {
  /** 默认连接，默认 memory */
  default: string
  connections: Record<string, QueueConnectionConfig>
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
}

/** Queue.fake()：记录投递而不执行 */
export class QueueFake {
  readonly dispatched: DispatchedJob[] = []

  constructor(private readonly manager: QueueManager) {}

  #matching(job: JobDefinition<any> | string, payload?: (payload: any) => boolean): DispatchedJob[] {
    const name = typeof job === 'string'
      ? job
      : this.manager.nameOf(job)
    return this.dispatched.filter(item => item.job === name && (!payload || payload(item.payload)))
  }

  assertDispatched<P>(job: JobDefinition<P> | string, payload?: (payload: P) => boolean): void {
    if (!this.#matching(job, payload).length) {
      throw new Error(`Expected job "${typeof job === 'string'
        ? job
        : this.manager.nameOf(job)}" to be dispatched${payload ? ' with a matching payload' : ''}`)
    }
  }

  assertNotDispatched<P>(job: JobDefinition<P> | string, payload?: (payload: P) => boolean): void {
    if (this.#matching(job, payload).length) {
      throw new Error(`Unexpected dispatch of job "${typeof job === 'string'
        ? job
        : this.manager.nameOf(job)}"`)
    }
  }

  assertCount(count: number): void {
    if (this.dispatched.length !== count)
      throw new Error(`Expected ${count} dispatched job(s), got ${this.dispatched.length}`)
  }

  /** 执行已记录的任务（按投递顺序，忽略延迟），返回执行结果 */
  async drain(): Promise<ProcessResult[]> {
    const results: ProcessResult[] = []
    for (const item of this.dispatched.splice(0)) {
      results.push(await this.manager.process({
        id: crypto.randomUUID(),
        job: item.job,
        payload: item.payload,
        queue: item.queue,
        attempts: 0,
        dispatchedAt: Date.now(),
      }, 1))
    }
    return results
  }
}

/** 队列管理（应用单例，`inject(QueueManager)`）：任务注册、投递、消费 */
export class QueueManager {
  readonly #jobs = new Map<string, JobDefinition<any>>()
  readonly #names = new WeakMap<JobDefinition<any>, string>()
  readonly #drivers = new Map<string, QueueDriver>()
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
        default:
          throw new Error(`Queue connection "${name}": unknown driver "${(config as { driver: string }).driver}"`)
      }
      this.#drivers.set(name, driver)
    }
    return driver
  }

  /** 投递任务（job 为定义或已注册的任务名），返回任务 ID */
  async dispatch<P>(job: JobDefinition<P> | string, payload: P, options: DispatchOptions = {}): Promise<string> {
    const definition = typeof job === 'string'
      ? this.#jobs.get(job)
      : job
    if (!definition)
      throw new Error(`Unknown job "${String(job)}"`)
    const name = typeof job === 'string'
      ? job
      : this.nameOf(definition)
    const queue = options.queue ?? definition.queue ?? 'default'
    const connection = options.connection ?? definition.connection ?? this.config.default
    const delay = options.delay === undefined
      ? 0
      : parseDuration(options.delay)
    if (this.#fake) {
      this.#fake.dispatched.push({
        job: name,
        payload,
        queue,
        delay,
        connection,
      })
      return crypto.randomUUID()
    }
    const message: JobMessage & { tries: number } = {
      id: crypto.randomUUID(),
      job: name,
      payload: JSON.parse(JSON.stringify(payload ?? null, jsonReplacer)),
      queue,
      attempts: 0,
      dispatchedAt: Date.now(),
      tries: definition.tries ?? 1,
    }
    // 可观测性：追踪上下文与投递时的请求 ID 随消息传递，worker 中接续同一条链路
    const context = this.#messageContext(message)
    if (context)
      message.context = context
    // 多租户：携带当前租户 ID，worker 中恢复租户上下文
    const tenant = tenantQueueKey()
    if (tenant)
      message.context = { ...message.context, tenant }
    if (telemetryActive()) {
      recordTelemetry('job.dispatched', {
        id: message.id,
        job: name,
        queue,
        connection,
        delay,
        payload: message.payload,
      })
    }
    const driver = this.connection(connection)
    if (driver.driver === 'sync') {
      const result = await this.process(message, 1)
      if (result.status !== 'ok')
        throw (result as { error: unknown }).error
      return message.id
    }
    await driver.push(message, delay)
    return message.id
  }

  /**
   * 执行一条消息：成功返回 ok；失败且还有次数返回 retry（含退避秒数）；
   * 最后一次失败时调用任务的 failed() 并返回 failed。
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
      ...(result.status !== 'ok' && {
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
      return { status: 'failed', error }
    }
    const controller = new AbortController()
    const context: JobContext = {
      id: message.id,
      attempt,
      queue: message.queue,
      logger,
      app: this.app,
      signal: controller.signal,
    }
    const timeout = definition.timeout === undefined
      ? undefined
      : parseDuration(definition.timeout) * 1000
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const run = Promise.resolve(definition.handle(message.payload, context))
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
      return { status: 'ok' }
    }
    catch (error) {
      const tries = definition.tries ?? 1
      if (attempt < tries) {
        const delay = backoffSeconds(definition.backoff, attempt)
        logger.warn(`Job attempt ${attempt}/${tries} failed, retrying in ${delay}s`, error)
        return { status: 'retry', delay, error }
      }
      logger.error(`Job failed after ${attempt} attempt(s)`, error)
      try {
        await definition.failed?.(message.payload, error, context)
      }
      catch (hookError) {
        logger.error('Job failed() hook threw', hookError)
      }
      return { status: 'failed', error }
    }
    finally {
      clearTimeout(timer)
    }
  }

  #consumeOptions(queues: string[], concurrency: number, resolve: () => QueueManager = () => this): Parameters<QueueDriver['consume']>[0] {
    return {
      queues,
      concurrency,
      process: async (message, attempt) => {
        // 维护模式（pauseWorkers）：任务之间暂停，恢复后继续（取最新的应用，开发时热替换后同样生效）
        const { container } = resolve().app
        if (container.has(MaintenanceManager))
          await container.make(MaintenanceManager).waitUntilUp()
        return resolve().process(message, attempt)
      },
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
   * 成功 ack；可重试时 retry({ delaySeconds })；最终失败调用 failed() 后 ack。
   */
  async handleBatch(batch: { messages: Array<{ body: unknown, attempts: number, ack: () => void, retry: (options?: { delaySeconds?: number }) => void }> }): Promise<void> {
    await Promise.all(batch.messages.map(async (message) => {
      const result = await this.process(message.body as JobMessage, message.attempts)
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
