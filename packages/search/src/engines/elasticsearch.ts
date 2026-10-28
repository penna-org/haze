import type { DocumentKey, SearchDocument, SearchEngine, SearchFilter, SearchIndex, SearchQuery, SearchResult } from '../engine'
import type { Fetch, HttpClient } from './http'
import { SearchEngineError } from '../engine'
import { httpClient } from './http'

export interface ElasticsearchConfig {
  /** 如 `http://127.0.0.1:9200` */
  url: string
  /** Basic 认证，或 API key（`Authorization: ApiKey …`） */
  auth?: { username: string, password: string } | { apiKey: string }
  /**
   * 写入后刷新索引：true 立即刷新（测试）、`wait_for` 等待下一次刷新，默认 false（近实时，约 1 秒后可搜）
   */
  refresh?: boolean | 'wait_for'
  /**
   * 字符串字段的精确匹配 / 排序使用的子字段后缀，默认 `.keyword`（动态映射的默认结构）；
   * 自定义 mappings 把字段直接映射为 keyword 时设为空字符串
   */
  keywordSuffix?: string
  fetch?: Fetch
}

/** Elasticsearch 与 OpenSearch（兼容的 REST 接口：_bulk、_search、_delete_by_query） */
export class ElasticsearchEngine implements SearchEngine {
  readonly #http: HttpClient

  constructor(readonly config: ElasticsearchConfig, readonly driver: 'elasticsearch' | 'opensearch' = 'elasticsearch') {
    const auth = config.auth
    this.#http = httpClient(driver === 'opensearch'
      ? 'OpenSearch'
      : 'Elasticsearch', {
      url: config.url,
      fetch: config.fetch,
      headers: !auth
        ? {}
        : 'apiKey' in auth
          ? { authorization: `ApiKey ${auth.apiKey}` }
          : { authorization: `Basic ${btoa(`${auth.username}:${auth.password}`)}` },
    })
  }

  get #refresh(): string | undefined {
    const refresh = this.config.refresh
    return refresh === true
      ? 'true'
      : refresh || undefined
  }

  async update(index: SearchIndex, documents: SearchDocument[]): Promise<void> {
    if (!documents.length)
      return
    const lines = documents.flatMap(document => [
      JSON.stringify({
        index: {
          _index: index.name,
          _id: String(document.key),
        },
      }),
      JSON.stringify({ ...document.data, [index.key]: document.key }),
    ])
    await this.#bulk(lines)
  }

  async delete(index: SearchIndex, keys: DocumentKey[]): Promise<void> {
    if (!keys.length)
      return
    await this.#bulk(keys.map(key => JSON.stringify({
      delete: {
        _index: index.name,
        _id: String(key),
      },
    })))
  }

  async flush(index: SearchIndex): Promise<void> {
    await this.#http(`/${encodeURIComponent(index.name)}/_delete_by_query`, {
      body: {
        query: { match_all: {} },
      },
      query: {
        refresh: this.config.refresh ? 'true' : undefined,
        conflicts: 'proceed',
      },
      allow: [404],
    })
  }

  async deleteIndex(index: SearchIndex): Promise<void> {
    await this.#http(`/${encodeURIComponent(index.name)}`, {
      method: 'DELETE',
      allow: [404],
    })
  }

  /** 索引不存在时按 settings.elasticsearch 创建；已存在时更新 mappings（只能新增字段） */
  async syncSettings(index: SearchIndex): Promise<void> {
    const { mappings, settings } = index.settings.elasticsearch ?? {}
    const path = `/${encodeURIComponent(index.name)}`
    const exists = await this.#http(path, {
      allow: [404],
    })
    if (!exists) {
      await this.#http(path, {
        method: 'PUT',
        body: {
          ...(mappings && { mappings }),
          ...(settings && { settings }),
        },
      })
    }
    else if (mappings) {
      await this.#http(`${path}/_mapping`, { method: 'PUT', body: mappings })
    }
  }

  async search(index: SearchIndex, query: SearchQuery): Promise<SearchResult> {
    const text = query.query.trim()
    const fields = index.settings.searchable ?? ['*']
    const body = {
      query: {
        bool: {
          must: text
            ? {
                multi_match: {
                  query: text,
                  fields,
                  operator: 'and',
                  lenient: true,
                },
              }
            : { match_all: {} },
          filter: query.filters.map(filter => this.#filter(filter)),
        },
      },
      sort: query.sort.length
        ? query.sort.map(({ field, direction }) => ({
            [field]: { order: direction, unmapped_type: 'keyword' },
          }))
        : undefined,
      from: (query.page - 1) * query.perPage,
      size: query.perPage,
      track_total_hits: query.withTotal,
      ...query.options,
    }
    const raw = await this.#http<{ hits: { total?: { value: number } | number, hits: Array<{ _id: string, _score: number | null, _source: Record<string, unknown> }> } }>(`/${encodeURIComponent(index.name)}/_search`, {
      body,
      allow: [404],
    })
    if (!raw)
      return { hits: [], total: 0, raw }
    const total = raw.hits.total
    return {
      hits: raw.hits.hits.map(hit => ({
        key: (hit._source?.[index.key] ?? hit._id) as DocumentKey,
        score: hit._score ?? undefined,
        document: hit._source,
      })),
      total: typeof total === 'number'
        ? total
        : total?.value ?? raw.hits.hits.length,
      raw,
    }
  }

  /** 字符串值匹配 keyword 子字段，其余值直接匹配 */
  #filter(filter: SearchFilter): Record<string, unknown> {
    const suffix = this.config.keywordSuffix ?? '.keyword'
    const field = (value: unknown): string => typeof value === 'string'
      ? `${filter.field}${suffix}`
      : filter.field
    switch (filter.type) {
      case 'eq':
        return {
          term: { [field(filter.value)]: filter.value },
        }
      case 'in':
        return {
          terms: { [field(filter.values[0])]: filter.values },
        }
      case 'notIn':
        return {
          bool: {
            must_not: {
              terms: { [field(filter.values[0])]: filter.values },
            },
          },
        }
    }
  }

  async #bulk(lines: string[]): Promise<void> {
    const result = await this.#http<{ errors: boolean, items: Array<Record<string, { status: number, error?: { reason?: string } }>> }>('/_bulk', {
      raw: `${lines.join('\n')}\n`,
      contentType: 'application/x-ndjson',
      query: { refresh: this.#refresh },
    })
    if (result?.errors) {
      // 删除不存在的文档（404）不视为错误
      const failed = result.items.map(item => Object.values(item)[0]!).find(item => item.error && item.status !== 404)
      if (failed)
        throw new SearchEngineError(`Bulk request failed: ${failed.error?.reason ?? JSON.stringify(failed.error)}`, failed.status, result)
    }
  }
}

export function elasticsearchEngine(config: ElasticsearchConfig): ElasticsearchEngine {
  return new ElasticsearchEngine(config, 'elasticsearch')
}

export function opensearchEngine(config: ElasticsearchConfig): ElasticsearchEngine {
  return new ElasticsearchEngine(config, 'opensearch')
}
