import type { Application } from '@hazejs/core'
import type { ConnectionConfig } from '../src'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApplication, defineRoutes, Tenancy } from '@hazejs/core'
import { sql } from 'drizzle-orm'
import { pgTable, text as pgText, serial } from 'drizzle-orm/pg-core'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseManager, databaseProvider, Db, Model, setDatabaseManager, startTrans, useDatabaseManager } from '../src'

const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  body: text('body').notNull(),
})

class Note extends Model.define(notes) {}

const DDL = sql`create table if not exists notes (id integer primary key autoincrement, body text not null)`

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'haze-replicas-'))
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** 写库与副本是两个独立的 SQLite 文件：直接写入“副本”，以证明读取走副本 */
function files(name: string): { writer: string, replica: string } {
  return {
    writer: `file:${join(dir, `${name}-writer.db`)}`,
    replica: `file:${join(dir, `${name}-replica.db`)}`,
  }
}

/** 通过直连写库 / 副本的连接（writer、replica）准备数据 */
async function seed(writer: string, replica: string): Promise<void> {
  for (const [connection, body] of [
    ['writer', writer],
    ['replica', replica],
  ]) {
    await Db.connection(connection).execute(DDL)
    await Db.connection(connection).execute(sql`delete from notes`)
    // 两边同一个主键：模拟复制后的同一行
    await Db.connection(connection).table(notes).insert({ id: 1, body })
  }
}

describe('read / write splitting on sqlite files', () => {
  let manager: DatabaseManager

  beforeEach(async () => {
    const { writer, replica } = files('main')
    manager = new DatabaseManager({
      default: 'main',
      connections: {
        main: {
          driver: 'sqlite',
          url: writer,
          read: { url: replica },
          sticky: true,
        },
        plain: {
          driver: 'sqlite',
          url: writer,
          read: [
            { url: replica },
          ],
        },
        writer: { driver: 'sqlite', url: writer },
        replica: { driver: 'sqlite', url: replica },
      },
    })
    setDatabaseManager(manager)
    await seed('on writer', 'on replica')
  })

  afterEach(async () => {
    await manager.close()
  })

  it('reads from the replica and writes to the writer', async () => {
    expect(await Db.table(notes).column('body')).toEqual(['on replica'])
    expect((await Note.all()).map(note => note.body)).toEqual(['on replica'])
    expect(await Note.count()).toBe(1)

    await Db.table(notes).insert({ body: 'inserted' })
    await Note.create({ body: 'created' })
    await Db.table(notes).where('body', 'on writer').update({ body: 'updated' })
    await Db.table(notes).upsert({ id: 100, body: 'upserted' })
    await Db.table(notes).where('body', 'inserted').delete()
    expect(await Db.connection('writer').table(notes).order('id').column('body')).toEqual(['updated', 'created', 'upserted'])
    expect(await Db.connection('replica').table(notes).column('body')).toEqual(['on replica'])
    // 没有请求 / 作用域时不 sticky：仍读副本
    expect(await Db.table(notes).column('body')).toEqual(['on replica'])
  })

  it('uses the writer for transactions, locks and useWriter()', async () => {
    await Db.transaction(async () => {
      expect(await Db.table(notes).column('body')).toEqual(['on writer'])
      expect((await Note.all()).map(note => note.body)).toEqual(['on writer'])
    })
    await startTrans()
    expect(await Note.query().column('body')).toEqual(['on writer'])
    await Db.rollback()

    expect(await Db.table(notes).lock().column('body')).toEqual(['on writer'])
    expect(await Db.table(notes).useWriter().column('body')).toEqual(['on writer'])
    expect((await Note.onWriter().select()).map(note => note.body)).toEqual(['on writer'])
    expect(await Db.useWriter(() => Db.table(notes).column('body'))).toEqual(['on writer'])
    expect(await Db.useWriter(() => Note.query().column('body'))).toEqual(['on writer'])
    // 原生 SQL 与 Db.drizzle() 默认走写库，drizzle({ read: true }) 按规则选择副本
    expect(await Db.execute(sql`select body from notes`)).toEqual([
      { body: 'on writer' },
    ])
    expect(await (await Db.drizzle()).select().from(notes)).toMatchObject([
      { body: 'on writer' },
    ])
    expect(await (await Db.drizzle({ read: true })).select().from(notes)).toMatchObject([
      { body: 'on replica' },
    ])
    // refresh() 读写库（通常紧跟在写入之后）
    const note = await Note.findOrFail(1)
    expect(note.body).toBe('on replica')
    expect((await note.refresh()).body).toBe('on writer')
  })

  it('sticks to the writer after a write within Db.withinScope()', async () => {
    await Db.withinScope(async () => {
      expect(await Note.query().column('body')).toEqual(['on replica'])
      await Note.create({ body: 'fresh' })
      expect(await Note.query().column('body')).toEqual(['on writer', 'fresh'])
      // 原生写入同样触发 sticky
    })
    await Db.withinScope(async () => {
      await Db.execute(sql`update notes set body = 'raw'`)
      expect(await Db.table(notes).value('body')).toBe('raw')
    })
    await Db.withinScope(async () => {
      await (await Db.drizzle()).insert(notes).values({ body: 'drizzle' })
      expect(await Db.table(notes).count()).toBe(3)
      // 只读语句不触发 sticky
    })
    await Db.withinScope(async () => {
      await Db.execute(sql`select 1`)
      expect(await Db.table(notes).count()).toBe(1)
    })
    // 作用域外恢复读副本
    expect(await Db.table(notes).column('body')).toEqual(['on replica'])
    // 未开启 sticky 的连接写入后仍读副本
    await Db.withinScope(async () => {
      await Db.connection('plain').table(notes).insert({ body: 'plain' })
      expect(await Db.connection('plain').table(notes).column('body')).toEqual(['on replica'])
    })
  })

  it('records which side ran each query', async () => {
    const records: Array<Record<string, unknown>> = []
    const kHub = Symbol.for('hazejs.telemetry')
    ;(globalThis as Record<symbol, unknown>)[kHub] = {
      listeners: new Set([
        () => {},
      ]),
      record: (kind: string, data: Record<string, unknown>) => kind === 'query' && records.push(data),
    }
    try {
      await Db.table(notes).count()
      await Db.table(notes).insert({ body: 'x' })
    }
    finally {
      delete (globalThis as Record<symbol, unknown>)[kHub]
    }
    expect(records.map(record => [String(record.sql).split(' ')[0], record.replica ?? false])).toEqual([
      ['select', true],
      ['insert', false],
    ])
  })

  it('accepts pool options and rejects unsupported drivers', async () => {
    const postgres = new DatabaseManager({
      default: 'pg',
      connections: {
        // postgres.js / mysql2 的连接池在第一次查询时才连接
        pg: {
          driver: 'postgres',
          url: 'postgres://127.0.0.1:1/none',
          pool: { max: 3, idleTimeout: '30s', connectTimeout: '500ms' },
        },
        my: {
          driver: 'mysql',
          url: 'mysql://root@127.0.0.1:1/none',
          pool: { max: 4, idleTimeout: '1m', connectTimeout: 5 },
        },
        replicated: {
          driver: 'postgres',
          url: 'postgres://127.0.0.1:1/none',
          read: [
            { url: 'postgres://127.0.0.1:2/none' },
            { url: 'postgres://127.0.0.1:3/none' },
          ],
          pool: 2,
        },
        mongo: {
          driver: 'mongodb',
          url: 'mongodb://127.0.0.1:1/none',
          read: { url: 'mongodb://127.0.0.1:2/none' },
        },
        bad: {
          driver: 'postgres',
          url: 'postgres://127.0.0.1:1/none',
          pool: { idleTimeout: 'soon' },
        },
      },
    })
    try {
      const pg = await postgres.connection('pg')
      expect(pg.db.$client.options).toMatchObject({ max: 3, idle_timeout: 30, connect_timeout: 0.5 })
      const my = await postgres.connection('my')
      expect(my.db.$client.pool.config).toMatchObject({ connectionLimit: 4, idleTimeout: 60_000 })
      expect(my.db.$client.pool.config.connectionConfig.connectTimeout).toBe(5000)
      const replicated = await postgres.connection('replicated')
      expect(replicated.replicas).toHaveLength(2)
      expect(replicated.replicas.map(replica => replica.$client.options.port[0])).toEqual([2, 3])
      expect(replicated.replicas[0].$client.options.max).toBe(2)
      await expect(postgres.connection('mongo')).rejects.toThrow('read / write splitting is not supported for mongodb')
      await expect(postgres.connection('bad')).rejects.toThrow('Invalid duration "soon"')
    }
    finally {
      await postgres.close()
    }
  })
})

describe('read / write splitting on pglite', () => {
  const pgNotes = pgTable('notes', {
    id: serial('id').primaryKey(),
    body: pgText('body').notNull(),
  })
  let manager: DatabaseManager

  beforeEach(async () => {
    // 两个独立的内存 PGlite 实例：未写 url 的副本继承连接配置（内存库）
    manager = new DatabaseManager({
      default: 'main',
      connections: {
        main: {
          driver: 'pglite',
          read: [{}],
          sticky: true,
        },
      },
    })
    setDatabaseManager(manager)
    const ddl = sql`create table notes (id serial primary key, body text not null)`
    await Db.execute(ddl)
    await Db.table(pgNotes).insert({ body: 'on writer' })
    const replica = await Db.drizzle({ read: true })
    await replica.execute(ddl)
    await replica.insert(pgNotes).values({ body: 'on replica' })
  })

  afterEach(async () => {
    await manager.close()
  })

  it('routes reads, writes, transactions and sticky scopes', async () => {
    expect(await Db.table(pgNotes).column('body')).toEqual(['on replica'])
    await Db.table(pgNotes).insert({ body: 'second' })
    expect(await Db.table(pgNotes).column('body')).toEqual(['on replica'])
    expect(await Db.transaction(() => Db.table(pgNotes).order('id').column('body'))).toEqual(['on writer', 'second'])
    expect(await Db.table(pgNotes).lock().order('id').column('body')).toEqual(['on writer', 'second'])
    await Db.withinScope(async () => {
      await Db.table(pgNotes).where('body', 'second').delete()
      expect(await Db.table(pgNotes).column('body')).toEqual(['on writer'])
    })
  })
})

describe('read / write splitting in requests and tenants', () => {
  let app: Application | undefined

  afterEach(async () => {
    await useDatabaseManager().close()
    await app?.dispose()
    app = undefined
  })

  async function boot(connections: Record<string, ConnectionConfig>, tenancy?: Record<string, unknown>): Promise<Application> {
    app = await createApplication({
      mode: 'test',
      env: false,
      providers: [
        databaseProvider(),
      ],
      routes: [
        defineRoutes((r) => {
          r.get('/notes', async () => Note.query().column('body'))
          r.post('/notes', async (ctx) => {
            await Note.create({ body: (await ctx.body<{ body: string }>()).body })
            return Note.query().order('id').column('body')
          })
        }),
      ],
      config: {
        logger: { level: 'silent' },
        database: {
          default: 'main',
          connections,
        },
        ...(tenancy && { tenancy }),
      },
    })
    return app
  }

  it('sticks to the writer for the rest of a request after a write', async () => {
    const { writer, replica } = files('request')
    const app = await boot({
      main: {
        driver: 'sqlite',
        url: writer,
        read: { url: replica },
        sticky: true,
      },
      writer: { driver: 'sqlite', url: writer },
      replica: { driver: 'sqlite', url: replica },
    })
    await seed('on writer', 'on replica')
    const json = async (response: Promise<Response>): Promise<unknown> => ((await (await response).json()) as { data: unknown }).data
    expect(await json(app.request('/notes'))).toEqual(['on replica'])
    // 同一个请求中写入后读取写库
    expect(await json(app.request('/notes', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ body: 'posted' }),
    }))).toEqual(['on writer', 'posted'])
    // 下一个请求重新读副本
    expect(await json(app.request('/notes'))).toEqual(['on replica'])
  })

  it('combines per-tenant connections with replicas', async () => {
    const urls = {
      acme: files('acme'),
      globex: files('globex'),
    }
    await boot({
      main: { driver: 'sqlite', url: ':memory:' },
    }, {
      find: (key: string) => (key in urls
        ? { id: key }
        : undefined),
      database: {
        connections: ['main'],
        config: (tenant: { id: string }, base: ConnectionConfig) => ({
          ...base,
          url: urls[tenant.id as keyof typeof urls].writer,
          read: { url: urls[tenant.id as keyof typeof urls].replica },
          sticky: true,
        }),
      },
    })
    for (const tenant of ['acme', 'globex'] as const) {
      await Tenancy.run(tenant, async () => {
        await Db.execute(DDL)
        await Db.execute(sql`delete from notes`)
        await Db.table(notes).insert({ body: `${tenant} writer` })
        const replica = await Db.drizzle({ read: true })
        await replica.run(DDL)
        await replica.run(sql`delete from notes`)
        await replica.insert(notes).values({ body: `${tenant} replica` })
      })
    }
    expect(await Tenancy.run('acme', () => Note.query().column('body'))).toEqual(['acme replica'])
    expect(await Tenancy.run('globex', () => Note.query().column('body'))).toEqual(['globex replica'])
    expect(await Tenancy.run('acme', () => Db.withinScope(async () => {
      await Note.create({ body: 'acme new' })
      return Note.query().order('id').column('body')
    }))).toEqual(['acme writer', 'acme new'])
    // sticky 按租户连接（main@acme）记录，其它租户不受影响
    expect(await Tenancy.run('globex', () => Note.query().column('body'))).toEqual(['globex replica'])
    expect(useDatabaseManager().connectionConfig('main@acme').read).toEqual({ url: urls.acme.replica })
  })
})
