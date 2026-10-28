import type { DocumentKey, SearchDocument, SearchEngine, SearchFilter, SearchIndex, SearchQuery, SearchResult } from '../engine'
import type { Fetch, HttpClient } from './http'
import { SearchEngineError } from '../engine'
import { httpClient } from './http'

export interface TypesenseConfig {
  /** 如 `http://127.0.0.1:8108` */
  url: string
  /** API key（X-TYPESENSE-API-KEY） */
  key: string
  fetch?: Fetch
}

/** Typesense 每页最多返回的数量 */
const MAX_PER_PAGE = 250

/** 过滤值：字符串用反引号包裹（可含逗号、空格等），其余原样 */
function literal(value: unknown): string {
  if (typeof value === 'number' || typeof value === 'boolean')
    return String(value)
  return `\`${String(value ?? '').replace(/`/g, '\\`')}\``
}

export function typesenseFilter(filter: SearchFilter): string {
  switch (filter.type) {
    case 'eq':
      return `${filter.field}:=${literal(filter.value)}`
    case 'in':
      return `${filter.field}:=[${filter.values.map(literal).join(',')}]`
    case 'notIn':
      return `${filter.field}:!=[${filter.values.map(literal).join(',')}]`
  }
}

/**
 * Typesense。集合缺失时按设置自动创建（默认字段 `{ name: '.*', type: 'auto' }` 自动推断类型），
 * 文档的 `id` 为主键的字符串形式。
 */
export class TypesenseEngine implements SearchEngine {
  readonly driver = 'typesense'
  readonly #http: HttpClient
  /** 未设置 searchable 时从集合结构中取的字符串字段 */
  readonly #queryBy = new Map<string, string>()

  constructor(readonly config: TypesenseConfig) {
    this.#http = httpClient('Typesense', {
      url: config.url,
      fetch: config.fetch,
      headers: { 'x-typesense-api-key': config.key },
    })
  }

  async update(index: SearchIndex, documents: SearchDocument[]): Promise<void> {
    if (!documents.length)
      return
    const body = documents.map(document => JSON.stringify({
      ...document.data,
      [index.key]: document.key,
      id: String(document.key),
    })).join('\n')
    const send = (): Promise<string | undefined> => this.#http<string>(`/collections/${encodeURIComponent(index.name)}/documents/import`, {
      raw: body,
      query: { action: 'upsert' },
      allow: [404],
    })
    let result = await send()
    if (result === undefined) {
      await this.#createCollection(index)
      result = await send()
    }
    // 响应为 JSONL，每行一个文档的结果
    const failed = String(result ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line) as { success: boolean, error?: string }).find(line => !line.success)
    if (failed)
      throw new SearchEngineError(`Typesense import into "${index.name}" failed: ${failed.error}`, undefined, failed)
  }

  async delete(index: SearchIndex, keys: DocumentKey[]): Promise<void> {
    if (!keys.length)
      return
    await this.#http(`/collections/${encodeURIComponent(index.name)}/documents`, {
      method: 'DELETE',
      query: { filter_by: `id:[${keys.map(key => literal(String(key))).join(',')}]` },
      allow: [404],
    })
  }

  /** 删除集合（下次写入或 sync-settings 时按设置重建） */
  async flush(index: SearchIndex): Promise<void> {
    await this.deleteIndex(index)
  }

  async deleteIndex(index: SearchIndex): Promise<void> {
    await this.#http(`/collections/${encodeURIComponent(index.name)}`, {
      method: 'DELETE',
      allow: [404],
    })
    this.#queryBy.delete(index.name)
  }

  /** 集合不存在时按设置创建（已存在的集合不修改字段：先 flush 再同步以重建） */
  async syncSettings(index: SearchIndex): Promise<void> {
    const existing = await this.#http(`/collections/${encodeURIComponent(index.name)}`, {
      allow: [404],
    })
    if (!existing)
      await this.#createCollection(index)
  }

  async search(index: SearchIndex, query: SearchQuery): Promise<SearchResult> {
    const queryBy = index.settings.searchable?.join(',') ?? await this.#defaultQueryBy(index)
    if (queryBy === undefined)
      return { hits: [], total: 0, raw: undefined }
    const params: Record<string, string | number | boolean | undefined> = {
      q: query.query.trim() || '*',
      query_by: queryBy,
      filter_by: query.filters.length
        ? query.filters.map(typesenseFilter).join(' && ')
        : undefined,
      sort_by: query.sort.length
        ? query.sort.map(({ field, direction }) => `${field}:${direction}`).join(',')
        : undefined,
      page: query.page,
      per_page: query.perPage,
      ...query.options as Record<string, string | number | boolean>,
    }
    const path = `/collections/${encodeURIComponent(index.name)}/documents/search`
    interface Response { found: number, hits: Array<{ document: Record<string, unknown>, text_match?: number }> }
    let raw: Response | undefined
    if (query.page === 1 && query.perPage > MAX_PER_PAGE) {
      // 每页最多 250 条：未分页的 get() / keys() 逐页取回
      for (let page = 1; ; page++) {
        const chunk = await this.#http<Response>(path, {
          query: { ...params, page, per_page: MAX_PER_PAGE },
          allow: [404],
        })
        if (!chunk)
          break
        raw = raw
          ? {
              ...chunk,
              hits: [
                ...raw.hits,
                ...chunk.hits,
              ],
            }
          : chunk
        if (chunk.hits.length < MAX_PER_PAGE || raw.hits.length >= query.perPage)
          break
      }
      raw &&= {
        ...raw,
        hits: raw.hits.slice(0, query.perPage),
      }
    }
    else {
      raw = await this.#http<Response>(path, {
        query: params,
        allow: [404],
      })
    }
    if (!raw)
      return { hits: [], total: 0, raw }
    return {
      hits: raw.hits.map(hit => ({
        key: (hit.document[index.key] ?? hit.document.id) as DocumentKey,
        score: hit.text_match,
        document: hit.document,
      })),
      total: raw.found,
      raw,
    }
  }

  async #createCollection(index: SearchIndex): Promise<void> {
    const { fields, ...rest } = index.settings.typesense ?? {}
    await this.#http('/collections', {
      body: {
        name: index.name,
        // 自动推断类型：数字字段默认可排序；字符串字段排序需在 settings.typesense.fields 中声明 sort: true
        fields: fields ?? [
          { name: '.*', type: 'auto' },
        ],
        ...rest,
      },
      allow: [409],
    })
  }

  /** 没有设置 searchable 时，以集合中所有字符串字段作为 query_by */
  async #defaultQueryBy(index: SearchIndex): Promise<string | undefined> {
    const cached = this.#queryBy.get(index.name)
    if (cached)
      return cached
    const collection = await this.#http<{ fields: Array<{ name: string, type: string }> }>(`/collections/${encodeURIComponent(index.name)}`, {
      allow: [404],
    })
    if (!collection)
      return undefined
    const names = collection.fields.filter(field => (field.type === 'string' || field.type === 'string[]') && !field.name.includes('*') && field.name !== '.*').map(field => field.name)
    if (!names.length)
      return undefined
    const queryBy = names.join(',')
    this.#queryBy.set(index.name, queryBy)
    return queryBy
  }
}

export function typesenseEngine(config: TypesenseConfig): TypesenseEngine {
  return new TypesenseEngine(config)
}
