import type * as OTel from '@opentelemetry/api'
import type { H3Event } from 'h3'
import type { Logger } from '../logger'
import type { OpenTelemetryConfig } from './config'
import type { TelemetryEvents, TelemetryKind } from './telemetry'
import { FRAMEWORK_NAME } from '../constants'
import { onTelemetry } from './telemetry'

type Api = typeof OTel

/**
 * OpenTelemetry 集成：只依赖 @opentelemetry/api（可选 peer 依赖），运行时动态加载。
 * 未安装或未开启时所有函数都是空操作：只判断一次模块级变量。
 * SDK（NodeSDK、导出器、上下文管理器、传播器）由项目在 instrumentation 文件中初始化。
 */

interface Instruments {
  provider: unknown
  requestDuration: OTel.Histogram
  activeRequests: OTel.UpDownCounter
  jobDuration: OTel.Histogram
  jobFailures: OTel.Counter
}

interface State {
  api: Api
  tracer: OTel.Tracer
  name: string
  traces: Required<NonNullable<OpenTelemetryConfig['traces']>>
  metrics: boolean
  instruments?: Instruments
  unsubscribe?: () => void
}

let state: State | undefined
let loader: () => Promise<unknown> = () => import('@opentelemetry/api')
let loaded: Promise<Api | undefined> | undefined

/** @internal */
export function setOpenTelemetryLoader(load: (() => Promise<unknown>) | undefined): void {
  loader = load ?? (() => import('@opentelemetry/api'))
  loaded = undefined
}

async function loadApi(): Promise<Api | undefined> {
  loaded ??= loader().then(
    // 打包器会把未安装的可选依赖替换为空模块，按实际导出判断
    mod => typeof (mod as Api)?.trace?.getTracer === 'function'
      ? mod as Api
      : undefined,
    () => undefined,
  )
  return loaded
}

/**
 * 按 config/observability.ts 的 otel 配置启用（应用启动时调用，重复调用以最后一次为准）。
 * 返回是否已启用。
 */
export async function setupOpenTelemetry(config: OpenTelemetryConfig | undefined, logger?: Logger): Promise<boolean> {
  if (!config?.enabled) {
    disableOpenTelemetry()
    return false
  }
  const api = await loadApi()
  if (!api) {
    logger?.warn('observability.otel.enabled is true, but @opentelemetry/api is not installed; tracing is disabled. Install it with: pnpm add @opentelemetry/api')
    disableOpenTelemetry()
    return false
  }
  const name = config.name ?? FRAMEWORK_NAME
  state?.unsubscribe?.()
  state = {
    api,
    tracer: api.trace.getTracer(name),
    name,
    traces: {
      http: true,
      db: true,
      cache: false,
      mail: true,
      queue: true,
      ai: true,
      ...config.traces,
    },
    metrics: config.metrics ?? true,
  }
  // 数据库、缓存、邮件、AI 的 span 由遥测事件在操作结束后补建（带真实的开始 / 结束时间）
  state.unsubscribe = onTelemetry(spanFromTelemetry)
  return true
}

export function disableOpenTelemetry(): void {
  state?.unsubscribe?.()
  state = undefined
}

/** OpenTelemetry 是否已启用 */
export function openTelemetryEnabled(): boolean {
  return state !== undefined
}

/** 当前活动 span 的 trace_id / span_id（写入日志） */
export function activeTraceIds(): { trace_id: string, span_id: string } | undefined {
  if (!state)
    return undefined
  const context = state.api.trace.getSpanContext(state.api.context.active())
  if (!context || !state.api.isSpanContextValid(context))
    return undefined
  return { trace_id: context.traceId, span_id: context.spanId }
}

// ---- W3C Trace Context -------------------------------------------------------

const TRACEPARENT_RE = /^00-([\da-f]{32})-([\da-f]{16})-([\da-f]{2})$/

function parseTraceparent(api: Api, value: string | undefined, tracestate?: string): OTel.SpanContext | undefined {
  const match = value?.trim().toLowerCase().match(TRACEPARENT_RE)
  if (!match)
    return undefined
  const context: OTel.SpanContext = {
    traceId: match[1]!,
    spanId: match[2]!,
    traceFlags: Number.parseInt(match[3]!, 16),
    isRemote: true,
    ...(tracestate && {
      traceState: api.createTraceState(tracestate),
    }),
  }
  return api.isSpanContextValid(context)
    ? context
    : undefined
}

function formatTraceparent(context: OTel.SpanContext): string {
  return `00-${context.traceId}-${context.spanId}-${(context.traceFlags & 0xFF).toString(16).padStart(2, '0')}`
}

const headersGetter: OTel.TextMapGetter<Headers> = {
  get: (carrier, key) => carrier.get(key) ?? undefined,
  keys: carrier => [
    ...carrier.keys(),
  ],
}

/**
 * 从载体（请求头或普通对象）中恢复上下文：先用全局传播器（NodeSDK 默认注册 W3C），
 * 未注册传播器时按 W3C traceparent 自行解析
 */
function extractContext(api: Api, carrier: Headers | Record<string, string | undefined>): OTel.Context {
  const isHeaders = carrier instanceof Headers
  const context = isHeaders
    ? api.propagation.extract(api.ROOT_CONTEXT, carrier, headersGetter)
    : api.propagation.extract(api.ROOT_CONTEXT, carrier)
  if (api.trace.getSpanContext(context))
    return context
  const get = (key: string): string | undefined => isHeaders
    ? carrier.get(key) ?? undefined
    : carrier[key]
  const parent = parseTraceparent(api, get('traceparent'), get('tracestate'))
  return parent
    ? api.trace.setSpanContext(context, parent)
    : context
}

function injectContext(api: Api, context: OTel.Context, carrier: Record<string, string>): Record<string, string> {
  api.propagation.inject(context, carrier)
  const span = api.trace.getSpanContext(context)
  if (!carrier.traceparent && span && api.isSpanContextValid(span)) {
    carrier.traceparent = formatTraceparent(span)
    const traceState = span.traceState?.serialize()
    if (traceState)
      carrier.tracestate = traceState
  }
  return carrier
}

/**
 * 把当前追踪上下文写入载体（traceparent / tracestate 等），用于跨进程传播：
 * 自定义的 RPC、消息队列等。未启用时原样返回。
 */
export function injectTraceContext(carrier: Record<string, string> = {}): Record<string, string> {
  if (!state)
    return carrier
  return injectContext(state.api, state.api.context.active(), carrier)
}

/** 在载体（如消息头）携带的追踪上下文中执行 fn，fn 内创建的 span 继续同一条链路 */
export function withTraceContext<T>(carrier: Headers | Record<string, string | undefined> | undefined, fn: () => T): T {
  if (!state || !carrier)
    return fn()
  return state.api.context.with(extractContext(state.api, carrier), fn)
}

/**
 * 带追踪的 fetch：创建 CLIENT span，并在请求头中注入 traceparent，下游服务可以接续链路。
 * 未启用 OpenTelemetry 时等同于 fetch。
 */
export async function tracedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  if (!state)
    return fetch(input, init)
  const { api, tracer } = state
  const request = new Request(input, init)
  const url = new URL(request.url)
  const span = tracer.startSpan(request.method, {
    kind: api.SpanKind.CLIENT,
    attributes: {
      'http.request.method': request.method,
      'url.full': stripCredentials(url),
      'server.address': url.hostname,
      ...(url.port && {
        'server.port': Number(url.port),
      }),
    },
  })
  const context = api.trace.setSpan(api.context.active(), span)
  const headers = new Headers(request.headers)
  for (const [key, value] of Object.entries(injectContext(api, context, {})))
    headers.set(key, value)
  try {
    const response = await api.context.with(context, () => fetch(new Request(request, { headers })))
    span.setAttribute('http.response.status_code', response.status)
    if (response.status >= 400) {
      span.setAttribute('error.type', String(response.status))
      span.setStatus({ code: api.SpanStatusCode.ERROR })
    }
    return response
  }
  catch (error) {
    span.recordException(error as Error)
    span.setAttribute('error.type', (error as Error)?.name ?? 'Error')
    span.setStatus({ code: api.SpanStatusCode.ERROR, message: (error as Error)?.message })
    throw error
  }
  finally {
    span.end()
  }
}

function stripCredentials(url: URL): string {
  if (!url.username && !url.password)
    return url.href
  const copy = new URL(url.href)
  copy.username = 'REDACTED'
  copy.password = 'REDACTED'
  return copy.href
}

// ---- 指标 --------------------------------------------------------------------

function instruments(): Instruments | undefined {
  if (!state?.metrics)
    return undefined
  // 全局 MeterProvider 没有代理：SDK 晚于应用注册时按新的 provider 重建
  const provider = state.api.metrics.getMeterProvider()
  if (state.instruments?.provider === provider)
    return state.instruments
  const meter = provider.getMeter(state.name)
  state.instruments = {
    provider,
    requestDuration: meter.createHistogram('http.server.request.duration', {
      unit: 's',
      description: 'Duration of HTTP server requests.',
      advice: {
        explicitBucketBoundaries: [
          0.005,
          0.01,
          0.025,
          0.05,
          0.075,
          0.1,
          0.25,
          0.5,
          0.75,
          1,
          2.5,
          5,
          7.5,
          10,
        ],
      },
    }),
    activeRequests: meter.createUpDownCounter('http.server.active_requests', {
      unit: '{request}',
      description: 'Number of active HTTP server requests.',
    }),
    jobDuration: meter.createHistogram('messaging.process.duration', {
      unit: 's',
      description: 'Duration of processing queued jobs.',
    }),
    jobFailures: meter.createCounter('haze.queue.job.failures', {
      unit: '{job}',
      description: 'Number of queued jobs that failed after all attempts.',
    }),
  }
  return state.instruments
}

// ---- HTTP 请求 ---------------------------------------------------------------

/** 一个请求的 span 与计时，由 Observability 的中间件创建、在 onResponse 中结束 */
export interface HttpSpanHandle {
  run: <T>(fn: () => T) => T
  end: (status: number, route: string | undefined) => void
}

export function startHttpSpan(event: H3Event): HttpSpanHandle | undefined {
  if (!state)
    return undefined
  const { api, tracer, traces } = state
  const metrics = instruments()
  if (!traces.http && !metrics)
    return undefined
  const method = event.req.method
  const scheme = event.url.protocol.replace(':', '')
  const base = { 'http.request.method': method, 'url.scheme': scheme }
  const started = performance.now()
  metrics?.activeRequests.add(1, base)

  let span: OTel.Span | undefined
  let context: OTel.Context | undefined
  if (traces.http) {
    const parent = extractContext(api, event.req.headers)
    const userAgent = event.req.headers.get('user-agent')
    span = tracer.startSpan(method, {
      kind: api.SpanKind.SERVER,
      attributes: {
        ...base,
        'url.path': event.url.pathname,
        ...(event.url.search && {
          'url.query': event.url.search.slice(1),
        }),
        'server.address': event.url.hostname,
        ...(event.url.port && {
          'server.port': Number(event.url.port),
        }),
        ...(userAgent && {
          'user_agent.original': userAgent,
        }),
      },
    }, parent)
    context = api.trace.setSpan(parent, span)
  }

  let ended = false
  return {
    run: fn => context
      ? api.context.with(context, fn)
      : fn(),
    end(status, route) {
      if (ended)
        return
      ended = true
      const attributes: OTel.Attributes = {
        ...base,
        'http.response.status_code': status,
        ...(route && {
          'http.route': route,
        }),
        ...(status >= 500 && {
          'error.type': String(status),
        }),
      }
      metrics?.activeRequests.add(-1, base)
      metrics?.requestDuration.record((performance.now() - started) / 1000, attributes)
      if (span) {
        if (route)
          span.updateName(`${method} ${route}`)
        span.setAttributes(attributes)
        if (status >= 500)
          span.setStatus({ code: api.SpanStatusCode.ERROR })
        span.end()
      }
    },
  }
}

/** 异常处理器渲染异常时调用：记录到当前请求的 span */
export function recordSpanException(error: unknown, status: number): void {
  if (!state || status < 500)
    return
  const span = state.api.trace.getActiveSpan()
  if (!span)
    return
  span.recordException(error instanceof Error
    ? error
    : String(error))
  span.setStatus({
    code: state.api.SpanStatusCode.ERROR,
    message: error instanceof Error
      ? error.message
      : undefined,
  })
}

// ---- 队列 --------------------------------------------------------------------

/** 投递任务：创建 PRODUCER span，返回需要写入消息的追踪上下文 */
export function traceJobDispatch(job: string, queue: string, id: string): Record<string, string> | undefined {
  if (!state)
    return undefined
  const { api, tracer, traces } = state
  if (!traces.queue)
    return injectTraceContext()
  const span = tracer.startSpan(`send ${queue}`, {
    kind: api.SpanKind.PRODUCER,
    attributes: {
      'messaging.system': FRAMEWORK_NAME,
      'messaging.operation.type': 'send',
      'messaging.operation.name': 'send',
      'messaging.destination.name': queue,
      'messaging.message.id': id,
      'haze.job.name': job,
    },
  })
  const carrier = injectContext(api, api.trace.setSpan(api.context.active(), span), {})
  span.end()
  return carrier
}

/** 执行任务：在消息携带的上下文中创建 CONSUMER span，并记录耗时与失败指标 */
export async function traceJobProcess<R extends { status: string, error?: unknown }>(
  message: { id: string, job: string, queue: string, context?: Record<string, string> },
  attempt: number,
  fn: () => Promise<R>,
): Promise<R> {
  if (!state)
    return fn()
  const { api, tracer, traces } = state
  const metrics = instruments()
  const parent = message.context
    ? extractContext(api, message.context)
    : api.context.active()
  const attributes: OTel.Attributes = {
    'messaging.system': FRAMEWORK_NAME,
    'messaging.operation.type': 'process',
    'messaging.operation.name': 'process',
    'messaging.destination.name': message.queue,
    'haze.job.name': message.job,
  }
  const span = traces.queue
    ? tracer.startSpan(`process ${message.queue}`, {
        kind: api.SpanKind.CONSUMER,
        attributes: {
          ...attributes,
          'messaging.message.id': message.id,
          'haze.job.attempt': attempt,
        },
      }, parent)
    : undefined
  const started = performance.now()
  const result = await api.context.with(span
    ? api.trace.setSpan(parent, span)
    : parent, fn)
  const failed = result.status !== 'ok'
  const errorType = failed
    ? (result.error as Error)?.name ?? 'Error'
    : undefined
  if (span) {
    span.setAttribute('haze.job.status', result.status)
    if (failed) {
      if (result.error instanceof Error)
        span.recordException(result.error)
      span.setAttribute('error.type', errorType!)
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: (result.error as Error)?.message })
    }
    span.end()
  }
  metrics?.jobDuration.record((performance.now() - started) / 1000, {
    ...attributes,
    ...(errorType && {
      'error.type': errorType,
    }),
  })
  if (result.status === 'failed')
    metrics?.jobFailures.add(1, attributes)
  return result
}

// ---- 由遥测事件补建的 span ----------------------------------------------------

const SQL_OPERATION_RE = /^\s*(?:with\b[\s\S]*?\)\s*)?([a-z]+)/i

function spanFromTelemetry<K extends TelemetryKind>(kind: K, data: TelemetryEvents[K]): void {
  if (!state)
    return
  const { api, tracer, traces } = state
  let name: string
  let attributes: OTel.Attributes
  let error: string | undefined
  let timing: { startTime: number, duration: number }
  switch (kind) {
    case 'query': {
      if (!traces.db)
        return
      const query = data as TelemetryEvents['query']
      const operation = query.sql.match(SQL_OPERATION_RE)?.[1]?.toUpperCase()
      name = operation ?? 'query'
      attributes = {
        'db.system.name': dbSystem(query.dialect),
        'db.query.text': query.sql,
        ...(operation && {
          'db.operation.name': operation,
        }),
        ...(query.connection && {
          'db.namespace': query.connection,
        }),
        ...(query.replica && {
          'db.replica': true,
        }),
      }
      error = query.error
      timing = query
      break
    }
    case 'cache': {
      if (!traces.cache)
        return
      const cache = data as TelemetryEvents['cache']
      name = `cache.${cache.command ?? cache.operation}`
      attributes = {
        'haze.cache.store': cache.store,
        ...(cache.key !== undefined && {
          'haze.cache.key': cache.key,
        }),
        ...(cache.hit !== undefined && {
          'haze.cache.hit': cache.hit,
        }),
      }
      timing = cache
      break
    }
    case 'mail': {
      if (!traces.mail)
        return
      const mail = data as TelemetryEvents['mail']
      name = 'mail.send'
      attributes = {
        'haze.mail.mailer': mail.mailer,
        'haze.mail.driver': mail.driver,
        'haze.mail.recipients': mail.to.length + (mail.cc?.length ?? 0) + (mail.bcc?.length ?? 0),
        ...(mail.messageId && {
          'haze.mail.message_id': mail.messageId,
        }),
      }
      error = mail.error
      timing = mail
      break
    }
    case 'ai': {
      if (!traces.ai)
        return
      const ai = data as TelemetryEvents['ai']
      const operation = ai.operation === 'embeddings'
        ? 'embeddings'
        : 'chat'
      name = `${operation} ${ai.model}`
      attributes = {
        'gen_ai.operation.name': operation,
        'gen_ai.provider.name': ai.provider,
        'gen_ai.request.model': ai.model,
        ...(ai.inputTokens !== undefined && {
          'gen_ai.usage.input_tokens': ai.inputTokens,
        }),
        ...(ai.outputTokens !== undefined && {
          'gen_ai.usage.output_tokens': ai.outputTokens,
        }),
        ...(ai.finishReason && {
          'gen_ai.response.finish_reasons': [ai.finishReason],
        }),
        ...(ai.operation === 'stream' && {
          'haze.ai.stream': true,
        }),
      }
      error = ai.error
      timing = ai
      break
    }
    default:
      return
  }
  const span = tracer.startSpan(name, {
    kind: api.SpanKind.CLIENT,
    startTime: timing.startTime,
    attributes,
  })
  if (error) {
    span.setAttribute('error.type', 'Error')
    span.setStatus({ code: api.SpanStatusCode.ERROR, message: error })
  }
  span.end(timing.startTime + timing.duration)
}

function dbSystem(dialect: string | undefined): string {
  switch (dialect) {
    case 'postgres':
    case 'pg':
    case 'postgresql':
      return 'postgresql'
    case 'mysql':
      return 'mysql'
    case 'sqlite':
      return 'sqlite'
    case 'mongodb':
      return 'mongodb'
    default:
      return dialect ?? 'other_sql'
  }
}
