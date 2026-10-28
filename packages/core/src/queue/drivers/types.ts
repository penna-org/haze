import type { FailedJob, JobMessage } from '../job'

/** 处理一条消息的结果：成功；需要重试（delay 秒后）；最终失败 */
export type ProcessResult = { status: 'ok' } | { status: 'retry', delay: number, error: unknown } | { status: 'failed', error: unknown }

export interface ConsumeOptions {
  queues: string[]
  concurrency: number
  /** 执行一条消息（attempt 从 1 开始） */
  process: (message: JobMessage, attempt: number) => Promise<ProcessResult>
  /** 第 attempt 次失败后的重试等待秒数（BullMQ 的 backoffStrategy 使用） */
  backoff: (message: JobMessage, attempt: number) => number
  /** 任务最多执行次数 */
  tries: (message: JobMessage) => number
}

/** 队列积压统计（各驱动按自己的能力提供） */
export interface QueueCounts {
  waiting: number
  delayed: number
  active: number
  failed: number
}

export interface QueueDriver {
  readonly driver: string
  push: (message: JobMessage, delaySeconds: number) => Promise<void>
  /** 开始消费，返回停止函数（等待执行中的任务完成） */
  consume: (options: ConsumeOptions) => Promise<() => Promise<void>>
  failed: () => Promise<FailedJob[]>
  /** 重新投递失败任务（不传 id 为全部），返回数量 */
  retry: (id?: string) => Promise<number>
  forget: (id: string) => Promise<boolean>
  flush: () => Promise<number>
  /** 积压统计（可选，队列面板与 queueCheck 使用） */
  counts?: () => Promise<QueueCounts>
  close: () => Promise<void>
}
