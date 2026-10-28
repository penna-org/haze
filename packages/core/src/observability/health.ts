import type { Middleware as H3Middleware } from 'h3'
import type { Application } from '../application'
import type { MaybePromise } from '../utils'
import { CacheManager } from '../cache/manager'
import { QueueManager } from '../queue/manager'
import { StorageManager } from '../storage/manager'

export type HealthStatus = 'ok' | 'degraded' | 'down'

export interface HealthCheckContext {
  app: Application
  /** 超时后中止 */
  signal: AbortSignal
}

/** 检查函数的返回值：无返回 / true 为正常，false 为故障，字符串为附带的说明 */
export type HealthCheckResult = void | boolean | string | { status?: HealthStatus, message?: string }

export type HealthCheckFn = (ctx: HealthCheckContext) => MaybePromise<HealthCheckResult>

export interface HealthCheckDefinition {
  check: HealthCheckFn
  /** 毫秒，默认取 config.timeout */
  timeout?: number
  /** false 时故障只把整体状态降为 degraded（仍返回 200），默认 true */
  critical?: boolean
}

export type HealthCheckInput = HealthCheckFn | HealthCheckDefinition

export interface HealthConfig {
  /** 默认开启 */
  enabled?: boolean
  /** 就绪检查路径，默认 /health；同时提供 `<path>/ready` 与存活检查 `<path>/live` */
  path?: string
  /** 单项检查的超时（毫秒），默认 5000 */
  timeout?: number
  checks?: Record<string, HealthCheckInput>
  /** 响应中包含故障原因，默认非 production 时开启（生产环境只记录到日志） */
  verbose?: boolean
  /** 缓存就绪检查结果的毫秒数，避免探针频繁访问数据库，默认 0（不缓存） */
  cache?: number
}

export interface HealthCheckReport {
  status: HealthStatus
  latencyMs: number
  message?: string
}

export interface HealthReport {
  status: HealthStatus
  checks: Record<string, HealthCheckReport>
}

/** `config/health.ts` 的默认导出 */
export function defineHealthConfig(config: HealthConfig | (() => HealthConfig)): HealthConfig | (() => HealthConfig) {
  return config
}

export interface ResolvedHealthConfig {
  enabled: boolean
  path: string
  timeout: number
  checks: Record<string, HealthCheckDefinition>
  verbose: boolean
  cache: number
}

export function resolveHealthConfig(app: Pick<Application, 'config' | 'mode'>): ResolvedHealthConfig {
  const config = app.config.get<HealthConfig>('health', {})
  return {
    enabled: config.enabled ?? true,
    path: `/${(config.path ?? '/health').replace(/^\/+|\/+$/g, '')}`,
    timeout: config.timeout ?? 5000,
    checks: Object.fromEntries(Object.entries(config.checks ?? {}).map(([name, input]) => [
      name,
      typeof input === 'function'
        ? { check: input }
        : input,
    ])),
    verbose: config.verbose ?? app.mode !== 'production',
    cache: config.cache ?? 0,
  }
}

/** 健康检查涉及的全部路径（OpenTelemetry 与开发面板默认忽略） */
export function healthPaths(config: ResolvedHealthConfig): string[] {
  return config.enabled
    ? [config.path]
    : []
}

async function runCheck(app: Application, name: string, definition: HealthCheckDefinition, config: ResolvedHealthConfig): Promise<HealthCheckReport> {
  const controller = new AbortController()
  const timeout = definition.timeout ?? config.timeout
  const started = performance.now()
  let timer: ReturnType<typeof setTimeout> | undefined
  const latency = (): number => Math.round((performance.now() - started) * 100) / 100
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => definition.check({ app, signal: controller.signal })),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort()
          reject(new HealthTimeoutError(`timed out after ${timeout}ms`))
        }, timeout)
      }),
    ])
    if (result === false) {
      return {
        status: 'down',
        latencyMs: latency(),
      }
    }
    if (typeof result === 'string') {
      return {
        status: 'ok',
        latencyMs: latency(),
        message: result,
      }
    }
    if (result && typeof result === 'object') {
      return {
        status: result.status ?? 'ok',
        latencyMs: latency(),
        ...(result.message !== undefined && {
          message: result.message,
        }),
      }
    }
    return {
      status: 'ok',
      latencyMs: latency(),
    }
  }
  catch (error) {
    const message = error instanceof Error
      ? error.message
      : String(error)
    if (!(error instanceof HealthTimeoutError))
      app.logger.child({ check: name }).error('Health check failed', error)
    return {
      status: 'down',
      latencyMs: latency(),
      // 生产环境默认不暴露内部错误（可能包含主机名、连接串等），超时信息始终可见
      message: config.verbose || error instanceof HealthTimeoutError
        ? message
        : 'check failed',
    }
  }
  finally {
    clearTimeout(timer)
  }
}

class HealthTimeoutError extends Error {}

/**
 * 执行全部检查（并行）：关键检查故障为 down，非关键检查故障或有检查返回 degraded 时为 degraded
 */
export async function runHealthChecks(app: Application, config: ResolvedHealthConfig = resolveHealthConfig(app)): Promise<HealthReport> {
  const entries = await Promise.all(Object.entries(config.checks).map(async ([name, definition]) =>
    [name, definition, await runCheck(app, name, definition, config)] as const))
  let status: HealthStatus = 'ok'
  const checks: Record<string, HealthCheckReport> = {}
  for (const [name, definition, report] of entries) {
    checks[name] = report
    if (report.status === 'down' && definition.critical !== false)
      status = 'down'
    else if (report.status !== 'ok' && status === 'ok')
      status = 'degraded'
  }
  return { status, checks }
}

function json(body: unknown, status: number, head: boolean): Response {
  return new Response(head
    ? null
    : JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * 健康检查中间件（安装在全局中间件之前，不受鉴权 / CSRF 影响，不经过统一响应格式）：
 * - `<path>/live`：存活检查，进程能处理请求即返回 200；
 * - `<path>`、`<path>/ready`：就绪检查，执行配置的检查，down 时返回 503。
 *
 * 项目中已定义相同路径的 GET 路由时以项目路由为准。
 */
export function healthMiddleware(app: Application): H3Middleware {
  const config = resolveHealthConfig(app)
  if (!config.enabled)
    return (_event, next) => next()
  const live = `${config.path}/live`
  const ready = `${config.path}/ready`
  let shadowed: Set<string> | undefined
  let cached: { at: number, report: Promise<HealthReport> } | undefined

  return async (event, next) => {
    const method = event.req.method
    if (method !== 'GET' && method !== 'HEAD')
      return next()
    const pathname = event.url.pathname
    if (pathname !== config.path && pathname !== live && pathname !== ready)
      return next()
    // 首次请求时路由已编译完成
    shadowed ??= new Set(app.router.list()
      .filter(route => route.method === 'GET' && !route.domain)
      .map(route => route.path))
    if (shadowed.has(pathname))
      return next()

    const head = method === 'HEAD'
    if (pathname === live)
      return json({ status: 'ok' }, 200, head)

    const now = Date.now()
    if (!cached || now - cached.at >= config.cache) {
      cached = {
        at: now,
        report: runHealthChecks(app, config),
      }
    }
    const report = await cached.report
    return json(report, report.status === 'down'
      ? 503
      : 200, head)
  }
}

// ---- 内置检查 ------------------------------------------------------------------

/** 缓存存储可读写（写入并读回一个短期键） */
export function cacheCheck(store?: string): HealthCheckFn {
  return async ({ app }) => {
    const repository = app.make(CacheManager).store(store)
    const key = `health:${crypto.randomUUID()}`
    await repository.set(key, 1, 10)
    const value = await repository.get(key)
    await repository.forget(key)
    if (value !== 1)
      return { status: 'down', message: `cache store "${repository.name}" did not return the written value` }
  }
}

/**
 * Redis：传入缓存存储名（redis / upstash 驱动的存储，读写探测），
 * 或带 ping() 的客户端（如 ioredis 实例）
 */
export function redisCheck(target: string | { ping: () => Promise<unknown> } = 'redis'): HealthCheckFn {
  if (typeof target === 'string')
    return cacheCheck(target)
  return async () => {
    const reply = await target.ping()
    if (reply !== 'PONG' && reply !== 'pong')
      return { status: 'down', message: `unexpected PING reply: ${String(reply)}` }
  }
}

/** 文件存储磁盘可访问（查询一个不存在的文件，不写入） */
export function storageCheck(disk?: string): HealthCheckFn {
  return async ({ app }) => {
    await app.make(StorageManager).disk(disk).exists('.haze-health-check')
  }
}

/**
 * 队列连接：有积压统计的驱动（memory / redis）返回待处理与失败数量，
 * 失败任务超过 maxFailed 时为 degraded
 */
export function queueCheck(options: { connection?: string, maxFailed?: number } = {}): HealthCheckFn {
  return async ({ app }) => {
    const counts = await app.make(QueueManager).counts(options.connection)
    if (!counts)
      return
    const message = `waiting ${counts.waiting}, delayed ${counts.delayed}, active ${counts.active}, failed ${counts.failed}`
    if (options.maxFailed !== undefined && counts.failed > options.maxFailed)
      return { status: 'degraded', message }
    return message
  }
}

/** @hazejs/orm 的 Db（或 Db.connection(name)）的结构，core 不直接依赖 ORM */
interface DbLike {
  execute: (query: any) => Promise<unknown>
  raw: (sql: string) => unknown
  connection?: (name: string) => { execute: (query: any) => Promise<unknown> }
}

/**
 * 数据库连接：执行 `select 1`。传入 @hazejs/orm 的 Db：
 *
 * ```ts
 * import { Db } from '@hazejs/orm'
 * checks: { db: dbCheck(Db), analytics: dbCheck(Db, { connection: 'analytics' }) }
 * ```
 */
export function dbCheck(db: DbLike, options: { connection?: string, query?: string } = {}): HealthCheckFn {
  return async () => {
    const target = options.connection && db.connection
      ? db.connection(options.connection)
      : db
    await target.execute(db.raw(options.query ?? 'select 1'))
  }
}
