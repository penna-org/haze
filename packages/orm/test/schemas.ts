import process from 'node:process'
import { int as myInt, serial as mySerial, mysqlTable, text as myText, timestamp as myTimestamp, varchar } from 'drizzle-orm/mysql-core'
import { integer as pgInt, pgTable, text as pgText, timestamp as pgTimestamp, serial } from 'drizzle-orm/pg-core'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

// 三种方言的同构表结构，用同一套用例验证 ORM 行为

const sqlite = {
  users: sqliteTable('users', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    name: text('name').notNull(),
    email: text('email'),
    status: integer('status').notNull().default(1),
    age: integer('age'),
    createdAt: integer('created_at', { mode: 'timestamp' }),
    updatedAt: integer('updated_at', { mode: 'timestamp' }),
    deletedAt: integer('deleted_at', { mode: 'timestamp' }),
  }),
  posts: sqliteTable('posts', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    title: text('title').notNull(),
    views: integer('views').notNull().default(0),
  }),
  profiles: sqliteTable('profiles', {
    id: integer('id').primaryKey({ autoIncrement: true }),
    userId: integer('user_id').notNull(),
    bio: text('bio'),
  }),
}

const postgres = {
  users: pgTable('users', {
    id: serial('id').primaryKey(),
    name: pgText('name').notNull(),
    email: pgText('email'),
    status: pgInt('status').notNull().default(1),
    age: pgInt('age'),
    createdAt: pgTimestamp('created_at'),
    updatedAt: pgTimestamp('updated_at'),
    deletedAt: pgTimestamp('deleted_at'),
  }),
  posts: pgTable('posts', {
    id: serial('id').primaryKey(),
    userId: pgInt('user_id').notNull(),
    title: pgText('title').notNull(),
    views: pgInt('views').notNull().default(0),
  }),
  profiles: pgTable('profiles', {
    id: serial('id').primaryKey(),
    userId: pgInt('user_id').notNull(),
    bio: pgText('bio'),
  }),
}

const mysql = {
  users: mysqlTable('users', {
    id: mySerial('id').primaryKey(),
    name: varchar('name', { length: 255 }).notNull(),
    email: varchar('email', { length: 255 }),
    status: myInt('status').notNull().default(1),
    age: myInt('age'),
    createdAt: myTimestamp('created_at'),
    updatedAt: myTimestamp('updated_at'),
    deletedAt: myTimestamp('deleted_at'),
  }),
  posts: mysqlTable('posts', {
    id: mySerial('id').primaryKey(),
    userId: myInt('user_id').notNull(),
    title: myText('title').notNull(),
    views: myInt('views').notNull().default(0),
  }),
  profiles: mysqlTable('profiles', {
    id: mySerial('id').primaryKey(),
    userId: myInt('user_id').notNull(),
    bio: myText('bio'),
  }),
}

/** 测试只使用 SQLite 表的类型；运行时按方言切换（列名与语义一致） */
export type Schema = typeof sqlite

const ddl = {
  sqlite: [
    'create table users (id integer primary key autoincrement, name text not null, email text, status integer not null default 1, age integer, created_at integer, updated_at integer, deleted_at integer)',
    'create table posts (id integer primary key autoincrement, user_id integer not null, title text not null, views integer not null default 0)',
    'create table profiles (id integer primary key autoincrement, user_id integer not null, bio text)',
  ],
  postgres: [
    'create table users (id serial primary key, name text not null, email text, status integer not null default 1, age integer, created_at timestamp, updated_at timestamp, deleted_at timestamp)',
    'create table posts (id serial primary key, user_id integer not null, title text not null, views integer not null default 0)',
    'create table profiles (id serial primary key, user_id integer not null, bio text)',
  ],
  mysql: [
    'drop table if exists users, posts, profiles',
    'create table users (id serial primary key, name varchar(255) not null, email varchar(255), status int not null default 1, age int, created_at timestamp null, updated_at timestamp null, deleted_at timestamp null)',
    'create table posts (id serial primary key, user_id int not null, title text not null, views int not null default 0)',
    'create table profiles (id serial primary key, user_id int not null, bio text)',
  ],
}

export const dialects = [
  {
    name: 'sqlite',
    connection: { driver: 'sqlite' as const, url: ':memory:' },
    schema: sqlite,
    ddl: ddl.sqlite,
  },
  {
    name: 'pglite',
    connection: { driver: 'pglite' as const },
    schema: postgres as unknown as Schema,
    ddl: ddl.postgres,
  },
  // MySQL 需要真实服务：THINK_TEST_MYSQL_URL=mysql://root:pass@127.0.0.1:3306/test
  ...(process.env.THINK_TEST_MYSQL_URL
    ? [
        {
          name: 'mysql',
          connection: { driver: 'mysql' as const, url: process.env.THINK_TEST_MYSQL_URL },
          schema: mysql as unknown as Schema,
          ddl: ddl.mysql,
        },
      ]
    : []),
]
