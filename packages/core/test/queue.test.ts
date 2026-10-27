import type { ApplicationOptions } from '../src'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, defineJob, Queue, QueueManager } from '../src'

const log: string[] = []
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const Greet = defineJob({
  async handle(payload: { name: string }, job) {
    log.push(`greet:${payload.name}:${job.attempt}`)
  },
})

let flakyFailures = 0
const Flaky = defineJob({
  tries: 3,
  async handle(payload: { id: number }, job) {
    if (job.attempt <= flakyFailures)
      throw new Error(`boom ${job.attempt}`)
    log.push(`flaky:${payload.id}:${job.attempt}`)
  },
  failed(payload, error) {
    log.push(`failed:${payload.id}:${(error as Error).message}`)
  },
})

const Slow = defineJob({
  timeout: 1,
  async handle(_payload: null, job) {
    await sleep(1500)
    log.push(`slow:${job.signal.aborted}`)
  },
  failed: () => void log.push('slow:failed'),
})

const Named = defineJob({
  name: 'custom-name',
  queue: 'emails',
  handle: () => void log.push('named'),
})

let app: Awaited<ReturnType<typeof createApplication>> | undefined
afterEach(async () => {
  await app?.dispose()
  app = undefined
  log.length = 0
  flakyFailures = 0
})

async function boot(queue: Record<string, unknown> = {}, options: ApplicationOptions = {}) {
  app = await createApplication({
    mode: 'test',
    env: false,
    // 与 import.meta.glob 相同的模块记录：文件名即任务名
    jobs: {
      '/app/job/Greet.ts': { default: Greet },
      '/app/job/Flaky.ts': { default: Flaky },
      '/app/job/Slow.ts': { default: Slow },
      '/app/job/Named.ts': { default: Named },
    },
    config: {
      logger: { level: 'silent' },
      queue,
    },
    ...options,
  })
  return app
}

describe('queue (memory)', () => {
  it('registers jobs by file name or explicit name and processes them in-process', async () => {
    const instance = await boot()
    expect([
      ...instance.make(QueueManager).jobs().keys(),
    ]).toEqual([
      'Flaky',
      'Greet',
      'custom-name',
      'Slow',
    ])
    await Greet.dispatch({ name: 'Ada' })
    await Queue.dispatch('Greet', { name: 'Bob' })
    await Named.dispatch(null as never)
    await Queue.idle()
    expect(log.sort()).toEqual(['greet:Ada:1', 'greet:Bob:1', 'named'])
  })

  it('retries failed attempts and calls failed() after the last one', async () => {
    await boot()
    flakyFailures = 2
    await Flaky.dispatch({ id: 1 })
    await Queue.idle()
    expect(log).toEqual(['flaky:1:3'])

    flakyFailures = 5
    await Flaky.dispatch({ id: 2 })
    await Queue.idle()
    expect(log).toEqual(['flaky:1:3', 'failed:2:boom 3'])
    const failed = await Queue.failed()
    expect(failed).toMatchObject([
      {
        job: 'Flaky',
        payload: { id: 2 },
        attempts: 3,
      },
    ])
    expect(failed[0].error).toContain('boom 3')

    // 重新投递失败任务
    flakyFailures = 0
    expect(await Queue.retry()).toBe(1)
    await Queue.idle()
    expect(log.at(-1)).toBe('flaky:2:1')
    expect(await Queue.failed()).toEqual([])
  })

  it('waits for backoff and delays', async () => {
    await boot()
    const Backoff = defineJob({
      name: 'backoff',
      tries: 2,
      backoff: [1],
      handle: (_: null, job) => {
        log.push(`${job.attempt}@${Date.now()}`)
        if (job.attempt === 1)
          throw new Error('again')
      },
    })
    app!.make(QueueManager).register(Backoff)
    const started = Date.now()
    await Backoff.dispatch(null)
    await Greet.dispatch({ name: 'later' }, { delay: 1 })
    await Queue.idle()
    const [first, second] = log.filter(item => item.includes('@')).map(item => Number(item.split('@')[1]))
    expect(second - first).toBeGreaterThanOrEqual(950)
    expect(log).toContain('greet:later:1')
    expect(Date.now() - started).toBeGreaterThanOrEqual(950)
  })

  it('fails jobs that exceed their timeout and aborts the signal', async () => {
    await boot()
    await Slow.dispatch(null)
    await Queue.idle()
    expect(log).toContain('slow:failed')
    expect((await Queue.failed())[0].error).toContain('timed out after 1s')
    await sleep(600)
    expect(log).toContain('slow:true')
  })

  it('forgets and flushes failed jobs, and rejects unknown jobs', async () => {
    const instance = await boot()
    flakyFailures = 5
    await Flaky.dispatch({ id: 1 })
    await Flaky.dispatch({ id: 2 })
    await Queue.idle()
    const [first] = await Queue.failed()
    expect(await instance.make(QueueManager).forget(first.id)).toBe(true)
    expect(await instance.make(QueueManager).flush()).toBe(1)
    await expect(Queue.dispatch('missing', {})).rejects.toThrow('Unknown job "missing"')
    const unregistered = defineJob({
      handle: () => {},
    })
    await expect(unregistered.dispatch(null)).rejects.toThrow('not registered')
  })
})

describe('queue (sync)', () => {
  it('runs jobs immediately and throws when they fail', async () => {
    await boot({ default: 'sync' })
    await Greet.dispatch({ name: 'now' })
    expect(log).toEqual(['greet:now:1'])
    flakyFailures = 1
    await expect(Flaky.dispatch({ id: 9 })).rejects.toThrow('boom 1')
  })
})

describe('queue.fake()', () => {
  it('records dispatches for assertions and drains them on demand', async () => {
    await boot()
    const fake = Queue.fake()
    await Greet.dispatch({ name: 'Ada' }, { delay: '10m', queue: 'low' })
    await Named.dispatch(null as never)
    fake.assertDispatched(Greet)
    fake.assertDispatched(Greet, payload => payload.name === 'Ada')
    fake.assertNotDispatched(Flaky)
    fake.assertCount(2)
    expect(fake.dispatched[0]).toMatchObject({ job: 'Greet', queue: 'low', delay: 600 })
    expect(() => fake.assertDispatched(Greet, payload => payload.name === 'Bob')).toThrow('matching payload')
    expect(log).toEqual([])
    expect(await fake.drain()).toEqual([
      { status: 'ok' },
      { status: 'ok' },
    ])
    expect(log).toEqual(['greet:Ada:1', 'named'])
  })
})

// 真实 Redis（BullMQ）：THINK_TEST_REDIS_URL=redis://127.0.0.1:6379
describe.runIf(process.env.THINK_TEST_REDIS_URL)('queue (redis / BullMQ)', () => {
  const connection = () => ({
    default: 'redis',
    connections: {
      redis: {
        driver: 'redis',
        url: process.env.THINK_TEST_REDIS_URL,
        prefix: `test-${crypto.randomUUID()}`,
        queues: ['default', 'emails'],
      },
    },
  })

  async function waitFor(check: () => boolean | Promise<boolean>, timeout = 15_000) {
    const start = Date.now()
    while (!(await check())) {
      if (Date.now() - start > timeout)
        throw new Error('Timed out')
      await sleep(50)
    }
  }

  it('distributes jobs across two workers, each job processed exactly once', async () => {
    const queue = connection()
    const producer = await boot(queue)
    // 两个“实例”：各自的应用与 Worker，共用同一个 Redis
    const second = await createApplication({
      mode: 'test',
      env: false,
      jobs: {
        '/app/job/Greet.ts': { default: Greet },
      },
      config: {
        logger: { level: 'silent' },
        queue,
      },
    })
    const workers = [
      await producer.make(QueueManager).work({ concurrency: 3 }),
      await second.make(QueueManager).work({ concurrency: 3 }),
    ]
    try {
      await Promise.all(Array.from({ length: 30 }, (_, index) => Greet.dispatch({ name: `n${index}` })))
      await waitFor(() => log.length >= 30)
      await sleep(300)
      expect(log).toHaveLength(30)
      expect(new Set(log).size).toBe(30)
    }
    finally {
      await Promise.all(workers.map(worker => worker.stop()))
      await second.dispose()
    }
  }, 30_000)

  it('retries with the job backoff, keeps failed jobs and retries them', async () => {
    const instance = await boot(connection())
    const worker = await instance.make(QueueManager).work({
      queues: ['default', 'emails'],
    })
    try {
      flakyFailures = 1
      const started = Date.now()
      await Flaky.dispatch({ id: 1 })
      await waitFor(() => log.includes('flaky:1:2'))

      flakyFailures = 5
      await Flaky.dispatch({ id: 2 })
      await waitFor(() => log.includes('failed:2:boom 3'))
      await waitFor(async () => (await Queue.failed()).length === 1)
      const [failed] = await Queue.failed()
      expect(failed).toMatchObject({
        job: 'Flaky',
        queue: 'default',
        payload: { id: 2 },
        attempts: 3,
      })

      flakyFailures = 0
      expect(await Queue.retry(failed.id)).toBe(1)
      await waitFor(() => log.includes('flaky:2:1'))

      // 延迟任务与其它队列
      await Greet.dispatch({ name: 'delayed' }, { delay: 1 })
      await Named.dispatch(null as never)
      await waitFor(() => log.includes('greet:delayed:1') && log.includes('named'))
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000)
    }
    finally {
      await worker.stop()
    }
  }, 30_000)
})
