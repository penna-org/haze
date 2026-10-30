import type { ConnectionConfig } from '../src'
import process from 'node:process'
import { PGlite } from '@electric-sql/pglite'
import { sql } from 'drizzle-orm'
import { integer, pgTable, timestamp, varchar } from 'drizzle-orm/pg-core'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseManager, Db, Model, setDatabaseManager } from '../src'

// 表定义不写列名：列名由连接的 casing 生成（itemCount → item_count）
const orders = pgTable('orders', {
  id: integer().primaryKey().generatedAlwaysAsIdentity(),
  orderNo: varchar({ length: 20 }).notNull().unique(),
  itemCount: integer().notNull().default(0),
  createdAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
})

const archivedOrders = pgTable('archived_orders', {
  orderNo: varchar({ length: 20 }).notNull(),
  itemCount: integer().notNull(),
})

class Order extends Model.define(orders) {
  static override timestamps = false as const
}

const DDL = [
  sql`create table orders (id integer generated always as identity primary key, order_no varchar(20) not null unique, item_count integer not null default 0, created_at timestamptz not null default now())`,
  sql`create table archived_orders (order_no varchar(20) not null, item_count integer not null)`,
]

let manager: DatabaseManager | undefined

function use(connection: ConnectionConfig): DatabaseManager {
  manager = new DatabaseManager({
    default: 'main',
    connections: { main: connection },
  })
  setDatabaseManager(manager)
  return manager
}

afterEach(async () => {
  await manager?.close()
  setDatabaseManager(undefined)
  manager = undefined
})

describe('casing', () => {
  it('maps unnamed columns with snake_case in queries, models, upserts and selectInsert', async () => {
    use({ driver: 'pglite', casing: 'snake_case' })
    for (const statement of DDL)
      await Db.execute(statement)

    await Db.table(orders).insert({ orderNo: 'A1', itemCount: 2 })
    await Order.create({ orderNo: 'A2', itemCount: 5 })
    expect(await Db.table(orders).where('itemCount', '>', 1).order('id').column('orderNo')).toEqual(['A1', 'A2'])
    expect((await Order.where('orderNo', 'A2').find())?.itemCount).toBe(5)

    // upsert 的 excluded.<列名> 与 selectInsert 的列清单按 casing 转换
    await Db.table(orders).upsert({ orderNo: 'A1', itemCount: 9 }, {
      target: 'orderNo',
      update: ['itemCount'],
    })
    expect(await Db.table(orders).where('orderNo', 'A1').value('itemCount')).toBe(9)
    await Db.table(orders).field({ orderNo: orders.orderNo, itemCount: orders.itemCount }).selectInsert(archivedOrders)
    expect(await Db.execute(sql`select order_no, item_count from archived_orders order by order_no`))
      .toEqual([
        { order_no: 'A1', item_count: 9 },
        { order_no: 'A2', item_count: 5 },
      ])

    // 原生 drizzle 查询同样使用连接的 casing
    const db = await Db.drizzle()
    expect(await db.select({ count: orders.itemCount }).from(orders).where(sql`${orders.orderNo} = 'A2'`)).toEqual([
      { count: 5 },
    ])
  })
})

describe('session time zone', () => {
  it('sets the PostgreSQL TimeZone for pglite', async () => {
    use({ driver: 'pglite', timezone: 'Asia/Shanghai' })
    expect(await Db.execute(sql`show timezone`)).toEqual([
      { TimeZone: 'Asia/Shanghai' },
    ])
    // 按日期计算使用会话时区：UTC 16:30 在上海已是第二天
    expect(await Db.execute(sql`select ('2026-10-28T16:30:00Z'::timestamptz)::date::text as day`)).toEqual([
      { day: '2026-10-29' },
    ])
  })

  it('rejects timezone for drivers that do not support it', async () => {
    use({ driver: 'sqlite', url: ':memory:', timezone: 'Asia/Shanghai' })
    await expect(Db.execute(sql`select 1`)).rejects.toThrow(/timezone is only supported/)
  })
})

describe('existing clients', () => {
  it('uses a PGlite instance owned by the caller and leaves it open on close', async () => {
    const client = new PGlite()
    try {
      await client.query('create table notes (id integer primary key, body text)')
      await client.query(`insert into notes values (1, 'from the caller')`)
      const first = use({ driver: 'pglite', client })
      expect(await Db.execute(sql`select body from notes`)).toEqual([
        { body: 'from the caller' },
      ])

      // 另一个应用实例（如测试中的第二个应用）用同一个客户端：共用数据
      const second = new DatabaseManager({
        default: 'main',
        connections: {
          main: { driver: 'pglite', client },
        },
      })
      await (await second.connection()).db.execute(sql`insert into notes values (2, 'second app')`)
      expect(await Db.execute(sql`select count(*)::int as n from notes`)).toEqual([
        { n: 2 },
      ])

      await first.close()
      await second.close()
      expect((await client.query<{ n: number }>('select count(*)::int as n from notes')).rows).toEqual([
        { n: 2 },
      ])
    }
    finally {
      await client.close()
    }
  })
})

describe('synchronous session access', () => {
  it('needs an open connection, then follows transactions', async () => {
    use({ driver: 'pglite', casing: 'snake_case' })
    expect(() => Db.drizzleSync()).toThrow(/not open yet/)
    await Db.connect()
    const root = Db.drizzleSync()
    for (const statement of DDL)
      await root.execute(statement)

    await Db.transaction(async (tx) => {
      expect(Db.drizzleSync()).toBe(tx)
      await Db.drizzleSync().insert(orders).values({ orderNo: 'T1' })
    })
    expect(Db.drizzleSync()).toBe(root)

    await Db.startTrans()
    expect(Db.drizzleSync()).not.toBe(root)
    await Db.drizzleSync().insert(orders).values({ orderNo: 'T2' })
    await Db.rollback()
    expect(await Db.table(orders).column('orderNo')).toEqual(['T1'])
  })

  it('lets transactions opened outside the ORM join the context', async () => {
    use({ driver: 'pglite', casing: 'snake_case' })
    for (const statement of DDL)
      await Db.execute(statement)
    const db = await Db.drizzle()

    // 第三方库自己开启事务，回调中的 Db / Model 与同步取用都加入它，失败时一起回滚
    await expect(db.transaction(async (tx: typeof db) => Db.joinTransaction(tx, async () => {
      expect(Db.inTransaction()).toBe(true)
      expect(Db.drizzleSync()).toBe(tx)
      await Order.create({ orderNo: 'J1' })
      await Db.table(orders).insert({ orderNo: 'J2' })
      throw new Error('boom')
    }))).rejects.toThrow('boom')
    expect(await Db.table(orders).count()).toBe(0)

    // 加入后再开启的事务是保存点：内层失败只撤销内层
    await db.transaction(async (tx: typeof db) => Db.joinTransaction(tx, async () => {
      await Db.table(orders).insert({ orderNo: 'J3' })
      await Db.transaction(async () => {
        await Db.table(orders).insert({ orderNo: 'J4' })
        throw new Error('inner')
      }).catch(() => {})
    }))
    expect(await Db.table(orders).column('orderNo')).toEqual(['J3'])
    expect(Db.inTransaction()).toBe(false)
  })
})

// 真实的 PostgreSQL：HAZE_TEST_PG_URL=postgres://user:pass@127.0.0.1:5432/test
describe.skipIf(!process.env.HAZE_TEST_PG_URL)('postgreSQL drivers', () => {
  for (const driver of ['node-postgres', 'postgres'] as const) {
    it(`${driver}: casing, time zone and transactions`, async () => {
      use({
        driver,
        url: process.env.HAZE_TEST_PG_URL,
        casing: 'snake_case',
        timezone: 'Asia/Shanghai',
        pool: 2,
      })
      expect(await Db.execute(sql`show timezone`)).toEqual([
        { TimeZone: 'Asia/Shanghai' },
      ])
      await Db.execute(sql`drop table if exists archived_orders, orders`)
      for (const statement of DDL)
        await Db.execute(statement)
      await Db.transaction(async () => {
        await Order.create({ orderNo: 'P1', itemCount: 3 })
      })
      expect(await Order.where('itemCount', 3).count()).toBe(1)
      await Db.execute(sql`drop table archived_orders, orders`)
    })
  }

  it('node-postgres: uses an existing pg.Pool without closing it', async () => {
    const pg = await import('pg')
    const pool = new pg.default.Pool({ connectionString: process.env.HAZE_TEST_PG_URL, max: 1 })
    try {
      use({ driver: 'node-postgres', client: pool })
      expect(await Db.execute(sql`select 1 as one`)).toEqual([
        { one: 1 },
      ])
      await manager!.close()
      expect((await pool.query('select 2 as two')).rows).toEqual([
        { two: 2 },
      ])
    }
    finally {
      await pool.end()
    }
  })
})

describe('several applications in one process', () => {
  it('serves each request from its own application and restores the previous manager on close', async () => {
    const { createApplication, defineRoutes } = await import('@hazejs/core')
    const { databaseProvider } = await import('../src')
    const boot = async (client: PGlite) => createApplication({
      mode: 'test',
      env: false,
      config: {
        logger: { level: 'silent' },
        app: {
          response: { envelope: false },
        },
        database: {
          default: 'main',
          connections: {
            main: { driver: 'pglite', client },
          },
        },
      },
      providers: [
        databaseProvider(),
      ],
      routes: [
        defineRoutes(r => r.get('/name', async () => (await Db.execute<{ name: string }>(sql`select name from info`))[0]!.name)),
      ],
    })
    const clients = [
      new PGlite(),
      new PGlite(),
    ]
    try {
      for (const [index, client] of clients.entries())
        await client.exec(`create table info (name text); insert into info values ('app ${index}')`)
      const first = await boot(clients[0]!)
      const second = await boot(clients[1]!)
      // 请求内使用请求所属应用的连接，请求外为最近启动的应用
      expect(await (await first.request('/name')).text()).toBe('app 0')
      expect(await (await second.request('/name')).text()).toBe('app 1')
      expect(await Db.execute(sql`select name from info`)).toEqual([
        { name: 'app 1' },
      ])

      // 请求之外：withManager() 固定使用某个应用的连接（含其中创建的定时器），事务按应用区分
      const firstManager = first.make(DatabaseManager)
      const fromTimer = await Db.withManager(firstManager, () => new Promise(resolve =>
        setTimeout(() => resolve(Db.execute(sql`select name from info`)), 1)))
      expect(fromTimer).toEqual([
        { name: 'app 0' },
      ])
      await Db.withManager(firstManager, () => Db.transaction(async () => {
        expect(Db.inTransaction()).toBe(true)
        // 另一个应用的同名连接不在这个事务中
        expect(Db.withManager(second.make(DatabaseManager), () => Db.inTransaction())).toBe(false)
        expect(await Db.withManager(second.make(DatabaseManager), () => Db.execute(sql`select name from info`))).toEqual([
          { name: 'app 1' },
        ])
      }))

      await second.dispose()
      expect(await (await first.request('/name')).text()).toBe('app 0')
      expect(await Db.execute(sql`select name from info`)).toEqual([
        { name: 'app 0' },
      ])
      await first.dispose()
    }
    finally {
      await Promise.all(clients.map(client => client.close()))
    }
  })
})
