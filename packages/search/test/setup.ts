import type { Application } from '@hazejs/core'
import type { ConnectionConfig } from '@hazejs/orm'
import { createApplication } from '@hazejs/core'
import { databaseProvider, Db, useDatabaseManager } from '@hazejs/orm'
import { sql } from 'drizzle-orm'
import { int, mysqlTable, text as mysqlText, timestamp, varchar } from 'drizzle-orm/mysql-core'
import { integer as pgInteger, pgTable, text as pgText, timestamp as pgTimestamp, serial } from 'drizzle-orm/pg-core'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'
import { searchProvider } from '../src'

export const sqlitePosts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
  body: text('body').notNull().default(''),
  status: text('status').notNull().default('published'),
  views: integer('views').notNull().default(0),
  tenantId: text('tenant_id'),
  deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
})

export const pgPosts = pgTable('posts', {
  id: serial('id').primaryKey(),
  title: pgText('title').notNull(),
  body: pgText('body').notNull().default(''),
  status: pgText('status').notNull().default('published'),
  views: pgInteger('views').notNull().default(0),
  tenantId: pgText('tenant_id'),
  deletedAt: pgTimestamp('deleted_at'),
})

// MySQL 与 ORM 测试共用同一个数据库（CI 中并行运行），使用独立的表名
export const mysqlPosts = mysqlTable('search_posts', {
  id: int('id').primaryKey().autoincrement(),
  title: varchar('title', { length: 200 }).notNull(),
  body: mysqlText('body').notNull(),
  status: varchar('status', { length: 20 }).notNull().default('published'),
  views: int('views').notNull().default(0),
  tenantId: varchar('tenant_id', { length: 50 }),
  deletedAt: timestamp('deleted_at'),
})

export const ddl = {
  sqlite: [
    'drop table if exists posts',
    `create table posts (id integer primary key autoincrement, title text not null, body text not null default '', status text not null default 'published', views integer not null default 0, tenant_id text, deleted_at integer)`,
  ],
  postgres: [
    'drop table if exists posts',
    `create table posts (id serial primary key, title text not null, body text not null default '', status text not null default 'published', views integer not null default 0, tenant_id text, deleted_at timestamp)`,
  ],
  mysql: [
    'drop table if exists search_posts',
    `create table search_posts (id int auto_increment primary key, title varchar(200) not null, body text not null, status varchar(20) not null default 'published', views int not null default 0, tenant_id varchar(50), deleted_at timestamp null) engine=InnoDB`,
  ],
}

export interface BootOptions {
  connection?: ConnectionConfig
  search?: Record<string, unknown>
  queue?: Record<string, unknown>
  tenancy?: Record<string, unknown>
  ddl?: string[]
  jobs?: Record<string, unknown>
}

/** 启动带数据库与搜索的应用，并建表 */
export async function boot(options: BootOptions = {}): Promise<Application> {
  const app = await createApplication({
    mode: 'test',
    env: false,
    providers: [
      databaseProvider(),
      searchProvider(),
    ],
    config: {
      logger: { level: 'silent' },
      database: {
        default: 'main',
        connections: { main: options.connection ?? { driver: 'sqlite', url: ':memory:' } },
      },
      search: options.search ?? {
        default: 'memory',
        engines: { memory: {} },
      },
      ...(options.queue && { queue: options.queue }),
      ...(options.tenancy && { tenancy: options.tenancy }),
    },
  })
  await useDatabaseManager().close()
  for (const statement of options.ddl ?? ddl.sqlite)
    await Db.execute(sql.raw(statement))
  return app
}

export async function shutdown(app: Application | undefined): Promise<void> {
  if (!app)
    return
  await useDatabaseManager().close()
  await app.dispose()
}

export const sample = [
  {
    title: 'Getting started with haze',
    body: 'Install the framework and create your first route',
    status: 'published',
    views: 10,
  },
  {
    title: 'Full-text search',
    body: 'Search posts with Meilisearch, Typesense or the database',
    status: 'published',
    views: 50,
  },
  {
    title: 'Queues and jobs',
    body: 'Dispatch jobs to Redis and process them in a worker',
    status: 'draft',
    views: 5,
  },
  {
    title: 'Search engines compared',
    body: 'Typesense and Meilisearch are fast search servers; the database search is simple',
    status: 'published',
    views: 30,
  },
]
