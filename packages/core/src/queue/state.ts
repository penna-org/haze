import type { JobContext } from './job'

/** 一次执行中由 job.release() 与中间件设置的状态（QueueManager 执行完后读取） */
export interface RunState {
  /** release() 放回的延迟秒数 */
  released?: number
  /** 覆盖本次失败后的重试等待秒数（throttlesExceptions 的 backoff） */
  retryDelay?: number
}

/** @internal */
export const runStates = new WeakMap<JobContext, RunState>()
