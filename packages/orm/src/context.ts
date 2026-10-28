import type { Dialect, Driver } from './config'
import type { Connection, DatabaseManager } from './connection'
import type { AnyDatabase } from './types'
import { AsyncLocalStorage } from 'node:async_hooks'
import { DatabaseError } from './errors'

let manager: DatabaseManager | undefined

/** 由 databaseProvider() 在应用启动时设置；脚本 / 测试中可直接调用 */
export function setDatabaseManager(value: DatabaseManager | undefined): void {
  manager = value
}

export function useDatabaseManager(): DatabaseManager {
  if (!manager)
    throw new DatabaseError('Database is not configured. Add databaseProvider() in app/provider and create config/database.ts')
  return manager
}

/** 事务上下文：连接名 → 事务内的 drizzle 实例 */
const transactions = new AsyncLocalStorage<Map<string, AnyDatabase>>()

export interface Session {
  name: string
  driver: Driver
  dialect: Dialect
  /** 当前可用的 drizzle 实例（处于事务中时为事务对象） */
  db: AnyDatabase
}

export async function resolveSession(connection?: string): Promise<Session> {
  const resolved: Connection = await useDatabaseManager().connection(connection)
  if (resolved.dialect === 'mongodb')
    throw new DatabaseError(`Connection "${resolved.name}" is MongoDB; use Mongo / MongoModel from @hazejs/orm/mongo`)
  return {
    name: resolved.name,
    driver: resolved.driver,
    dialect: resolved.dialect,
    db: transactions.getStore()?.get(resolved.name) ?? resolved.db,
  }
}

/**
 * 在事务中执行；回调内通过 Db / Model 发起的查询自动加入该事务（隐式传播），
 * 嵌套调用使用保存点。回调抛错时回滚。
 */
export async function transaction<R>(callback: (tx: AnyDatabase) => Promise<R>, connection?: string): Promise<R> {
  const session = await resolveSession(connection)
  // D1 拒绝 BEGIN / SAVEPOINT：原子写入使用 batch
  if (session.driver === 'd1')
    throw new DatabaseError(`Connection "${session.name}" is Cloudflare D1, which does not support interactive transactions; use (await Db.drizzle()).batch([...]) for atomic writes`)
  const store = transactions.getStore()
  return session.db.transaction((tx: AnyDatabase) =>
    transactions.run(new Map(store).set(session.name, tx), () => callback(tx)))
}
