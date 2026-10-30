import type { ConfigInput } from '@hazejs/core'
import type { SnowflakeOptions } from './snowflake'

/**
 * - `sqlite`：libsql 驱动（本地文件 `file:./data/app.db`、`:memory:`、Turso `libsql://…`）
 * - `turso`：libsql 的纯 HTTP 客户端（Turso / sqld，`libsql://`、`https://`），不含原生二进制，可运行于 Edge 与 Serverless
 * - `d1`：Cloudflare D1（通过 Workers 绑定访问，`binding` 为绑定名）
 * - `postgres`：postgres-js
 * - `node-postgres`：node-postgres（`pg`，drizzle 默认的 PostgreSQL 驱动，连接池为 pg.Pool）
 * - `pglite`：嵌入式 PostgreSQL（WASM），适合本地开发与测试，url 为数据目录，省略为内存库
 * - `mysql`：mysql2
 * - `mongodb`：官方 mongodb 驱动（使用 `@hazejs/orm/mongo` 的 Mongo / MongoModel）
 */
export type Driver = 'sqlite' | 'turso' | 'd1' | 'postgres' | 'node-postgres' | 'pglite' | 'mysql' | 'mongodb'

export type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'mongodb'

/** 连接池选项（postgres / mysql / mongodb；sqlite、turso、pglite、d1 没有连接池，忽略） */
export interface PoolOptions {
  /** 最大连接数，默认 10 */
  max?: number
  /** 空闲连接的回收时间：秒数，或 `'30s'` / `'5m'` / `'500ms'` */
  idleTimeout?: number | string
  /** 建立连接的超时：秒数，或 `'5s'` / `'500ms'` */
  connectTimeout?: number | string
}

/**
 * 读写分离中某一端的配置：未写的字段继承连接本身的配置（driver 不能修改）。
 *
 * ```ts
 * main: {
 *   driver: 'postgres',
 *   write: { url: env('DB_WRITE_URL') },
 *   read: [{ url: env('DB_READ_URL_1') }, { url: env('DB_READ_URL_2') }],
 *   sticky: true,
 * }
 * ```
 */
export type ConnectionEndpoint = Partial<Pick<ConnectionConfig, 'url' | 'authToken' | 'pool' | 'logging'>>

export interface ConnectionConfig {
  driver: Driver
  url?: string
  /** libsql / Turso 认证令牌 */
  authToken?: string
  /** D1：Workers 绑定名（默认 `DB`），或直接传入 D1Database 对象 */
  binding?: string | object
  /** 连接池：最大连接数，或 `{ max, idleTimeout, connectTimeout }`（postgres / mysql / mongodb） */
  pool?: number | PoolOptions
  /** MongoDB 数据库名（默认取 url 中的路径） */
  database?: string
  /** 以 debug 级别输出 SQL */
  logging?: boolean
  /** drizzle 表定义目录（相对 srcDir），默认 `database/schema` */
  schema?: string
  /** 迁移目录（相对 srcDir），默认连接为 `database/migrations`，其它连接为 `database/migrations/<name>` */
  migrations?: string
  /** 读写分离：写库（主库），省略时为连接本身的配置 */
  write?: ConnectionEndpoint
  /** 读写分离：只读副本（一个或多个，每次读取随机选择）；配置后 select 类查询走副本，写入、事务、加锁读走写库 */
  read?: ConnectionEndpoint | ConnectionEndpoint[]
  /** 读写分离：当前请求（或 Db.withinScope() 作用域）写入过之后，后续读取也走写库，避免读到复制延迟前的旧数据 */
  sticky?: boolean
  /**
   * 列名的大小写转换（drizzle 的 `casing`）：`snake_case` 时表定义中没有写列名的字段按 `createdAt → created_at` 映射。
   * 需与 drizzle-kit 生成迁移时的 casing 一致（`haze db:generate` 会传入）
   */
  casing?: 'snake_case' | 'camelCase'
  /**
   * 会话时区（PostgreSQL：postgres、node-postgres、pglite），如 `Asia/Shanghai`。
   * 影响 `::date`、`date_trunc` 等按日期的计算与不带时区的时间戳的输出；带时区的时间戳读写不受影响
   */
  timezone?: string
  /**
   * 使用已创建的客户端（pglite 为 PGlite 实例，node-postgres 为 pg.Pool / pg.Client，postgres 为 postgres-js 实例）：
   * 由调用方负责关闭，应用关闭时不会关闭它（测试中多个应用共用一个内存数据库、接管已有的连接池）
   */
  client?: object
}

/** 模型工厂（database/factories）的设置 */
export interface FactoryConfig {
  /** faker 的语言，例如 `zh_CN`、`en_US`、`ja`，默认 `en` */
  locale?: string
}

export interface DatabaseConfig {
  /** 默认连接名 */
  default: string
  connections: Record<string, ConnectionConfig>
  /** 雪花 ID 生成器（snowflakeId() 与 *Snowflake() 列使用）：多实例部署时为每个实例配置不同的 workerId / datacenterId */
  snowflake?: SnowflakeOptions
  /** 模型工厂：faker 的语言等 */
  factories?: FactoryConfig
}

/** `config/database.ts` 的默认导出 */
export function defineDatabaseConfig(config: ConfigInput<DatabaseConfig>): ConfigInput<DatabaseConfig> {
  return config
}

export function dialectOf(driver: Driver): Dialect {
  switch (driver) {
    case 'pglite':
    case 'node-postgres':
      return 'postgres'
    case 'turso':
    case 'd1':
      return 'sqlite'
    default:
      return driver
  }
}
