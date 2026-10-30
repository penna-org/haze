import type { Application } from '../application'
import type { Logger } from '../logger'
import type { MaybePromise } from '../utils'
import type { Batch } from './batch'
import { parseDuration } from '../utils'
import { useQueueManager } from './context'
import { PendingJob } from './pending'

const kJob = Symbol.for('hazejs.job')

/** 任务执行时的上下文 */
export interface JobContext {
  id: string
  /** 任务名 */
  name: string
  /** 第几次执行（从 1 开始） */
  attempt: number
  queue: string
  logger: Logger
  app: Application
  /** 超时时触发 */
  signal: AbortSignal
  /**
   * 放回队列，delay（秒数 / '30s'，默认 0）后再执行：不算失败、不消耗执行次数。
   * 调用后 handle / 中间件正常返回即可；sync 连接无法延后执行，放回的任务被丢弃（记一条警告）
   */
  release: (delay?: string | number) => void
  /** 当前任务所属的批次（执行前读取的快照，`await job.batch()?.fresh()` 取最新状态）；不属于批次时为 undefined */
  batch: () => Batch | undefined
}

export type Backoff = number | string | Array<number | string> | 'exponential'

/**
 * 任务中间件：包住 handle 执行，调用 next() 继续；不调用 next() 即跳过本次执行
 * （可先调用 job.release(delay) 放回队列）
 */
export type JobMiddleware<P = any> = (payload: P, job: JobContext, next: () => Promise<unknown>) => MaybePromise<unknown>

export interface UniqueJobOptions<P> {
  /** 唯一键（同一任务名下），默认空：同一时间只允许一个该任务 */
  key?: (payload: P) => string
  /** 锁的有效期（秒数 / '1h'），过期后自动释放，默认 '1d' */
  for?: string | number
  /** 何时释放：开始执行时（processing）或执行结束时（processed，默认，最终失败也释放） */
  until?: 'processing' | 'processed'
}

export interface JobOptions<P> {
  /** 任务名，默认 app/job 下的文件名 */
  name?: string
  /** 最多执行次数，默认 1（不重试） */
  tries?: number
  /** 重试前等待：秒数 / '5m'，数组按次数取（不足时取最后一个），'exponential' 为 2^n 秒；默认 0 */
  backoff?: Backoff
  /** 超时视为失败（进入重试） */
  timeout?: string | number
  /** 队列名，默认 default */
  queue?: string
  /** 队列连接（config/queue.ts 的 connections），默认 default */
  connection?: string
  /** 唯一任务：投递时取缓存锁，锁被占用时跳过本次投递 */
  unique?: boolean | UniqueJobOptions<P>
  /** 任务中间件（在 config/queue.ts 的全局中间件之后执行） */
  middleware?: JobMiddleware<P>[]
  /**
   * 在数据库事务中投递时，推迟到最外层事务提交后再投递（回滚时不投递）；不在事务中时立即投递。
   * 投递时的 `{ afterCommit }` 选项优先。需要注册了事务实现的数据库包（@hazejs/orm）
   */
  afterCommit?: boolean
  handle: (payload: P, job: JobContext) => MaybePromise<unknown>
  /** 全部重试都失败后调用 */
  failed?: (payload: P, error: unknown, job: JobContext) => MaybePromise<unknown>
}

export interface DispatchOptions {
  /** 延迟执行：秒数 / '10m' */
  delay?: string | number
  queue?: string
  connection?: string
  /** 处于数据库事务中时推迟到提交后投递（回滚时丢弃），默认取任务的 afterCommit */
  afterCommit?: boolean
}

/**
 * 投递参数：载荷类型为 void / undefined（或没有声明，即 unknown）时载荷可以省略，
 * `await Cleanup.dispatch()`、`s.job(Cleanup)`
 */
export type DispatchArgs<P, O = DispatchOptions> = unknown extends P
  ? [payload?: P, options?: O]
  : [P] extends [void | undefined]
      ? [payload?: P, options?: O]
      : [payload: P, options?: O]

/** `Job.with(payload).dispatch()` 与 `Queue.chain(...).dispatch()` 的结果 */
export interface DispatchResult {
  /** 任务 ID；唯一任务被跳过时为持有锁的任务 ID（未知时为空字符串） */
  id: string
  /** 唯一任务的锁已被占用，本次没有投递 */
  skipped: boolean
  /** afterCommit：处于事务中，推迟到提交后投递（id 为届时使用的任务 ID；唯一锁到那时才检查） */
  deferred?: boolean
  /** 任务链 ID（Queue.chain） */
  chainId?: string
}

export interface JobDefinition<P = unknown> extends JobOptions<P> {
  readonly [kJob]: true
  /** 投递任务，返回任务 ID（唯一任务被跳过时为已在队列中的任务 ID）；无载荷的任务可以省略 payload */
  dispatch: (...args: DispatchArgs<P>) => Promise<string>
  /** 待投递的任务：任务链、批量与回调使用，也可以直接 `.dispatch()`（返回 `{ id, skipped }`） */
  with: (...args: WithArgs<P>) => PendingJob<P>
}

/**
 * 定义任务（app/job/*.ts 的默认导出，自动注册，文件名即任务名）：
 *
 * ```ts
 * export default defineJob({
 *   tries: 3,
 *   backoff: [10, 60],
 *   async handle(payload: { userId: number }, job) { ... },
 * })
 * await SendWelcomeEmail.dispatch({ userId: 1 }, { delay: '10m' })
 * ```
 */
export function defineJob<P>(options: JobOptions<P>): JobDefinition<P> {
  const job: JobDefinition<P> = {
    ...options,
    [kJob]: true,
    dispatch: (...args) => useQueueManager().dispatch(job, ...args),
    with: (...args) => new PendingJob(job, args[0] as P),
  }
  return job
}

/** `Job.with(payload)` 的参数：无载荷的任务可以省略 */
export type WithArgs<P> = unknown extends P
  ? [payload?: P]
  : [P] extends [void | undefined]
      ? [payload?: P]
      : [payload: P]

export function isJob(value: unknown): value is JobDefinition<any> {
  return typeof value === 'object' && value !== null && kJob in value
}

/** 第 attempt 次失败后、下一次执行前等待的秒数 */
export function backoffSeconds(backoff: Backoff | undefined, attempt: number): number {
  if (backoff === undefined)
    return 0
  if (backoff === 'exponential')
    return 2 ** attempt
  if (Array.isArray(backoff)) {
    return backoff.length
      ? parseDuration(backoff[Math.min(attempt, backoff.length) - 1])
      : 0
  }
  return parseDuration(backoff)
}

/** 消息中待投递的任务（任务链的后续任务、回调任务） */
export interface QueuedJob {
  job: string
  payload: unknown
  /** 延迟秒数 */
  delay?: number
  queue?: string
  connection?: string
}

/** 回调：任务引用（投递该任务），或本进程内的函数（只在 sync / memory 连接上可用，按 ID 查找） */
export type QueuedCallback = QueuedJob | { closure: string }

/** 任务链的剩余部分（随消息传递） */
export interface ChainState {
  id: string
  /** 当前任务成功后依次投递的任务 */
  jobs: QueuedJob[]
  /** 链中任务最终失败时执行（剩余任务不再投递） */
  catch?: QueuedCallback[]
}

/** 队列中传递的消息（JSON） */
export interface JobMessage {
  id: string
  job: string
  payload: unknown
  queue: string
  /** 已执行次数 */
  attempts: number
  dispatchedAt: number
  /** 投递时的追踪上下文（traceparent / tracestate）、请求 ID（requestId）与租户（tenant），worker 中据此接续 */
  context?: Record<string, string>
  /** 投递所用的连接（release() 放回时使用） */
  connection?: string
  /** 被 release() 放回的次数 */
  releases?: number
  /** 任务链：本任务成功后投递的后续任务 */
  chain?: ChainState
  /** 所属批次 ID */
  batch?: string
  /** 作为该批次的回调（then / catch / finally）投递，job.batch() 返回该批次 */
  callbackOf?: string
  /** 唯一任务的锁：缓存存储、实际键与释放时机（持有者为消息 ID） */
  unique?: { store: string, key: string, until: 'processing' | 'processed' }
}

export interface FailedJob {
  id: string
  job: string
  queue: string
  payload: unknown
  error: string
  attempts: number
  failedAt: number
  /** 所属批次 ID */
  batch?: string
  /** 任务链 ID */
  chain?: string
}
