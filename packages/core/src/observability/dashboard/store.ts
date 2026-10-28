import type { TelemetryEvents, TelemetryKind } from '../telemetry'
import { definePersistent } from '../../persistent'
import { getRequestStore } from '../../request'
import { currentTelemetryScope } from '../scope'
import { onTelemetry } from '../telemetry'

export type DashboardEntryType = 'request' | 'query' | 'job' | 'mail' | 'event' | 'cache' | 'log' | 'exception' | 'ai'

export const DASHBOARD_ENTRY_TYPES: readonly DashboardEntryType[] = [
  'request',
  'query',
  'job',
  'mail',
  'event',
  'cache',
  'log',
  'exception',
  'ai',
]

export interface DashboardEntry {
  /** 进程内递增的序号 */
  id: number
  type: DashboardEntryType
  /** Unix 时间戳（毫秒） */
  time: number
  /** 所属请求（任务执行期间为投递它的请求） */
  requestId?: string
  /** 任务执行期间产生的记录 */
  jobId?: string
  content: Record<string, unknown>
}

export interface DashboardQuery {
  type?: DashboardEntryType
  requestId?: string
  jobId?: string
  /** 只返回 id 大于该值的记录（增量拉取） */
  after?: number
  /** 默认 100 */
  limit?: number
}

const TELEMETRY_TYPES: Partial<Record<TelemetryKind, DashboardEntryType>> = {
  'query': 'query',
  'cache': 'cache',
  'mail': 'mail',
  'job.dispatched': 'job',
  'job.processed': 'job',
  'event': 'event',
  'log': 'log',
  'exception': 'exception',
  'ai': 'ai',
}

/** 单个记录内容的上限：超出的字符串截断，避免大载荷撑满内存 */
const MAX_STRING = 64 * 1024

function truncate(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') {
    return value.length > MAX_STRING
      ? `${value.slice(0, MAX_STRING)}…（已截断）`
      : value
  }
  if (depth > 6 || value === null || typeof value !== 'object')
    return value
  if (Array.isArray(value))
    return value.slice(0, 200).map(item => truncate(item, depth + 1))
  if (value instanceof Date)
    return value.toISOString()
  const result: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value))
    result[key] = truncate(item, depth + 1)
  return result
}

/**
 * 开发面板的内存记录：每类记录各一个环形缓冲（默认 500 条），
 * 跨热重载保留，按请求 ID 关联，订阅者（SSE）实时收到新记录。
 */
export class DashboardStore {
  limit = 500
  readonly #buffers = new Map<DashboardEntryType, DashboardEntry[]>()
  readonly #subscribers = new Set<(entry: DashboardEntry) => void>()
  #sequence = 0
  #unsubscribe: (() => void) | undefined

  /** 订阅遥测总线（查询、任务、邮件、事件、缓存、日志、异常、AI） */
  listen(): this {
    this.#unsubscribe ??= onTelemetry((kind, data) => this.#record(kind, data))
    return this
  }

  add(type: DashboardEntryType, content: Record<string, unknown>, meta: { requestId?: string, jobId?: string, time?: number } = {}): DashboardEntry {
    const entry: DashboardEntry = {
      id: ++this.#sequence,
      type,
      time: meta.time ?? Date.now(),
      ...(meta.requestId && {
        requestId: meta.requestId,
      }),
      ...(meta.jobId && {
        jobId: meta.jobId,
      }),
      content: truncate(content) as Record<string, unknown>,
    }
    let buffer = this.#buffers.get(type)
    if (!buffer)
      this.#buffers.set(type, buffer = [])
    buffer.push(entry)
    if (buffer.length > this.limit)
      buffer.splice(0, buffer.length - this.limit)
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(entry)
      }
      catch {}
    }
    return entry
  }

  /** 按条件查询，最新的在前 */
  list(query: DashboardQuery = {}): DashboardEntry[] {
    const types = query.type
      ? [query.type]
      : DASHBOARD_ENTRY_TYPES
    const limit = query.limit ?? 100
    const result: DashboardEntry[] = []
    for (const type of types) {
      for (const entry of this.#buffers.get(type) ?? []) {
        if (query.requestId && entry.requestId !== query.requestId)
          continue
        if (query.jobId && entry.jobId !== query.jobId)
          continue
        if (query.after !== undefined && entry.id <= query.after)
          continue
        result.push(entry)
      }
    }
    return result.sort((a, b) => b.id - a.id).slice(0, limit)
  }

  get(id: number): DashboardEntry | undefined {
    for (const buffer of this.#buffers.values()) {
      const entry = buffer.find(item => item.id === id)
      if (entry)
        return entry
    }
    return undefined
  }

  /** 某个请求的记录（不存在时为 undefined）与它关联的全部记录 */
  request(requestId: string): { request: DashboardEntry | undefined, entries: DashboardEntry[] } {
    const entries = this.list({ requestId, limit: Number.POSITIVE_INFINITY })
    return {
      request: entries.find(entry => entry.type === 'request'),
      entries: entries.filter(entry => entry.type !== 'request').reverse(),
    }
  }

  /** 各类记录的数量（按请求 ID 汇总时传入 requestId） */
  counts(requestId?: string): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const [type, buffer] of this.#buffers) {
      counts[type] = requestId
        ? buffer.filter(entry => entry.requestId === requestId).length
        : buffer.length
    }
    return counts
  }

  clear(): void {
    this.#buffers.clear()
  }

  subscribe(listener: (entry: DashboardEntry) => void): () => void {
    this.#subscribers.add(listener)
    return () => {
      this.#subscribers.delete(listener)
    }
  }

  close(): void {
    this.#unsubscribe?.()
    this.#unsubscribe = undefined
    this.#subscribers.clear()
    this.#buffers.clear()
  }

  #record<K extends TelemetryKind>(kind: K, data: TelemetryEvents[K]): void {
    const type = TELEMETRY_TYPES[kind]
    if (!type)
      return
    // 任务执行期间以任务的来源请求为准（memory 队列的任务可能在别的请求的异步上下文中被调度）
    const scope = currentTelemetryScope()
    const requestId = scope
      ? scope.requestId
      : getRequestStore()?.ctx.requestId
    let content: Record<string, unknown> = data as Record<string, unknown>
    let jobId = scope?.jobId
    let time: number | undefined
    if (kind === 'job.dispatched' || kind === 'job.processed') {
      const job = data as TelemetryEvents['job.processed'] | TelemetryEvents['job.dispatched']
      jobId = job.id
      content = kind === 'job.dispatched'
        ? { ...job, status: 'dispatched' }
        : { ...job }
    }
    if ('startTime' in data && typeof data.startTime === 'number')
      time = data.startTime
    this.add(type, content, { requestId, jobId, time })
  }
}

/** 进程内唯一的面板存储（跨热重载保留，应用关闭时释放） */
export function useDashboardStore(): DashboardStore {
  return definePersistent('observability:dashboard', () => new DashboardStore(), {
    dispose: store => store.close(),
  })
}
