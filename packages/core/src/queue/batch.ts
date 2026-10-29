import type { CacheRepository } from '../cache/repository'
import type { QueuedCallback } from './job'
import type { PendingJob } from './pending'
import { runWithoutTenant } from '../tenancy/context'

/** 批次的固定信息（创建时写入缓存） */
export interface BatchMeta {
  id: string
  name: string
  createdAt: number
  allowFailures: boolean
  then?: QueuedCallback[]
  catch?: QueuedCallback[]
  finally?: QueuedCallback[]
  /** 批次的默认连接 / 队列（add() 追加的任务使用） */
  connection?: string
  queue?: string
}

/** 批次的计数（原子自增维护） */
export interface BatchCounters {
  total: number
  /** 已结束的任务数：成功、最终失败或因取消被跳过 */
  done: number
  failed: number
  failedJobIds: string[]
  cancelledAt: number | undefined
  finishedAt: number | undefined
}

/** 批次的读取与控制（QueueManager 实现；Queue.fake() 时操作记录的批次） */
export interface BatchControl {
  findBatch: (id: string) => Promise<Batch | undefined>
  cancelBatch: (id: string) => Promise<void>
  addToBatch: (id: string, jobs: PendingJob<any>[]) => Promise<Batch>
}

/**
 * 批次的状态快照（`Queue.batch(...).dispatch()`、`Queue.findBatch(id)`、任务中的 `job.batch()`）。
 * 字段是读取时的值，`await batch.fresh()` 重新读取。
 */
export class Batch {
  readonly id: string
  readonly name: string
  /** 任务总数（add() 追加后增加） */
  readonly total: number
  /** 尚未结束的任务数 */
  readonly pending: number
  /** 已结束且没有失败的任务数（包括取消后被跳过的任务） */
  readonly processed: number
  /** 最终失败的任务数 */
  readonly failed: number
  /** 进度百分比（0–100，已结束的任务 / 总数） */
  readonly progress: number
  readonly finished: boolean
  readonly cancelled: boolean
  readonly allowFailures: boolean
  readonly failedJobIds: string[]
  readonly createdAt: Date
  readonly finishedAt: Date | null
  readonly cancelledAt: Date | null
  readonly #control: BatchControl

  constructor(meta: BatchMeta, counters: BatchCounters, control: BatchControl) {
    this.id = meta.id
    this.name = meta.name
    this.allowFailures = meta.allowFailures
    this.total = counters.total
    this.pending = Math.max(0, counters.total - counters.done)
    this.failed = counters.failed
    this.processed = Math.max(0, counters.done - counters.failed)
    this.progress = counters.total
      ? Math.min(100, Math.floor(counters.done / counters.total * 100))
      : 100
    this.finished = counters.finishedAt !== undefined
    this.cancelled = counters.cancelledAt !== undefined
    this.failedJobIds = counters.failedJobIds
    this.createdAt = new Date(meta.createdAt)
    this.finishedAt = counters.finishedAt === undefined
      ? null
      : new Date(counters.finishedAt)
    this.cancelledAt = counters.cancelledAt === undefined
      ? null
      : new Date(counters.cancelledAt)
    this.#control = control
  }

  /** 取消批次：尚未执行的任务被跳过（执行中的任务可检查 `job.batch()?.cancelled`），全部结束后仍执行 finally */
  cancel(): Promise<void> {
    return this.#control.cancelBatch(this.id)
  }

  /** 追加任务（批次已结束时抛错），返回最新状态 */
  add(jobs: PendingJob<any> | PendingJob<any>[]): Promise<Batch> {
    return this.#control.addToBatch(this.id, Array.isArray(jobs)
      ? jobs
      : [jobs])
  }

  /** 重新读取最新状态（批次已过期时返回当前快照） */
  async fresh(): Promise<Batch> {
    return await this.#control.findBatch(this.id) ?? this
  }
}

/**
 * 批次状态在缓存中的存放（键位于中央上下文，不带租户前缀：批次 ID 是随机值）：
 * - `queue:batch:<id>`：BatchMeta；
 * - `queue:batch:<id>:total` / `:done` / `:failed`：原子计数；
 * - `:failed_ids`：失败任务 ID 的数组（push）；
 * - `:cancelled` / `:finished`：时间戳，以 add（不存在才写）写入，只有第一个写入者成功——
 *   完成回调由把 finished 写入成功的那个 worker 执行，保证只执行一次。
 */
export class BatchStore {
  constructor(readonly repository: CacheRepository, readonly ttl: number) {}

  #key(id: string, part?: string): string {
    return part
      ? `queue:batch:${id}:${part}`
      : `queue:batch:${id}`
  }

  async create(meta: BatchMeta, total: number): Promise<void> {
    await runWithoutTenant(async () => {
      await this.repository.set(this.#key(meta.id), meta, this.ttl)
      await this.repository.increment(this.#key(meta.id, 'total'), total, this.ttl)
    })
  }

  read(id: string): Promise<{ meta: BatchMeta, counters: BatchCounters } | undefined> {
    return runWithoutTenant(async () => {
      const meta = await this.repository.get<BatchMeta>(this.#key(id))
      if (!meta)
        return undefined
      const parts = [
        'total',
        'done',
        'failed',
        'failed_ids',
        'cancelled',
        'finished',
      ]
      const values = await this.repository.many(parts.map(part => this.#key(id, part)))
      const value = (part: string): unknown => values[this.#key(id, part)]
      const time = (part: string): number | undefined => value(part) === undefined
        ? undefined
        : Number(value(part))
      return {
        meta,
        counters: {
          total: Number(value('total') ?? 0),
          done: Number(value('done') ?? 0),
          failed: Number(value('failed') ?? 0),
          failedJobIds: (value('failed_ids') as string[] | undefined) ?? [],
          cancelledAt: time('cancelled'),
          finishedAt: time('finished'),
        },
      }
    })
  }

  /** 追加任务前增加总数 */
  grow(id: string, count: number): Promise<number> {
    return runWithoutTenant(() => this.repository.increment(this.#key(id, 'total'), count, this.ttl))
  }

  /** 标记取消，返回是否是第一次取消 */
  cancel(id: string): Promise<boolean> {
    return runWithoutTenant(() => this.repository.add(this.#key(id, 'cancelled'), Date.now(), this.ttl))
  }

  /**
   * 记录一个任务结束：失败时先计入 failed（之后读到 done 达到总数时失败数已准确），再自增 done。
   * 返回自增后的 done、当前总数，以及这是否是第一个失败（catch 只执行一次）
   */
  record(id: string, outcome: 'processed' | 'failed' | 'skipped', jobId: string): Promise<{ done: number, total: number, firstFailure: boolean }> {
    return runWithoutTenant(async () => {
      let firstFailure = false
      if (outcome === 'failed') {
        firstFailure = await this.repository.increment(this.#key(id, 'failed'), 1, this.ttl) === 1
        await this.repository.push(this.#key(id, 'failed_ids'), jobId, this.ttl)
      }
      const done = await this.repository.increment(this.#key(id, 'done'), 1, this.ttl)
      const total = Number(await this.repository.get(this.#key(id, 'total')) ?? 0)
      return { done, total, firstFailure }
    })
  }

  /** 标记完成，只有第一个调用者返回 true */
  finish(id: string): Promise<boolean> {
    return runWithoutTenant(() => this.repository.add(this.#key(id, 'finished'), Date.now(), this.ttl))
  }
}
