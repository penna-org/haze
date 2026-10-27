import type { SQL } from 'drizzle-orm'
import type { Connection, DatabaseManager } from './connection'
import type { AnyDatabase } from './types'
import { readFile as readDiskFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { sql } from 'drizzle-orm'
import { useDatabaseManager } from './context'
import { DatabaseError } from './errors'

/** 与 drizzle 迁移器一致的迁移记录（`__drizzle_migrations` 表） */
interface MigrationEntry {
  sql: string[]
  bps: boolean
  folderMillis: number
  hash: string
}

interface Journal {
  entries: { tag: string, when: number, breakpoints: boolean }[]
}

/** 内嵌的迁移文件：相对后端源码目录的路径 → 文件内容（生产构建由框架打包进产物） */
export type MigrationFiles = Record<string, string>

export interface MigrateOptions {
  /** 连接名，默认 default 连接 */
  connection?: string
  /** 迁移目录（drizzle-kit generate 的输出目录）；配合 files 时为其中的相对路径 */
  folder: string
  /** 从内嵌文件读取迁移而不是磁盘（Edge / Serverless 产物没有源码目录） */
  files?: MigrationFiles
  manager?: DatabaseManager
}

export interface MigrateResult {
  connection: string
  folder: string
  /** 本次执行的迁移数 */
  applied: number
  /** 迁移总数 */
  total: number
}

/**
 * 执行 drizzle-kit 生成的迁移（已执行过的会跳过）。迁移记录与 drizzle 自带的迁移器相同，
 * 可与 drizzle-kit migrate 混用。
 */
export async function migrate(options: MigrateOptions): Promise<MigrateResult> {
  const manager = options.manager ?? useDatabaseManager()
  const migrations = await readMigrations(options.folder, options.files)
  const connection = await manager.connection(options.connection)
  if (connection.driver === 'mongodb')
    throw new DatabaseError(`Connection "${connection.name}" is MongoDB, which has no SQL migrations; manage indexes with Mongo.collection().createIndex()`)

  const before = await appliedCount(connection)
  const { db } = connection
  switch (connection.driver) {
    case 'sqlite':
    case 'turso':
      await migrateSqlite(db, migrations, statements => db.session.migrate(statements))
      break
    case 'd1':
      // D1 不支持 BEGIN：以 batch 原子执行
      await migrateSqlite(db, migrations, async statements => statements.length && db.session.batch(statements), true)
      break
    default:
      await db.dialect.migrate(migrations, db.session, { migrationsFolder: options.folder })
  }
  return {
    connection: connection.name,
    folder: options.folder,
    applied: (await appliedCount(connection)) - before,
    total: migrations.length,
  }
}

export interface RunMigrationsOptions {
  /** 连接名，默认 default 连接 */
  connection?: string
  /** 对所有 SQL 连接执行（跳过 MongoDB 与没有迁移的连接） */
  all?: boolean
  /** 内嵌的迁移文件；省略时从 srcDir 读取 */
  files?: MigrationFiles
  /** 后端源码目录，默认 process.cwd() */
  srcDir?: string
  manager?: DatabaseManager
}

export interface RunMigrationsResult extends Partial<MigrateResult> {
  connection: string
  folder: string
  /** 跳过的原因 */
  skipped?: 'mongodb' | 'no-migrations'
}

/** 迁移目录（相对后端源码目录）：连接配置的 migrations，默认连接为 database/migrations，其它为 database/migrations/<name> */
export function migrationsFolder(name?: string, manager: DatabaseManager = useDatabaseManager()): string {
  const connection = name ?? manager.defaultConnection
  return (manager.connectionConfig(connection).migrations ?? (connection === manager.defaultConnection
    ? 'database/migrations'
    : `database/migrations/${connection}`)).replace(/^\.\//, '').replace(/\/+$/, '')
}

/**
 * 按 config/database.ts 执行迁移：`think-h3 db:migrate` 与生产构建的迁移入口
 * （`node dist/server/migrate.mjs`、Lambda 的 `index.migrate`）共用。
 */
export async function runMigrations(options: RunMigrationsOptions = {}): Promise<RunMigrationsResult[]> {
  const manager = options.manager ?? useDatabaseManager()
  const names = options.all
    ? Object.keys(manager.config.connections)
    : [options.connection ?? manager.defaultConnection]
  const results: RunMigrationsResult[] = []
  for (const name of names) {
    const relative = migrationsFolder(name, manager)
    if (manager.connectionConfig(name).driver === 'mongodb') {
      results.push({ connection: name, folder: relative, skipped: 'mongodb' })
      continue
    }
    const folder = options.files || isAbsolute(relative)
      ? relative
      : resolve(options.srcDir ?? process.cwd(), relative)
    if (!(await readFile(journalPath(folder), options.files))) {
      // 显式指定的连接没有迁移视为错误
      if (!options.all)
        throw new DatabaseError(`No migrations for connection "${name}" in ${relative}. Run think-h3 db:generate first.`)
      results.push({ connection: name, folder: relative, skipped: 'no-migrations' })
      continue
    }
    results.push({
      ...await migrate({
        connection: name,
        folder,
        files: options.files,
        manager,
      }),
      folder: relative,
    })
  }
  return results
}

/** 与 drizzle 的 readMigrationFiles 相同的解析（哈希为整个文件的 SHA-256），可读取内嵌文件 */
async function readMigrations(folder: string, files?: MigrationFiles): Promise<MigrationEntry[]> {
  const journal = await readFile(journalPath(folder), files)
  if (journal === undefined)
    throw new DatabaseError(`Migrations not found in ${folder} (meta/_journal.json is missing). Run think-h3 db:generate first.`)
  const entries: MigrationEntry[] = []
  for (const entry of (JSON.parse(journal) as Journal).entries) {
    const query = await readFile(`${trimSlash(folder)}/${entry.tag}.sql`, files)
    if (query === undefined)
      throw new DatabaseError(`Migration file ${entry.tag}.sql not found in ${folder}`)
    entries.push({
      sql: query.split('--> statement-breakpoint'),
      bps: entry.breakpoints,
      folderMillis: entry.when,
      hash: await sha256(query),
    })
  }
  return entries
}

/** 与 drizzle 的 libsql / d1 迁移器相同：一次批量执行全部未运行的迁移 */
async function migrateSqlite(db: AnyDatabase, migrations: MigrationEntry[], execute: (statements: unknown[]) => Promise<unknown>, literal = false): Promise<void> {
  const table = sql.identifier('__drizzle_migrations')
  await db.session.run(sql`CREATE TABLE IF NOT EXISTS ${table} (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)`)
  const [last] = await db.values(sql`SELECT id, hash, created_at FROM ${table} ORDER BY created_at DESC LIMIT 1`) as unknown[][]
  const statements: unknown[] = []
  for (const migration of migrations) {
    if (last && Number(last[2]) >= migration.folderMillis)
      continue
    for (const statement of migration.sql)
      statements.push(db.run(sql.raw(statement)))
    statements.push(db.run(literal
      // D1 的 batch 中参数绑定行为与普通查询不同，与 drizzle 一致使用字面量
      ? sql`INSERT INTO ${table} ("hash", "created_at") VALUES(${sql.raw(`'${migration.hash}'`)}, ${sql.raw(String(migration.folderMillis))})`
      : sql`INSERT INTO ${table} ("hash", "created_at") VALUES(${migration.hash}, ${migration.folderMillis})`))
  }
  await execute(statements)
}

/** 已执行的迁移数（迁移表不存在时为 0） */
async function appliedCount(connection: Connection): Promise<number> {
  const table: SQL = connection.dialect === 'postgres'
    ? sql`"drizzle"."__drizzle_migrations"`
    : sql`${sql.identifier('__drizzle_migrations')}`
  const query = sql`select count(*) as n from ${table}`
  const { db } = connection
  try {
    const result = connection.dialect === 'sqlite'
      ? await db.all(query)
      : await db.execute(query)
    const rows = connection.dialect === 'mysql'
      ? result[0]
      : Array.isArray(result)
        ? result
        : result.rows
    return Number(rows[0]?.n ?? 0)
  }
  catch {
    return 0
  }
}

async function readFile(path: string, files?: MigrationFiles): Promise<string | undefined> {
  if (files)
    return files[path]
  return readDiskFile(path, 'utf8').catch(() => undefined)
}

function journalPath(folder: string): string {
  return `${trimSlash(folder)}/meta/_journal.json`
}

function trimSlash(path: string): string {
  return path.replace(/\/+$/, '')
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [
    ...new Uint8Array(digest),
  ].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
