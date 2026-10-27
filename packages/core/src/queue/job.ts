import type { Application } from '../application'
import type { Logger } from '../logger'
import type { MaybePromise } from '../utils'
import { parseDuration } from '../utils'
import { useQueueManager } from './context'

const kJob = Symbol.for('think-h3.job')

/** 任务执行时的上下文 */
export interface JobContext {
  id: string
  /** 第几次执行（从 1 开始） */
  attempt: number
  queue: string
  logger: Logger
  app: Application
  /** 超时时触发 */
  signal: AbortSignal
}

export type Backoff = number | string | Array<number | string> | 'exponential'

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
  handle: (payload: P, job: JobContext) => MaybePromise<unknown>
  /** 全部重试都失败后调用 */
  failed?: (payload: P, error: unknown, job: JobContext) => MaybePromise<unknown>
}

export interface DispatchOptions {
  /** 延迟执行：秒数 / '10m' */
  delay?: string | number
  queue?: string
  connection?: string
}

export interface JobDefinition<P = unknown> extends JobOptions<P> {
  readonly [kJob]: true
  /** 投递任务，返回任务 ID */
  dispatch: (payload: P, options?: DispatchOptions) => Promise<string>
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
    dispatch: (payload, dispatchOptions) => useQueueManager().dispatch(job, payload, dispatchOptions),
  }
  return job
}

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

/** 队列中传递的消息（JSON） */
export interface JobMessage {
  id: string
  job: string
  payload: unknown
  queue: string
  /** 已执行次数 */
  attempts: number
  dispatchedAt: number
}

export interface FailedJob {
  id: string
  job: string
  queue: string
  payload: unknown
  error: string
  attempts: number
  failedAt: number
}
