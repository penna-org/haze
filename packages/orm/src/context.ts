import type { Dialect, Driver } from './config'
import type { Connection, DatabaseManager } from './connection'
import type { AnyDatabase } from './types'
import { AsyncLocalStorage } from 'node:async_hooks'
import { DatabaseError } from './errors'
import { forcedWriter, hasWritten } from './routing'

let manager: DatabaseManager | undefined

/** 由 databaseProvider() 在应用启动时设置；脚本 / 测试中可直接调用 */
export function setDatabaseManager(value: DatabaseManager | undefined): void {
  manager = value
}

/** 当前的 DatabaseManager（未配置时为 undefined，不抛错） */
export function currentDatabaseManager(): DatabaseManager | undefined {
  return manager
}

export function useDatabaseManager(): DatabaseManager {
  if (!manager)
    throw new DatabaseError('Database is not configured. Add databaseProvider() in app/provider and create config/database.ts')
  return manager
}

/**
 * 事务选项，按方言透传给 drizzle：
 * - PostgreSQL：`isolationLevel`、`accessMode`、`deferrable`
 * - MySQL：`isolationLevel`、`accessMode`、`withConsistentSnapshot`
 * - SQLite：`behavior`（`deferred` / `immediate` / `exclusive`）
 *
 * 嵌套事务（保存点）忽略这些选项。
 */
export interface TransactionConfig {
  isolationLevel?: 'read uncommitted' | 'read committed' | 'repeatable read' | 'serializable'
  accessMode?: 'read only' | 'read write'
  deferrable?: boolean
  withConsistentSnapshot?: boolean
  behavior?: 'deferred' | 'immediate' | 'exclusive'
}

/** 某个连接上正在进行的事务（嵌套时通过 parent 指向外层） */
interface TxState {
  /** 事务内的 drizzle 实例（手动事务在 BEGIN 完成前为 Promise） */
  db: AnyDatabase | Promise<AnyDatabase>
  parent: TxState | undefined
  /** 已提交 / 回滚（手动事务结束后外层上下文仍可能引用它） */
  closed: boolean
  /** startTrans() 开启的手动事务 */
  manual?: {
    end: (commit: boolean) => void
    finished: Promise<void>
  }
}

/** 事务上下文：连接名 → 当前事务 */
const transactions = new AsyncLocalStorage<Map<string, TxState>>()

/** 跳过已结束的事务，取仍在进行的最内层事务 */
function active(state: TxState | undefined): TxState | undefined {
  while (state?.closed)
    state = state.parent
  return state
}

export interface Session {
  name: string
  driver: Driver
  dialect: Dialect
  /** 当前可用的 drizzle 实例（处于事务中时为事务对象，读写分离的读取为某个副本） */
  db: AnyDatabase
  /** 读写分离：本次使用的是只读副本 */
  replica: boolean
}

export interface SessionOptions {
  /**
   * 只读查询：配置了读写分离时可以使用副本。以下情况仍使用写库：处于事务中、`writer: true`、
   * Db.useWriter() 中、sticky 连接在当前请求 / 作用域内写入过。默认 false（写库）
   */
  read?: boolean
  /** 强制使用写库（useWriter()、lock()） */
  writer?: boolean
}

/**
 * 取得连接当前可用的 drizzle 实例。默认返回写库（原生 SQL、Db.drizzle() 可能写入）；
 * `{ read: true }` 时按读写分离规则选择副本或写库。
 */
export async function resolveSession(connection?: string, options: SessionOptions = {}): Promise<Session> {
  const resolved: Connection = await useDatabaseManager().connection(connection)
  if (resolved.dialect === 'mongodb')
    throw new DatabaseError(`Connection "${resolved.name}" is MongoDB; use Mongo / MongoModel from @hazejs/orm/mongo`)
  const state = active(transactions.getStore()?.get(resolved.name))
  const session = {
    name: resolved.name,
    driver: resolved.driver,
    dialect: resolved.dialect,
  }
  if (state)
    return { ...session, db: await state.db, replica: false }
  const replicas = resolved.replicas
  if (!options.read || options.writer || !replicas.length || forcedWriter() || (resolved.sticky && hasWritten(resolved.name)))
    return { ...session, db: resolved.db, replica: false }
  return {
    ...session,
    db: replicas.length === 1
      ? replicas[0]
      : replicas[Math.floor(Math.random() * replicas.length)],
    replica: true,
  }
}

function assertTransactional(name: string, driver: Driver): void {
  // D1 拒绝 BEGIN / SAVEPOINT：原子写入使用 batch
  if (driver === 'd1')
    throw new DatabaseError(`Connection "${name}" is Cloudflare D1, which does not support interactive transactions; use (await Db.drizzle()).batch([...]) for atomic writes`)
  if (driver === 'mongodb')
    throw new DatabaseError(`Connection "${name}" is MongoDB; use Mongo.transaction() from @hazejs/orm/mongo`)
}

/**
 * 在事务中执行；回调内通过 Db / Model 发起的查询自动加入该事务（隐式传播），
 * 嵌套调用使用保存点。回调抛错时回滚。
 */
export async function transaction<R>(callback: (tx: AnyDatabase) => Promise<R>, connection?: string, config?: TransactionConfig): Promise<R> {
  const session = await resolveSession(connection)
  assertTransactional(session.name, session.driver)
  const store = transactions.getStore()
  const parent = active(store?.get(session.name))
  const run = (tx: AnyDatabase): Promise<R> =>
    transactions.run(new Map(store).set(session.name, { db: tx, parent, closed: false }), () => callback(tx))
  return parent
    ? session.db.transaction(run)
    : session.db.transaction(run, config)
}

/** 回滚手动事务时从 drizzle 回调中抛出 */
const ROLLBACK = Symbol('rollback')

/**
 * 手动开启事务（ThinkPHP 的 `Db::startTrans()`），之后在同一个异步函数中的查询自动加入，
 * 用 commit() / rollback() 结束；重复调用开启嵌套事务（保存点）。
 *
 * 事务上下文绑定在调用处的异步上下文上：startTrans 与 commit / rollback 需位于同一个函数，
 * 跨函数传递时请改用 transaction(callback)。
 */
export function startTrans(connection?: string, config?: TransactionConfig): Promise<void> {
  const databases = useDatabaseManager()
  const name = databases.resolveName(connection)
  try {
    assertTransactional(name, databases.connectionConfig(name).driver)
  }
  catch (error) {
    return Promise.reject(error)
  }

  const store = new Map(transactions.getStore())
  const parent = active(store.get(name))
  let ready!: { resolve: (tx: AnyDatabase) => void, reject: (error: unknown) => void }
  let end!: (commit: boolean) => void
  const db = new Promise<AnyDatabase>((resolve, reject) => ready = { resolve, reject })
  const ended = new Promise<boolean>(resolve => end = resolve)
  const state: TxState = { db, parent, closed: false }
  // 必须同步进入：之后调用方的异步延续才能继承这个上下文
  store.set(name, state)
  transactions.enterWith(store)

  const finished = (async () => {
    const base = parent
      ? await parent.db
      : (await databases.connection(name)).db
    const body = async (tx: AnyDatabase): Promise<void> => {
      ready.resolve(tx)
      if (!await ended)
        throw ROLLBACK
    }
    await (parent
      ? base.transaction(body)
      : base.transaction(body, config))
  })().then(() => {}, (error: unknown) => {
    state.closed = true
    ready.reject(error)
    if (error !== ROLLBACK)
      throw error
  })
  state.manual = { end, finished }
  // BEGIN 失败时由 startTrans() 的返回值报告，这里避免未处理的拒绝
  finished.catch(() => {})
  return db.then(() => {})
}

async function finish(commit: boolean, connection?: string): Promise<void> {
  const name = useDatabaseManager().resolveName(connection)
  const store = transactions.getStore()
  const state = active(store?.get(name))
  if (!state?.manual)
    throw new DatabaseError(`No transaction started with startTrans() on connection "${name}"`)
  state.manual.end(commit)
  try {
    await state.manual.finished
  }
  finally {
    state.closed = true
    if (state.parent)
      store!.set(name, state.parent)
    else
      store!.delete(name)
  }
}

/** 提交 startTrans() 开启的事务 */
export function commit(connection?: string): Promise<void> {
  return finish(true, connection)
}

/** 回滚 startTrans() 开启的事务 */
export function rollback(connection?: string): Promise<void> {
  return finish(false, connection)
}

/** 当前上下文是否处于该连接的事务中 */
export function inTransaction(connection?: string): boolean {
  const name = useDatabaseManager().resolveName(connection)
  return active(transactions.getStore()?.get(name)) !== undefined
}

/**
 * 内部使用：在事务中执行一组写入（已处于事务中则直接执行）。
 * D1 与 MongoDB 不支持交互式 SQL 事务，直接执行。
 */
export async function atomically<R>(callback: () => Promise<R>, connection?: string): Promise<R> {
  const databases = useDatabaseManager()
  const name = databases.resolveName(connection)
  const driver = databases.connectionConfig(name).driver
  if (driver === 'd1' || driver === 'mongodb' || inTransaction(name))
    return callback()
  return transaction(callback, name)
}
