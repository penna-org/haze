import type { JobMiddleware } from '../src'
import { afterEach, describe, expect, it } from 'vitest'
import { defineJob, Queue, QueueManager, rateLimited, skipIf, throttlesExceptions, withoutOverlapping } from '../src'
import { bootQueue, redisConfig, redisUrl, sleep, waitFor } from './support/queue'

const log: string[] = []
afterEach(() => {
  log.length = 0
})

function concurrent(extra: Record<string, unknown> = {}) {
  return {
    queue: {
      default: 'memory',
      connections: {
        memory: { driver: 'memory', concurrency: 5 },
      },
      ...extra,
    },
  }
}

const Limited = defineJob({
  name: 'Limited',
  middleware: [
    rateLimited('api', { max: 2, per: 1 }),
  ],
  handle(payload: { n: number }, job) {
    log.push(`limited:${payload.n}:${job.attempt}:${Math.floor(Date.now() / 1000)}`)
  },
})

let running = 0
let peak = 0
const Exclusive = defineJob({
  name: 'Exclusive',
  middleware: [
    withoutOverlapping((payload: { user: number }) => `user:${payload.user}`, { releaseAfter: 0.05, expireAfter: '1m' }),
  ],
  async handle(payload: { user: number, n: number }) {
    running++
    peak = Math.max(peak, running)
    await sleep(60)
    running--
    log.push(`exclusive:${payload.user}:${payload.n}`)
  },
})

const Flaky = defineJob({
  name: 'Flaky',
  tries: 3,
  middleware: [
    throttlesExceptions({ max: 1, per: 1 }),
  ],
  handle(_payload: null, job) {
    log.push(`flaky:${job.attempt}:${Date.now()}`)
    throw new Error('upstream down')
  },
})

let releases = 0
const Releasing = defineJob({
  name: 'Releasing',
  tries: 1,
  handle(_payload: null, job) {
    log.push(`releasing:${job.attempt}`)
    if (releases++ < 2)
      job.release(0.05)
  },
})

function order(name: string): JobMiddleware {
  return async (_payload, _job, next) => {
    log.push(`${name}:before`)
    const result = await next()
    log.push(`${name}:after`)
    return result
  }
}

const Wrapped = defineJob({
  name: 'Wrapped',
  middleware: [
    order('job'),
    skipIf((payload: { skip?: boolean }) => !!payload.skip),
  ],
  handle(payload: { skip?: boolean }) {
    log.push(`wrapped:${payload.skip ?? false}`)
  },
})

const jobs = [
  Limited,
  Exclusive,
  Flaky,
  Releasing,
  Wrapped,
]

afterEach(() => {
  running = 0
  peak = 0
  releases = 0
})

describe('job middleware (memory)', () => {
  it('rateLimited releases jobs over the limit to the next window without using up attempts', async () => {
    await bootQueue(jobs, concurrent())
    // 窗口刚开始时投递，避免跨窗口
    await sleep(1000 - Date.now() % 1000 + 10)
    await Promise.all(Array.from({ length: 5 }, (_, n) => Limited.dispatch({ n })))
    await Queue.idle()
    expect(log).toHaveLength(5)
    const windows = new Map<string, number>()
    for (const line of log) {
      const [, , attempt, second] = line.split(':')
      expect(attempt).toBe('1')
      windows.set(second!, (windows.get(second!) ?? 0) + 1)
    }
    expect([
      ...windows.values(),
    ].every(count => count <= 2)).toBe(true)
    expect(windows.size).toBe(3)
  })

  it('withoutOverlapping runs one job per key at a time and releases the others', async () => {
    await bootQueue(jobs, concurrent())
    await Promise.all([
      Exclusive.dispatch({ user: 1, n: 1 }),
      Exclusive.dispatch({ user: 1, n: 2 }),
      Exclusive.dispatch({ user: 1, n: 3 }),
    ])
    await Queue.idle()
    expect(peak).toBe(1)
    expect(log.sort()).toEqual(['exclusive:1:1', 'exclusive:1:2', 'exclusive:1:3'])

    peak = 0
    log.length = 0
    await Promise.all([
      Exclusive.dispatch({ user: 1, n: 1 }),
      Exclusive.dispatch({ user: 2, n: 1 }),
    ])
    await Queue.idle()
    // 不同的键可以并发
    expect(peak).toBe(2)
  })

  it('throttlesExceptions defers attempts after too many exceptions in the window', async () => {
    await bootQueue(jobs)
    const started = Date.now()
    await Flaky.dispatch(null)
    await Queue.idle()
    const runs = log.map(line => Number(line.split(':')[2]))
    expect(log.map(line => line.split(':')[1])).toEqual(['1', '2', '3'])
    // 第 1 次异常后熔断：第 2 次执行被推迟到窗口结束
    expect(runs[1]! - started).toBeGreaterThanOrEqual(900)
    expect(await Queue.failed()).toHaveLength(1)
  })

  it('job.release() puts the job back without counting an attempt', async () => {
    await bootQueue(jobs)
    await Releasing.dispatch(null)
    await Queue.idle()
    expect(log).toEqual(['releasing:1', 'releasing:1', 'releasing:1'])
    expect(await Queue.failed()).toEqual([])
  })

  it('runs global middleware first, then the job middleware; skipIf skips the handler', async () => {
    await bootQueue(jobs, concurrent({
      middleware: [
        order('global'),
      ],
    }))
    await Wrapped.dispatch({})
    await Queue.idle()
    expect(log).toEqual([
      'global:before',
      'job:before',
      'wrapped:false',
      'job:after',
      'global:after',
    ])
    log.length = 0
    await Wrapped.dispatch({ skip: true })
    await Queue.idle()
    expect(log).toEqual([
      'global:before',
      'job:before',
      'job:after',
      'global:after',
    ])
  })

  it('drops released jobs on the sync connection and re-records them with Queue.fake()', async () => {
    const app = await bootQueue(jobs, {
      queue: { default: 'sync' },
    })
    await Releasing.dispatch(null)
    expect(log).toEqual(['releasing:1'])
    log.length = 0
    const fake = app.make(QueueManager).fake()
    await Releasing.dispatch(null)
    const [result] = await fake.drain()
    expect(result).toEqual({ status: 'released', delay: 0.05 })
    fake.assertDispatched(Releasing)
  })
})

describe.runIf(redisUrl)('job middleware (redis)', () => {
  it('releases through BullMQ with a fresh job id and keeps the attempt count', async () => {
    const app = await bootQueue(jobs, redisConfig())
    const worker = await app.make(QueueManager).work({ concurrency: 3 })
    try {
      await Releasing.dispatch(null)
      await Promise.all([
        Exclusive.dispatch({ user: 1, n: 1 }),
        Exclusive.dispatch({ user: 1, n: 2 }),
      ])
      await waitFor(() => log.filter(line => line.startsWith('releasing')).length === 3 && log.filter(line => line.startsWith('exclusive')).length === 2)
      expect(log.filter(line => line.startsWith('releasing'))).toEqual(['releasing:1', 'releasing:1', 'releasing:1'])
      expect(peak).toBe(1)
    }
    finally {
      await worker.stop()
    }
  }, 30_000)
})
