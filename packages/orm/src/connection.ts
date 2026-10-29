import type { Logger } from '@hazejs/core'
import type { ConnectionConfig, DatabaseConfig, Dialect, Driver, PoolOptions } from './config'
import type { AnyDatabase } from './types'
import { mkdir } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { currentTenancy, definePersistent, usePlatformBinding } from '@hazejs/core'
import { dialectOf } from './config'
import { DatabaseError } from './errors'
import { trackWrites } from './routing'
import { instrumentDatabase, queryLogger } from './telemetry'

export interface Connection {
  name: string
  driver: Driver
  dialect: Dialect
  /** SQL 为 drizzle 实例，MongoDB 为 mongodb 的 Db；配置了读写分离时为写库 */
  db: AnyDatabase
  /** 读写分离：只读副本的 drizzle 实例（未配置 read 时为空） */
  replicas: AnyDatabase[]
  /** 读写分离：写入后的读取是否走写库 */
  sticky: boolean
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

/** 模块的迁移目录（config/modules.ts 或 modules/<name>/） */
export interface ModuleMigrations {
  module: string
  /** 绝对路径，或相对后端源码目录的路径（生产构建中为内嵌文件的键） */
  folder: string
  /** 迁移使用的连接，默认 default 连接 */
  connection?: string
}

export interface DatabaseManagerOptions {
  logger?: Logger
  /** 解析 sqlite 相对路径的基准目录，默认 process.cwd() */
  rootDir?: string
  /** 后端源码目录：解析相对的迁移目录（本地模块等），默认 rootDir */
  srcDir?: string
  /** 已启用模块的迁移，按启用顺序（由 databaseProvider 从 app.modules() 读取） */
  modules?: ModuleMigrations[]
}

export class DatabaseManager {
  readonly config: DatabaseConfig
  readonly #options: DatabaseManagerOptions
  /** 按租户计算出的连接配置：`<连接名>@<租户>` → 配置 */
  readonly #tenantConfigs = new Map<string, ConnectionConfig>()

  constructor(config: DatabaseConfig, options: DatabaseManagerOptions = {}) {
    if (!config?.connections || !config.default)
      throw new DatabaseError('Invalid database config: `default` and `connections` are required (config/database.ts)')
    this.config = config
    this.#options = options
  }

  get defaultConnection(): string {
    return this.config.default
  }

  /** 解析相对迁移目录的基准目录 */
  get srcDir(): string | undefined {
    return this.#options.srcDir ?? this.#options.rootDir
  }

  /** 已启用模块的迁移（按启用顺序） */
  get moduleMigrations(): readonly ModuleMigrations[] {
    return this.#options.modules ?? []
  }

  connectionConfig(name = this.config.default): ConnectionConfig {
    const config = this.config.connections[name] ?? this.#tenantConfigs.get(name)
    if (!config)
      throw new DatabaseError(`Database connection "${name}" is not defined in config/database.ts`)
    return config
  }

  /**
   * 实际使用的连接名：处于租户上下文且 config/tenancy.ts 配置了每租户独立数据库时，
   * 为 `<连接名>@<租户>`（连接配置由租户计算，按租户缓存连接），否则为原连接名
   */
  resolveName(name = this.config.default): string {
    const scope = currentTenancy()
    const database = scope?.config.database
    if (!scope || !database?.config || !(database.connections ?? [this.config.default]).includes(name))
      return name
    const key = `${name}@${scope.key}`
    if (!this.#tenantConfigs.has(key))
      this.#tenantConfigs.set(key, database.config(scope.tenant, this.connectionConfig(name), name) as ConnectionConfig)
    return key
  }

  /** 获取连接（首次使用时建立） */
  connection(name = this.config.default): Promise<Connection> {
    name = this.resolveName(name)
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
  if (!config.read && !config.write) {
    const connection = await createConnection(name, config, options)
    // 查询遥测（开发面板 / OpenTelemetry），没有监听者时为空操作
    if (connection.dialect !== 'mongodb')
      instrumentDatabase(connection.db, { connection: name, dialect: connection.dialect })
    return connection
  }

  // 读写分离：写库与各个副本是独立的客户端，未写的字段继承连接本身的配置
  if (config.driver === 'mongodb' || config.driver === 'd1')
    throw new DatabaseError(`Connection "${name}": read / write splitting is not supported for ${config.driver} (MongoDB: use readPreference in the url; D1: use the Sessions API through Db.drizzle())`)
  const { read, write, sticky, ...base } = config
  const readers = ([] as NonNullable<ConnectionConfig['write']>[]).concat(read ?? [])
  const writer = await createConnection(name, {
    ...base,
    ...write,
  }, options)
  const replicas: Connection[] = []
  try {
    for (const endpoint of readers) {
      replicas.push(await createConnection(name, {
        ...base,
        ...endpoint,
      }, options))
    }
  }
  catch (error) {
    await Promise.all([writer, ...replicas].map(connection => connection.close().catch(() => undefined)))
    throw error
  }
  instrumentDatabase(writer.db, { connection: name, dialect: writer.dialect })
  for (const replica of replicas)
    instrumentDatabase(replica.db, { connection: name, dialect: replica.dialect, replica: true })
  // sticky：写库上执行过写语句后，同一请求 / 作用域内的读取改走写库
  if (sticky && replicas.length)
    trackWrites(writer.db, name)
  return {
    ...writer,
    replicas: replicas.map(replica => replica.db),
    sticky: sticky === true,
    close: async () => {
      await Promise.all([writer, ...replicas].map(connection => connection.close()))
    },
  }
}

async function createConnection(name: string, config: ConnectionConfig, options: DatabaseManagerOptions): Promise<Connection> {
  // 始终传入 logger：遥测借 logQuery 取得实际 SQL 与参数；开启 logging 时同时写日志
  const logger = queryLogger(config.logging && options.logger
    ? (query, params) => options.logger!.debug(`[db:${name}] ${query}`, params.length ? params : '')
    : undefined)
  const base = {
    name,
    driver: config.driver,
    dialect: dialectOf(config.driver),
    replicas: [],
    sticky: false,
  }
  const pool = poolOptions(config.pool)

  switch (config.driver) {
    case 'sqlite': {
      const { createClient } = await importDriver('@libsql/client', () => import('@libsql/client'))
      const { drizzle } = await import('drizzle-orm/libsql')
      const url = await sqliteUrl(config.url ?? 'file:./data/app.db', options.rootDir)
      const client = createClient({ url, authToken: config.authToken, intMode: 'bigint' })
      return {
        ...base,
        db: drizzle(losslessIntegers(client), { logger }),
        close: async () => client.close(),
      }
    }
    case 'turso': {
      // 纯 HTTP 客户端：不加载 libsql 原生模块，Edge / Serverless 均可使用
      const { createClient } = await importDriver('@libsql/client', () => import('@libsql/client/web'))
      const { drizzle } = await import('drizzle-orm/libsql/web')
      if (!config.url)
        throw new DatabaseError(`Connection "${name}": url is required for turso (libsql:// or https://)`)
      const client = createClient({ url: config.url, authToken: config.authToken, intMode: 'bigint' })
      return {
        ...base,
        db: drizzle(losslessIntegers(client), { logger }),
        close: async () => client.close(),
      }
    }
    case 'd1': {
      const { drizzle } = await import('drizzle-orm/d1')
      const binding = typeof config.binding === 'object'
        ? config.binding
        : usePlatformBinding<object>(config.binding ?? 'DB')
      if (!binding)
        throw new DatabaseError(`Connection "${name}": D1 binding "${config.binding ?? 'DB'}" not found. D1 is only available on Cloudflare Workers (preset cloudflare); use the sqlite driver locally`)
      return {
        ...base,
        db: drizzle(binding as Parameters<typeof drizzle>[0], { logger }),
        close: async () => {},
      }
    }
    case 'postgres': {
      const { default: postgres } = await importDriver('postgres', () => import('postgres'))
      const { drizzle } = await import('drizzle-orm/postgres-js')
      if (!config.url)
        throw new DatabaseError(`Connection "${name}": url is required for postgres`)
      const client = postgres(config.url, {
        max: pool.max ?? 10,
        // postgres.js 的超时单位为秒
        ...(pool.idleTimeout !== undefined && { idle_timeout: pool.idleTimeout / 1000 }),
        ...(pool.connectTimeout !== undefined && { connect_timeout: pool.connectTimeout / 1000 }),
        onnotice: () => {},
      })
      return {
        ...base,
        db: drizzle(client, { logger }),
        close: () => client.end(),
      }
    }
    case 'pglite': {
      const { PGlite } = await importDriver('@electric-sql/pglite', () => import('@electric-sql/pglite'))
      const { drizzle } = await import('drizzle-orm/pglite')
      const client = new PGlite(config.url)
      return {
        ...base,
        db: drizzle(client, { logger }),
        close: () => client.close(),
      }
    }
    case 'mysql': {
      const mysql = await importDriver('mysql2', () => import('mysql2/promise'))
      const { drizzle } = await import('drizzle-orm/mysql2')
      if (!config.url)
        throw new DatabaseError(`Connection "${name}": url is required for mysql`)
      // 超出 2^53 的 BIGINT（雪花 ID 等）以字符串返回，而不是丢失精度的 number
      const client = mysql.createPool({
        uri: config.url,
        connectionLimit: pool.max ?? 10,
        ...(pool.idleTimeout !== undefined && { idleTimeout: pool.idleTimeout }),
        ...(pool.connectTimeout !== undefined && { connectTimeout: pool.connectTimeout }),
        supportBigNumbers: true,
      })
      return {
        ...base,
        db: drizzle(client, { logger, mode: 'default' }),
        close: () => client.end(),
      }
    }
    case 'mongodb': {
      const { MongoClient } = await importDriver('mongodb', () => import('mongodb'))
      if (!config.url)
        throw new DatabaseError(`Connection "${name}": url is required for mongodb`)
      const client = new MongoClient(config.url, {
        maxPoolSize: pool.max ?? 10,
        ...(pool.idleTimeout !== undefined && { maxIdleTimeMS: pool.idleTimeout }),
        ...(pool.connectTimeout !== undefined && { connectTimeoutMS: pool.connectTimeout }),
      })
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

/** 连接池选项归一化：超时统一为毫秒 */
function poolOptions(pool: ConnectionConfig['pool']): { max?: number, idleTimeout?: number, connectTimeout?: number } {
  if (pool === undefined || typeof pool === 'number')
    return { max: pool }
  const { max, idleTimeout, connectTimeout } = pool satisfies PoolOptions
  return {
    max,
    idleTimeout: idleTimeout === undefined
      ? undefined
      : durationMs(idleTimeout),
    connectTimeout: connectTimeout === undefined
      ? undefined
      : durationMs(connectTimeout),
  }
}

/** `30` / `'30s'` / `'5m'` / `'500ms'` → 毫秒（数字按秒） */
function durationMs(value: number | string): number {
  if (typeof value === 'number')
    return value * 1000
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:(ms|[smh])\s*)?$/i.exec(value)
  if (!match)
    throw new DatabaseError(`Invalid duration "${value}" in the pool options (expected e.g. 30, '30s', '5m', '500ms')`)
  const unit = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
  }[(match[2] ?? 's').toLowerCase() as 's']
  return Number(match[1]) * unit
}

/** 安全范围内的 BigInt 转回 number，超出范围的保留 BigInt（不丢失精度） */
function normalizeInteger(value: unknown): unknown {
  return typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
    ? Number(value)
    : value
}

/** libsql 的结果行：下标属性不可枚举，列名属性可枚举（drizzle 依赖这一结构） */
function normalizeRow(row: any): any {
  const result: Record<string | number, unknown> = {}
  Object.defineProperty(result, 'length', { value: row.length, enumerable: false })
  for (let index = 0; index < row.length; index++) {
    Object.defineProperty(result, index, {
      value: normalizeInteger(row[index]),
      enumerable: false,
      writable: true,
      configurable: true,
    })
  }
  for (const key of Object.keys(row)) {
    Object.defineProperty(result, key, {
      value: normalizeInteger(row[key]),
      enumerable: true,
      writable: true,
      configurable: true,
    })
  }
  return result
}

function normalizeResult(result: any): any {
  if (result && Array.isArray(result.rows))
    result.rows = result.rows.map(normalizeRow)
  return result
}

/**
 * libsql 的默认 intMode（number）遇到超出 2^53 的整数会直接报错，bigint 模式又会把所有整数变成 BigInt。
 * 这里以 bigint 模式读取，再把安全范围内的值转回 number：普通整数列不受影响，64 位整数不丢失精度。
 */
function losslessIntegers<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, property) {
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function')
        return value
      switch (property) {
        case 'execute':
          return async (...args: unknown[]) => normalizeResult(await value.apply(target, args))
        case 'batch':
        case 'migrate':
          return async (...args: unknown[]) => (await value.apply(target, args)).map(normalizeResult)
        case 'transaction':
          return async (...args: unknown[]) => losslessIntegers(await value.apply(target, args))
        default:
          return value.bind(target)
      }
    },
  })
}

/**
 * 加载驱动。导入路径须为字面量：打包器（Edge / 全量打包）据此静态解析驱动，
 * 未安装或该平台不支持的驱动在构建时替换为调用即报错的空模块。
 */
async function importDriver<T>(pkg: string, load: () => Promise<T>): Promise<T> {
  try {
    return await load()
  }
  catch (error) {
    throw new DatabaseError(`Database driver "${pkg}" could not be loaded. Install it with: pnpm add ${pkg}`, { cause: error })
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
