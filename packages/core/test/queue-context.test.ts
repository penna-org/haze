import type { AfterCommitHandler, Application, ApplicationOptions } from '../src'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { afterCommit, config, createApplication, defineEvent, defineJob, defineListener, defineSchedule, EventManager, Events, inject, Queue, QueueManager, registerAfterCommitHandler, runInApp, Scheduler, useApp } from '../src'
import { registerInProcessWorkers } from '../src/server/in-process'

// 迁移真实后端（ai-admin）时发现的队列、定时任务与事件的不足

const log: string[] = []
const apps: Application[] = []

afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.dispose()))
  log.length = 0
})

interface Captured { level: string, msg: string, [key: string]: any }

async function boot(name: string, options: ApplicationOptions = {}, extra: Record<string, unknown> = {}): Promise<{ app: Application, lines: Captured[] }> {
  const lines: Captured[] = []
  const app = await createApplication({
    mode: 'test',
    env: false,
    config: {
      app: { name },
      logger: {
        level: 'debug',
        format: 'json',
        write: (line: string) => lines.push(JSON.parse(line)),
      },
      ...extra,
    },
    ...options,
  })
  apps.push(app)
  return { app, lines }
}

/** 记录任务 / 监听器 / 定时任务中门面解析到的应用 */
function snapshot(label: string): void {
  log.push(`${label}:${useApp().config.get('app.name')}:${config('app.name' as never)}:${Queue.manager().app.config.get('app.name')}:${inject(QueueManager).app.config.get('app.name')}`)
}

const Probe = defineJob({
  handle: () => snapshot('job'),
})

const Ping = defineEvent<{ id: number }>()
const OnPing = defineListener(Ping, () => snapshot('listener'))

describe('application context', () => {
  it('resolves facades to the application that owns the job, the listener and the scheduled task', async () => {
    const shared = {
      jobs: {
        '/app/job/Probe.ts': { default: Probe },
      },
      events: {
        '/app/event/Ping.ts': { default: Ping },
      },
      listeners: {
        '/app/listener/OnPing.ts': { default: OnPing },
      },
      schedules: {
        '/schedule/tasks.ts': {
          default: defineSchedule((s) => {
            s.call('probe', () => snapshot('task')).everyMinute().when(() => useApp().config.get('app.name') === 'first')
          }),
        },
      },
    }
    const { app: first } = await boot('first', shared, {
      queue: { default: 'sync' },
    })
    // 第二个应用最后启动：请求之外的门面原来会解析到它
    await boot('second', shared, {
      queue: { default: 'sync' },
    })

    await first.make(QueueManager).dispatch(Probe)
    await first.make(EventManager).emit(Ping, { id: 1 })
    const [run] = await first.make(Scheduler).runDue(new Date())
    expect(run!.status).toBe('ok')
    expect(log).toEqual([
      'job:first:first:first:first',
      'listener:first:first:first:first',
      'task:first:first:first:first',
    ])
  })

  it('runInApp() pins facades for scripts, and a request inside it still wins', async () => {
    const { app: first } = await boot('first')
    const { app: second } = await boot('second')
    expect(useApp()).toBe(second)
    await runInApp(first, async () => {
      await Promise.resolve()
      expect(useApp()).toBe(first)
      expect(config('app.name' as never)).toBe('first')
      expect(Queue.manager()).toBe(first.make(QueueManager))
      expect(inject(QueueManager)).toBe(first.make(QueueManager))
    })
  })

  it('passes the application to defineSchedule and dispatches s.job() to its queue', async () => {
    let received: Application | undefined
    const { app } = await boot('first', {
      jobs: {
        '/app/job/Probe.ts': { default: Probe },
      },
      schedules: {
        '/schedule/tasks.ts': {
          default: defineSchedule((s, owner) => {
            received = owner
            s.job(Probe).everyMinute().skip(() => owner.config.get('app.name') !== 'first')
          }),
        },
      },
    })
    const other = await boot('second', {
      jobs: {
        '/app/job/Probe.ts': { default: Probe },
      },
    })
    const fake = app.make(QueueManager).fake()
    const otherFake = other.app.make(QueueManager).fake()
    const [run] = await app.make(Scheduler).runDue(new Date())
    expect(received).toBe(app)
    expect(run!.status).toBe('ok')
    fake.assertDispatched(Probe)
    otherFake.assertCount(0)
  })
})

const Cleanup = defineJob({
  handle(payload: void) {
    log.push(`cleanup:${String(payload)}`)
  },
})

const Untyped = defineJob({
  handle: () => void log.push('untyped'),
})

describe('jobs without a payload', () => {
  it('dispatch() and s.job() accept no payload', async () => {
    const { app, lines } = await boot('first', {
      jobs: {
        '/app/job/Cleanup.ts': { default: Cleanup },
        '/app/job/Untyped.ts': { default: Untyped },
      },
      schedules: {
        '/schedule/tasks.ts': {
          default: defineSchedule(s => void s.job(Cleanup).everyMinute()),
        },
      },
    })
    await Cleanup.dispatch()
    await Untyped.dispatch()
    await Untyped.with().dispatch()
    await Queue.dispatch(Cleanup)
    await app.make(Scheduler).runDue(new Date())
    await Queue.idle()
    expect(log).toEqual([
      'cleanup:undefined',
      'untyped',
      'untyped',
      'cleanup:undefined',
      'cleanup:undefined',
    ])
    // 成功执行的 debug 日志带任务名、耗时与执行次数；s.job() 记为“已投递”
    expect(lines.filter(line => /^Job "Cleanup" done in \d+ms \(attempt 1\/1\)$/.test(line.msg))).toHaveLength(3)
    expect(lines.some(line => line.msg.startsWith('Scheduled job dispatched to the queue') && line.task === 'job:Cleanup')).toBe(true)

    expectTypeOf(Cleanup.dispatch).toBeCallableWith()
    const Typed = defineJob({
      handle: (_payload: { id: number }) => {},
    })
    // @ts-expect-error the payload is required
    expectTypeOf(Typed.dispatch).toBeCallableWith()
    expectTypeOf(Typed.dispatch).toBeCallableWith({ id: 1 })
  })
})

describe('duplicate names', () => {
  it('reports both sources when two jobs share a name', async () => {
    const other = defineJob({
      handle: () => {},
    })
    await expect(boot('first', {
      jobs: {
        '/app/job/Cleanup.ts': { default: Cleanup },
        '/app/job/admin/Cleanup.ts': { default: other },
      },
    })).rejects.toThrow('Duplicate job name "Cleanup": defined in /app/job/admin/Cleanup.ts and /app/job/Cleanup.ts')
  })

  it('reports both sources when two listeners share a name', async () => {
    const other = defineListener(Ping, () => {})
    await expect(boot('first', {
      events: {
        '/app/event/Ping.ts': { default: Ping },
      },
      listeners: {
        '/app/listener/OnPing.ts': { default: OnPing },
        '/app/listener/sub/OnPing.ts': { default: other },
      },
    })).rejects.toThrow(/Duplicate listener name "OnPing": defined in \/app\/listener\/OnPing\.ts and \/app\/listener\/sub\/OnPing\.ts/)
  })

  it('ignores registering the same definition twice', async () => {
    const { app } = await boot('first', {
      jobs: {
        '/app/job/Cleanup.ts': { default: Cleanup },
      },
    })
    expect(() => app.make(QueueManager).register(Cleanup, 'Cleanup')).not.toThrow()
    expect(() => app.make(QueueManager).register(Untyped, 'Cleanup')).toThrow('registered at runtime')
  })
})

describe('listener error isolation', () => {
  it('keeps running the other listeners and logs the failure', async () => {
    const Broken = defineListener(Ping, () => {
      throw new Error('listener boom')
    })
    const After = defineListener(Ping, ({ id }) => void log.push(`after:${id}`))
    const { lines } = await boot('first', {
      events: {
        '/app/event/Ping.ts': { default: Ping },
      },
      listeners: {
        '/app/listener/A.ts': { default: Broken },
        '/app/listener/B.ts': { default: After },
      },
    })
    await expect(Ping.emit({ id: 1 })).resolves.toBeUndefined()
    expect(log).toEqual(['after:1'])
    const error = lines.find(line => line.level === 'error')
    expect(error).toMatchObject({ msg: 'Listener "A" failed', event: 'Ping' })
    expect(error!.err.message).toBe('listener boom')
  })
})

describe('afterCommit', () => {
  /** 模拟数据库包注册的事务实现 */
  function fakeTransactions() {
    let pending: Array<() => Promise<void>> | undefined
    const handler: AfterCommitHandler = (callback) => {
      if (!pending)
        return false
      pending.push(callback)
      return true
    }
    const unregister = registerAfterCommitHandler(handler)
    return {
      unregister,
      begin: () => void (pending = []),
      commit: async () => {
        const callbacks = pending ?? []
        pending = undefined
        for (const callback of callbacks)
          await callback()
      },
      rollback: () => void (pending = undefined),
    }
  }

  it('defers jobs, events and callbacks until the transaction commits and drops them on rollback', async () => {
    const tx = fakeTransactions()
    try {
      const Deferred = defineJob({
        afterCommit: true,
        handle: () => void log.push('deferred-job'),
      })
      const Placed = defineEvent<{ id: number }>({ afterCommit: true })
      const OnPlaced = defineListener(Placed, ({ id }) => void log.push(`placed:${id}`))
      await boot('first', {
        jobs: {
          '/app/job/Deferred.ts': { default: Deferred },
          '/app/job/Cleanup.ts': { default: Cleanup },
        },
        events: {
          '/app/event/Placed.ts': { default: Placed },
        },
        listeners: {
          '/app/listener/OnPlaced.ts': { default: OnPlaced },
        },
      }, {
        queue: { default: 'sync' },
      })

      // 不在事务中：立即执行
      await Deferred.dispatch()
      expect(log).toEqual(['deferred-job'])
      log.length = 0

      tx.begin()
      const result = await Deferred.with().dispatch()
      expect(result.deferred).toBe(true)
      await Placed.emit({ id: 1 })
      await Cleanup.with().afterCommit().dispatch()
      await Cleanup.dispatch(undefined, { afterCommit: true })
      await afterCommit(() => void log.push('callback'))
      // afterCommit(false) 覆盖任务的设置
      await Deferred.dispatch(undefined, { afterCommit: false })
      expect(log).toEqual(['deferred-job'])
      await tx.commit()
      expect(log).toEqual([
        'deferred-job',
        'deferred-job',
        'placed:1',
        'cleanup:undefined',
        'cleanup:undefined',
        'callback',
      ])

      log.length = 0
      tx.begin()
      await Deferred.dispatch()
      await Placed.emit({ id: 2 })
      tx.rollback()
      expect(log).toEqual([])
    }
    finally {
      tx.unregister()
    }
  })

  it('records deferred dispatches in Queue.fake() only after commit', async () => {
    const tx = fakeTransactions()
    try {
      await boot('first', {
        jobs: {
          '/app/job/Cleanup.ts': { default: Cleanup },
        },
      })
      const fake = Queue.fake()
      tx.begin()
      await Cleanup.with().afterCommit().dispatch()
      fake.assertCount(0)
      await tx.commit()
      fake.assertDispatched(Cleanup)
    }
    finally {
      tx.unregister()
    }
  })
})

describe('warnings', () => {
  it('queue.runInServer skips sync (with a warning) and memory connections', async () => {
    const work = vi.spyOn(QueueManager.prototype, 'work')
    try {
      for (const queue of [
        { default: 'sync', runInServer: true },
        { default: 'memory', runInServer: true },
      ]) {
        const { app, lines } = await boot('first', {}, { queue })
        const stop = registerInProcessWorkers(app)!
        const { serverExtensions } = await import('../src/server/extensions')
        await serverExtensions().find(extension => extension.name === 'haze:in-process-workers')!.node!({} as never)
        await vi.waitFor(() => expect(lines.some(line => line.msg.startsWith('In-process workers started'))).toBe(true))
        expect(lines.some(line => line.level === 'warn' && line.msg.includes('sync driver'))).toBe(queue.default === 'sync')
        await stop()
      }
      expect(work).not.toHaveBeenCalled()
    }
    finally {
      work.mockRestore()
    }
  })

  it('warns once when a unique job locks in a memory store but runs in another process', async () => {
    const Unique = defineJob({
      unique: true,
      handle: () => {},
    })
    const { app, lines } = await boot('first', {
      jobs: {
        '/app/job/Unique.ts': { default: Unique },
      },
    }, {
      queue: {
        default: 'remote',
        connections: {
          remote: { driver: 'remote' },
        },
      },
    })
    const pushed: unknown[] = []
    const { registerQueueDriver } = await import('../src')
    registerQueueDriver('remote', () => ({
      driver: 'remote',
      push: async (message: unknown) => void pushed.push(message),
      consume: async () => async () => {},
      failed: async () => [],
      retry: async () => 0,
      forget: async () => false,
      flush: async () => 0,
      close: async () => {},
    }))
    await Unique.dispatch()
    await Unique.dispatch()
    expect(pushed).toHaveLength(1)
    expect(lines.filter(line => line.level === 'warn' && line.msg.includes('cannot release it'))).toHaveLength(1)
    expect(app.make(QueueManager).config.default).toBe('remote')
  })

  it('queue:work refuses the sync connection with a clear error', async () => {
    const { app } = await boot('first')
    await expect(app.make(QueueManager).work({ connection: 'sync' })).rejects.toThrow('needs no worker')
  })
})

describe('event order', () => {
  it('runs listeners in file path order, runtime listeners last', async () => {
    const first = defineListener(Ping, () => void log.push('a'))
    const second = defineListener(Ping, () => void log.push('b'))
    await boot('first', {
      events: {
        '/app/event/Ping.ts': { default: Ping },
      },
      listeners: {
        '/app/listener/b/Second.ts': { default: second },
        '/app/listener/a/First.ts': { default: first },
      },
    })
    Events.on(Ping, () => void log.push('runtime'))
    await Ping.emit({ id: 1 })
    expect(log).toEqual(['a', 'b', 'runtime'])
  })
})
