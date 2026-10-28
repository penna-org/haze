import type { Middleware as H3Middleware } from 'h3'
import type { Application } from '../../application'
import type { RouteBuilder } from '../../routing/builder'
import type { DashboardEntryType, DashboardStore } from './store'
import { QueueManager } from '../../queue/manager'
import { DASHBOARD_ENTRY_TYPES } from './store'
import { renderDashboardPage } from './ui'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

function html(body: string): Response {
  return new Response(body, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
    },
  })
}

/**
 * 写操作要求自定义请求头：跨站页面无法在不经 CORS 预检的情况下附带它，
 * 开发面板绕过了 CSRF 中间件，以此防止跨站请求重试 / 删除任务
 */
function isTrustedWrite(request: Request): boolean {
  if (request.headers.get('x-haze-dashboard') !== '1')
    return false
  const origin = request.headers.get('origin')
  if (!origin)
    return true
  try {
    return new URL(origin).host === new URL(request.url).host
  }
  catch {
    return false
  }
}

// ---- 队列 ----------------------------------------------------------------------

export interface QueueConnectionSummary {
  name: string
  driver: string
  default: boolean
  counts?: { waiting: number, delayed: number, active: number, failed: number }
  failed?: Array<Record<string, unknown>>
  error?: string
}

/** 各连接的积压与失败任务（sync 连接没有存储，跳过） */
export async function queueSummary(manager: QueueManager): Promise<QueueConnectionSummary[]> {
  const config = manager.config
  const result: QueueConnectionSummary[] = []
  for (const [name, connection] of Object.entries(config.connections)) {
    if (connection.driver === 'sync')
      continue
    const summary: QueueConnectionSummary = { name, driver: connection.driver, default: name === config.default }
    try {
      const [counts, failed] = await Promise.all([
        manager.counts(name),
        manager.failed(name),
      ])
      if (counts)
        summary.counts = counts
      summary.failed = failed.slice().reverse() as unknown as Array<Record<string, unknown>>
    }
    catch (error) {
      summary.error = error instanceof Error
        ? error.message
        : String(error)
    }
    result.push(summary)
  }
  return result
}

/**
 * 队列 API（开发面板与生产环境挂载的队列面板共用）：
 * - `GET  <api>`：各连接的统计与失败任务
 * - `POST <api>/<connection>/retry`（body `{ id? }`，不传 id 为全部）
 * - `POST <api>/<connection>/forget`（body `{ id }`）
 * - `POST <api>/<connection>/flush`
 */
export async function handleQueueApi(manager: QueueManager, request: Request, segments: string[]): Promise<Response> {
  if (!segments.length) {
    if (request.method !== 'GET')
      return json({ error: 'Method not allowed' }, 405)
    return json({ connections: await queueSummary(manager) })
  }
  const [connection, action] = segments.map(decodeURIComponent)
  if (segments.length !== 2 || request.method !== 'POST')
    return json({ error: 'Not found' }, 404)
  if (!isTrustedWrite(request))
    return json({ error: 'Missing x-haze-dashboard header or cross-origin request' }, 403)
  if (!manager.config.connections[connection!])
    return json({ error: `Unknown queue connection "${connection}"` }, 404)
  const body = await request.json().catch(() => ({})) as { id?: unknown }
  const id = typeof body.id === 'string'
    ? body.id
    : undefined
  switch (action) {
    case 'retry':
      return json({ retried: await manager.retry(id, connection) })
    case 'forget':
      if (!id)
        return json({ error: 'id is required' }, 422)
      return json({ forgotten: await manager.forget(id, connection) })
    case 'flush':
      return json({ flushed: await manager.flush(connection) })
    default:
      return json({ error: `Unknown action "${action}"` }, 404)
  }
}

export interface QueueDashboardOptions {
  /** 页面路径，默认 /__haze/queues；API 位于 `<path>/api` */
  path?: string
}

/**
 * 在路由中挂载队列面板（可用于生产环境，配合鉴权中间件）：
 *
 * ```ts
 * r.group({ middleware: ['auth', 'can:viewQueues'] }, r => queueDashboard(r))
 * ```
 *
 * 开发模式下开发面板（/__haze）先于路由处理同名路径。
 */
export function queueDashboard(r: RouteBuilder, options: QueueDashboardOptions = {}): void {
  const path = `/${(options.path ?? '/__haze/queues').replace(/^\/+|\/+$/g, '')}`
  const api = `${path}/api`
  const hidden = { hidden: true }
  r.get(path, () => html(renderDashboardPage({ base: path, queuesApi: api, mode: 'queues' }))).doc(hidden)
  r.get(api, ctx => handleQueueApi(ctx.make(QueueManager), ctx.req as Request, [])).doc(hidden)
  r.post(`${api}/:connection/:action`, ctx => handleQueueApi(ctx.make(QueueManager), ctx.req as Request, [
    encodeURIComponent(ctx.param('connection')!),
    ctx.param('action')!,
  ])).doc(hidden)
}

// ---- 开发面板 ------------------------------------------------------------------

const SSE_HEARTBEAT = 15_000

/** 计时器不阻止进程退出（Node） */
function unref(timer: unknown): void {
  (timer as { unref?: () => void }).unref?.()
}

function eventStream(store: DashboardStore, signal: AbortSignal | undefined): Response {
  const encoder = new TextEncoder()
  let cleanup = (): void => {}
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (chunk: string): void => {
        try {
          controller.enqueue(encoder.encode(chunk))
        }
        catch {
          cleanup()
        }
      }
      send(': connected\n\n')
      const unsubscribe = store.subscribe(entry => send(`event: entry\nid: ${entry.id}\ndata: ${JSON.stringify(entry)}\n\n`))
      const heartbeat = setInterval(send, SSE_HEARTBEAT, ': ping\n\n')
      unref(heartbeat)
      cleanup = () => {
        unsubscribe()
        clearInterval(heartbeat)
      }
      signal?.addEventListener('abort', () => {
        cleanup()
        try {
          controller.close()
        }
        catch {}
      })
    },
    cancel() {
      cleanup()
    },
  })
  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}

function parseType(value: string | null): DashboardEntryType | undefined {
  return value && (DASHBOARD_ENTRY_TYPES as readonly string[]).includes(value)
    ? value as DashboardEntryType
    : undefined
}

/**
 * 开发面板中间件（安装在全局中间件之前）：
 * - 页面：`<base>`、`<base>/requests/<id>`、`<base>/queues`
 * - API：`<base>/api/entries`、`/entries/<id>`、`/requests/<id>`、`/stats`、`/stream`（SSE）、`/clear`、
 *   `/mail/<id>/preview`、`/queues/**`
 */
export function dashboardMiddleware(app: Application, store: DashboardStore, base: string): H3Middleware {
  const api = `${base}/api`
  return async (event, next) => {
    const pathname = event.url.pathname
    if (pathname !== base && !pathname.startsWith(`${base}/`))
      return next()
    const request = event.req as Request
    const method = request.method

    if (!pathname.startsWith(`${api}/`) && pathname !== api) {
      if (method !== 'GET' && method !== 'HEAD')
        return next()
      const rest = pathname.slice(base.length).replace(/^\/+/, '')
      const initial = rest.startsWith('requests/')
        ? `#/requests/${rest.slice('requests/'.length)}`
        : rest === 'queues'
          ? '#/queues'
          : undefined
      if (rest && !initial)
        return next()
      return html(renderDashboardPage({
        base,
        api,
        queuesApi: `${api}/queues`,
        mode: 'full',
        initial,
      }))
    }

    const segments = pathname.slice(api.length).split('/').filter(Boolean)
    const [resource, id, extra] = segments
    if (resource === 'queues')
      return handleQueueApi(app.make(QueueManager), request, segments.slice(1))

    if (method === 'POST' && resource === 'clear' && segments.length === 1) {
      if (!isTrustedWrite(request))
        return json({ error: 'Missing x-haze-dashboard header or cross-origin request' }, 403)
      store.clear()
      return json({ cleared: true })
    }
    if (method !== 'GET')
      return json({ error: 'Method not allowed' }, 405)

    switch (resource) {
      case 'stream':
        return eventStream(store, (request as { signal?: AbortSignal }).signal)
      case 'stats':
        return json({
          counts: store.counts(),
        })
      case 'entries': {
        if (id) {
          const entry = store.get(Number(id))
          return entry
            ? json({ entry })
            : json({ error: 'Not found' }, 404)
        }
        const query = event.url.searchParams
        const type = query.get('type')
        if (type && !parseType(type))
          return json({ error: `Unknown type "${type}"` }, 422)
        return json({
          entries: store.list({
            type: parseType(type),
            requestId: query.get('requestId') ?? undefined,
            jobId: query.get('jobId') ?? undefined,
            after: query.has('after')
              ? Number(query.get('after'))
              : undefined,
            limit: query.has('limit')
              ? Math.min(Number(query.get('limit')) || 100, 1000)
              : undefined,
          }),
        })
      }
      case 'requests': {
        if (!id) {
          return json({
            entries: store.list({ type: 'request' }),
          })
        }
        return json(store.request(decodeURIComponent(id)))
      }
      case 'mail': {
        const entry = id
          ? store.get(Number(id))
          : undefined
        if (!entry || entry.type !== 'mail' || extra !== 'preview')
          return json({ error: 'Not found' }, 404)
        // 邮件 HTML 在沙箱中显示：禁止脚本与同源访问
        return new Response(String(entry.content.html ?? ''), {
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-security-policy': 'sandbox; default-src \'none\'; img-src * data:; style-src \'unsafe-inline\' *; font-src * data:',
            'cache-control': 'no-store',
          },
        })
      }
      default:
        return json({ error: 'Not found' }, 404)
    }
  }
}
