import { afterEach, describe, expect, it } from 'vitest'
import { Cache, defineJob, Queue, QueueManager, Tenancy } from '../src'
import { bootQueue, redisConfig, redisUrl, sleep, waitFor } from './support/queue'

const log: string[] = []
let gate: Promise<void> = Promise.resolve()
let open: () => void = () => {}
function hold(): void {
  gate = new Promise<void>(resolve => open = resolve)
}

const SyncFeed = defineJob({
  name: 'SyncFeed',
  unique: {
    key: (payload: { feed: number }) => String(payload.feed),
  },
  async handle(payload: { feed: number }) {
    log.push(`start:${payload.feed}`)
    await gate
    log.push(`done:${payload.feed}`)
  },
})

const Reindex = defineJob({
  name: 'Reindex',
  unique: { until: 'processing' },
  async handle() {
    log.push('reindex:start')
    await gate
    log.push('reindex:done')
  },
})

const Short = defineJob({
  name: 'Short',
  unique: { for: 1 },
  handle: () => void log.push('short'),
})

const Broken = defineJob({
  name: 'Broken',
  unique: true,
  handle() {
    throw new Error('broken')
  },
})

afterEach(() => {
  log.length = 0
  open()
  gate = Promise.resolve()
})

describe('unique jobs (memory)', () => {
  it('skips a duplicate dispatch while the first one is queued or running (until processed)', async () => {
    await bootQueue([SyncFeed, Reindex, Short, Broken])
    hold()
    const first = await SyncFeed.with({ feed: 1 }).dispatch()
    expect(first.skipped).toBe(false)
    const duplicate = await SyncFeed.with({ feed: 1 }).dispatch()
    expect(duplicate).toEqual({ id: first.id, skipped: true })
    // dispatch() 返回已在队列中的任务 ID
    expect(await SyncFeed.dispatch({ feed: 1 })).toBe(first.id)
    // 不同的键互不影响
    expect((await SyncFeed.with({ feed: 2 }).dispatch()).skipped).toBe(false)
    await waitFor(() => log.includes('start:1'))
    // 执行中仍然持有锁
    expect((await SyncFeed.with({ feed: 1 }).dispatch()).skipped).toBe(true)
    open()
    await Queue.idle()
    expect(log.sort()).toEqual([
      'done:1',
      'done:2',
      'start:1',
      'start:2',
    ])
    // 执行完成后释放
    expect((await SyncFeed.with({ feed: 1 }).dispatch()).skipped).toBe(false)
    await Queue.idle()
  })

  it('releases the lock when processing starts with until: processing', async () => {
    await bootQueue([SyncFeed, Reindex, Short, Broken])
    hold()
    // 延迟执行：在队列中等待时持有锁
    await Reindex.with(null as never).delay(0.2).dispatch()
    expect((await Reindex.with(null as never).dispatch()).skipped).toBe(true)
    await waitFor(() => log.includes('reindex:start'))
    // 已开始执行：可以再投递一个
    expect((await Reindex.with(null as never).delay(0.2).dispatch()).skipped).toBe(false)
    expect((await Reindex.with(null as never).dispatch()).skipped).toBe(true)
    open()
    await Queue.idle()
    expect(log.filter(line => line === 'reindex:done')).toHaveLength(2)
  })

  it('lets the lock expire after `for`, and releases it after the final failure', async () => {
    await bootQueue([SyncFeed, Reindex, Short, Broken])
    await Short.dispatch(null as never, { delay: 3 })
    expect((await Short.with(null as never).dispatch()).skipped).toBe(true)
    await sleep(1100)
    expect((await Short.with(null as never).dispatch()).skipped).toBe(false)

    await Broken.dispatch(null as never)
    await waitFor(async () => (await Queue.failed()).length === 1)
    expect((await Broken.with(null as never).dispatch()).skipped).toBe(false)
  })

  it('scopes unique keys per tenant', async () => {
    await bootQueue([SyncFeed, Reindex, Short, Broken], {
      tenancy: {
        find: (key: string) => ({ id: key }),
      },
    })
    hold()
    expect((await Tenancy.run('acme', () => SyncFeed.with({ feed: 1 }).dispatch())).skipped).toBe(false)
    expect((await Tenancy.run('globex', () => SyncFeed.with({ feed: 1 }).dispatch())).skipped).toBe(false)
    expect((await Tenancy.run('acme', () => SyncFeed.with({ feed: 1 }).dispatch())).skipped).toBe(true)
    open()
    await Queue.idle()
  })

  it('stores the lock in the configured cache store and works on the sync connection', async () => {
    await bootQueue([SyncFeed, Reindex, Short, Broken], {
      queue: { default: 'sync', store: 'locks' },
      cache: {
        default: 'memory',
        stores: {
          memory: { driver: 'memory' },
          locks: { driver: 'memory' },
        },
      },
    })
    await SyncFeed.dispatch({ feed: 1 })
    await SyncFeed.dispatch({ feed: 1 })
    expect(log).toEqual([
      'start:1',
      'done:1',
      'start:1',
      'done:1',
    ])
    expect(await Cache.store('locks').has('lock:queue:unique:SyncFeed:1')).toBe(false)
  })

  it('simulates unique locks with Queue.fake()', async () => {
    const app = await bootQueue([SyncFeed, Reindex, Short, Broken])
    const fake = app.make(QueueManager).fake()
    await SyncFeed.dispatch({ feed: 1 })
    expect((await SyncFeed.with({ feed: 1 }).dispatch()).skipped).toBe(true)
    await SyncFeed.dispatch({ feed: 2 })
    fake.assertPushedUnique(SyncFeed, payload => payload.feed === 1)
    fake.assertSkipped(SyncFeed, payload => payload.feed === 1)
    expect(() => fake.assertSkipped(SyncFeed, payload => payload.feed === 2)).toThrow(/to be skipped/)
    expect(() => fake.assertPushedUnique(SyncFeed)).toThrow(/exactly once, got 2/)
    await fake.drain()
    // drain 执行后释放模拟的锁
    expect((await SyncFeed.with({ feed: 1 }).dispatch()).skipped).toBe(false)
  })
})

describe.runIf(redisUrl)('unique jobs (redis)', () => {
  it('holds the lock in redis until the BullMQ worker finished the job', async () => {
    const app = await bootQueue([SyncFeed, Reindex, Short, Broken], redisConfig())
    const worker = await app.make(QueueManager).work()
    try {
      hold()
      const first = await SyncFeed.with({ feed: 7 }).dispatch()
      expect(await SyncFeed.with({ feed: 7 }).dispatch()).toEqual({ id: first.id, skipped: true })
      await waitFor(() => log.includes('start:7'))
      open()
      await waitFor(() => log.includes('done:7'))
      await waitFor(async () => !(await SyncFeed.with({ feed: 7 }).dispatch()).skipped)
    }
    finally {
      await worker.stop()
    }
  }, 30_000)
})
