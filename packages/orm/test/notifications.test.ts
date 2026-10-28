import { createApplication, defineNotification, markAsRead, Notification, notify, unreadNotifications } from '@hazejs/core'
import { sql } from 'drizzle-orm'
import { jsonb, pgTable, text as pgText, timestamp } from 'drizzle-orm/pg-core'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DatabaseManager, databaseNotificationStore, databaseProvider, Db, Model, setDatabaseManager } from '../src'

// 与 haze make:notifications-table 生成的表结构一致
const sqliteNotifications = sqliteTable('notifications', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),
  notifiableType: text('notifiable_type').notNull(),
  notifiableId: text('notifiable_id').notNull(),
  data: text('data', { mode: 'json' }).notNull(),
  readAt: integer('read_at', { mode: 'timestamp_ms' }),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
})

const pgNotifications = pgTable('notifications', {
  id: pgText('id').primaryKey(),
  type: pgText('type').notNull(),
  notifiableType: pgText('notifiable_type').notNull(),
  notifiableId: pgText('notifiable_id').notNull(),
  data: jsonb('data').notNull(),
  readAt: timestamp('read_at', { precision: 3 }),
  createdAt: timestamp('created_at', { precision: 3 }).notNull(),
})

const dialects = [
  {
    name: 'sqlite',
    connection: { driver: 'sqlite' as const, url: ':memory:' },
    table: sqliteNotifications,
    ddl: 'create table notifications (id text primary key, type text not null, notifiable_type text not null, notifiable_id text not null, data text not null, read_at integer, created_at integer not null)',
  },
  {
    name: 'pglite',
    connection: { driver: 'pglite' as const },
    table: pgNotifications,
    ddl: 'create table notifications (id text primary key, type text not null, notifiable_type text not null, notifiable_id text not null, data jsonb not null, read_at timestamp(3), created_at timestamp(3) not null)',
  },
]

describe.each(dialects)('databaseNotificationStore on $name', (dialect) => {
  beforeEach(async () => {
    const manager = new DatabaseManager({
      default: 'main',
      connections: { main: dialect.connection },
    })
    setDatabaseManager(manager)
    await manager.close()
    await Db.execute(sql.raw(dialect.ddl))
  })

  it('stores, lists, counts and marks notifications', async () => {
    const store = databaseNotificationStore(dialect.table)
    const ada = { type: 'User', id: '1' }
    const base = Date.now()
    for (const [index, amount] of [10, 20, 30].entries()) {
      await store.insert({
        id: `n${index}`,
        type: index === 2
          ? 'OrderShipped'
          : 'InvoicePaid',
        notifiableType: 'User',
        notifiableId: '1',
        data: {
          amount,
          items: [
            { name: '咖啡' },
          ],
        },
        readAt: null,
        createdAt: new Date(base + index),
      })
    }
    await store.insert({
      id: 'other',
      type: 'InvoicePaid',
      notifiableType: 'User',
      notifiableId: '2',
      data: {},
      readAt: null,
      createdAt: new Date(base),
    })

    const all = await store.list(ada)
    expect(all.map(item => item.id)).toEqual(['n2', 'n1', 'n0'])
    expect(all[2]).toEqual({
      id: 'n0',
      type: 'InvoicePaid',
      notifiableType: 'User',
      notifiableId: '1',
      data: {
        amount: 10,
        items: [
          { name: '咖啡' },
        ],
      },
      readAt: null,
      createdAt: new Date(base),
    })
    expect((await store.list(ada, { limit: 1, offset: 1 })).map(item => item.id)).toEqual(['n1'])
    expect(await store.count(ada, { type: 'InvoicePaid' })).toBe(2)

    expect(await store.markAsRead(['n0', 'other'])).toBe(2)
    expect(await store.markAsRead(['n0'])).toBe(0)
    expect(await store.count(ada, { unread: true })).toBe(2)
    expect((await store.list(ada, { unread: false }))[0].readAt).toBeInstanceOf(Date)
    expect(await store.markAsUnread(['n0'])).toBe(1)
    expect(await store.markAllAsRead(ada)).toBe(3)
    expect(await store.count(ada, { unread: true })).toBe(0)
    expect(await store.delete(['n1', 'n2'])).toBe(2)
    expect(await store.delete([])).toBe(0)
    expect(await store.count(ada)).toBe(1)
  })
})

const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
})

class User extends Model.define(users) {}

const Welcome = defineNotification<{ plan: string }>({
  via: () => ['database'],
  toDatabase: (user: User, { plan }) => ({ plan, name: user.name }),
})

describe('database notification channel (sqlite)', () => {
  const closers: Array<() => Promise<unknown>> = []
  afterEach(async () => {
    for (const close of closers.splice(0))
      await close()
  })

  it('writes notifications for models and reads them back', async () => {
    const app = await createApplication({
      mode: 'test',
      env: false,
      providers: [
        databaseProvider(),
      ],
      discovered: {
        notifications: {
          '/app/notification/Welcome.ts': { default: Welcome },
        },
      },
      config: {
        logger: { level: 'silent' },
        database: {
          default: 'main',
          connections: {
            main: { driver: 'sqlite', url: ':memory:' },
          },
        },
        notification: {
          channels: {
            database: {
              store: () => databaseNotificationStore(sqliteNotifications),
            },
          },
        },
      },
    })
    closers.push(() => app.dispose())
    await Db.execute(sql.raw(dialects[0].ddl))
    await Db.execute(sql.raw('create table users (id integer primary key autoincrement, name text not null)'))
    const ada = await User.create({ name: 'Ada' })

    await notify(ada, Welcome({ plan: 'pro' }))
    // 按创建时间倒序：避免两条落在同一毫秒
    await new Promise(resolve => setTimeout(resolve, 5))
    await Notification.send([ada], Welcome({ plan: 'team' }))
    const unread = await unreadNotifications(ada)
    expect(unread.map(item => item.data)).toEqual([
      { plan: 'team', name: 'Ada' },
      { plan: 'pro', name: 'Ada' },
    ])
    expect(unread[0]).toMatchObject({
      type: 'Welcome',
      notifiableType: 'User',
      notifiableId: String(ada.id),
    })
    expect(await markAsRead(unread[1])).toBe(1)
    expect(await Notification.unreadCount(ada)).toBe(1)
  })
})
