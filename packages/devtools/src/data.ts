import type { AppIntrospection, DashboardEntry, DashboardEntryType, DashboardQuery } from '@hazejs/core'

/** 开发面板记录的读取接口（DashboardStore 的子集，测试中可替换） */
export interface EntrySource {
  list: (query?: DashboardQuery) => DashboardEntry[]
  request: (requestId: string) => { request: DashboardEntry | undefined, entries: DashboardEntry[] }
}

// ---------- 请求 ----------

export interface RequestSummary {
  id: number
  requestId: string
  time: number
  method: string
  path: string
  route?: string
  name?: string
  module?: string
  app?: string
  status: number
  duration?: number
  counts: Partial<Record<DashboardEntryType, number>>
  /** 重复执行的 SQL 条数（疑似 N+1） */
  repeatedQueries: number
}

export interface Span {
  id: number
  type: DashboardEntryType
  label: string
  /** 相对请求开始的毫秒数 */
  start: number
  duration: number
  /** 执行于请求投递的任务中 */
  jobId?: string
  error?: string
  content: Record<string, unknown>
}

export interface RepeatedQuery {
  sql: string
  count: number
  total: number
}

export interface RequestDetail {
  request: DashboardEntry
  spans: Span[]
  repeatedQueries: RepeatedQuery[]
}

/** 同一请求中执行两次以上的同一条 SQL */
export function repeatedQueries(entries: readonly DashboardEntry[], min = 2): RepeatedQuery[] {
  const groups = new Map<string, RepeatedQuery>()
  for (const entry of entries) {
    if (entry.type !== 'query')
      continue
    const sql = String(entry.content.sql ?? '')
    const group = groups.get(sql) ?? { sql, count: 0, total: 0 }
    group.count++
    group.total += Number(entry.content.duration ?? 0)
    groups.set(sql, group)
  }
  return [
    ...groups.values(),
  ].filter(group => group.count >= min).sort((a, b) => b.count - a.count)
}

export function listRequests(source: EntrySource, limit = 100): RequestSummary[] {
  return source.list({ type: 'request', limit }).map((entry) => {
    const requestId = entry.requestId ?? ''
    const { entries } = requestId
      ? source.request(requestId)
      : { entries: [] }
    const counts: Partial<Record<DashboardEntryType, number>> = {}
    for (const child of entries)
      counts[child.type] = (counts[child.type] ?? 0) + 1
    const c = entry.content
    return {
      id: entry.id,
      requestId,
      time: entry.time,
      method: String(c.method ?? ''),
      path: String(c.path ?? ''),
      route: c.route as string | undefined,
      name: c.name as string | undefined,
      module: c.module as string | undefined,
      app: c.app as string | undefined,
      status: Number(c.status ?? 0),
      duration: c.duration as number | undefined,
      counts,
      repeatedQueries: repeatedQueries(entries).reduce((sum, group) => sum + group.count, 0),
    }
  })
}

/** 请求的瀑布图：子记录按开始时间排列在请求的时间轴上 */
export function requestDetail(source: EntrySource, requestId: string): RequestDetail | undefined {
  const { request, entries } = source.request(requestId)
  if (!request)
    return undefined
  const duration = Number(request.content.duration ?? 0)
  const origin = request.time - duration
  const spans = entries
    .filter(entry => entry.type !== 'request')
    .map((entry): Span => {
      const c = entry.content
      const spanDuration = typeof c.duration === 'number'
        ? c.duration
        : 0
      const startTime = typeof c.startTime === 'number'
        ? c.startTime
        : entry.time - spanDuration
      return {
        id: entry.id,
        type: entry.type,
        label: spanLabel(entry),
        start: startTime - origin,
        duration: spanDuration,
        // 任务记录的 jobId 是它自己；其它记录带 jobId 表示发生在任务执行期间
        jobId: entry.type === 'job'
          ? undefined
          : entry.jobId,
        error: typeof c.error === 'string'
          ? c.error
          : entry.type === 'exception'
            ? String(c.message ?? '')
            : undefined,
        content: c,
      }
    })
    .sort((a, b) => a.start - b.start || a.id - b.id)
  return {
    request,
    spans,
    repeatedQueries: repeatedQueries(entries),
  }
}

function spanLabel(entry: DashboardEntry): string {
  const c = entry.content
  switch (entry.type) {
    case 'query': return String(c.sql ?? '')
    case 'cache': return `${c.operation}${c.key
      ? ` ${c.key}`
      : ''}${c.hit === true
      ? ' (hit)'
      : c.hit === false
        ? ' (miss)'
        : ''}`
    case 'job': return c.status === 'dispatched'
      ? `dispatch ${c.job}`
      : `${c.job} · ${c.status}`
    case 'event': return String(c.event ?? '')
    case 'mail': return String(c.subject ?? '')
    case 'log': return `[${c.level}] ${c.msg}`
    case 'exception': return `${c.name}: ${c.message}`
    case 'ai': return `${c.operation} ${c.provider}/${c.model}`
    case 'http': return `${c.method} ${c.url}${c.status
      ? ` → ${c.status}`
      : ''}`
    case 'schedule': return String(c.name ?? '')
    default: return entry.type
  }
}

// ---------- 模块联动图 ----------

export type GraphNodeType = 'app' | 'module' | 'subapp' | 'event' | 'job'
export type GraphEdgeKind = 'owns' | 'listens' | 'middleware' | 'mounted' | 'schedules' | 'emits' | 'dispatches'

export interface GraphNode {
  id: string
  type: GraphNodeType
  label: string
  /** 所属模块（事件、任务）；项目自己的为 undefined */
  module?: string
  detail: Record<string, unknown>
}

export interface GraphEdge {
  from: string
  to: string
  kind: GraphEdgeKind
  /** 监听器名、中间件别名等 */
  labels: string[]
  /** 运行时观测到的次数（emits / dispatches） */
  count?: number
  /** 来自运行时记录，而不是声明 */
  runtime?: boolean
}

export interface ModuleGraph {
  nodes: GraphNode[]
  edges: GraphEdge[]
}

/** 框架内部的任务（排队监听器、排队邮件 / 通知），不画进联动图 */
function internalJob(name: string): boolean {
  return name.includes(':')
}

/**
 * 模块联动图：模块之间没有显式依赖声明，联动从两方面推导——
 * 声明（事件归属与监听、任务与定时任务、跨模块使用的中间件、挂载到子应用），
 * 以及运行时记录（请求 / 任务中触发的事件、投递的任务）。
 */
export function buildGraph(info: AppIntrospection, entries: readonly DashboardEntry[] = []): ModuleGraph {
  const nodes = new Map<string, GraphNode>()
  const edges = new Map<string, GraphEdge>()
  const ownerId = (module: string | undefined): string => module
    ? `module:${module}`
    : 'app'
  const addEdge = (from: string, to: string, kind: GraphEdgeKind, label?: string, runtime = false): void => {
    if (from === to || !nodes.has(from) || !nodes.has(to))
      return
    const key = `${from}|${to}|${kind}`
    const edge = edges.get(key) ?? {
      from,
      to,
      kind,
      labels: [],
      ...(runtime && { runtime, count: 0 }),
    }
    if (label && !edge.labels.includes(label))
      edge.labels.push(label)
    if (runtime)
      edge.count = (edge.count ?? 0) + 1
    edges.set(key, edge)
  }

  nodes.set('app', {
    id: 'app',
    type: 'app',
    label: info.app.name,
    detail: { routes: info.routes.filter(route => !route.module).length },
  })
  for (const app of info.apps) {
    nodes.set(`subapp:${app.name}`, {
      id: `subapp:${app.name}`,
      type: 'subapp',
      label: app.name,
      detail: { prefix: app.prefix, domain: app.domain, routes: app.routes },
    })
  }
  for (const module of info.modules) {
    nodes.set(`module:${module.name}`, {
      id: `module:${module.name}`,
      type: 'module',
      label: module.name,
      module: module.name,
      detail: {
        source: module.source,
        prefix: module.prefix || '/',
        routes: module.routes,
        providers: module.providers,
        listeners: module.listeners,
        middleware: module.middleware,
      },
    })
    if (module.app)
      addEdge(`module:${module.name}`, `subapp:${module.app}`, 'mounted')
  }

  const eventNode = (name: string, module?: string): string => {
    const id = `event:${name}`
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        type: 'event',
        label: name,
        module,
        detail: {},
      })
    }
    return id
  }
  const jobNode = (name: string, module?: string): string => {
    const id = `job:${name}`
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        type: 'job',
        label: name,
        module,
        detail: {},
      })
    }
    return id
  }

  for (const event of info.events) {
    const id = eventNode(event.name, event.module)
    nodes.get(id)!.detail = { listeners: event.listeners }
    addEdge(ownerId(event.module), id, 'owns')
    for (const listener of event.listeners) {
      addEdge(id, ownerId(listener.module), 'listens', listener.queued
        ? `${listener.name} (queued)`
        : listener.name)
    }
  }
  for (const job of info.jobs.filter(job => !internalJob(job.name))) {
    const id = jobNode(job.name, job.module)
    nodes.get(id)!.detail = { queue: job.queue, connection: job.connection, tries: job.tries }
    addEdge(ownerId(job.module), id, 'owns')
  }
  for (const task of info.schedules) {
    if (task.kind === 'job' && task.name.startsWith('job:'))
      addEdge(ownerId(task.module), `job:${task.name.slice(4)}`, 'schedules', task.expression)
  }

  // 路由使用其它模块注册的中间件别名
  const aliasOwners = new Map(info.middleware.aliases.filter(alias => alias.module).map(alias => [alias.name, alias.module!]))
  for (const route of info.routes) {
    for (const ref of route.middleware) {
      const alias = ref.split(':')[0]!
      const owner = aliasOwners.get(alias)
      if (owner && owner !== route.module)
        addEdge(ownerId(route.module), `module:${owner}`, 'middleware', alias)
    }
  }

  // 运行时：请求 / 任务中触发的事件与投递的任务
  const requestOwners = new Map<string, string>()
  const jobNames = new Map<string, string>()
  for (const entry of entries) {
    if (entry.type === 'request' && entry.requestId)
      requestOwners.set(entry.requestId, ownerId(entry.content.module as string | undefined))
    if (entry.type === 'job' && entry.jobId)
      jobNames.set(entry.jobId, String(entry.content.job))
  }
  // 记录发生在哪个任务里（任务内触发的事件）或哪个请求里；任务记录自身的 jobId 是它自己，只看请求
  const sourceOf = (entry: DashboardEntry): string | undefined => {
    const job = entry.type !== 'job' && entry.jobId && jobNames.get(entry.jobId)
    if (job && !internalJob(job))
      return jobNode(job)
    return entry.requestId
      ? requestOwners.get(entry.requestId)
      : undefined
  }
  for (const entry of entries) {
    if (entry.type === 'event') {
      const from = sourceOf(entry)
      if (from)
        addEdge(from, eventNode(String(entry.content.event)), 'emits', undefined, true)
    }
    else if (entry.type === 'job' && entry.content.status === 'dispatched') {
      const name = String(entry.content.job)
      const from = sourceOf(entry)
      if (from && !internalJob(name))
        addEdge(from, jobNode(name), 'dispatches', undefined, true)
    }
  }

  return {
    nodes: [
      ...nodes.values(),
    ],
    edges: [
      ...edges.values(),
    ],
  }
}

// ---------- AI ----------

export interface AiModelStats {
  model: string
  provider: string
  calls: number
  errors: number
  inputTokens: number
  outputTokens: number
  totalDuration: number
}

export interface AiSummary {
  calls: number
  errors: number
  inputTokens: number
  outputTokens: number
  models: AiModelStats[]
  entries: DashboardEntry[]
}

export function aiSummary(source: EntrySource, limit = 200): AiSummary {
  const entries = source.list({ type: 'ai', limit }).reverse()
  const models = new Map<string, AiModelStats>()
  for (const entry of entries) {
    const c = entry.content
    const key = `${c.provider}/${c.model}`
    const stats = models.get(key) ?? {
      model: String(c.model),
      provider: String(c.provider),
      calls: 0,
      errors: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalDuration: 0,
    }
    stats.calls++
    if (c.error)
      stats.errors++
    stats.inputTokens += Number(c.inputTokens ?? 0)
    stats.outputTokens += Number(c.outputTokens ?? 0)
    stats.totalDuration += Number(c.duration ?? 0)
    models.set(key, stats)
  }
  const all = [
    ...models.values(),
  ]
  return {
    calls: entries.length,
    errors: all.reduce((sum, stats) => sum + stats.errors, 0),
    inputTokens: all.reduce((sum, stats) => sum + stats.inputTokens, 0),
    outputTokens: all.reduce((sum, stats) => sum + stats.outputTokens, 0),
    models: all.sort((a, b) => b.calls - a.calls),
    entries,
  }
}
