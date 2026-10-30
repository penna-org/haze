import type { MaybePromise } from '../utils'
import type { Batch } from './batch'
import type { DispatchOptions, DispatchResult, JobDefinition } from './job'
import { useQueueManager } from './context'

/**
 * 待投递的任务（`Job.with(payload)`）：用于任务链、批量与回调，也可以直接投递。
 *
 * ```ts
 * await ProcessVideo.with({ id }).onQueue('media').delay('1m').dispatch()   // { id, skipped }
 * ```
 */
export class PendingJob<P = unknown> {
  readonly options: DispatchOptions = {}

  constructor(readonly definition: JobDefinition<P>, readonly payload: P) {}

  /** 延迟执行：秒数 / '10m' */
  delay(delay: string | number): this {
    this.options.delay = delay
    return this
  }

  onQueue(queue: string): this {
    this.options.queue = queue
    return this
  }

  onConnection(connection: string): this {
    this.options.connection = connection
    return this
  }

  /** 处于数据库事务中时推迟到提交后投递（回滚时丢弃）；`afterCommit(false)` 覆盖任务的 afterCommit */
  afterCommit(enabled = true): this {
    this.options.afterCommit = enabled
    return this
  }

  /** 投递，返回 `{ id, skipped, deferred? }`（skipped：唯一任务的锁被占用，没有投递） */
  dispatch(): Promise<DispatchResult> {
    return useQueueManager().dispatchPending(this)
  }
}

export function isPendingJob(value: unknown): value is PendingJob<any> {
  return value instanceof PendingJob
}

/**
 * 回调：任务引用（`Cleanup.with(...)`，到时投递，任何连接都可用），
 * 或函数（不能序列化，只在 sync / memory 连接上可用：投递与执行必须是同一个进程）
 */
export type QueueCallback<A extends unknown[]> = PendingJob<any> | ((...args: A) => MaybePromise<unknown>)

/**
 * 任务链（`Queue.chain([...])`）：依次执行，前一个成功后才投递下一个；
 * 某个任务最终失败时丢弃剩余任务并执行 catch。
 */
export class PendingChain {
  connection: string | undefined
  queue: string | undefined
  readonly catchCallbacks: QueueCallback<[error: unknown]>[] = []

  constructor(readonly jobs: PendingJob<any>[]) {
    if (!jobs.length)
      throw new Error('Queue.chain() needs at least one job')
  }

  /** 链中任务的默认连接（任务自己的 onConnection 优先） */
  onConnection(connection: string): this {
    this.connection = connection
    return this
  }

  /** 链中任务的默认队列（任务自己的 onQueue 优先） */
  onQueue(queue: string): this {
    this.queue = queue
    return this
  }

  /** 链中任务最终失败时执行（函数收到错误；任务引用直接投递） */
  catch(callback: QueueCallback<[error: unknown]>): this {
    this.catchCallbacks.push(callback)
    return this
  }

  /** 投递第一个任务，返回 `{ id, skipped, chainId }` */
  dispatch(): Promise<DispatchResult> {
    return useQueueManager().dispatchChain(this)
  }
}

/**
 * 批量任务（`Queue.batch([...])`）：状态保存在缓存存储中，全部完成时执行 then / finally（各一次），
 * 第一个任务失败时执行 catch。
 */
export class PendingBatch {
  batchName = ''
  failuresAllowed = false
  connection: string | undefined
  queue: string | undefined
  readonly callbacks: {
    then: QueueCallback<[batch: Batch]>[]
    catch: QueueCallback<[batch: Batch, error: unknown]>[]
    finally: QueueCallback<[batch: Batch]>[]
  } = { then: [], catch: [], finally: [] }

  constructor(readonly jobs: PendingJob<any>[]) {}

  name(name: string): this {
    this.batchName = name
    return this
  }

  /** 有任务失败时不取消批次（默认第一个失败即取消，尚未执行的任务被跳过） */
  allowFailures(allow = true): this {
    this.failuresAllowed = allow
    return this
  }

  onConnection(connection: string): this {
    this.connection = connection
    return this
  }

  onQueue(queue: string): this {
    this.queue = queue
    return this
  }

  /**
   * 全部任务成功完成后执行（有失败或已取消时不执行）。
   * 注意：PendingBatch 不能 await，需要调用 dispatch()
   */
  then(callback: QueueCallback<[batch: Batch]>, onRejected?: (reason: unknown) => void): this {
    // `await Queue.batch(...)`（忘了 dispatch()）会以 (resolve, reject) 调用 then：直接报错
    if (typeof onRejected === 'function') {
      onRejected(new TypeError('Queue.batch(...) is not awaitable: call .dispatch()'))
      return this
    }
    this.callbacks.then.push(callback)
    return this
  }

  /** 第一个任务最终失败时执行 */
  catch(callback: QueueCallback<[batch: Batch, error: unknown]>): this {
    this.callbacks.catch.push(callback)
    return this
  }

  /** 全部任务执行完（成功、失败或因取消被跳过）后执行 */
  finally(callback: QueueCallback<[batch: Batch]>): this {
    this.callbacks.finally.push(callback)
    return this
  }

  /** 投递全部任务，返回批次 */
  dispatch(): Promise<Batch> {
    return useQueueManager().dispatchBatch(this)
  }
}
