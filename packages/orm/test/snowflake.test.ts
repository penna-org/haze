import { createApplication, defineRoutes } from '@hazejs/core'
import { sql } from 'drizzle-orm'
import { mysqlTable, text as myText, varchar } from 'drizzle-orm/mysql-core'
import { pgTable, text as pgText } from 'drizzle-orm/pg-core'
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureSnowflake, DatabaseManager, databaseProvider, Db, DEFAULT_SNOWFLAKE_EPOCH, Model, mysqlSnowflake, pgSnowflake, setDatabaseManager, Snowflake, snowflakeId, sqliteSnowflake } from '../src'
import { dialects } from './schemas'

describe('snowflake generator', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('generates unique, increasing 64-bit ids with the MyBatis-Plus layout', () => {
    const generator = new Snowflake({ workerId: 7, datacenterId: 3 })
    const ids = Array.from({ length: 20000 }, () => generator.nextBigInt())
    expect(new Set(ids).size).toBe(ids.length)
    for (let index = 1; index < ids.length; index++)
      expect(ids[index] > ids[index - 1]).toBe(true)
    expect(ids.at(-1)! > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true)

    const parts = Snowflake.parse(ids[0])
    expect([parts.workerId, parts.datacenterId]).toEqual([7, 3])
    expect(Math.abs(parts.time.getTime() - Date.now())).toBeLessThan(5000)
    expect(generator.nextId()).toMatch(/^\d{19}$/)
  })

  it('computes the same id as Java for a fixed time and sequence', () => {
    const now = DEFAULT_SNOWFLAKE_EPOCH + 1000
    vi.spyOn(Date, 'now').mockReturnValue(now)
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const id = new Snowflake({ workerId: 1, datacenterId: 2 }).nextBigInt()
    // ((1000 << 22) | (2 << 17) | (1 << 12) | 1)，与 MyBatis-Plus 的位运算一致
    expect(id).toBe((1000n << 22n) | (2n << 17n) | (1n << 12n) | 1n)
    expect(Snowflake.parse(id)).toEqual({
      time: new Date(now),
      datacenterId: 2,
      workerId: 1,
      sequence: 1,
    })
  })

  it('waits for the next millisecond when the sequence is exhausted and rejects large clock rollbacks', () => {
    let now = 1_700_000_000_000
    let calls = 0
    vi.spyOn(Date, 'now').mockImplementation(() => {
      calls++
      // 每 5000 次调用前进 1 毫秒：保证同一毫秒内会用完 4096 个序列号
      if (calls % 5000 === 0)
        now++
      return now
    })
    const generator = new Snowflake({ workerId: 0, datacenterId: 0 })
    const ids = Array.from({ length: 4500 }, () => generator.nextBigInt())
    expect(new Set(ids).size).toBe(4500)

    now -= 100
    expect(() => generator.nextBigInt()).toThrow(/Clock moved backwards/)
  })

  it('reads worker and datacenter ids from the environment and validates them', () => {
    vi.stubEnv('SNOWFLAKE_WORKER_ID', '9')
    vi.stubEnv('SNOWFLAKE_DATACENTER_ID', '4')
    expect(new Snowflake()).toMatchObject({ workerId: 9, datacenterId: 4 })
    expect(() => new Snowflake({ workerId: 32 })).toThrow(RangeError)
  })
})

const tables = {
  sqlite: {
    orders: sqliteTable('orders', {
      id: sqliteSnowflake('id').primaryKey(),
      title: text('title').notNull(),
    }),
    items: sqliteTable('items', {
      id: sqliteSnowflake('id').primaryKey(),
      orderId: sqliteSnowflake('order_id', { auto: false }).notNull(),
      name: text('name').notNull(),
    }),
  },
  pg: {
    orders: pgTable('orders', {
      id: pgSnowflake('id').primaryKey(),
      title: pgText('title').notNull(),
    }),
    items: pgTable('items', {
      id: pgSnowflake('id').primaryKey(),
      orderId: pgSnowflake('order_id', { auto: false }).notNull(),
      name: pgText('name').notNull(),
    }),
  },
  mysql: {
    orders: mysqlTable('orders', {
      id: mysqlSnowflake('id').primaryKey(),
      title: varchar('title', { length: 255 }).notNull(),
    }),
    items: mysqlTable('items', {
      id: mysqlSnowflake('id').primaryKey(),
      orderId: mysqlSnowflake('order_id', { auto: false }).notNull(),
      name: myText('name').notNull(),
    }),
  },
}

const ddl = {
  sqlite: [
    'drop table if exists orders',
    'drop table if exists items',
    'create table orders (id text primary key, title text not null)',
    'create table items (id text primary key, order_id text not null, name text not null)',
  ],
  pg: [
    'create table orders (id bigint primary key, title text not null)',
    'create table items (id bigint primary key, order_id bigint not null, name text not null)',
  ],
  mysql: [
    'drop table if exists orders, items',
    'create table orders (id bigint primary key, title varchar(255) not null)',
    'create table items (id bigint primary key, order_id bigint not null, name text not null)',
  ],
}

/** 2^53 + 1：number 无法精确表示的最小正整数 */
const UNSAFE = '9007199254740993'

describe.each(dialects)('snowflake ids on $name', (dialect) => {
  const kind = dialect.connection.driver === 'pglite'
    ? 'pg'
    : dialect.connection.driver === 'mysql'
      ? 'mysql'
      : 'sqlite'
  const { orders, items } = tables[kind] as typeof tables.sqlite

  class Order extends Model.define(orders) {
    items() {
      return this.hasMany(Item, 'orderId')
    }
  }

  class Item extends Model.define(items) {
    order() {
      return this.belongsTo(Order, 'orderId')
    }
  }

  let manager: DatabaseManager

  beforeAll(async () => {
    await dialect.setup?.()
    configureSnowflake({ workerId: 5, datacenterId: 6 })
  })

  beforeEach(async () => {
    manager = new DatabaseManager({
      default: 'main',
      connections: { main: dialect.connection },
    })
    setDatabaseManager(manager)
    await manager.close()
    for (const statement of ddl[kind])
      await Db.execute(sql.raw(statement))
  })

  afterAll(async () => {
    configureSnowflake(undefined)
    await manager.close()
    await dialect.dispose?.()
  })

  it('generates ids on insert and reads them back exactly as strings', async () => {
    const order = await Order.create({ title: 'First' })
    expect(order.id).toMatch(/^\d{19}$/)
    expect(Snowflake.parse(order.id)).toMatchObject({ workerId: 5, datacenterId: 6 })
    expect((await Order.findOrFail(order.id)).title).toBe('First')

    const id = await Db.table(orders).insertGetId({ title: 'Second' })
    expect(typeof id).toBe('string')
    expect(await Db.table(orders).where('id', id as string).value('title')).toBe('Second')

    const [row] = await Db.table(orders).insert({ id: UNSAFE, title: 'Unsafe' })
    expect(row.id).toBe(UNSAFE)
    const found = await Order.findOrFail(UNSAFE)
    expect(found.id).toBe(UNSAFE)
    expect(found.toJSON().id).toBe(UNSAFE)
    expect(await Order.whereIn('id', [UNSAFE, order.id]).count()).toBe(2)

    found.title = 'Renamed'
    await found.save()
    expect(await Db.table(orders).where('id', UNSAFE).value('title')).toBe('Renamed')
    const explicit = snowflakeId()
    await Order.create({ id: explicit, title: 'Explicit' })
    expect((await Order.findOrFail(explicit)).id).toBe(explicit)
  })

  it('matches relations on snowflake keys', async () => {
    const order = await Order.create({ id: UNSAFE, title: 'Order' })
    await order.items().saveAll([
      { name: 'A' },
      { name: 'B' },
    ])
    const [loaded] = await Order.with('items').withCount('items').select()
    expect(loaded.getRelation('items')!.map(item => item.name).sort()).toEqual(['A', 'B'])
    expect(loaded.getAttr('itemsCount')).toBe(2)
    const item = await Item.with('order').findOrFail((loaded.getRelation('items')!)[0].id)
    expect(item.getRelation('order')!.id).toBe(UNSAFE)
    expect(await Order.has('items').count()).toBe(1)
  })

  it.skipIf(dialect.connection.driver === 'd1')('reads raw 64-bit integers without losing precision', async () => {
    const cast = kind === 'pg'
      ? sql.raw(`select ${UNSAFE}::bigint as big, 1 as small`)
      : sql.raw(`select ${UNSAFE} as big, 1 as small`)
    const [row] = await Db.execute<{ big: unknown, small: unknown }>(cast)
    expect(String(row.big)).toBe(UNSAFE)
    expect(row.small).toBe(1)
  })

  it('returns snowflake ids and BigInt values as JSON strings', async () => {
    const app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        database: {
          default: 'main',
          connections: { main: dialect.connection },
        },
      },
      providers: [
        databaseProvider(),
      ],
      routes: [
        defineRoutes((r) => {
          r.get('/orders/:id', ctx => Order.findOrFail(ctx.param('id')))
          r.get('/big', () => ({
            id: BigInt(UNSAFE),
            list: [1n, 2],
          }))
        }),
      ],
    })
    await Order.create({ id: UNSAFE, title: 'Order' })
    const body = await (await app.request(`/orders/${UNSAFE}`)).text()
    expect(body).toContain(`"id":"${UNSAFE}"`)
    expect(await (await app.request('/big')).json()).toMatchObject({
      data: {
        id: UNSAFE,
        list: ['1', 2],
      },
    })
  })
})
