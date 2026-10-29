import type { Batch } from '../src'
import { afterEach, describe, expect, it } from 'vitest'
import { defineJob, Queue, QueueManager } from '../src'
import { bootQueue, redisConfig, redisUrl, sleep, waitFor } from './support/queue'

const log: string[] = []

const Import = defineJob({
  name: 'Import',
  async handle(payload: { n: number, fail?: boolean, wait?: number, more?: number }, job) {
    await sleep(payload.wait ?? Math.random() * 10)
    if (job.batch()?.cancelled) {
      log.push(`import:${payload.n}:cancelled`)
      return
    }
    if (payload.fail)
      throw new Error(`import ${payload.n} failed`)
    // 在批次中追加任务
    if (payload.more)
      await job.batch()!.add(Import.with({ n: payload.more }))
    log.push(`import:${payload.n}`)
  },
})

const Notify = defineJob({
  name: 'Notify',
  async handle(payload: { label: string }, job) {
    const batch = await job.batch()?.fresh()
    log.push(`notify:${payload.label}:${batch?.processed}/${batch?.total}`)
  },
})

afterEach(() => {
  log.length = 0
})

function counters() {
  const calls = {
    then: 0,
    catch: 0,
    finally: 0,
    errors: [] as string[],
  }
  return {
    calls,
    then: () => void calls.then++,
    catch: (_batch: Batch, error: unknown) => {
      calls.catch++
      calls.errors.push((error as Error).message)
    },
    finally: () => void calls.finally++,
  }
}

const concurrent = {
  queue: {
    default: 'memory',
    connections: {
      memory: { driver: 'memory', concurrency: 5 },
    },
  },
}

describe('queue.batch (memory)', () => {
  it('tracks progress and runs then / finally exactly once under concurrency 5', async () => {
    await bootQueue([Import, Notify], concurrent)
    const callbacks = counters()
    const batch = await Queue.batch(Array.from({ length: 40 }, (_, n) => Import.with({ n })))
      .name('import')
      .then(callbacks.then)
      .catch(callbacks.catch)
      .finally(callbacks.finally)
      .dispatch()
    expect(batch).toMatchObject({
      name: 'import',
      total: 40,
      finished: false,
      cancelled: false,
    })
    expect(batch.id).toMatch(/^[0-9a-f-]{36}$/)
    await Queue.idle()
    const done = (await Queue.findBatch(batch.id))!
    expect(done).toMatchObject({
      total: 40,
      pending: 0,
      processed: 40,
      failed: 0,
      progress: 100,
      finished: true,
      cancelled: false,
    })
    expect(done.createdAt).toBeInstanceOf(Date)
    expect(done.finishedAt).toBeInstanceOf(Date)
    expect(callbacks.calls).toMatchObject({ then: 1, catch: 0, finally: 1 })
    expect(log).toHaveLength(40)
    expect(await Queue.findBatch('missing')).toBeUndefined()
  })

  it('reports partial progress while jobs are running', async () => {
    await bootQueue([Import, Notify])
    const batch = await Queue.batch([
      Import.with({ n: 1, wait: 0 }),
      Import.with({ n: 2, wait: 300 }),
    ]).dispatch()
    await waitFor(() => log.length === 1)
    expect(await batch.fresh()).toMatchObject({
      total: 2,
      pending: 1,
      processed: 1,
      progress: 50,
      finished: false,
    })
    await Queue.idle()
  })

  it('cancels on the first failure by default: catch once, then skipped, the rest skipped, finally once', async () => {
    await bootQueue([Import, Notify])
    const callbacks = counters()
    const batch = await Queue.batch([
      Import.with({ n: 1, fail: true }),
      ...Array.from({ length: 5 }, (_, n) => Import.with({ n: n + 2 })),
    ]).then(callbacks.then).catch(callbacks.catch).finally(callbacks.finally).dispatch()
    await Queue.idle()
    const done = (await batch.fresh())!
    expect(done).toMatchObject({
      total: 6,
      failed: 1,
      processed: 5,
      pending: 0,
      finished: true,
      cancelled: true,
    })
    expect(done.failedJobIds).toHaveLength(1)
    // concurrency 1：后面的任务在执行前被跳过，handle 不会运行
    expect(log).toEqual([])
    expect(callbacks.calls).toEqual({
      then: 0,
      catch: 1,
      finally: 1,
      errors: ['import 1 failed'],
    })
  })

  it('keeps going with allowFailures(): every job runs, then is skipped because of failures', async () => {
    await bootQueue([Import, Notify], concurrent)
    const callbacks = counters()
    const batch = await Queue.batch(Array.from({ length: 20 }, (_, n) => Import.with({ n, fail: n % 7 === 3 })))
      .allowFailures()
      .then(callbacks.then)
      .catch(callbacks.catch)
      .finally(callbacks.finally)
      .dispatch()
    await Queue.idle()
    expect(await batch.fresh()).toMatchObject({
      total: 20,
      failed: 3,
      processed: 17,
      finished: true,
      cancelled: false,
    })
    expect(log).toHaveLength(17)
    expect(callbacks.calls.then).toBe(0)
    expect(callbacks.calls.catch).toBe(1)
    expect(callbacks.calls.finally).toBe(1)
    expect((await Queue.failed()).map(job => job.batch)).toEqual([batch.id, batch.id, batch.id])
  })

  it('cancels a running batch: running jobs see job.batch().cancelled, queued ones are skipped', async () => {
    await bootQueue([Import, Notify])
    const callbacks = counters()
    const batch = await Queue.batch(Array.from({ length: 4 }, (_, n) => Import.with({ n, wait: 100 })))
      .then(callbacks.then)
      .finally(callbacks.finally)
      .dispatch()
    await sleep(20)
    await batch.cancel()
    await Queue.idle()
    // 第一个任务执行前读取的快照中尚未取消，执行完成；其余在执行前被跳过
    expect(log).toEqual(['import:0'])
    expect(await batch.fresh()).toMatchObject({
      total: 4,
      finished: true,
      cancelled: true,
      pending: 0,
    })
    expect(callbacks.calls).toMatchObject({ then: 0, finally: 1 })
  })

  it('adds jobs to a running batch, also from inside a batch job', async () => {
    await bootQueue([Import, Notify])
    const callbacks = counters()
    const batch = await Queue.batch([
      Import.with({ n: 1, more: 10, wait: 50 }),
    ])
      .then(callbacks.then)
      .finally(callbacks.finally)
      .dispatch()
    const grown = await batch.add([
      Import.with({ n: 2 }),
    ])
    expect(grown.total).toBe(2)
    await Queue.idle()
    expect(log.sort()).toEqual(['import:1', 'import:10', 'import:2'])
    expect(await batch.fresh()).toMatchObject({ total: 3, processed: 3, finished: true })
    expect(callbacks.calls).toMatchObject({ then: 1, finally: 1 })
    await expect(batch.add(Import.with({ n: 3 }))).rejects.toThrow(/already finished/)
  })

  it('dispatches job callbacks with access to the batch, and finishes an empty batch immediately', async () => {
    await bootQueue([Import, Notify])
    await Queue.batch([
      Import.with({ n: 1 }),
      Import.with({ n: 2 }),
    ])
      .then(Notify.with({ label: 'then' }))
      .finally(Notify.with({ label: 'finally' }))
      .dispatch()
    await Queue.idle()
    expect(log.filter(line => line.startsWith('notify')).sort()).toEqual(['notify:finally:2/2', 'notify:then:2/2'])

    const callbacks = counters()
    const empty = await Queue.batch([]).then(callbacks.then).finally(callbacks.finally).dispatch()
    expect(empty).toMatchObject({ total: 0, finished: true, progress: 100 })
    expect(callbacks.calls).toMatchObject({ then: 1, finally: 1 })
  })

  it('runs batches on the sync connection without throwing failures to the caller', async () => {
    await bootQueue([Import, Notify], {
      queue: { default: 'sync' },
    })
    const callbacks = counters()
    const batch = await Queue.batch([
      Import.with({ n: 1, wait: 0 }),
      Import.with({ n: 2, wait: 0, fail: true }),
    ])
      .allowFailures()
      .catch(callbacks.catch)
      .finally(callbacks.finally)
      .dispatch()
    expect(batch).toMatchObject({
      total: 2,
      processed: 1,
      failed: 1,
      finished: true,
    })
    expect(callbacks.calls).toMatchObject({ catch: 1, finally: 1 })
  })

  it('rejects function callbacks for remote connections and guards against awaiting the builder', async () => {
    await bootQueue([Import, Notify], {
      queue: {
        default: 'memory',
        connections: {
          redis: { driver: 'redis', url: 'redis://127.0.0.1:1' },
        },
      },
    })
    await expect(Queue.batch([
      Import.with({ n: 1 }),
    ]).onConnection('redis').then(() => {}).dispatch()).rejects.toThrow(/cannot run function callbacks/)
    await expect((async () => await (Queue.batch([]) as unknown as Promise<unknown>))()).rejects.toThrow(/not awaitable/)
  })

  it('records batches with Queue.fake()', async () => {
    const app = await bootQueue([Import, Notify])
    const fake = app.make(QueueManager).fake()
    const batch = await Queue.batch([
      Import.with({ n: 1 }),
      Import.with({ n: 2 }),
    ]).name('nightly').allowFailures().then(() => {}).dispatch()
    await batch.add(Import.with({ n: 3 }))
    fake.assertBatched(record => record.name === 'nightly' && record.jobs.length === 3 && record.allowFailures)
    fake.assertBatchCount(1)
    expect(() => fake.assertBatched(record => record.name === 'other')).toThrow(/Expected a batch/)
    expect(() => fake.assertNothingBatched()).toThrow(/no batches/)
    await batch.cancel()
    expect(await Queue.findBatch(batch.id)).toMatchObject({ cancelled: true, total: 3 })
    // 批次中的任务不进入 dispatched
    fake.assertCount(0)
  })
})

describe.runIf(redisUrl)('queue.batch (redis)', () => {
  it('counts atomically across two workers and runs the callbacks exactly once', async () => {
    const config = redisConfig()
    const app = await bootQueue([Import, Notify], config)
    const second = await bootQueue([Import, Notify], config)
    const workers = [
      await app.make(QueueManager).work({ concurrency: 5 }),
      await second.make(QueueManager).work({ concurrency: 5 }),
    ]
    try {
      const batch = await Queue.batch(Array.from({ length: 30 }, (_, n) => Import.with({ n, fail: n === 7 })))
        .allowFailures()
        .then(Notify.with({ label: 'then' }))
        .catch(Notify.with({ label: 'catch' }))
        .finally(Notify.with({ label: 'finally' }))
        .dispatch()
      await waitFor(async () => (await batch.fresh()).finished && log.filter(line => line.startsWith('notify')).length >= 2)
      await sleep(300)
      expect(await batch.fresh()).toMatchObject({
        total: 30,
        processed: 29,
        failed: 1,
        finished: true,
      })
      expect(log.filter(line => line.startsWith('notify')).map(line => line.split(':')[1]).sort()).toEqual(['catch', 'finally'])
    }
    finally {
      await Promise.all(workers.map(worker => worker.stop()))
    }
  }, 30_000)
})
