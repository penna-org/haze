import type { RequestStore } from '@hazejs/core'
import { AsyncLocalStorage } from 'node:async_hooks'
import { getRequestStore } from '@hazejs/core'

/**
 * 读写分离的路由上下文：
 * - `written`：本作用域内写入过的连接（sticky 用），省略时使用当前请求的集合
 * - `writer`：Db.useWriter() 中强制读取走写库
 */
interface RoutingScope {
  written?: Set<string>
  writer?: boolean
}

const scopes = new AsyncLocalStorage<RoutingScope>()

/** 每个请求写入过的连接（以请求的上下文对象为键，请求结束后随之回收） */
const requestWrites = new WeakMap<RequestStore, Set<string>>()

/** 当前作用域（Db.withinScope）或当前请求写入过的连接；都不存在时为 undefined（不记录） */
function writtenSet(create: boolean): Set<string> | undefined {
  const scope = scopes.getStore()
  if (scope?.written)
    return scope.written
  const request = getRequestStore()
  if (!request)
    return undefined
  let set = requestWrites.get(request)
  if (!set && create)
    requestWrites.set(request, set = new Set())
  return set
}

/** 记录当前请求 / 作用域写入过该连接（sticky：之后的读取走写库） */
export function markWritten(connection: string): void {
  writtenSet(true)?.add(connection)
}

/** 当前请求 / 作用域是否写入过该连接 */
export function hasWritten(connection: string): boolean {
  return writtenSet(false)?.has(connection) ?? false
}

/** 是否处于 Db.useWriter() 中 */
export function forcedWriter(): boolean {
  return scopes.getStore()?.writer === true
}

/** 回调内的读取都走写库（不影响事务与写入） */
export function useWriter<R>(callback: () => R): R {
  const current = scopes.getStore()
  return scopes.run({ written: current?.written, writer: true }, callback)
}

/**
 * 新的 sticky 作用域：回调内写入过的连接，之后的读取走写库。
 * 请求中自动以请求为作用域；队列任务、命令、脚本等请求之外的代码用它划定范围。
 */
export function withinScope<R>(callback: () => R): R {
  return scopes.run({
    written: new Set(),
    writer: scopes.getStore()?.writer,
  }, callback)
}

/** 只读语句（其余语句都视为写入，宁可多走写库也不读到旧数据） */
const READ_STATEMENT_RE = /^[\s(]*(?:select|show|explain|pragma|values|describe|desc)\b/i

type AnyObject = Record<PropertyKey, any>

const kTracked = Symbol.for('hazejs.orm.trackWrites')

function trackSession(session: AnyObject | undefined, connection: string): void {
  if (!session || session[kTracked] || typeof session.prepareQuery !== 'function')
    return
  session[kTracked] = true
  const prepareQuery = session.prepareQuery
  session.prepareQuery = function (this: AnyObject, query: { sql?: string } | undefined, ...rest: unknown[]) {
    if (!READ_STATEMENT_RE.test(query?.sql ?? ''))
      markWritten(connection)
    return prepareQuery.call(this, query, ...rest)
  }
}

/**
 * 写库上执行的写语句标记 sticky：包装 drizzle session 的 prepareQuery，
 * 查询构造器、模型、Db.execute() 与 Db.drizzle() 直接写入都经过它（事务对象同样包装）
 */
export function trackWrites<T>(db: T, connection: string): T {
  const target = db as AnyObject
  if (!target || target[kTracked])
    return db
  target[kTracked] = true
  trackSession(target.session, connection)
  const transaction = target.transaction
  if (typeof transaction === 'function') {
    target.transaction = function (this: AnyObject, callback: (tx: unknown) => unknown, ...rest: unknown[]) {
      return transaction.call(this, (tx: unknown) => callback(trackWrites(tx, connection)), ...rest)
    }
  }
  return db
}
