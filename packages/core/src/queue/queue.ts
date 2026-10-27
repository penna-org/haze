import type { DispatchOptions, FailedJob, JobDefinition } from './job'
import type { QueueFake, QueueManager } from './manager'
import { useQueueManager } from './context'

/**
 * 队列门面：
 *
 * ```ts
 * await Queue.dispatch(SendWelcomeEmail, { userId: 1 }, { delay: '10m' })
 * const fake = Queue.fake()   // 测试
 * ```
 */
export const Queue = {
  dispatch: <P>(job: JobDefinition<P> | string, payload: P, options?: DispatchOptions): Promise<string> => useQueueManager().dispatch(job, payload, options),
  fake: (): QueueFake => useQueueManager().fake(),
  restore: (): void => useQueueManager().restore(),
  failed: (connection?: string): Promise<FailedJob[]> => useQueueManager().failed(connection),
  retry: (id?: string, connection?: string): Promise<number> => useQueueManager().retry(id, connection),
  idle: (connection?: string): Promise<void> => useQueueManager().idle(connection),
  manager: (): QueueManager => useQueueManager(),
}
