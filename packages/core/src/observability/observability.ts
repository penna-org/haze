import type { H3Event, Middleware as H3Middleware } from 'h3'
import type { Application } from '../application'
import type { DashboardConfig, ObservabilityConfig, PathMatcher } from './config'
import type { HttpSpanHandle } from './otel'
import { getHttpContext } from '../http/context'
import { matchesPath } from './config'
import { dashboardMiddleware } from './dashboard/handler'
import { useDashboardStore } from './dashboard/store'
import { healthMiddleware, healthPaths, resolveHealthConfig } from './health'
import { recordSpanException, setupOpenTelemetry, startHttpSpan } from './otel'
import { recordTelemetry, telemetryActive, telemetryHub } from './telemetry'

const kSpan = Symbol.for('hazejs.observability.span')

/** 默认隐藏的请求头（开发面板记录请求时） */
const SENSITIVE_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-csrf-token',
  'x-xsrf-token',
]

export interface ResolvedDashboardConfig {
  enabled: boolean
  path: string
  limit: number
  redactHeaders: Set<string>
  ignorePaths: PathMatcher[]
}

/** 开发面板只在 development 模式下可用，配置无法在其它模式开启 */
export function resolveDashboardConfig(app: Pick<Application, 'config' | 'mode'>): ResolvedDashboardConfig {
  const config = app.config.get<DashboardConfig>('observability.dashboard', {})
  const path = `/${(config.path ?? '/__haze').replace(/^\/+|\/+$/g, '')}`
  return {
    enabled: app.mode === 'development' && config.enabled !== false,
    path,
    limit: config.limit ?? 500,
    redactHeaders: new Set([
      ...SENSITIVE_HEADERS,
      ...(config.redactHeaders ?? []),
    ].map(name => name.toLowerCase())),
    ignorePaths: [
      path,
      ...(config.ignorePaths ?? []),
    ],
  }
}

let dashboardBase: string | undefined

/** 开发面板中某个请求的链接（面板未开启时为 undefined），开发错误页使用 */
export function dashboardLink(requestId: string): string | undefined {
  return dashboardBase && `${dashboardBase}/requests/${encodeURIComponent(requestId)}`
}

/** 异常处理器渲染异常时调用：5xx 记录到请求 span 与开发面板 */
export function reportException(error: unknown, status: number): void {
  // 4xx 属于客户端错误（与 ExceptionHandler.shouldReport 一致），不记录
  if (status < 500)
    return
  recordSpanException(error, status)
  if (!telemetryActive())
    return
  const err = error instanceof Error
    ? error
    : undefined
  recordTelemetry('exception', {
    name: err?.constructor?.name && err.constructor.name !== 'HTTPError'
      ? err.constructor.name
      : err?.name ?? 'Error',
    message: err?.message ?? String(error),
    status,
    stack: err?.stack,
  })
}

function redactHeaders(headers: Headers, redact: Set<string>): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key] = redact.has(key.toLowerCase())
      ? `${value.slice(0, 6)}…（已隐藏）`
      : value
  })
  return result
}

/**
 * 应用的可观测性：健康检查、OpenTelemetry 请求 span 与指标、开发面板。
 * 由 Application 在启动时创建（`await Observability.setup(app)`），接入点：
 * - `middleware()`：最外层中间件（请求作用域之前），建立请求 span；
 * - `onResponse()`：h3 的 onResponse 钩子中调用，结束 span、记录请求；
 * - `routes()`：健康检查与开发面板，安装在全局中间件之前（不受鉴权 / CSRF 影响）。
 */
export class Observability {
  readonly dashboard: ResolvedDashboardConfig
  readonly #app: Application
  readonly #otel: boolean
  readonly #ignore: PathMatcher[]
  /** 健康检查与开发面板自身的路径（不写访问日志） */
  readonly #internal: PathMatcher[]

  /** 使用 Observability.setup() 创建 */
  constructor(app: Application, otel: boolean) {
    this.#app = app
    this.#otel = otel
    this.dashboard = resolveDashboardConfig(app)
    const config = app.config.get<ObservabilityConfig>('observability', {})
    const health = healthPaths(resolveHealthConfig(app))
    this.#internal = [...health, this.dashboard.path]
    this.#ignore = config.otel?.ignorePaths ?? this.#internal
    this.dashboard.ignorePaths.push(...health)
  }

  /** 读取 config/observability.ts：加载 OpenTelemetry（可选）、开启开发面板的记录 */
  static async setup(app: Application): Promise<Observability> {
    const config = app.config.get<ObservabilityConfig>('observability', {})
    const otel = await setupOpenTelemetry(config.otel, app.logger)
    const observability = new Observability(app, otel)
    // 只有开发面板会展示 AI 提示词等内容
    telemetryHub().captureContent = observability.dashboard.enabled
    if (observability.dashboard.enabled) {
      const store = useDashboardStore().listen()
      store.limit = observability.dashboard.limit
      dashboardBase = observability.dashboard.path
    }
    else if (dashboardBase === observability.dashboard.path) {
      dashboardBase = undefined
    }
    return observability
  }

  /** 最外层中间件：在请求的追踪上下文中执行后续处理（未启用时直接放行） */
  middleware(): H3Middleware {
    if (!this.#otel)
      return (_event, next) => next()
    return (event, next) => {
      if (matchesPath(event.url.pathname, this.#ignore))
        return next()
      const handle = startHttpSpan(event)
      if (!handle)
        return next()
      const context = event.context as Record<symbol, unknown>
      context[kSpan] = handle
      return handle.run(next)
    }
  }

  /** h3 onResponse：结束请求 span（状态码为异常渲染后的最终值），开发面板记录请求 */
  onResponse(response: Response, event: H3Event): void {
    const handle = (event.context as Record<symbol, HttpSpanHandle | undefined>)[kSpan]
    const matched = event.context.matchedRoute as { route?: string, meta?: { name?: string, module?: string } } | undefined
    handle?.end(response.status, matched?.route)
    if (this.dashboard.enabled)
      this.#recordRequest(response, event, matched)
  }

  /** 是否为健康检查或开发面板的请求（探针频繁，不写访问日志） */
  isInternal(pathname: string): boolean {
    return matchesPath(pathname, this.#internal)
  }

  /** 健康检查与开发面板的中间件（安装在全局中间件之前） */
  routes(): H3Middleware {
    const health = healthMiddleware(this.#app)
    if (!this.dashboard.enabled)
      return health
    const dashboard = dashboardMiddleware(this.#app, useDashboardStore(), this.dashboard.path)
    return (event, next) => health(event, () => dashboard(event, next))
  }

  #recordRequest(response: Response, event: H3Event, matched: { route?: string, meta?: { name?: string, module?: string } } | undefined): void {
    const pathname = event.url.pathname
    if (matchesPath(pathname, this.dashboard.ignorePaths))
      return
    const ctx = getHttpContext(event)
    const requestId = ctx?.requestId
    const duration = ctx
      ? performance.now() - ctx.startedAt
      : undefined
    useDashboardStore().add('request', {
      method: event.req.method,
      path: pathname,
      query: event.url.search.slice(1) || undefined,
      route: matched?.route,
      name: matched?.meta?.name,
      module: matched?.meta?.module,
      status: response.status,
      duration,
      ip: ctx?.ip,
      app: ctx?.appName,
      requestHeaders: redactHeaders(event.req.headers, this.dashboard.redactHeaders),
      responseHeaders: redactHeaders(response.headers, this.dashboard.redactHeaders),
    }, { requestId })
  }
}
