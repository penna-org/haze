import type { Application } from '@hazejs/core'
import type { Dialect, Driver } from './config'
import type { Connection, DatabaseManager } from './connection'
import type { AnyDatabase } from './types'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getContextApp, registerAfterCommitHandler } from '@hazejs/core'
import { DatabaseError } from './errors'
import { forcedWriter, hasWritten } from './routing'

let manager: DatabaseManager | undefined

/** 各应用自己的 DatabaseManager：同一进程中有多个应用（测试）时，请求内使用请求所属应用的连接 */
const managers = new WeakMap<Application, DatabaseManager>()

/** 由 databaseProvider() 在应用启动时设置；脚本 / 测试中可直接调用 */
export function setDatabaseManager(value: DatabaseManager | undefined): void {
  manager = value
}

/** 记录应用的 DatabaseManager（databaseProvider() 调用） */
export function bindDatabaseManager(app: Application, value: DatabaseManager): void {
  managers.set(app, value)
}

/** withDatabaseManager() 指定的 DatabaseManager（随异步上下文传递，包括其中创建的定时器与 Promise） */
const scoped = new AsyncLocalStorage<DatabaseManager>()

/**
 * 在回调中使用指定的 DatabaseManager：其中的 Db / Model 查询、事务与 Db.drizzleSync()，以及回调中创建的定时器、
 * Promise 都使用它，优先于请求所属的应用与最近启动的应用。同一进程中有多个应用（测试）时，
 * 请求之外的代码（后台任务、脚本）可以借此固定使用自己应用的连接
 */
export function withDatabaseManager<R>(value: DatabaseManager, callback: () => R): R {
  return scoped.run(value, callback)
}

/**
 * 当前的 DatabaseManager（未配置时为 undefined，不抛错），依次为：withDatabaseManager() 指定的、
 * 当前上下文所属应用的（请求、队列任务、定时任务、事件监听器）、最近启动的应用的
 */
export function currentDatabaseManager(): DatabaseManager | undefined {
  const explicit = scoped.getStore()
  if (explicit)
    return explicit
  // 请求所属的应用，或队列任务 / 定时任务 / 事件监听器所属的应用（core 的 runInApp()）
  const app = getContextApp()
  return (app && managers.get(app)) ?? manager
}

export function useDatabaseManager(): DatabaseManager {
  const manager = currentDatabaseManager()
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
  /** 外部开启、经 joinTransaction() 加入的事务 */
  joined?: boolean
  /** afterCommit 回调：本层提交后移交外层，最外层提交后执行，回滚时丢弃 */
  callbacks?: CommitCallback[]
}

/** 一个 afterCommit 回调（同时处于多个连接的事务中时，全部提交后才执行，任一回滚即丢弃） */
interface CommitCallback {
  run: () => Promise<void>
  remaining: number
  discarded: boolean
}

/** 事务上下文：`<DatabaseManager>:<连接名>` → 当前事务（同一进程中多个应用的同名连接互不影响） */
const transactions = new AsyncLocalStorage<Map<string, TxState>>()

const managerIds = new WeakMap<DatabaseManager, number>()
let nextManagerId = 0

function txKey(databases: DatabaseManager, name: string): string {
  let id = managerIds.get(databases)
  if (id === undefined)
    managerIds.set(databases, id = ++nextManagerId)
  return `${id}:${name}`
}

/** 跳过已结束的事务，取仍在进行的最内层事务 */
function active(state: TxState | undefined): TxState | undefined {
  while (state?.closed)
    state = state.parent
  return state
}

/** 事务回滚：丢弃登记在这一层的 afterCommit 回调 */
function discardCallbacks(state: TxState): void {
  for (const callback of state.callbacks ?? [])
    callback.discarded = true
  state.callbacks = undefined
}

/**
 * 事务提交：保存点（有外层事务）把回调移交外层；最外层提交后依次执行
 * （joinTransaction() 加入的外部事务没有外层时，在其回调成功返回后执行）
 */
async function commitCallbacks(state: TxState): Promise<void> {
  const callbacks = state.callbacks ?? []
  state.callbacks = undefined
  const parent = active(state.parent)
  if (parent) {
    (parent.callbacks ??= []).push(...callbacks)
    return
  }
  for (const callback of callbacks) {
    if (callback.discarded || --callback.remaining > 0)
      continue
    await callback.run()
  }
}

/**
 * 登记 afterCommit 回调：当前上下文处于事务中时（指定 connection 时只看该连接，否则为任意连接）
 * 登记到最内层事务并返回 true；不在事务中时返回 false
 */
export function deferAfterCommit(run: () => Promise<void>, connection?: string): boolean {
  const store = transactions.getStore()
  if (!store?.size)
    return false
  let states: TxState[]
  if (connection === undefined) {
    states = [
      ...new Set([
        ...store.values(),
      ].map(active).filter((state): state is TxState => state !== undefined)),
    ]
  }
  else {
    const databases = useDatabaseManager()
    const state = active(store.get(txKey(databases, databases.resolveName(connection))))
    states = state
      ? [state]
      : []
  }
  if (!states.length)
    return false
  const callback: CommitCallback = { run, remaining: states.length, discarded: false }
  for (const state of states)
    (state.callbacks ??= []).push(callback)
  return true
}

// core 的 afterCommit()、任务与事件的 afterCommit 通过这个钩子判断是否处于事务中（globalThis 上的集合，重复注册无影响）
registerAfterCommitHandler(callback => deferAfterCommit(callback))

/**
 * 事务提交后执行（ThinkPHP / Laravel 的 afterCommit）：处于事务中时推迟到最外层事务提交后执行
 * （保存点回滚、整个事务回滚时丢弃），不在事务中时立即执行。推迟执行的回调在 `Db.transaction()` /
 * `Db.commit()` 返回前执行，抛出的错误只记录日志（事务已经提交）。指定 connection 时只看该连接的事务
 */
export async function afterCommit(callback: () => unknown, connection?: string): Promise<void> {
  const run = async (): Promise<void> => {
    try {
      await callback()
    }
    catch (error) {
      const logger = getContextApp()?.logger
      if (logger)
        logger.error('afterCommit callback failed', error)
      else
        console.error('afterCommit callback failed', error)
    }
  }
  if (deferAfterCommit(run, connection))
    return
  await callback()
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
  const databases = useDatabaseManager()
  const resolved: Connection = await databases.connection(connection)
  if (resolved.dialect === 'mongodb')
    throw new DatabaseError(`Connection "${resolved.name}" is MongoDB; use Mongo / MongoModel from @hazejs/orm/mongo`)
  const state = active(transactions.getStore()?.get(txKey(databases, resolved.name)))
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

/**
 * 同步取得连接当前可用的 drizzle 实例（处于事务中时为事务对象），给不能 await 的代码使用（如 Repository 的 `db` 属性）。
 * 需先建立连接（`await Db.connect()` 或任意一次查询）；配置了读写分离时总是写库
 */
export function resolveSessionSync(connection?: string): Session {
  const databases = useDatabaseManager()
  const resolved = databases.connectionSync(connection)
  if (resolved.dialect === 'mongodb')
    throw new DatabaseError(`Connection "${resolved.name}" is MongoDB; use Mongo / MongoModel from @hazejs/orm/mongo`)
  const session = {
    name: resolved.name,
    driver: resolved.driver,
    dialect: resolved.dialect,
    replica: false,
  }
  const state = active(transactions.getStore()?.get(txKey(databases, resolved.name)))
  if (!state)
    return { ...session, db: resolved.db }
  if (state.db instanceof Promise)
    throw new DatabaseError(`The transaction on connection "${resolved.name}" has not started yet; await Db.startTrans() before using it synchronously`)
  return { ...session, db: state.db }
}

/**
 * 让外部开启的事务加入事务上下文（第三方库自己调用 drizzle 的 `db.transaction(tx => …)` 时）：
 * 回调中的 Db / Model 查询与 Db.drizzleSync() 都使用这个事务对象，其中再开启的事务为保存点。
 * 事务的提交与回滚仍由外部负责
 */
export function joinTransaction<R>(tx: AnyDatabase, callback: () => R, connection?: string): R {
  const databases = useDatabaseManager()
  const key = txKey(databases, databases.resolveName(connection))
  const store = transactions.getStore()
  const parent = active(store?.get(key))
  const state: TxState = {
    db: tx,
    parent,
    closed: false,
    joined: true,
  }
  const result = transactions.run(new Map(store).set(key, state), callback)
  // 外部事务的提交时机未知：回调成功返回后视为提交（外部随即提交），失败时视为回滚
  if (result instanceof Promise) {
    return result.then(async (value) => {
      state.closed = true
      await commitCallbacks(state)
      return value
    }, (error: unknown) => {
      state.closed = true
      discardCallbacks(state)
      throw error
    }) as R
  }
  state.closed = true
  void commitCallbacks(state)
  return result
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
  const databases = useDatabaseManager()
  const session = await resolveSession(connection)
  assertTransactional(session.name, session.driver)
  const key = txKey(databases, session.name)
  const store = transactions.getStore()
  const parent = active(store?.get(key))
  let state: TxState | undefined
  const run = (tx: AnyDatabase): Promise<R> => {
    state = { db: tx, parent, closed: false }
    return transactions.run(new Map(store).set(key, state), () => callback(tx))
  }
  let result: R
  try {
    result = await (parent
      ? session.db.transaction(run)
      : session.db.transaction(run, config))
  }
  catch (error) {
    if (state) {
      state.closed = true
      discardCallbacks(state)
    }
    throw error
  }
  // 已提交（保存点已释放）：afterCommit 回调移交外层，或在最外层提交后执行
  if (state) {
    state.closed = true
    await commitCallbacks(state)
  }
  return result
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

  const key = txKey(databases, name)
  const store = new Map(transactions.getStore())
  const parent = active(store.get(key))
  let ready!: { resolve: (tx: AnyDatabase) => void, reject: (error: unknown) => void }
  let end!: (commit: boolean) => void
  const db = new Promise<AnyDatabase>((resolve, reject) => ready = { resolve, reject })
  const ended = new Promise<boolean>(resolve => end = resolve)
  const state: TxState = { db, parent, closed: false }
  // 必须同步进入：之后调用方的异步延续才能继承这个上下文
  store.set(key, state)
  transactions.enterWith(store)

  const finished = (async () => {
    const base = parent
      ? await parent.db
      : (await databases.connection(name)).db
    const body = async (tx: AnyDatabase): Promise<void> => {
      // 同步取用（Db.drizzleSync()）需要已解析的事务对象
      state.db = tx
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
  const databases = useDatabaseManager()
  const name = databases.resolveName(connection)
  const key = txKey(databases, name)
  const store = transactions.getStore()
  const state = active(store?.get(key))
  if (!state?.manual)
    throw new DatabaseError(`No transaction started with startTrans() on connection "${name}"`)
  state.manual.end(commit)
  let committed = false
  try {
    await state.manual.finished
    committed = commit
  }
  finally {
    state.closed = true
    if (state.parent)
      store!.set(key, state.parent)
    else
      store!.delete(key)
    if (!committed)
      discardCallbacks(state)
  }
  if (committed)
    await commitCallbacks(state)
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
  const databases = useDatabaseManager()
  return active(transactions.getStore()?.get(txKey(databases, databases.resolveName(connection)))) !== undefined
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
