import type { RedisConnectionName, RedisConnectionRef } from '../../redis/config'
import type { RedisManager } from '../../redis/manager'
import type { FailedJob, JobMessage } from '../job'
import type { ConsumeOptions, QueueDriver } from './types'
import { redisTarget, useRedisManager } from '../../redis/manager'

export interface RedisQueueConfig extends RedisConnectionRef {
  driver: 'redis'
  /**
   * config/redis.ts 中的连接名，默认为其 default 连接（REDIS_URL）。
   * BullMQ 不允许 ioredis 的 keyPrefix：连接上的 keyPrefix 会被去掉，键前缀请用 prefix
   */
  connection?: RedisConnectionName
  /** 内联地址（旧写法）：redis://…，设置后不使用命名连接 */
  url?: string
  /** BullMQ 键前缀，默认 haze（Cluster 需要带哈希标签，如 `{haze}`） */
  prefix?: string
  /** 要管理的队列（queue:failed / retry 遍历），默认 ['default'] */
  queues?: string[]
  /** 完成后保留的任务数，默认 1000 */
  keepCompleted?: number
}

type BullMQ = typeof import('bullmq')

async function loadBullMQ(): Promise<BullMQ> {
  try {
    return await import('bullmq')
  }
  catch (error) {
    throw new Error('Queue driver "redis" requires bullmq (and ioredis). Install with: pnpm add bullmq ioredis', { cause: error })
  }
}

/**
 * BullMQ 驱动：延迟、重试与退避、执行中进程崩溃后的恢复（stalled）、并发、失败任务保留。
 * 重试由 BullMQ 调度：attempts 为任务的 tries，退避按任务定义计算。
 */
export function redisQueue(config: RedisQueueConfig, redis: RedisManager = useRedisManager()): QueueDriver {
  const prefix = config.prefix ?? 'haze'
  const target = redisTarget(config)
  const queues = new Map<string, import('bullmq').Queue>()
  const workers: import('bullmq').Worker[] = []
  // 连接选项（或 Cluster / 自定义客户端的专用实例），Queue 与 Worker 共用这一份设置
  let resolved: ReturnType<RedisManager['bullmq']> | undefined

  const connectionOptions = async (): Promise<{ connection: unknown, prefix: string }> => ({
    // Worker 的阻塞命令要求 maxRetriesPerRequest 为 null（RedisManager.bullmq 已设置）
    connection: (await (resolved ??= redis.bullmq(target))).connection,
    prefix,
  })

  const queue = async (queueName: string): Promise<import('bullmq').Queue> => {
    let instance = queues.get(queueName)
    if (!instance) {
      const { Queue } = await loadBullMQ()
      const options = await connectionOptions()
      // 等待期间可能已由并发的调用创建
      instance = queues.get(queueName) ?? new Queue(queueName, options as never)
      queues.set(queueName, instance)
    }
    return instance
  }

  const managed = async (): Promise<import('bullmq').Queue[]> => Promise.all([
    ...new Set([
      ...(config.queues ?? ['default']),
      ...queues.keys(),
    ]),
  ].map(queue))

  const toFailed = (job: import('bullmq').Job): FailedJob => {
    const message = job.data as JobMessage
    return {
      id: String(job.id),
      job: message.job,
      queue: job.queueName,
      payload: message.payload,
      error: job.failedReason,
      attempts: (message.attempts ?? 0) + job.attemptsMade,
      failedAt: job.finishedOn ?? Date.now(),
      ...(message.batch && {
        batch: message.batch,
      }),
      ...(message.chain && {
        chain: message.chain.id,
      }),
    }
  }

  const find = async (id: string): Promise<import('bullmq').Job | undefined> => {
    for (const instance of await managed()) {
      const job = await instance.getJob(id)
      if (job)
        return job
    }
    return undefined
  }

  return {
    driver: 'redis',
    async push(message, delaySeconds) {
      const tries = (message as JobMessage & { tries?: number }).tries ?? 1
      // release() 放回的消息：原任务仍在执行中（jobId 不能重复），换一个 jobId；已用掉的次数记在 attempts 中
      await (await queue(message.queue)).add(message.job, message, {
        jobId: message.releases
          ? `${message.id}-r${message.releases}`
          : message.id,
        delay: Math.max(0, Math.round(delaySeconds * 1000)),
        attempts: Math.max(1, tries - (message.attempts ?? 0)),
        backoff: { type: 'haze' },
        removeOnComplete: config.keepCompleted ?? 1000,
        removeOnFail: false,
      })
    },
    async consume(options: ConsumeOptions) {
      const { Worker } = await loadBullMQ()
      // 本次失败的重试等待（中间件可能覆盖了任务的 backoff），backoffStrategy 优先使用
      const delays = new Map<string, number>()
      for (const queueName of options.queues) {
        const worker = new Worker(queueName, async (job) => {
          const message = job.data as JobMessage
          const result = await options.process(message, (message.attempts ?? 0) + job.attemptsMade + 1)
          // 抛出后由 BullMQ 按 attempts / backoffStrategy 重试或移入失败集合；released 时新消息已投递，原任务按完成处理
          if (result.status === 'retry' || result.status === 'failed') {
            if (result.status === 'retry')
              delays.set(String(job.id), result.delay)
            throw result.error instanceof Error
              ? result.error
              : new Error(String(result.error))
          }
        }, {
          ...await connectionOptions(),
          concurrency: options.concurrency,
          settings: {
            backoffStrategy: (attemptsMade: number, _type: string | undefined, _error: Error | undefined, job: import('bullmq').Job | undefined) => {
              if (!job)
                return 0
              const delay = delays.get(String(job.id))
              delays.delete(String(job.id))
              const message = job.data as JobMessage
              return (delay ?? options.backoff(message, (message.attempts ?? 0) + attemptsMade)) * 1000
            },
          },
        } as never)
        worker.on('error', () => {})
        workers.push(worker)
      }
      await Promise.all(workers.map(worker => worker.waitUntilReady()))
      return async () => {
        await Promise.all(workers.splice(0).map(worker => worker.close()))
      }
    },
    async failed() {
      const jobs = (await Promise.all((await managed()).map(instance => instance.getFailed()))).flat()
      return jobs.filter(Boolean).map(toFailed).sort((a, b) => a.failedAt - b.failedAt)
    },
    async retry(id) {
      const jobs = id === undefined
        ? (await Promise.all((await managed()).map(instance => instance.getFailed()))).flat()
        : [await find(id)].filter(job => job && job.failedReason !== undefined)
      // 重新开始计数：重试后的任务再次拥有完整的执行次数
      await Promise.all(jobs.map(job => job!.retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true } as never)))
      return jobs.length
    },
    async forget(id) {
      const job = await find(id)
      if (!job)
        return false
      await job.remove()
      return true
    },
    async flush() {
      let count = 0
      for (const instance of await managed())
        count += (await instance.clean(0, 0, 'failed')).length
      return count
    },
    async counts() {
      const counts = {
        waiting: 0,
        delayed: 0,
        active: 0,
        failed: 0,
      }
      for (const instance of await managed()) {
        const item = await instance.getJobCounts('waiting', 'delayed', 'active', 'failed')
        counts.waiting += item.waiting ?? 0
        counts.delayed += item.delayed ?? 0
        counts.active += item.active ?? 0
        counts.failed += item.failed ?? 0
      }
      return counts
    },
    async close() {
      await Promise.all(workers.splice(0).map(worker => worker.close()))
      await Promise.all([
        ...queues.values(),
      ].map(instance => instance.close()))
      queues.clear()
      const connection = resolved
      resolved = undefined
      await (await connection?.catch(() => undefined))?.close()
    },
  }
}
