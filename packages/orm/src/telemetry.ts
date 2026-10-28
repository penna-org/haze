/**
 * 查询遥测：上报到 @hazejs/core 的遥测总线（`globalThis[Symbol.for('hazejs.telemetry')]`），
 * 供开发面板与 OpenTelemetry 使用。不依赖 core 的实现；没有监听者时只多一次属性判断。
 */

interface TelemetryHub {
  listeners: { size: number }
  record: (kind: string, data: object) => void
}

const kHub = Symbol.for('hazejs.telemetry')
const kInstrumented = Symbol.for('hazejs.orm.instrumented')
const kRunning = Symbol('running')

function activeHub(): TelemetryHub | undefined {
  const hub = (globalThis as { [kHub]?: TelemetryHub })[kHub]
  return hub?.listeners.size ? hub : undefined
}

interface Captured {
  sql?: string
  params?: unknown[]
}

/** drizzle 的 logQuery 在执行查询前同步调用：借此拿到实际 SQL 与绑定参数 */
let capturing: Captured | undefined

/** drizzle 的 logger：捕获 SQL / 参数，并在开启 logging 时写日志 */
export function queryLogger(log?: (query: string, params: unknown[]) => void): { logQuery: (query: string, params: unknown[]) => void } {
  return {
    logQuery(query, params) {
      if (capturing) {
        capturing.sql = query
        capturing.params = params
      }
      log?.(query, params)
    },
  }
}

const PREPARED_METHODS = [
  'execute',
  'all',
  'get',
  'values',
  'run',
] as const

type AnyObject = Record<PropertyKey, any>

function instrumentPrepared(prepared: AnyObject, info: { connection: string, dialect: string }): AnyObject {
  for (const method of PREPARED_METHODS) {
    const original = prepared[method]
    if (typeof original !== 'function')
      continue
    prepared[method] = function (this: AnyObject, ...args: unknown[]) {
      const hub = activeHub()
      // execute() 内部会调用 all() / run()：只记录最外层
      if (!hub || prepared[kRunning])
        return original.apply(this, args)
      const captured: Captured = {}
      const startTime = Date.now()
      const started = performance.now()
      let result: unknown
      prepared[kRunning] = true
      capturing = captured
      try {
        result = original.apply(this, args)
      }
      finally {
        capturing = undefined
        prepared[kRunning] = false
      }
      const report = (error?: unknown): void => hub.record('query', {
        sql: captured.sql ?? prepared.query?.sql ?? prepared.queryString ?? prepared.rawQuery?.sql ?? '',
        params: captured.params ?? prepared.query?.params ?? prepared.params,
        connection: info.connection,
        dialect: info.dialect,
        startTime,
        duration: performance.now() - started,
        ...(error !== undefined && {
          error: error instanceof Error
            ? error.message
            : String(error),
        }),
      })
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        return (result as Promise<unknown>).then((value) => {
          report()
          return value
        }, (error: unknown) => {
          report(error)
          throw error
        })
      }
      report()
      return result
    }
  }
  return prepared
}

function instrumentSession(session: AnyObject | undefined, info: { connection: string, dialect: string }): void {
  if (!session || session[kInstrumented] || typeof session.prepareQuery !== 'function')
    return
  session[kInstrumented] = true
  const prepareQuery = session.prepareQuery
  session.prepareQuery = function (this: AnyObject, ...args: unknown[]) {
    return instrumentPrepared(prepareQuery.apply(this, args), info)
  }
}

/**
 * 给 drizzle 实例加上查询遥测：包装 session 的 prepareQuery（关系查询与查询构造器都经过它），
 * 事务回调拿到的 tx 使用新的 session，同样包装。
 */
export function instrumentDatabase<T>(db: T, info: { connection: string, dialect: string }): T {
  const target = db as AnyObject
  if (!target || target[kInstrumented])
    return db
  target[kInstrumented] = true
  instrumentSession(target.session, info)
  const transaction = target.transaction
  if (typeof transaction === 'function') {
    target.transaction = function (this: AnyObject, callback: (tx: unknown) => unknown, ...rest: unknown[]) {
      return transaction.call(this, (tx: unknown) => callback(instrumentDatabase(tx, info)), ...rest)
    }
  }
  return db
}
