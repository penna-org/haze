import type { Application } from '@hazejs/core'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { createApplication, defineJob, Queue, QueueManager, withoutOverlapping } from '@hazejs/core'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { databaseProvider, databaseQueue, Db, useDatabaseManager } from '../src'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
async function waitFor(check: () => boolean | Promise<boolean>, timeout = 20_000) {
  const start = Date.now()
  while (!(await check())) {
    if (Date.now() - start > timeout)
      throw new Error('Timed out')
    await sleep(20)
  }
}

const dir = mkdtempSync(join(tmpdir(), 'haze-queue-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// 与 haze make:queue-tables 生成的表结构一致
const dialects = [
  {
    name: 'sqlite',
    connections: (file: string) => ({
      main: { driver: 'sqlite' as const, url: `file:${file}` },
      // 第二个连接指向同一个文件：两个独立的 libsql 客户端争用同一个库
      second: { driver: 'sqlite' as const, url: `file:${file}` },
    }),
    ddl: [
      'drop table if exists jobs',
      'drop table if exists failed_jobs',
      'create table jobs (id integer primary key autoincrement, queue text not null, payload text not null, attempts integer not null default 0, reserved_at integer, available_at integer not null, created_at integer not null)',
      'create index jobs_queue_index on jobs (queue, available_at)',
      'create table failed_jobs (id integer primary key autoincrement, uuid text not null unique, connection text not null, queue text not null, payload text not null, exception text not null, failed_at integer not null)',
    ],
  },
  {
    name: 'pglite',
    // PGlite 是进程内的单连接库：两个消费者共用同一个连接
    connections: () => ({
      main: { driver: 'pglite' as const },
    }),
    ddl: [
      'drop table if exists jobs',
      'drop table if exists failed_jobs',
      'create table jobs (id bigserial primary key, queue text not null, payload text not null, attempts integer not null default 0, reserved_at bigint, available_at bigint not null, created_at bigint not null)',
      'create index jobs_queue_index on jobs (queue, available_at)',
      'create table failed_jobs (id bigserial primary key, uuid text not null unique, connection text not null, queue text not null, payload text not null, exception text not null, failed_at bigint not null)',
    ],
  },
  // MySQL 需要真实服务：HAZE_TEST_MYSQL_URL=mysql://root:pass@127.0.0.1:3306/test
  ...(process.env.HAZE_TEST_MYSQL_URL
    ? [
        {
          name: 'mysql',
          connections: () => ({
            main: { driver: 'mysql' as const, url: process.env.HAZE_TEST_MYSQL_URL },
            second: { driver: 'mysql' as const, url: process.env.HAZE_TEST_MYSQL_URL },
          }),
          ddl: [
            'drop table if exists jobs',
            'drop table if exists failed_jobs',
            'create table jobs (id bigint unsigned auto_increment primary key, queue varchar(255) not null, payload longtext not null, attempts int unsigned not null default 0, reserved_at bigint null, available_at bigint not null, created_at bigint not null, index jobs_queue_index (queue, available_at))',
            'create table failed_jobs (id bigint unsigned auto_increment primary key, uuid varchar(36) not null unique, connection varchar(255) not null, queue varchar(255) not null, payload longtext not null, exception longtext not null, failed_at bigint not null)',
          ],
        },
      ]
    : []),
]

const log: string[] = []
let failures = 0

const Work = defineJob({
  name: 'Work',
  tries: 3,
  backoff: 1,
  async handle(payload: { n: number, wait?: number }, job) {
    if (payload.wait)
      await sleep(payload.wait)
    if (job.attempt <= failures)
      throw new Error(`work ${payload.n} failed (${job.attempt})`)
    log.push(`work:${payload.n}:${job.attempt}`)
  },
})

const Exclusive = defineJob({
  name: 'Exclusive',
  middleware: [
    withoutOverlapping('shared', { releaseAfter: 0.05 }),
  ],
  async handle(payload: { n: number }, job) {
    await sleep(50)
    log.push(`exclusive:${payload.n}:${job.attempt}`)
  },
})

describe.each(dialects)('database queue driver on $name', (dialect) => {
  const apps: Application[] = []
  let file = ''

  async function boot(): Promise<Application> {
    const connections = dialect.connections(file)
    const queue = (connection: string) => ({
      driver: 'database',
      connection,
      sleep: 0.02,
      maxSleep: 0.1,
      retryAfter: 2,
    })
    const app = await createApplication({
      mode: 'test',
      env: false,
      providers: [
        databaseProvider(),
      ],
      jobs: {
        '/app/job/Work.ts': { default: Work },
        '/app/job/Exclusive.ts': { default: Exclusive },
      },
      config: {
        logger: { level: 'silent' },
        database: { default: 'main', connections },
        queue: {
          default: 'database',
          connections: {
            database: queue('main'),
            second: queue('second' in connections
              ? 'second'
              : 'main'),
          },
        },
      },
    })
    apps.push(app)
    return app
  }

  async function setup(): Promise<Application> {
    file = join(dir, `${crypto.randomUUID()}.db`)
    const app = await boot()
    for (const statement of dialect.ddl)
      await Db.execute(sql.raw(statement))
    return app
  }

  afterEach(async () => {
    for (const app of apps.splice(0).reverse())
      await app.dispose()
    await useDatabaseManager().close().catch(() => {})
    log.length = 0
    failures = 0
  })

  it('dispatches into the jobs table and consumes it, honouring delays', async () => {
    const app = await setup()
    const started = Date.now()
    await Work.dispatch({ n: 1 })
    await Work.dispatch({ n: 2 }, { delay: 3 })
    expect(await Queue.manager().counts()).toEqual({
      waiting: 1,
      delayed: 1,
      active: 0,
      failed: 0,
    })
    const worker = await app.make(QueueManager).work({ concurrency: 2 })
    try {
      await waitFor(() => log.includes('work:1:1'))
      expect(log).toEqual(['work:1:1'])
      await waitFor(() => log.includes('work:2:1'))
      expect(Date.now() - started).toBeGreaterThanOrEqual(3000)
      expect(await Db.execute(sql`select * from jobs`)).toEqual([])
    }
    finally {
      await worker.stop()
    }
  })

  it('retries with backoff, keeps failed jobs and supports failed / retry / forget / flush / counts', async () => {
    const app = await setup()
    const worker = await app.make(QueueManager).work()
    try {
      failures = 1
      const started = Date.now()
      await Work.dispatch({ n: 1 })
      await waitFor(() => log.includes('work:1:2'))
      expect(Date.now() - started).toBeGreaterThanOrEqual(1000)

      failures = 5
      const id = await Work.dispatch({ n: 2 })
      await Work.dispatch({ n: 3 })
      await waitFor(async () => (await Queue.failed()).length === 2, 30_000)
      const failed = await Queue.failed()
      expect(failed[0]).toMatchObject({
        id,
        job: 'Work',
        queue: 'default',
        payload: { n: 2 },
        attempts: 3,
      })
      expect(failed[0]!.error).toContain('work 2 failed (3)')
      expect(await Queue.manager().counts()).toMatchObject({ waiting: 0, failed: 2 })

      failures = 0
      expect(await Queue.retry(id)).toBe(1)
      await waitFor(() => log.includes('work:2:1'))
      expect(await Queue.manager().forget(failed[1]!.id)).toBe(true)
      expect(await Queue.manager().forget(failed[1]!.id)).toBe(false)
      expect(await Queue.failed()).toEqual([])

      failures = 5
      await Work.dispatch({ n: 4 })
      await waitFor(async () => (await Queue.failed()).length === 1, 30_000)
      expect(await Queue.manager().flush()).toBe(1)
      expect(await Queue.manager().counts()).toEqual({
        waiting: 0,
        delayed: 0,
        active: 0,
        failed: 0,
      })
    }
    finally {
      await worker.stop()
    }
  }, 60_000)

  it('releases reservations older than retryAfter (crashed workers), failing rows that used up their tries', async () => {
    const app = await setup()
    const now = Date.now()
    const message = (n: number) => JSON.stringify({
      id: `stale-${n}`,
      job: 'Work',
      payload: { n },
      queue: 'default',
      attempts: 0,
      dispatchedAt: now,
    })
    // worker 领取后崩溃：reserved_at 停在 10 秒前
    await Db.execute(sql`insert into jobs (queue, payload, attempts, reserved_at, available_at, created_at) values ('default', ${message(1)}, 1, ${now - 10_000}, ${now - 10_000}, ${now - 10_000})`)
    await Db.execute(sql`insert into jobs (queue, payload, attempts, reserved_at, available_at, created_at) values ('default', ${message(2)}, 3, ${now - 10_000}, ${now - 10_000}, ${now - 10_000})`)
    // 刚被领取的不动
    await Db.execute(sql`insert into jobs (queue, payload, attempts, reserved_at, available_at, created_at) values ('default', ${message(3)}, 1, ${now}, ${now}, ${now})`)
    const worker = await app.make(QueueManager).work()
    try {
      await waitFor(() => log.includes('work:1:2'))
      await waitFor(async () => (await Queue.failed()).length === 1)
      expect((await Queue.failed())[0]).toMatchObject({ id: 'stale-2', attempts: 4 })
      expect((await Queue.failed())[0]!.error).toMatch(/attempted too many times/)
      expect(log).toEqual(['work:1:2'])
      // retryAfter（2 秒）之后第三行也被重新领取
      await waitFor(() => log.includes('work:3:2'), 10_000)
    }
    finally {
      await worker.stop()
    }
  })

  it('does not double-process 200 jobs with two concurrent consumers', async () => {
    const producer = await setup()
    const consumer = await boot()
    await Promise.all(Array.from({ length: 200 }, (_, n) => Work.dispatch({ n })))
    const workers = [
      await producer.make(QueueManager).work({ concurrency: 4 }),
      await consumer.make(QueueManager).work({ connection: 'second', concurrency: 4 }),
    ]
    try {
      await waitFor(() => log.length >= 200, 60_000)
      await sleep(200)
      expect(log).toHaveLength(200)
      expect(new Set(log).size).toBe(200)
      expect(await Db.execute(sql`select * from jobs`)).toEqual([])
    }
    finally {
      await Promise.all(workers.map(worker => worker.stop()))
    }
  }, 90_000)

  it('supports release() via middleware, chains and graceful stop', async () => {
    const app = await setup()
    const worker = await app.make(QueueManager).work({ concurrency: 3 })
    await Promise.all([
      Exclusive.dispatch({ n: 1 }),
      Exclusive.dispatch({ n: 2 }),
      Exclusive.dispatch({ n: 3 }),
    ])
    await waitFor(() => log.length === 3)
    // 被放回的任务不消耗执行次数
    expect(log.map(line => line.split(':')[2])).toEqual(['1', '1', '1'])
    log.length = 0
    await Queue.chain([
      Work.with({ n: 1 }),
      Work.with({ n: 2 }),
    ]).dispatch()
    await waitFor(() => log.length === 2)
    expect(log).toEqual(['work:1:1', 'work:2:1'])
    // 停止时等待执行中的任务完成
    log.length = 0
    await Work.dispatch({ n: 9, wait: 300 })
    await waitFor(async () => (await Queue.manager().counts())!.active === 1)
    await worker.stop()
    expect(log).toEqual(['work:9:1'])
  })
})

describe('databaseQueue()', () => {
  it('is registered by databaseProvider and reports a helpful error otherwise', async () => {
    const app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        logger: { level: 'silent' },
        queue: {
          default: 'db',
          connections: {
            db: { driver: 'nope' } as never,
          },
        },
      },
    })
    try {
      expect(() => app.make(QueueManager).connection()).toThrow(/unknown driver "nope"/)
      expect(databaseQueue('x').driver).toBe('database')
    }
    finally {
      await app.dispose()
    }
  })
})
