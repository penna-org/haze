import type { Batch } from './batch'
import type { DispatchArgs, FailedJob, JobDefinition } from './job'
import type { QueueFake, QueueManager } from './manager'
import type { PendingJob } from './pending'
import { useQueueManager } from './context'
import { PendingBatch, PendingChain } from './pending'

/**
 * 队列门面：
 *
 * ```ts
 * await Queue.dispatch(SendWelcomeEmail, { userId: 1 }, { delay: '10m' })
 * await Queue.chain([ProcessVideo.with({ id }), Publish.with({ id })]).catch(Cleanup.with({ id })).dispatch()
 * const batch = await Queue.batch([Import.with(a), Import.with(b)]).then(Notify.with({ ... })).dispatch()
 * const fake = Queue.fake()   // 测试
 * ```
 */
export const Queue = {
  dispatch: <P>(job: JobDefinition<P> | string, ...args: DispatchArgs<P>): Promise<string> => useQueueManager().dispatch(job, ...args),
  /** 任务链：依次执行，前一个成功后才投递下一个 */
  chain: (jobs: PendingJob<any>[]): PendingChain => new PendingChain(jobs),
  /** 批量任务：进度、取消、追加与完成回调，状态保存在缓存存储中 */
  batch: (jobs: PendingJob<any>[]): PendingBatch => new PendingBatch(jobs),
  /** 读取批次（不存在或已过期时为 undefined） */
  findBatch: (id: string): Promise<Batch | undefined> => useQueueManager().findBatch(id),
  fake: (): QueueFake => useQueueManager().fake(),
  restore: (): void => useQueueManager().restore(),
  failed: (connection?: string): Promise<FailedJob[]> => useQueueManager().failed(connection),
  retry: (id?: string, connection?: string): Promise<number> => useQueueManager().retry(id, connection),
  idle: (connection?: string): Promise<void> => useQueueManager().idle(connection),
  manager: (): QueueManager => useQueueManager(),
}
