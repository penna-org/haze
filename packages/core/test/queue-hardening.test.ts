import type { JobMessage, QueueDriver } from '../src'
import { afterEach, describe, expect, it } from 'vitest'
import { defineJob, Maintenance, Queue, QueueManager, registerQueueDriver } from '../src'
import { memoryStore } from '../src/cache/drivers/memory'
import { bootQueue, redisConfig, redisUrl, sleep, waitFor } from './support/queue'

const log: string[] = []
afterEach(() => {
  log.length = 0
})

const Step = defineJob({
  name: 'Step',
  handle: (payload: { n: number }, job) => void log.push(`step:${payload.n}:${job.attempt}`),
})

const Mark = defineJob({
  name: 'Mark',
  handle: (payload: { label: string }) => void log.push(`mark:${payload.label}`),
})

/** 第 failAt 次 push 抛错的驱动（不消费） */
function flakyDriver(pushed: JobMessage[], failAt: () => number): QueueDriver {
  let calls = 0
  return {
    driver: 'flaky',
    async push(message) {
      if (++calls === failAt())
        throw new Error('queue unavailable')
      pushed.push(message)
    },
    consume: async () => async () => {},
    failed: async () => [],
    retry: async () => 0,
    forget: async () => false,
    flush: async () => 0,
    close: async () => {},
  }
}

describe('batch dispatch failures', () => {
  it('records undelivered jobs as failed so the batch can finish, and rethrows', async () => {
    const pushed: JobMessage[] = []
    let failAt = 3
    registerQueueDriver('flaky', () => flakyDriver(pushed, () => failAt))
    const app = await bootQueue([Step, Mark], {
      queue: {
        default: 'flaky',
        connections: {
          flaky: { driver: 'flaky' },
        },
      },
    })
    const callbacks = (): string[] => pushed.filter(message => message.job === 'Mark').map(message => (message.payload as { label: string }).label)
    const pending = Queue.batch(Array.from({ length: 5 }, (_, n) => Step.with({ n })))
      .allowFailures()
      .catch(Mark.with({ label: 'catch' }))
      .finally(Mark.with({ label: 'finally' }))
    await expect(pending.dispatch()).rejects.toThrow('queue unavailable')
    const steps = pushed.filter(message => message.job === 'Step')
    expect(steps).toHaveLength(2)
    const manager = app.make(QueueManager)
    const id = steps[0]!.batch!
    // 3 个没投递出去的任务计为失败：已投递的 2 个完成后批次结束
    expect(await manager.findBatch(id)).toMatchObject({
      total: 5,
      failed: 3,
      pending: 2,
      finished: false,
    })
    expect(callbacks()).toEqual(['catch'])
    for (const message of steps)
      await manager.process(message, 1)
    expect(await manager.findBatch(id)).toMatchObject({
      total: 5,
      failed: 3,
      pending: 0,
      finished: true,
    })
    expect(callbacks()).toEqual(['catch', 'finally'])

    // Batch.add()：同样补偿
    pushed.length = 0
    failAt = -1
    const batch = await Queue.batch([
      Step.with({ n: 10 }),
    ]).allowFailures().dispatch()
    failAt = 8
    await expect(batch.add([
      Step.with({ n: 11 }),
      Step.with({ n: 12 }),
    ])).rejects.toThrow('queue unavailable')
    expect(await batch.fresh()).toMatchObject({ total: 3, failed: 1, pending: 2 })
  })
})

describe('worker stop during maintenance', () => {
  it('stop() returns while a picked job waits for maintenance to end, and the job is released', async () => {
    const app = await bootQueue([Step], {
      app: {
        key: 'k'.repeat(32),
      },
      cache: {
        default: 'shared',
        stores: {
          shared: {
            driver: 'custom',
            store: memoryStore(`queue-hardening-${Math.random()}`),
          },
        },
      },
      maintenance: { interval: 0, workerSleep: 20 },
      queue: {
        default: 'memory',
        connections: {
          memory: { driver: 'memory' },
        },
      },
    })
    const manager = app.make(QueueManager)
    const worker = await manager.work()
    await Maintenance.down()
    await Step.dispatch({ n: 1 })
    await sleep(100)
    expect(log).toEqual([])
    const started = Date.now()
    await worker.stop()
    expect(Date.now() - started).toBeLessThan(1000)
    expect(log).toEqual([])

    // 任务被放回队列，没有消耗执行次数
    await Maintenance.up()
    const again = await manager.work()
    await waitFor(() => log.length === 1, 3000)
    expect(log).toEqual(['step:1:1'])
    await again.stop()
  })
})

describe.runIf(redisUrl)('redis worker (BullMQ)', () => {
  const Unique = defineJob({
    name: 'Unique',
    unique: { for: '10m' },
    handle: () => void log.push('unique:run'),
    failed: (_payload: { n: number }, error) => void log.push(`unique:failed:${(error as Error).message}`),
  })

  it('settles jobs that BullMQ fails without calling the processor (stalled beyond the limit)', async () => {
    const config = redisConfig() as { queue: { connections: { redis: { prefix: string } } } }
    const app = await bootQueue([Unique, Mark], config)
    const batch = await Queue.batch([
      Unique.with({ n: 1 }),
    ])
      .catch(Mark.with({ label: 'catch' }))
      .finally(Mark.with({ label: 'finally' }))
      .dispatch()
    const first = await Unique.with({ n: 2 }).dispatch()
    expect((await Unique.with({ n: 2 }).dispatch()).skipped).toBe(true)

    // 与 BullMQ 判定 stalled 超限时相同：给任务写入 deferred failure，worker 领取后不调用处理函数直接移入失败集合
    const { Redis } = await import('ioredis')
    const raw = new Redis(redisUrl!)
    try {
      const prefix = config.queue.connections.redis.prefix
      const keys = (await raw.keys(`${prefix}:default:*`)).filter(key => /:[0-9a-f-]{36}$/.test(key))
      expect(keys).toHaveLength(2)
      for (const key of keys)
        await raw.hset(key, 'defa', 'job stalled more than allowable limit')
    }
    finally {
      await raw.quit()
    }
    const worker = await app.make(QueueManager).work()
    try {
      await waitFor(async () => (await batch.fresh()).finished && log.length >= 4)
      expect(log.filter(item => item.startsWith('unique'))).toEqual([
        'unique:failed:job stalled more than allowable limit',
        'unique:failed:job stalled more than allowable limit',
      ])
      expect(await batch.fresh()).toMatchObject({ failed: 1, finished: true })
      expect(log.filter(item => item.startsWith('mark')).sort()).toEqual(['mark:catch', 'mark:finally'])
      // 唯一锁已释放：可以再次投递
      expect(first.skipped).toBe(false)
      expect((await Unique.with({ n: 2 }).dispatch()).skipped).toBe(false)
      // 经过处理函数的失败不重复收尾（failed() 各只调用一次）
      await sleep(300)
      expect(log.filter(item => item.startsWith('unique:failed'))).toHaveLength(2)
    }
    finally {
      await worker.stop()
    }
  }, 30_000)
})
