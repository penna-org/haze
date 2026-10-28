import type { DatabaseSearchOptions } from './engines/database'
import type { SearchableModel } from './searchable'

export type DocumentKey = string | number

/** 索引设置（`haze search:sync-settings` 同步到引擎） */
export interface IndexSettings {
  /** 参与全文搜索的字段（按权重从高到低） */
  searchable?: string[]
  /** 可用于 where / whereIn 的字段 */
  filterable?: string[]
  /** 可用于 orderBy 的字段 */
  sortable?: string[]
  /** Meilisearch 的其它设置（原样合并到 PATCH /indexes/{uid}/settings） */
  meilisearch?: Record<string, unknown>
  /** Typesense：集合字段定义（默认 `{ name: '.*', type: 'auto' }` 自动推断）与其它集合选项 */
  typesense?: { fields?: Array<Record<string, unknown>>, [key: string]: unknown }
  /** Elasticsearch / OpenSearch：创建索引时的 mappings / settings */
  elasticsearch?: { mappings?: Record<string, unknown>, settings?: Record<string, unknown> }
}

/** 一个模型对应的索引（由 searchable() 的选项与配置计算） */
export interface SearchIndex {
  /** 实际的索引名（含配置前缀与租户前缀） */
  name: string
  /** 文档主键字段 */
  key: string
  settings: IndexSettings
  /** 所属模型（database 引擎据此构造查询；队列中执行时为 undefined） */
  model?: SearchableModel
  /** database 引擎的模型级选项 */
  database?: DatabaseSearchOptions
}

export interface SearchDocument {
  key: DocumentKey
  data: Record<string, unknown>
}

export type SearchFilter
  = | { type: 'eq', field: string, value: unknown }
    | { type: 'in', field: string, values: unknown[] }
    | { type: 'notIn', field: string, values: unknown[] }

export interface SearchSort {
  field: string
  direction: 'asc' | 'desc'
}

export interface SearchQuery {
  /** 搜索词，空字符串表示匹配全部 */
  query: string
  filters: SearchFilter[]
  sort: SearchSort[]
  /** 分页（从 1 开始），与 perPage 一起使用 */
  page: number
  perPage: number
  /** 是否需要精确的总数（paginate 时为 true） */
  withTotal: boolean
  /** 各引擎的原生选项（`.options({...})`），合并到请求中 */
  options: Record<string, unknown>
}

export interface SearchHit {
  key: DocumentKey
  /** 相关度（越大越相关；各引擎含义不同，SQLite 为 -bm25） */
  score?: number
  document?: Record<string, unknown>
}

export interface SearchResult {
  hits: SearchHit[]
  total: number
  /** 引擎的原始响应 */
  raw: unknown
  /** database 引擎直接查询出的模型（按相关度排序），无需再按主键加载 */
  models?: unknown[]
}

/**
 * 搜索引擎驱动。所有外部引擎都直接用 fetch 调用 HTTP 接口，不依赖 SDK。
 */
export interface SearchEngine {
  readonly driver: string
  /** 新增或替换文档 */
  update: (index: SearchIndex, documents: SearchDocument[]) => Promise<void>
  delete: (index: SearchIndex, keys: DocumentKey[]) => Promise<void>
  search: (index: SearchIndex, query: SearchQuery) => Promise<SearchResult>
  /** 清空索引中的文档 */
  flush: (index: SearchIndex) => Promise<void>
  /** 创建索引并同步设置（searchable / filterable / sortable 等） */
  syncSettings?: (index: SearchIndex) => Promise<void>
  /** 删除整个索引 */
  deleteIndex?: (index: SearchIndex) => Promise<void>
  /** 等待之前的异步写入完成（Meilisearch 的任务队列） */
  settle?: () => Promise<void>
}

/** 引擎返回的错误（HTTP 状态与响应体） */
export class SearchEngineError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: unknown) {
    super(message)
    this.name = 'SearchEngineError'
  }
}

/** 搜索词分词：按非字母数字切分，小写 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)
}
