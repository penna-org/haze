import type { SQL, Table } from 'drizzle-orm'
import type { SessionOptions, TransactionConfig } from './context'
import type { QueryOptions } from './query/builder'
import type { AnyDatabase } from './types'
import { sql } from 'drizzle-orm'
import { commit, inTransaction, joinTransaction, resolveSession, resolveSessionSync, rollback, startTrans, transaction, useDatabaseManager, withDatabaseManager } from './context'
import { QueryBuilder } from './query/builder'
import { useWriter, withinScope } from './routing'

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
  drizzle: (options?: Pick<SessionOptions, 'read'>) => Promise<AnyDatabase>
  drizzleSync: () => AnyDatabase
  joinTransaction: <R>(tx: AnyDatabase, callback: () => R) => R
  connect: () => Promise<void>
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
    /**
     * 底层 drizzle 实例（处于事务中时为事务对象），用于 join 等复杂查询；
     * 配置了读写分离时默认为写库，`drizzle({ read: true })` 按读写分离规则选择副本
     */
    drizzle: async (options?: Pick<SessionOptions, 'read'>): Promise<AnyDatabase> => (await resolveSession(connection, options)).db,
    /**
     * drizzleSync()：同步取得 drizzle 实例（处于事务中时为事务对象），给不能 await 的代码使用，
     * 如把查询放在 Repository 中、通过 `get db()` 取用；需先 `await Db.connect()`。读写分离时总是写库
     */
    drizzleSync: (): AnyDatabase => resolveSessionSync(connection).db,
    /**
     * 让外部开启的 drizzle 事务加入事务上下文：`db.transaction(tx => Db.joinTransaction(tx, () => …))`，
     * 回调中的 Db / Model 查询都在这个事务中，提交与回滚由外部负责
     */
    joinTransaction: <R>(tx: AnyDatabase, callback: () => R): R => joinTransaction(tx, callback, connection),
    /** 建立连接（首次查询时也会自动建立）；之后可以同步取用 drizzleSync() */
    connect: async (): Promise<void> => void (await useDatabaseManager().connection(connection)),
  }
}

/** 数据库门面：默认连接的快捷入口，`Db.connection(name)` 切换连接 */
export const Db = {
  ...scoped(),
  connection: (name: string) => scoped(name),
  /** 读写分离：回调内的读取都使用写库 */
  useWriter,
  /**
   * 回调内（含其中创建的定时器与 Promise）的 Db / Model 都使用指定的 DatabaseManager：
   * 同一进程中有多个应用时，固定使用某个应用的连接（`Db.withManager(app.make(DatabaseManager), fn)`）
   */
  withManager: withDatabaseManager,
  /**
   * 读写分离：新的 sticky 作用域，回调内写入过的连接之后的读取使用写库。
   * 请求中自动以请求为作用域；队列任务、命令等请求之外的代码用它划定范围
   */
  withinScope,
  /** 原样拼入 SQL 的片段（不转义）：`Db.raw('count(*)')`，带参数时请用 drizzle 的 sql`` 模板 */
  raw: (value: string): SQL => sql.raw(value),
}
