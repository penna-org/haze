import { sql } from 'drizzle-orm'
import { pgTable, text as pgText, serial } from 'drizzle-orm/pg-core'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { DatabaseManager, Db, setDatabaseManager } from '../src'

/** 模拟 @hazejs/core 的遥测总线（只依赖 globalThis 上的约定结构） */
const kHub = Symbol.for('hazejs.telemetry')
const records: Array<Record<string, any>> = []
function installHub() {
  ;(globalThis as Record<symbol, unknown>)[kHub] = {
    listeners: new Set([
      () => {},
    ]),
    record: (kind: string, data: Record<string, unknown>) => {
      if (kind === 'query')
        records.push(data)
    },
  }
}

const dialects = [
  {
    name: 'sqlite',
    connection: { driver: 'sqlite' as const, url: ':memory:' },
    table: sqliteTable('notes', {
      id: integer('id').primaryKey({ autoIncrement: true }),
      body: text('body').notNull(),
    }),
    ddl: sql`create table notes (id integer primary key autoincrement, body text not null)`,
    placeholder: '?',
  },
  {
    name: 'pglite',
    connection: { driver: 'pglite' as const },
    table: pgTable('notes', {
      id: serial('id').primaryKey(),
      body: pgText('body').notNull(),
    }),
    ddl: sql`create table notes (id serial primary key, body text not null)`,
    placeholder: '$1',
  },
]

describe.each(dialects)('orm query telemetry on $name', ({ connection, table: notes, ddl, placeholder }) => {
  let manager: DatabaseManager
  beforeAll(async () => {
    manager = new DatabaseManager({
      default: 'main',
      connections: { main: connection },
    })
    setDatabaseManager(manager)
    await Db.execute(ddl)
  })
  afterEach(() => {
    delete (globalThis as Record<symbol, unknown>)[kHub]
    records.length = 0
  })
  afterAll(async () => {
    await manager.close()
    setDatabaseManager(undefined)
  })

  it('reports each query once with SQL, bindings and duration', async () => {
    installHub()
    await Db.table(notes).insert({ body: 'hello' })
    const row = await Db.table(notes).where('body', 'hello').find()
    expect(row).toMatchObject({ body: 'hello' })

    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      connection: 'main',
      params: ['hello'],
    })
    expect(records[0]!.sql).toMatch(/^insert into "notes"/)
    expect(records[1]!.sql).toContain(`where "notes"."body" = ${placeholder}`)
    expect(records[1]!.params).toEqual(['hello', 1])
    for (const record of records) {
      expect(record.duration).toBeGreaterThanOrEqual(0)
      expect(typeof record.startTime).toBe('number')
    }
  })

  it('covers transactions (including nested ones) and failed queries', async () => {
    installHub()
    await Db.transaction(async () => {
      await Db.table(notes).insert({ body: 'outer' })
      await Db.transaction(async () => {
        await Db.table(notes).insert({ body: 'inner' })
      })
    })
    const inserts = records.filter(record => record.sql.startsWith('insert'))
    expect(inserts.map(record => record.params)).toEqual([
      ['outer'],
      ['inner'],
    ])

    await expect(Db.execute(sql`select * from missing_table`)).rejects.toThrow()
    expect(records.at(-1)).toMatchObject({ sql: 'select * from missing_table' })
    expect(records.at(-1)!.error).toContain('missing_table')
  })

  it('does nothing without listeners', async () => {
    await Db.table(notes).count()
    expect(records).toHaveLength(0)
  })
})
