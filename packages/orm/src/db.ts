import type { SQL, Table } from 'drizzle-orm'
import type { TransactionConfig } from './context'
import type { QueryOptions } from './query/builder'
import type { AnyDatabase } from './types'
import { sql } from 'drizzle-orm'
import { commit, inTransaction, resolveSession, rollback, startTrans, transaction } from './context'
import { QueryBuilder } from './query/builder'

/** 执行原生 SQL，统一返回行数组 */
async function execute<R = Record<string, unknown>>(query: SQL, connection?: string): Promise<R[]> {
  const { db, dialect } = await resolveSession(connection)
  if (dialect === 'sqlite')
    return db.all(query)
  const result = await db.execute(query)
  if (dialect === 'mysql')
    return result[0]
  return Array.isArray(result)
    ? result
    : result.rows
}

export interface ScopedDb {
  table: <T extends Table>(table: T) => QueryBuilder<T>
  transaction: <R>(callback: (tx: AnyDatabase) => Promise<R>, config?: TransactionConfig) => Promise<R>
  startTrans: (config?: TransactionConfig) => Promise<void>
  commit: () => Promise<void>
  rollback: () => Promise<void>
  inTransaction: () => boolean
  execute: <R = Record<string, unknown>>(query: SQL) => Promise<R[]>
  query: <R = Record<string, unknown>>(query: SQL) => Promise<R[]>
  drizzle: () => Promise<AnyDatabase>
}

function scoped(connection?: string): ScopedDb {
  return {
    /** 查询构造器：`Db.table(users).where('id', 1).find()` */
    table: <T extends Table>(table: T): QueryBuilder<T> => new QueryBuilder(table, { connection } satisfies QueryOptions),
    /** 事务（回调内的 Db / Model 查询自动加入事务，嵌套使用保存点） */
    transaction: <R>(callback: (tx: AnyDatabase) => Promise<R>, config?: TransactionConfig): Promise<R> => transaction(callback, connection, config),
    /** 手动事务：`await Db.startTrans()` … `await Db.commit()` / `await Db.rollback()`（需在同一个异步函数中） */
    startTrans: (config?: TransactionConfig): Promise<void> => startTrans(connection, config),
    commit: (): Promise<void> => commit(connection),
    rollback: (): Promise<void> => rollback(connection),
    /** 当前是否处于事务中 */
    inTransaction: (): boolean => inTransaction(connection),
    /** 原生 SQL：`Db.execute(sql\`select 1\`)` */
    execute: <R = Record<string, unknown>>(query: SQL): Promise<R[]> => execute<R>(query, connection),
    /** execute() 的别名 */
    query: <R = Record<string, unknown>>(query: SQL): Promise<R[]> => execute<R>(query, connection),
    /** 底层 drizzle 实例（处于事务中时为事务对象），用于 join 等复杂查询 */
    drizzle: async (): Promise<AnyDatabase> => (await resolveSession(connection)).db,
  }
}

/** 数据库门面：默认连接的快捷入口，`Db.connection(name)` 切换连接 */
export const Db = {
  ...scoped(),
  connection: (name: string) => scoped(name),
  /** 原样拼入 SQL 的片段（不转义）：`Db.raw('count(*)')`，带参数时请用 drizzle 的 sql`` 模板 */
  raw: (value: string): SQL => sql.raw(value),
}
