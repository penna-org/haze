import type { ConsumeOptions, FailedJob, JobMessage, Logger, QueueCounts, QueueDriver } from '@hazejs/core'
import type { SQL } from 'drizzle-orm'
import type { Dialect } from './config'
import { parseDuration, Tenancy } from '@hazejs/core'
import { sql } from 'drizzle-orm'
import { resolveSession } from './context'
import { Db } from './db'

/** config/queue.ts 中 `driver: 'database'` 的连接 */
export interface DatabaseQueueConfig {
  driver: 'database'
  /** 数据库连接名（config/database.ts），默认其 default 连接 */
  connection?: string
  /** 任务表，默认 jobs */
  table?: string
  /** 失败任务表，默认 failed_jobs */
  failedTable?: string
  /**
   * 领取后超过这么久仍未完成的任务视为 worker 已崩溃，可被重新领取（秒数 / '90s'，默认 90 秒）。
   * 必须大于任务的 timeout，否则执行中的任务会被另一个 worker 再领取一次
   */
  retryAfter?: string | number
  /** 空闲时的轮询间隔（秒数，可为小数，或 '1s'），默认 1 秒；连续空闲时加倍，直到 maxSleep */
  sleep?: string | number
  /** 空闲轮询间隔的上限，默认为 sleep 的 5 倍 */
  maxSleep?: string | number
}

declare module '@hazejs/core' {
  interface QueueDriverRegistry {
    database: DatabaseQueueConfig
  }
}

export interface DatabaseQueueOptions {
  /** 消费循环中的数据库错误写到这里（默认忽略，任务在 retryAfter 后被重新领取） */
  logger?: Logger
}

/** 领取到的任务行 */
interface Reserved {
  id: number | string
  message: JobMessage
  /** 本次执行是第几次（领取时已自增） */
  attempt: number
  /** 领取时写入的 reserved_at：确认 / 释放时以它为条件，被重新领取过的行不会被旧 worker 删除 */
  reservedAt: number
}

const sleepFor = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

/** SQLite 的写锁冲突（多个连接同时写同一个文件时） */
function isBusy(error: unknown): boolean {
  let current = error as { message?: unknown, code?: unknown, cause?: unknown } | undefined
  for (let depth = 0; current && depth < 5; depth++) {
    if (/SQLITE_BUSY|database is locked/i.test(`${String(current.code ?? '')} ${String(current.message ?? '')}`))
      return true
    current = current.cause as typeof current
  }
  return false
}

function seconds(value: string | number): number {
  return typeof value === 'string' && /^\s*\d+(?:\.\d+)?\s*$/.test(value)
    ? Number(value)
    : parseDuration(value)
}

/**
 * 数据库队列驱动（@hazejs/orm；databaseProvider 注册为 `driver: 'database'`）：
 *
 * ```ts
 * // config/queue.ts
 * connections: { database: { driver: 'database', connection: 'main', table: 'jobs', retryAfter: '90s' } }
 * ```
 *
 * 表结构用 `haze make:queue-tables` 生成。领取任务：
 * - PostgreSQL / MySQL 8：事务中 `SELECT … FOR UPDATE SKIP LOCKED`，再写入 reserved_at 并把 attempts 加 1；
 * - SQLite / libsql / Turso / D1：一条原子的 `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING`。
 * reserved_at 早于 retryAfter 的行（worker 崩溃）可被重新领取；延迟任务用 available_at。
 * 失败任务写入 failed_jobs。投递在任何平台都可用（包括 Workers 上的 D1 / Turso），消费需要常驻的 worker 进程。
 * 所有查询都在中央（无租户）上下文中执行：队列表位于中央库，任务的租户由消息携带。
 */
export function databaseQueue(name: string, config: Partial<DatabaseQueueConfig> = {}, options: DatabaseQueueOptions = {}): QueueDriver {
  const jobs = sql.identifier(config.table ?? 'jobs')
  const failedJobs = sql.identifier(config.failedTable ?? 'failed_jobs')
  const retryAfter = parseDuration(config.retryAfter ?? '90s') * 1000
  const idleSleep = Math.max(0.001, seconds(config.sleep ?? 1)) * 1000
  const maxSleep = Math.max(idleSleep, config.maxSleep === undefined
    ? idleSleep * 5
    : seconds(config.maxSleep) * 1000)
  /** 本进程中的消费者（投递后立即唤醒，不必等到下一次轮询） */
  const consumers = new Set<{ wake: () => void, stop: () => Promise<void> }>()

  const db = (): ReturnType<typeof Db.connection> => Db.connection(config.connection as string)
  const central = <T>(fn: () => Promise<T>): Promise<T> => Tenancy.central(fn)

  async function dialect(): Promise<{ dialect: Dialect, driver: string }> {
    return central(() => resolveSession(config.connection))
  }

  /** 执行 SQL（SQLite 写锁冲突时稍后重试） */
  function execute<R = Record<string, unknown>>(query: SQL): Promise<R[]> {
    return central(async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await db().execute<R>(query)
        }
        catch (error) {
          if (attempt >= 100 || !isBusy(error))
            throw error
          await sleepFor(5 + Math.random() * 20)
        }
      }
    })
  }

  const available = (queue: string, now: number): SQL => sql`queue = ${queue} and ((reserved_at is null and available_at <= ${now}) or reserved_at <= ${now - retryAfter})`

  function parse(row: Record<string, unknown>): JobMessage {
    return typeof row.payload === 'string'
      ? JSON.parse(row.payload)
      : row.payload as JobMessage
  }

  /** PostgreSQL / MySQL：行锁 + SKIP LOCKED，并发的 worker 跳过已被锁住的行 */
  async function claimLocked(queue: string): Promise<Reserved | undefined> {
    return central(() => db().transaction(async () => {
      const now = Date.now()
      const [row] = await db().execute(sql`select id, payload, attempts from ${jobs} where ${available(queue, now)} order by id limit 1 for update skip locked`)
      if (!row)
        return undefined
      await db().execute(sql`update ${jobs} set reserved_at = ${now}, attempts = attempts + 1 where id = ${row.id}`)
      return {
        id: row.id as number,
        message: parse(row),
        attempt: Number(row.attempts) + 1,
        reservedAt: now,
      }
    }))
  }

  /** SQLite 系：单条 UPDATE … RETURNING 原子地领取（外层条件在写入时再检查一次） */
  async function claimAtomic(queue: string): Promise<Reserved | undefined> {
    const now = Date.now()
    const [row] = await execute(sql`update ${jobs} set reserved_at = ${now}, attempts = attempts + 1 where id = (select id from ${jobs} where ${available(queue, now)} order by id limit 1) and (reserved_at is null or reserved_at <= ${now - retryAfter}) returning id, payload, attempts`)
    return row && {
      id: row.id as number,
      message: parse(row),
      attempt: Number(row.attempts),
      reservedAt: now,
    }
  }

  async function claim(queues: string[]): Promise<Reserved | undefined> {
    const { dialect: kind } = await dialect()
    // 按优先级依次查看各队列
    for (const queue of queues) {
      const reserved = kind === 'sqlite'
        ? await claimAtomic(queue)
        : await claimLocked(queue)
      if (reserved)
        return reserved
    }
    return undefined
  }

  async function insert(message: JobMessage, delaySeconds: number): Promise<void> {
    const now = Date.now()
    await execute(sql`insert into ${jobs} (queue, payload, attempts, reserved_at, available_at, created_at) values (${message.queue}, ${JSON.stringify(message)}, ${message.attempts ?? 0}, ${null}, ${now + Math.max(0, Math.round(delaySeconds * 1000))}, ${now})`)
  }

  async function fail(message: JobMessage, attempt: number, error: unknown): Promise<void> {
    await execute(sql`insert into ${failedJobs} (uuid, connection, queue, payload, exception, failed_at) values (${message.id}, ${name}, ${message.queue}, ${JSON.stringify({ ...message, attempts: attempt })}, ${String((error as Error)?.stack ?? error)}, ${Date.now()})`)
  }

  async function settle(reserved: Reserved, consume: ConsumeOptions): Promise<void> {
    const result = await consume.process(reserved.message, reserved.attempt)
    const mine = sql`id = ${reserved.id} and reserved_at = ${reserved.reservedAt}`
    if (result.status === 'retry') {
      // 放回等待重试：attempts 已在领取时计入
      await execute(sql`update ${jobs} set reserved_at = ${null}, available_at = ${Date.now() + Math.round(result.delay * 1000)} where ${mine}`)
      return
    }
    if (result.status === 'failed')
      await fail(reserved.message, reserved.attempt, result.error)
    // ok / failed / released（released 时 QueueManager 已插入了新的一行）
    await execute(sql`delete from ${jobs} where ${mine}`)
  }

  function wakeAll(): void {
    for (const consumer of consumers)
      consumer.wake()
  }

  return {
    driver: 'database',
    async push(message, delaySeconds) {
      await insert(message, delaySeconds)
      wakeAll()
    },
    async consume(consume) {
      const concurrency = Math.max(1, consume.concurrency || 1)
      const inflight = new Set<Promise<void>>()
      // 对象属性：停止函数在循环之外修改它
      const state = { running: true }
      let wait = idleSleep
      let timer: ReturnType<typeof setTimeout> | undefined
      let wakeUp: (() => void) | undefined
      const wake = (): void => {
        clearTimeout(timer)
        wakeUp?.()
      }
      const pause = (ms: number): Promise<void> => new Promise<void>((resolve) => {
        wakeUp = resolve
        timer = setTimeout(resolve, ms)
      }).finally(() => {
        wakeUp = undefined
      })
      const loop = (async () => {
        while (state.running) {
          if (inflight.size >= concurrency) {
            // 并发已满：任一任务结束时被唤醒
            await pause(maxSleep)
            continue
          }
          let reserved: Reserved | undefined
          try {
            reserved = await claim(consume.queues)
          }
          catch (error) {
            options.logger?.error(`Queue connection "${name}": failed to reserve a job`, error)
          }
          if (!reserved) {
            // 空闲：等待 sleep，连续空闲时加倍（投递到本进程时立即唤醒）
            await pause(wait)
            wait = Math.min(wait * 2, maxSleep)
            continue
          }
          wait = idleSleep
          const task: Promise<void> = settle(reserved, consume)
            .catch(error => options.logger?.error(`Queue connection "${name}": failed to finish job ${reserved.message.id}`, error))
            .finally(() => {
              inflight.delete(task)
              wake()
            })
          inflight.add(task)
        }
      })()
      const consumer = {
        wake,
        // 停止领取新任务，等待执行中的任务完成（SIGTERM 时 worker.mjs 调用）
        stop: async (): Promise<void> => {
          state.running = false
          wake()
          await loop
          await Promise.all(inflight)
          consumers.delete(consumer)
        },
      }
      consumers.add(consumer)
      return consumer.stop
    },
    async failed() {
      const rows = await execute(sql`select uuid, queue, payload, exception, failed_at from ${failedJobs} order by id`)
      return rows.map((row): FailedJob => {
        const message = parse(row)
        return {
          id: String(row.uuid),
          job: message.job,
          queue: String(row.queue),
          payload: message.payload,
          error: String(row.exception),
          attempts: message.attempts,
          failedAt: Number(row.failed_at),
          ...(message.batch && {
            batch: message.batch,
          }),
          ...(message.chain && {
            chain: message.chain.id,
          }),
        }
      })
    },
    async retry(id) {
      const rows = await execute(id === undefined
        ? sql`select id, payload from ${failedJobs} order by id`
        : sql`select id, payload from ${failedJobs} where uuid = ${id}`)
      for (const row of rows) {
        // 重新开始计数：重试后的任务再次拥有完整的执行次数
        await insert({
          ...parse(row),
          attempts: 0,
          dispatchedAt: Date.now(),
        }, 0)
        await execute(sql`delete from ${failedJobs} where id = ${row.id}`)
      }
      if (rows.length)
        wakeAll()
      return rows.length
    },
    async forget(id) {
      const rows = await execute(sql`select id from ${failedJobs} where uuid = ${id}`)
      if (!rows.length)
        return false
      await execute(sql`delete from ${failedJobs} where uuid = ${id}`)
      return true
    },
    async flush() {
      const [row] = await execute(sql`select count(*) as count from ${failedJobs}`)
      await execute(sql`delete from ${failedJobs}`)
      return Number(row?.count ?? 0)
    },
    async counts(): Promise<QueueCounts> {
      const now = Date.now()
      // delayed 是 MySQL 的保留字：列别名加 _count
      const [row] = await execute(sql`select
        sum(case when reserved_at is null and available_at <= ${now} then 1 else 0 end) as ready_count,
        sum(case when reserved_at is null and available_at > ${now} then 1 else 0 end) as delayed_count,
        sum(case when reserved_at is not null then 1 else 0 end) as active_count
        from ${jobs}`)
      const [failed] = await execute(sql`select count(*) as count from ${failedJobs}`)
      return {
        waiting: Number(row?.ready_count ?? 0),
        delayed: Number(row?.delayed_count ?? 0),
        active: Number(row?.active_count ?? 0),
        failed: Number(failed?.count ?? 0),
      }
    },
    async close() {
      await Promise.all([...consumers].map(consumer => consumer.stop()))
    },
  }
}
