import { customType as mysqlCustomType } from 'drizzle-orm/mysql-core'
import { customType as pgCustomType } from 'drizzle-orm/pg-core'
import { customType as sqliteCustomType } from 'drizzle-orm/sqlite-core'
import { snowflakeId } from './snowflake'

/**
 * 雪花 ID 列（`@hazejs/orm/columns`，供 database/schema 中的表结构使用）：数据库中为 64 位整数（SQLite 为文本），应用中统一为十进制字符串，
 * 读写都不经过 number，因此不会丢失精度；作为 JSON 返回给前端时也是字符串（与 Java 的 Long 约定一致）。
 *
 * - `auto`（默认 true）：插入时未提供值则自动生成，用于主键；外键列传 `{ auto: false }`
 */
export interface SnowflakeColumnOptions {
  auto?: boolean
}

/** 任何驱动返回的 64 位整数（number / string / BigInt）→ 字符串 */
function toText(value: unknown): string {
  return typeof value === 'string'
    ? value
    : String(value)
}

const pgBigintText = pgCustomType<{ data: string, driverData: string | bigint | number }>({
  dataType: () => 'bigint',
  toDriver: value => toText(value),
  fromDriver: value => toText(value),
})

const mysqlBigintText = mysqlCustomType<{ data: string, driverData: string | bigint | number }>({
  dataType: () => 'bigint',
  toDriver: value => toText(value),
  fromDriver: value => toText(value),
})

// SQLite 保存为文本：Cloudflare D1 读取超过 2^53 的整数会丢失精度，文本在所有 SQLite 驱动上都是精确的。
// 雪花 ID 在可预见的年份内都是 19 位，文本排序与数值排序一致
const sqliteText = sqliteCustomType<{ data: string, driverData: string | bigint | number }>({
  dataType: () => 'text',
  toDriver: value => toText(value),
  fromDriver: value => toText(value),
})

// 返回类型由 drizzle 的 customType 推导，写出来过于冗长
/* eslint-disable ts/explicit-function-return-type */
const pgColumn = <TName extends string>(name: TName) => pgBigintText(name)
const mysqlColumn = <TName extends string>(name: TName) => mysqlBigintText(name)
const sqliteColumn = <TName extends string>(name: TName) => sqliteText(name)
/* eslint-enable ts/explicit-function-return-type */

type WithDefault<C> = C extends { $defaultFn: (...args: any[]) => infer R } ? R : never

/** PostgreSQL 雪花 ID 列（bigint）：`id: pgSnowflake('id').primaryKey()`，外键 `pgSnowflake('user_id', { auto: false })` */
export function pgSnowflake<TName extends string>(name: TName, options: { auto: false }): ReturnType<typeof pgColumn<TName>>
export function pgSnowflake<TName extends string>(name: TName, options?: SnowflakeColumnOptions): WithDefault<ReturnType<typeof pgColumn<TName>>>
export function pgSnowflake(name: string, options: SnowflakeColumnOptions = {}): unknown {
  const column = pgColumn(name)
  return options.auto === false
    ? column
    : column.$defaultFn(snowflakeId)
}

/** MySQL 雪花 ID 列（bigint）：`id: mysqlSnowflake('id').primaryKey()`，外键 `mysqlSnowflake('user_id', { auto: false })` */
export function mysqlSnowflake<TName extends string>(name: TName, options: { auto: false }): ReturnType<typeof mysqlColumn<TName>>
export function mysqlSnowflake<TName extends string>(name: TName, options?: SnowflakeColumnOptions): WithDefault<ReturnType<typeof mysqlColumn<TName>>>
export function mysqlSnowflake(name: string, options: SnowflakeColumnOptions = {}): unknown {
  const column = mysqlColumn(name)
  return options.auto === false
    ? column
    : column.$defaultFn(snowflakeId)
}

/** SQLite / Turso / D1 雪花 ID 列（text）：`id: sqliteSnowflake('id').primaryKey()`，外键 `sqliteSnowflake('user_id', { auto: false })` */
export function sqliteSnowflake<TName extends string>(name: TName, options: { auto: false }): ReturnType<typeof sqliteColumn<TName>>
export function sqliteSnowflake<TName extends string>(name: TName, options?: SnowflakeColumnOptions): WithDefault<ReturnType<typeof sqliteColumn<TName>>>
export function sqliteSnowflake(name: string, options: SnowflakeColumnOptions = {}): unknown {
  const column = sqliteColumn(name)
  return options.auto === false
    ? column
    : column.$defaultFn(snowflakeId)
}

// 表结构文件只应依赖 drizzle（drizzle-kit 直接读取），从 @hazejs/orm/columns 导入不会加载框架
export { DEFAULT_SNOWFLAKE_EPOCH, Snowflake, snowflakeId } from './snowflake'
export type { SnowflakeOptions, SnowflakeParts } from './snowflake'
