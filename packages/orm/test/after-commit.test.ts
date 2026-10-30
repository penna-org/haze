import type { Application } from '@hazejs/core'
import { afterCommit, createApplication, defineEvent, defineJob, defineListener, Queue, QueueManager, runInApp, useApp } from '@hazejs/core'
import { sql } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseManager, databaseProvider, Db, setDatabaseManager } from '../src'
import { dialects } from './schemas'

// 事务提交后再执行：Db.afterCommit()、任务与事件的 afterCommit（core 的钩子由 @hazejs/orm 实现）

const local = dialects.filter(dialect => dialect.name === 'sqlite' || dialect.name === 'pglite')

const log: string[] = []

describe.each(local)('afterCommit on $name', (dialect) => {
  const { users } = dialect.schema
  let manager: DatabaseManager

  beforeAll(async () => {
    await dialect.setup?.()
  })

  beforeEach(async () => {
    await manager?.close()
    manager = new DatabaseManager({
      default: 'main',
      connections: { main: dialect.connection },
    } as never)
    setDatabaseManager(manager)
    for (const statement of dialect.ddl)
      await Db.execute(sql.raw(statement))
    log.length = 0
  })

  afterAll(async () => {
    await manager.close()
    await dialect.dispose?.()
  })

  it('runs immediately outside a transaction', async () => {
    await Db.afterCommit(() => void log.push('now'))
    expect(log).toEqual(['now'])
  })

  it('runs after the outermost commit, before transaction() returns', async () => {
    await Db.transaction(async () => {
      await Db.table(users).insert({ name: 'Ada' })
      await Db.afterCommit(async () => {
        // 已提交：回调中不在事务里，看得到提交的数据
        log.push(`outer:${Db.inTransaction()}:${await Db.table(users).count()}`)
      })
      await Db.transaction(async () => {
        await Db.afterCommit(() => void log.push('savepoint'))
      })
      // 保存点提交后仍等待最外层
      expect(log).toEqual([])
    })
    expect(log).toEqual(['outer:false:1', 'savepoint'])
  })

  it('drops callbacks on rollback, including those of a rolled back savepoint', async () => {
    await expect(Db.transaction(async () => {
      await Db.afterCommit(() => void log.push('outer'))
      throw new Error('rollback')
    })).rejects.toThrow('rollback')
    expect(log).toEqual([])

    await Db.transaction(async () => {
      await Db.afterCommit(() => void log.push('kept'))
      await Db.transaction(async () => {
        await Db.afterCommit(() => void log.push('dropped'))
        throw new Error('savepoint')
      }).catch(() => {})
    })
    expect(log).toEqual(['kept'])
  })

  it('supports manual transactions (startTrans / commit / rollback)', async () => {
    await Db.startTrans()
    await Db.afterCommit(() => void log.push('committed'))
    expect(log).toEqual([])
    await Db.commit()
    expect(log).toEqual(['committed'])

    await Db.startTrans()
    await Db.afterCommit(() => void log.push('rolled back'))
    await Db.rollback()
    expect(log).toEqual(['committed'])
  })

  it('logs errors thrown by deferred callbacks instead of failing the committed transaction', async () => {
    const result = await Db.transaction(async () => {
      await Db.afterCommit(() => {
        throw new Error('callback failed')
      })
      await Db.afterCommit(() => void log.push('next'))
      return 'done'
    })
    expect(result).toBe('done')
    expect(log).toEqual(['next'])
  })

  it('treats joinTransaction() as committed when its callback resolves', async () => {
    const db = await Db.drizzle()
    await (db as any).transaction(async (tx: unknown) => Db.joinTransaction(tx as never, async () => {
      await Db.afterCommit(() => void log.push('joined'))
      expect(log).toEqual([])
    }))
    expect(log).toEqual(['joined'])
  })
})

describe('jobs and events with afterCommit', () => {
  const apps: Application[] = []
  const { users } = dialects[0]!.schema

  beforeEach(() => {
    log.length = 0
  })

  afterEach(async () => {
    await Promise.all(apps.splice(0).map(app => app.dispose()))
  })

  const Notify = defineJob({
    afterCommit: true,
    async handle(payload: { id: number }) {
      // 任务在所属应用的上下文中执行：Db 使用这个应用的连接，看得到已提交的数据
      log.push(`job:${payload.id}:${await Db.table(users).count()}:${useApp().config.get('app.name')}`)
    },
  })
  const Created = defineEvent<{ id: number }>({ afterCommit: true })
  const OnCreated = defineListener(Created, async ({ id }) => {
    log.push(`event:${id}:${await Db.table(users).count()}`)
  })

  async function boot(name: string): Promise<Application> {
    const app = await createApplication({
      mode: 'test',
      env: false,
      providers: [
        databaseProvider(),
      ],
      jobs: {
        '/app/job/Notify.ts': { default: Notify },
      },
      events: {
        '/app/event/Created.ts': { default: Created },
      },
      listeners: {
        '/app/listener/OnCreated.ts': { default: OnCreated },
      },
      config: {
        app: { name },
        logger: { level: 'silent' },
        // 连接池按连接名在进程内共享：两个应用使用不同的连接名
        database: {
          default: name,
          connections: {
            [name]: { driver: 'sqlite', url: ':memory:' },
          },
        },
        queue: { default: 'sync' },
      },
    })
    apps.push(app)
    for (const statement of dialects[0]!.ddl)
      await Db.withManager(app.make(DatabaseManager), () => Db.execute(sql.raw(statement)))
    return app
  }

  it('dispatches jobs and emits events only after the transaction commits', async () => {
    const app = await boot('first')
    // 第二个应用最后启动：任务中的 Db 原来会解析到它（空表）
    await boot('second')
    // runInApp()：门面（Db、任务、事件）都解析到 first（脚本 / 测试中固定应用）
    await runInApp(app, async () => {
      await Db.transaction(async () => {
        await Db.table(users).insert({ name: 'Ada' })
        const result = await Notify.with({ id: 1 }).dispatch()
        expect(result.deferred).toBe(true)
        await Created.emit({ id: 1 })
        await afterCommit(() => void log.push('callback'))
        expect(log).toEqual([])
      })
      expect(log).toEqual(['job:1:1:first', 'event:1:1', 'callback'])

      log.length = 0
      await Db.transaction(async () => {
        await Notify.dispatch({ id: 2 })
        await Created.emit({ id: 2 })
        throw new Error('rollback')
      }).catch(() => {})
      expect(log).toEqual([])
    })
  })

  it('runs jobs with the database of the application that owns them', async () => {
    const app = await boot('first')
    await Db.withManager(app.make(DatabaseManager), () => Db.table(users).insert({ name: 'Ada' }))
    await boot('second')
    // 请求与 withManager 之外：任务中的 Db 使用所属应用（first）的连接，而不是最近启动的应用
    await app.make(QueueManager).dispatch(Notify, { id: 9 })
    expect(log).toEqual(['job:9:1:first'])
  })

  it('queue.fake() records a deferred dispatch after commit', async () => {
    const app = await boot('first')
    const fake = Queue.fake()
    await Db.withManager(app.make(DatabaseManager), () => Db.transaction(async () => {
      await Notify.dispatch({ id: 3 })
      fake.assertCount(0)
    }))
    fake.assertDispatched(Notify, payload => payload.id === 3)
  })
})
