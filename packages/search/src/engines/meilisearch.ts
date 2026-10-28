import type { DocumentKey, SearchDocument, SearchEngine, SearchFilter, SearchIndex, SearchQuery, SearchResult } from '../engine'
import type { Fetch, HttpClient } from './http'
import { SearchEngineError } from '../engine'
import { httpClient } from './http'

export interface MeilisearchConfig {
  /** 如 `http://127.0.0.1:7700` */
  url: string
  /** Master / API key */
  key?: string
  /**
   * 写入后等待任务完成（Meilisearch 的写入是异步任务），默认 false；
   * `search:import` / `search:sync-settings` 始终等待
   */
  wait?: boolean
  /** 等待任务的超时（毫秒），默认 30 秒 */
  waitTimeout?: number
  fetch?: Fetch
}

interface Task { taskUid: number }

/** 过滤表达式中的值：字符串加双引号并转义，其余原样 */
function literal(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  if (value === null || value === undefined)
    return 'null'
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

export function meilisearchFilter(filter: SearchFilter): string {
  switch (filter.type) {
    case 'eq':
      return `${filter.field} = ${literal(filter.value)}`
    case 'in':
      return `${filter.field} IN [${filter.values.map(literal).join(', ')}]`
    case 'notIn':
      return `${filter.field} NOT IN [${filter.values.map(literal).join(', ')}]`
  }
}

/** Meilisearch（HTTP API v1） */
export class MeilisearchEngine implements SearchEngine {
  readonly driver = 'meilisearch'
  readonly #http: HttpClient
  /** 未等待的写入任务（settle() 等待它们完成） */
  readonly #pending = new Set<number>()

  constructor(readonly config: MeilisearchConfig) {
    this.#http = httpClient('Meilisearch', {
      url: config.url,
      fetch: config.fetch,
      headers: config.key
        ? { authorization: `Bearer ${config.key}` }
        : {},
    })
  }

  async update(index: SearchIndex, documents: SearchDocument[], wait = this.config.wait): Promise<void> {
    if (!documents.length)
      return
    const task = await this.#http<Task>(`/indexes/${encodeURIComponent(index.name)}/documents`, {
      body: documents.map(document => ({ ...document.data, [index.key]: document.key })),
      query: { primaryKey: index.key },
    })
    await this.#track(task!.taskUid, wait)
  }

  async delete(index: SearchIndex, keys: DocumentKey[]): Promise<void> {
    if (!keys.length)
      return
    const task = await this.#http<Task>(`/indexes/${encodeURIComponent(index.name)}/documents/delete-batch`, { body: keys })
    await this.#track(task!.taskUid, this.config.wait)
  }

  async flush(index: SearchIndex, wait = this.config.wait): Promise<void> {
    const task = await this.#http<Task>(`/indexes/${encodeURIComponent(index.name)}/documents`, {
      method: 'DELETE',
      allow: [404],
    })
    if (task)
      await this.#track(task.taskUid, wait)
  }

  async deleteIndex(index: SearchIndex): Promise<void> {
    const task = await this.#http<Task>(`/indexes/${encodeURIComponent(index.name)}`, {
      method: 'DELETE',
      allow: [404],
    })
    if (task)
      await this.waitForTask(task.taskUid)
  }

  /** 创建索引（已存在时忽略）并更新 searchable / filterable / sortable 等设置 */
  async syncSettings(index: SearchIndex): Promise<void> {
    const created = await this.#http<Task>('/indexes', {
      body: { uid: index.name, primaryKey: index.key },
    })
    await this.waitForTask(created!.taskUid, ['index_already_exists'])
    const { searchable, filterable, sortable, meilisearch } = index.settings
    const settings = {
      ...(searchable && { searchableAttributes: searchable }),
      ...(filterable && { filterableAttributes: filterable }),
      ...(sortable && { sortableAttributes: sortable }),
      ...meilisearch,
    }
    if (!Object.keys(settings).length)
      return
    const task = await this.#http<Task>(`/indexes/${encodeURIComponent(index.name)}/settings`, { method: 'PATCH', body: settings })
    await this.waitForTask(task!.taskUid)
  }

  async search(index: SearchIndex, query: SearchQuery): Promise<SearchResult> {
    const body = {
      q: query.query,
      filter: query.filters.length
        ? query.filters.map(meilisearchFilter)
        : undefined,
      sort: query.sort.length
        ? query.sort.map(({ field, direction }) => `${field}:${direction}`)
        : undefined,
      // page / hitsPerPage 返回精确的 totalHits
      ...(query.withTotal
        ? { page: query.page, hitsPerPage: query.perPage }
        : { offset: (query.page - 1) * query.perPage, limit: query.perPage }),
      showRankingScore: true,
      ...query.options,
    }
    const raw = await this.#http<{ hits: Array<Record<string, unknown>>, totalHits?: number, estimatedTotalHits?: number }>(`/indexes/${encodeURIComponent(index.name)}/search`, {
      body,
      allow: [404],
    })
    if (!raw)
      return { hits: [], total: 0, raw }
    return {
      hits: raw.hits.map(hit => ({
        key: hit[index.key] as DocumentKey,
        score: hit._rankingScore as number | undefined,
        document: hit,
      })),
      total: raw.totalHits ?? raw.estimatedTotalHits ?? raw.hits.length,
      raw,
    }
  }

  /** 等待之前未等待的写入任务全部完成（search:import 结束时、测试中使用） */
  async settle(): Promise<void> {
    const tasks = [...this.#pending]
    this.#pending.clear()
    for (const uid of tasks)
      await this.waitForTask(uid)
  }

  async #track(uid: number, wait: boolean | undefined): Promise<void> {
    if (wait)
      await this.waitForTask(uid)
    else
      this.#pending.add(uid)
  }

  /** 等待异步任务完成；失败时抛出（ignore 中的错误码视为成功） */
  async waitForTask(uid: number, ignore: string[] = []): Promise<void> {
    const deadline = Date.now() + (this.config.waitTimeout ?? 30_000)
    let delay = 20
    while (true) {
      const task = await this.#http<{ status: string, error?: { code: string, message: string } }>(`/tasks/${uid}`)
      if (task!.status === 'succeeded')
        return
      if (task!.status === 'failed' || task!.status === 'canceled') {
        if (task!.error && ignore.includes(task!.error.code))
          return
        throw new SearchEngineError(`Meilisearch task ${uid} ${task!.status}: ${task!.error?.message ?? ''}`, undefined, task)
      }
      if (Date.now() > deadline)
        throw new SearchEngineError(`Meilisearch task ${uid} did not finish within ${this.config.waitTimeout ?? 30_000}ms`)
      await new Promise(resolve => setTimeout(resolve, delay))
      delay = Math.min(delay * 2, 500)
    }
  }
}

export function meilisearchEngine(config: MeilisearchConfig): MeilisearchEngine {
  return new MeilisearchEngine(config)
}
