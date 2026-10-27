import type { Logger } from '@think-h3/core'
import type { ConnectionConfig, DatabaseConfig, Dialect, Driver } from './config'
import type { AnyDatabase } from './types'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { definePersistent } from '@think-h3/core'
import { dialectOf } from './config'
import { DatabaseError } from './errors'

export interface Connection {
  name: string
  driver: Driver
  dialect: Dialect
  /** SQL 为 drizzle 实例，MongoDB 为 mongodb 的 Db */
  db: AnyDatabase
  /** 底层客户端（MongoDB 事务需要） */
  client?: unknown
  close: () => Promise<void>
}

interface Entry {
  hash: string
  connection: Promise<Connection>
}

/**
 * 连接跨 HMR 重载保留（同名且配置不变时复用），只在应用真正关闭时释放
 */
function connections(): Map<string, Entry> {
  // 每次取用时注册：应用关闭会清空持久化存储，之后新建的连接也要能在下次关闭时释放
  return definePersistent('orm:connections', () => new Map<string, Entry>(), {
    dispose: async (entries) => {
      await Promise.all([
        ...entries.values(),
      ].map(async entry => (await entry.connection.catch(() => undefined))?.close()))
      entries.clear()
    },
  })
}

export interface DatabaseManagerOptions {
  logger?: Logger
  /** 解析 sqlite 相对路径的基准目录，默认 process.cwd() */
  rootDir?: string
}

export class DatabaseManager {
  readonly config: DatabaseConfig
  readonly #options: DatabaseManagerOptions

  constructor(config: DatabaseConfig, options: DatabaseManagerOptions = {}) {
    if (!config?.connections || !config.default)
      throw new DatabaseError('Invalid database config: `default` and `connections` are required (config/database.ts)')
    this.config = config
    this.#options = options
  }

  get defaultConnection(): string {
    return this.config.default
  }

  connectionConfig(name = this.config.default): ConnectionConfig {
    const config = this.config.connections[name]
    if (!config)
      throw new DatabaseError(`Database connection "${name}" is not defined in config/database.ts`)
    return config
  }

  /** 获取连接（首次使用时建立） */
  connection(name = this.config.default): Promise<Connection> {
    const config = this.connectionConfig(name)
    const hash = JSON.stringify(config)
    const pool = connections()
    const existing = pool.get(name)
    if (existing?.hash === hash)
      return existing.connection

    // 配置变化（例如热更新修改了 url）时替换旧连接
    void existing?.connection.then(connection => connection.close(), () => undefined)
    const connection = openConnection(name, config, this.#options)
    pool.set(name, { hash, connection })
    connection.catch(() => pool.get(name)?.connection === connection && pool.delete(name))
    return connection
  }

  /** 关闭连接（默认全部）；测试中可用于重建内存数据库 */
  async close(name?: string): Promise<void> {
    const pool = connections()
    const names = name
      ? [name]
      : [
          ...pool.keys(),
        ]
    for (const key of names) {
      const entry = pool.get(key)
      pool.delete(key)
      await (await entry?.connection.catch(() => undefined))?.close()
    }
  }
}

async function openConnection(name: string, config: ConnectionConfig, options: DatabaseManagerOptions): Promise<Connection> {
  const logger = config.logging && options.logger
    ? {
        logQuery: (query: string, params: unknown[]) => options.logger!.debug(`[db:${name}] ${query}`, params.length ? params : ''),
      }
    : undefined
  const base = {
    name,
    driver: config.driver,
    dialect: dialectOf(config.driver),
  }

  switch (config.driver) {
    case 'sqlite': {
      const { createClient } = await importDriver<typeof import('@libsql/client')>('@libsql/client')
      const { drizzle } = await import('drizzle-orm/libsql')
      const url = await sqliteUrl(config.url ?? 'file:./data/app.db', options.rootDir)
      const client = createClient({ url, authToken: config.authToken })
      return {
        ...base,
        db: drizzle(client, { logger }),
        close: async () => client.close(),
      }
    }
    case 'postgres': {
      // postgres 为 CommonJS 风格导出，兼容默认导入
      const module = await importDriver<{ default?: typeof import('postgres') } & typeof import('postgres')>('postgres')
      const postgres = module.default ?? module
      const { drizzle } = await import('drizzle-orm/postgres-js')
      if (!config.url)
        throw new DatabaseError(`Connection "${name}": url is required for postgres`)
      const client = postgres(config.url, {
        max: config.pool ?? 10,
        onnotice: () => {},
      })
      return {
        ...base,
        db: drizzle(client, { logger }),
        close: () => client.end(),
      }
    }
    case 'pglite': {
      const { PGlite } = await importDriver<typeof import('@electric-sql/pglite')>('@electric-sql/pglite')
      const { drizzle } = await import('drizzle-orm/pglite')
      const client = new PGlite(config.url)
      return {
        ...base,
        db: drizzle(client, { logger }),
        close: () => client.close(),
      }
    }
    case 'mysql': {
      const mysql = await importDriver<typeof import('mysql2/promise')>('mysql2/promise')
      const { drizzle } = await import('drizzle-orm/mysql2')
      if (!config.url)
        throw new DatabaseError(`Connection "${name}": url is required for mysql`)
      const client = mysql.createPool({ uri: config.url, connectionLimit: config.pool ?? 10 })
      return {
        ...base,
        db: drizzle(client, { logger, mode: 'default' }),
        close: () => client.end(),
      }
    }
    case 'mongodb': {
      const { MongoClient } = await importDriver<typeof import('mongodb')>('mongodb')
      if (!config.url)
        throw new DatabaseError(`Connection "${name}": url is required for mongodb`)
      const client = new MongoClient(config.url, { maxPoolSize: config.pool ?? 10 })
      await client.connect()
      return {
        ...base,
        db: client.db(config.database),
        client,
        close: () => client.close(),
      }
    }
    default:
      throw new DatabaseError(`Connection "${name}": unknown driver "${(config as ConnectionConfig).driver}"`)
  }
}

async function importDriver<T>(pkg: string): Promise<T> {
  try {
    return await import(/* @vite-ignore */ pkg) as T
  }
  catch (error) {
    throw new DatabaseError(`Database driver "${pkg}" is not installed. Run: pnpm add ${pkg.split('/')[0]}`, { cause: error })
  }
}

/** file: 相对路径按项目根解析，并确保目录存在 */
async function sqliteUrl(url: string, rootDir = process.cwd()): Promise<string> {
  if (!url.startsWith('file:'))
    return url
  const path = url.slice('file:'.length)
  const absolute = isAbsolute(path)
    ? path
    : resolve(rootDir, path)
  await mkdir(dirname(absolute), { recursive: true })
  return `file:${absolute}`
}
