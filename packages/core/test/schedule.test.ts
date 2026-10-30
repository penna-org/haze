import process from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApplication, defineJob, defineSchedule, Queue, QueueManager, Schedule, Scheduler } from '../src'

const log: string[] = []
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const Cleanup = defineJob({
  handle: (payload: { days: number }) => void log.push(`cleanup:${payload.days}`),
})

const schedules = defineSchedule((s) => {
  s.call('every-minute', () => void log.push('every-minute')).everyMinute()
  s.call('nightly', () => void log.push('nightly')).dailyAt('03:00')
  s.call('weekday-morning', () => void log.push('weekday-morning')).weekdays().at('09:30').timezone('Asia/Shanghai')
  s.cron('*/15 * * * *', 'quarter', () => void log.push('quarter'))
  s.job(Cleanup, { days: 30 }).hourlyAt(5)
  s.call('guarded', () => void log.push('guarded')).everyMinute().when(() => log.includes('allow'))
  s.call('broken', () => {
    throw new Error('task failed')
  }).everyMinute().onFailure(error => void log.push(`onFailure:${(error as Error).message}`))
})

let apps: Awaited<ReturnType<typeof createApplication>>[] = []
afterEach(async () => {
  await Promise.all(apps.map(app => app.dispose()))
  apps = []
  log.length = 0
})

async function boot(definitions: unknown[] = [schedules], config: Record<string, unknown> = {}) {
  const app = await createApplication({
    mode: 'test',
    env: false,
    jobs: {
      '/app/job/Cleanup.ts': { default: Cleanup },
    },
    schedules: definitions,
    config: {
      logger: { level: 'silent' },
      ...config,
    },
  })
  apps.push(app)
  return app
}

describe('schedule definitions', () => {
  it('builds cron expressions fluently', () => {
    const s = new Schedule()
    expect(s.call('a', () => {}).everyFiveMinutes().expression).toBe('*/5 * * * *')
    expect(s.call('b', () => {}).dailyAt('13:05').expression).toBe('5 13 * * *')
    expect(s.call('c', () => {}).weekdays().at('09:30').expression).toBe('30 9 * * 1-5')
    expect(s.call('d', () => {}).weeklyOn(1, '08:00').expression).toBe('0 8 * * 1')
    expect(s.call('e', () => {}).monthlyOn(15, '12:00').expression).toBe('0 12 15 * *')
    expect(s.call('f', () => {}).twiceDaily(1, 13).expression).toBe('0 1,13 * * *')
    expect(s.call('g', () => {}).hourly().expression).toBe('0 * * * *')
    expect(() => s.call('a', () => {})).toThrow('Duplicate scheduled task "a"')
  })

  it('decides due tasks per minute, honoring time zones', async () => {
    const scheduler = (await boot()).make(Scheduler)
    const names = (iso: string) => scheduler.due(new Date(iso)).map(task => task.name)
    // 2026-10-27 是周二；Asia/Shanghai 09:30 = UTC 01:30
    expect(names('2026-10-27T03:00:20Z')).toEqual([
      'every-minute',
      'nightly',
      'quarter',
      'guarded',
      'broken',
    ])
    expect(names('2026-10-27T01:30:00Z')).toEqual([
      'every-minute',
      'weekday-morning',
      'quarter',
      'guarded',
      'broken',
    ])
    expect(names('2026-10-25T01:30:00Z')).not.toContain('weekday-morning')
    expect(names('2026-10-27T04:05:00Z')).toContain('job:Cleanup')
    const next = scheduler.tasks().find(task => task.name === 'nightly')!.nextRun(new Date('2026-10-27T03:00:00Z'))
    expect(next?.toISOString()).toBe('2026-10-28T03:00:00.000Z')
  })

  it('uses the configured default time zone', async () => {
    const scheduler = (await boot([
      defineSchedule(s => void s.call('local', () => {}).dailyAt('08:00')),
    ], {
      schedule: { timezone: 'Asia/Shanghai' },
    })).make(Scheduler)
    expect(scheduler.due(new Date('2026-10-27T00:00:00Z')).map(task => task.name)).toEqual(['local'])
  })
})

describe('running scheduled tasks', () => {
  it('runs due tasks, applies filters, dispatches jobs and reports failures', async () => {
    await boot()
    const fake = Queue.fake()
    const runs = await (apps[0]).make(Scheduler).runDue(new Date('2026-10-27T04:05:00Z'))
    expect(runs.map(run => [run.name, run.status, run.reason])).toEqual([
      ['every-minute', 'ok', undefined],
      ['job:Cleanup', 'ok', undefined],
      ['guarded', 'skipped', 'filter'],
      ['broken', 'failed', undefined],
    ])
    fake.assertDispatched(Cleanup, payload => payload.days === 30)
    expect(log).toEqual(['every-minute', 'onFailure:task failed'])
  })

  it('withoutOverlapping skips while the previous run is still going', async () => {
    const slow = defineSchedule(s => void s.call('slow', async () => {
      log.push('slow:start')
      await sleep(200)
      log.push('slow:end')
    }).everyMinute().withoutOverlapping())
    const scheduler = (await boot([slow])).make(Scheduler)
    const [first, second] = await Promise.all([
      scheduler.runDue(),
      sleep(20).then(() => scheduler.runDue()),
    ])
    expect(first[0].status).toBe('ok')
    expect(second[0]).toMatchObject({ status: 'skipped', reason: 'overlapping' })
    // 结束后释放锁
    expect((await scheduler.runDue())[0].status).toBe('ok')
  })

  it('onOneServer runs a slot once across instances sharing the cache store', async () => {
    const once = defineSchedule(s => void s.call('report', () => void log.push('report')).everyMinute().onOneServer())
    // 同一进程中的两个应用共用内存缓存，模拟两台服务器共用 Redis
    const [a, b] = await Promise.all([
      boot([once]),
      boot([once]),
    ])
    const minute = new Date('2026-10-27T05:00:00Z')
    const results = await Promise.all([
      a.make(Scheduler).runDue(minute),
      b.make(Scheduler).runDue(minute),
    ])
    expect(results.flat().map(run => run.status).sort()).toEqual(['ok', 'skipped'])
    expect(log).toEqual(['report'])
    // 下一分钟重新执行
    await a.make(Scheduler).runDue(new Date('2026-10-27T05:01:00Z'))
    expect(log).toEqual(['report', 'report'])
  })

  it('requires an atomic cache store for locks', async () => {
    const once = defineSchedule(s => void s.call('report', () => {}).everyMinute().onOneServer())
    const app = await boot([once], {
      cache: {
        default: 'kv',
        stores: {
          kv: { driver: 'kv', binding: {} },
        },
      },
    })
    await expect(app.make(Scheduler).runDue()).rejects.toThrow('atomic cache store')
  })

  it('work() runs on minute boundaries until aborted', async () => {
    const scheduler = (await boot([
      defineSchedule(s => void s.call('tick', () => {}).everyMinute()),
    ])).make(Scheduler)
    const controller = new AbortController()
    const working = scheduler.work(controller.signal)
    controller.abort()
    await expect(working).resolves.toBeUndefined()
  })

  it.runIf(process.env.HAZE_TEST_REDIS_URL)('onOneServer across instances with Redis', async () => {
    const once = defineSchedule(s => void s.call('redis-report', () => void log.push('redis-report')).everyMinute().onOneServer())
    const config = {
      cache: {
        default: 'redis',
        prefix: `sched:${crypto.randomUUID()}:`,
        stores: {
          redis: { driver: 'redis', url: process.env.HAZE_TEST_REDIS_URL },
        },
      },
    }
    const instances = await Promise.all([
      boot([once], config),
      boot([once], config),
      boot([once], config),
    ])
    const minute = new Date('2026-10-27T06:00:00Z')
    const results = await Promise.all(instances.map(app => app.make(Scheduler).runDue(minute)))
    expect(results.flat().filter(run => run.status === 'ok')).toHaveLength(1)
    expect(log).toEqual(['redis-report'])
  })
})

describe('runInServer', () => {
  it('starts the scheduler and the queue worker when the HTTP server listens, and stops them on dispose', async () => {
    const work = vi.spyOn(Scheduler.prototype, 'work')
    const consume = vi.spyOn(QueueManager.prototype, 'work')
    try {
      const app = await createApplication({
        mode: 'production',
        env: false,
        config: {
          logger: { level: 'silent' },
          app: {
            key: 'k'.repeat(32),
          },
          schedule: { runInServer: true },
          queue: {
            runInServer: {
              queues: ['high', 'default'],
              concurrency: 2,
            },
          },
        },
      })
      // 没有监听端口（命令行、测试）时不启动
      expect(work).not.toHaveBeenCalled()
      const server = app.serve({ port: 0, hostname: '127.0.0.1', silent: true })
      await server.ready()
      await vi.waitFor(() => expect(consume).toHaveBeenCalledWith({
        queues: ['high', 'default'],
        concurrency: 2,
      }))
      expect(work).toHaveBeenCalledTimes(1)
      const signal = work.mock.calls[0]![0]!
      await server.close()
      await app.dispose()
      expect(signal.aborted).toBe(true)
    }
    finally {
      work.mockRestore()
      consume.mockRestore()
    }
  })

  it('is off by default', async () => {
    const work = vi.spyOn(Scheduler.prototype, 'work')
    try {
      const app = await createApplication({
        mode: 'production',
        env: false,
        config: {
          logger: { level: 'silent' },
          app: {
            key: 'k'.repeat(32),
          },
        },
      })
      const server = app.serve({ port: 0, hostname: '127.0.0.1', silent: true })
      await server.ready()
      expect(work).not.toHaveBeenCalled()
      await server.close()
      await app.dispose()
    }
    finally {
      work.mockRestore()
    }
  })
})
