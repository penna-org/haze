import type { ConfigInput } from '@think-h3/core'

/**
 * - `sqlite`：libsql 驱动（本地文件 `file:./data/app.db`、`:memory:`、Turso `libsql://…`）
 * - `turso`：libsql 的纯 HTTP 客户端（Turso / sqld，`libsql://`、`https://`），不含原生二进制，可运行于 Edge 与 Serverless
 * - `d1`：Cloudflare D1（通过 Workers 绑定访问，`binding` 为绑定名）
 * - `postgres`：postgres-js
 * - `pglite`：嵌入式 PostgreSQL（WASM），适合本地开发与测试，url 为数据目录，省略为内存库
 * - `mysql`：mysql2
 * - `mongodb`：官方 mongodb 驱动（使用 `@think-h3/orm/mongo` 的 Mongo / MongoModel）
 */
export type Driver = 'sqlite' | 'turso' | 'd1' | 'postgres' | 'pglite' | 'mysql' | 'mongodb'

export type Dialect = 'sqlite' | 'postgres' | 'mysql' | 'mongodb'

export interface ConnectionConfig {
  driver: Driver
  url?: string
  /** libsql / Turso 认证令牌 */
  authToken?: string
  /** D1：Workers 绑定名（默认 `DB`），或直接传入 D1Database 对象 */
  binding?: string | object
  /** 连接池大小（postgres / mysql / mongodb） */
  pool?: number
  /** MongoDB 数据库名（默认取 url 中的路径） */
  database?: string
  /** 以 debug 级别输出 SQL */
  logging?: boolean
  /** drizzle 表定义目录（相对 srcDir），默认 `database/schema` */
  schema?: string
  /** 迁移目录（相对 srcDir），默认连接为 `database/migrations`，其它连接为 `database/migrations/<name>` */
  migrations?: string
}

export interface DatabaseConfig {
  /** 默认连接名 */
  default: string
  connections: Record<string, ConnectionConfig>
}

/** `config/database.ts` 的默认导出 */
export function defineDatabaseConfig(config: ConfigInput<DatabaseConfig>): ConfigInput<DatabaseConfig> {
  return config
}

export function dialectOf(driver: Driver): Dialect {
  switch (driver) {
    case 'pglite':
      return 'postgres'
    case 'turso':
    case 'd1':
      return 'sqlite'
    default:
      return driver
  }
}
