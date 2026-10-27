import type { ConfigInput } from '@think-h3/core'

/**
 * - `sqlite`：libsql 驱动（本地文件 `file:./data/app.db`、`:memory:`、Turso `libsql://…`）
 * - `postgres`：postgres-js
 * - `pglite`：嵌入式 PostgreSQL（WASM），适合本地开发与测试，url 为数据目录，省略为内存库
 * - `mysql`：mysql2
 */
export type Driver = 'sqlite' | 'postgres' | 'pglite' | 'mysql'

export type Dialect = 'sqlite' | 'postgres' | 'mysql'

export interface ConnectionConfig {
  driver: Driver
  url?: string
  /** libsql / Turso 认证令牌 */
  authToken?: string
  /** 连接池大小（postgres / mysql） */
  pool?: number
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
  return driver === 'pglite'
    ? 'postgres'
    : driver
}
