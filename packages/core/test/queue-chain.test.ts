import { afterEach, describe, expect, it } from 'vitest'
import { defineJob, Queue, QueueManager, Tenancy } from '../src'
import { bootQueue, redisConfig, redisUrl, waitFor } from './support/queue'

const log: string[] = []

const Step = defineJob({
  name: 'Step',
  tries: 2,
  async handle(payload: { n: number, fail?: 'once' | 'always' }, job) {
    if (payload.fail === 'always' || (payload.fail === 'once' && job.attempt === 1))
      throw new Error(`step ${payload.n} failed`)
    log.push(`step:${payload.n}:${job.attempt}:${Tenancy.key() ?? 'central'}`)
  },
})

/** 只执行一次（sync 连接不重试） */
const Single = defineJob({
  name: 'Single',
  handle(payload: { n: number, fail?: boolean }) {
    if (payload.fail)
      throw new Error(`single ${payload.n} failed`)
    log.push(`single:${payload.n}`)
  },
})

const Cleanup = defineJob({
  name: 'Cleanup',
  handle(payload: { reason: string }) {
    log.push(`cleanup:${payload.reason}`)
  },
})

afterEach(() => {
  log.length = 0
})

describe('queue.chain (memory)', () => {
  it('runs the jobs one after another, each only after the previous one succeeded', async () => {
    await bootQueue([Step, Cleanup])
    const result = await Queue.chain([
      Step.with({ n: 1 }),
      Step.with({ n: 2, fail: 'once' }),
      Step.with({ n: 3 }),
    ]).dispatch()
    expect(result.skipped).toBe(false)
    expect(result.chainId).toMatch(/^[0-9a-f-]{36}$/)
    await Queue.idle()
    // 第 2 个任务重试一次后成功，链继续
    expect(log).toEqual(['step:1:1:central', 'step:2:2:central', 'step:3:1:central'])
  })

  it('drops the rest of the chain when a job fails for good and runs catch', async () => {
    await bootQueue([Step, Cleanup])
    const errors: string[] = []
    await Queue.chain([
      Step.with({ n: 1 }),
      Step.with({ n: 2, fail: 'always' }),
      Step.with({ n: 3 }),
    ])
      .catch(error => void errors.push((error as Error).message))
      .catch(Cleanup.with({ reason: 'chain' }))
      .dispatch()
    await Queue.idle()
    expect(log).toEqual(['step:1:1:central', 'cleanup:chain'])
    expect(errors).toEqual(['step 2 failed'])
    const failed = await Queue.failed()
    expect(failed).toHaveLength(1)
    expect(failed[0]!.chain).toMatch(/^[0-9a-f-]{36}$/)
  })

  it('runs catch when the last job of the chain fails', async () => {
    await bootQueue([Step, Cleanup])
    await Queue.chain([
      Step.with({ n: 1 }),
      Step.with({ n: 2, fail: 'always' }),
    ]).catch(Cleanup.with({ reason: 'last' })).dispatch()
    await Queue.idle()
    expect(log).toEqual(['step:1:1:central', 'cleanup:last'])
  })

  it('applies chain defaults while per-job options win', async () => {
    const app = await bootQueue([Step, Cleanup], {
      queue: {
        default: 'memory',
        connections: {
          memory: { driver: 'memory' },
        },
      },
    })
    const fake = app.make(QueueManager).fake()
    await Queue.chain([
      Step.with({ n: 1 }),
      Step.with({ n: 2 }).onQueue('high').delay('1m'),
    ]).onQueue('media').dispatch()
    expect(fake.dispatched).toMatchObject([
      { job: 'Step', queue: 'media', delay: 0 },
    ])
    await fake.drain()
    expect(fake.dispatched).toMatchObject([
      {
        job: 'Step',
        queue: 'high',
        delay: 60,
        payload: { n: 2 },
      },
    ])
    fake.assertChained(['Step', Step])
    fake.assertChained([
      Step.with({ n: 1 }),
      Step.with({ n: 2 }),
    ])
    expect(() => fake.assertChained([
      Step.with({ n: 1 }),
      Step.with({ n: 3 }),
    ])).toThrow(/Expected a chain/)
    expect(() => fake.assertChained([Step])).toThrow(/Expected a chain/)
  })

  it('keeps the tenant through the whole chain', async () => {
    await bootQueue([Step, Cleanup], {
      tenancy: {
        find: (key: string) => ({ id: key }),
      },
    })
    await Tenancy.run('acme', () => Queue.chain([
      Step.with({ n: 1 }),
      Step.with({ n: 2 }),
    ]).dispatch())
    await Queue.idle()
    expect(log).toEqual(['step:1:1:acme', 'step:2:1:acme'])
  })

  it('runs chains inline on the sync connection and throws when the first job fails', async () => {
    await bootQueue([Single, Cleanup], {
      queue: { default: 'sync' },
    })
    await Queue.chain([
      Single.with({ n: 1 }),
      Single.with({ n: 2 }),
    ]).dispatch()
    expect(log).toEqual(['single:1', 'single:2'])
    log.length = 0
    await expect(Queue.chain([
      Single.with({ n: 1, fail: true }),
      Single.with({ n: 2 }),
    ]).catch(Cleanup.with({ reason: 'sync' })).dispatch()).rejects.toThrow(/single 1 failed/)
    expect(log).toEqual(['cleanup:sync'])
  })

  it('rejects function callbacks on connections whose worker runs in another process', async () => {
    await bootQueue([Step, Cleanup], {
      queue: {
        default: 'memory',
        connections: {
          redis: { driver: 'redis', url: 'redis://127.0.0.1:1' },
        },
      },
    })
    await expect(Queue.chain([
      Step.with({ n: 1 }),
    ]).onConnection('redis').catch(() => {}).dispatch()).rejects.toThrow(/cannot run function callbacks/)
    expect(() => Queue.chain([])).toThrow(/at least one job/)
  })
})

describe.runIf(redisUrl)('queue.chain (redis)', () => {
  it('continues the chain across the BullMQ worker and runs a job callback on failure', async () => {
    const app = await bootQueue([Step, Cleanup], redisConfig())
    const worker = await app.make(QueueManager).work({ concurrency: 2 })
    try {
      await Queue.chain([
        Step.with({ n: 1 }),
        Step.with({ n: 2, fail: 'once' }),
        Step.with({ n: 3 }),
      ]).dispatch()
      await waitFor(() => log.length >= 3)
      expect(log).toEqual(['step:1:1:central', 'step:2:2:central', 'step:3:1:central'])
      log.length = 0
      await Queue.chain([
        Step.with({ n: 1, fail: 'always' }),
        Step.with({ n: 2 }),
      ]).catch(Cleanup.with({ reason: 'redis' })).dispatch()
      await waitFor(() => log.includes('cleanup:redis'))
      expect(log).toEqual(['cleanup:redis'])
    }
    finally {
      await worker.stop()
    }
  }, 30_000)
})
