import type { Model, ModelQuery, Paginated } from '@hazejs/orm'
import type { DocumentKey, SearchFilter, SearchQuery, SearchResult, SearchSort } from './engine'
import type { SearchableModel } from './searchable'
import { currentTenancy } from '@hazejs/core'
import { ModelQuery as Query } from '@hazejs/orm'
import { useSearchManager } from './manager'
import { engineNameOf, indexFor, normalizeKey } from './searchable'

/** 未分页时一次取回的最大数量（Meilisearch 默认 maxTotalHits 为 1000） */
const DEFAULT_LIMIT = 1000

/**
 * 搜索构造器（`search(Post, 'q')` / `Post.search('q')` 返回）：
 *
 * ```ts
 * const page = await search(Post, 'haze')
 *   .where('status', 'published')
 *   .whereIn('category', ['news', 'blog'])
 *   .orderBy('createdAt', 'desc')
 *   .paginate(1, 20)
 * ```
 *
 * get() / paginate() 按相关度顺序返回模型（从数据库加载，已删除的记录自动略过）；
 * raw() 返回引擎的原始响应，keys() 只返回主键。
 */
export class SearchBuilder<M> {
  protected filters: SearchFilter[] = []
  protected sorts: SearchSort[] = []
  protected engineOptions: Record<string, unknown> = {}
  protected limitValue: number | undefined
  protected indexName: string | undefined
  protected constraints: Array<(query: ModelQuery<any>) => unknown> = []

  constructor(readonly model: SearchableModel, readonly query: string) {}

  /** 精确匹配（字段需在 filterable 中） */
  where(field: string, value: unknown): this {
    this.filters.push({ type: 'eq', field, value })
    return this
  }

  whereIn(field: string, values: readonly unknown[]): this {
    this.filters.push({
      type: 'in',
      field,
      values: [...values],
    })
    return this
  }

  whereNotIn(field: string, values: readonly unknown[]): this {
    this.filters.push({
      type: 'notIn',
      field,
      values: [...values],
    })
    return this
  }

  /** 排序（字段需在 sortable 中）；不排序时按相关度 */
  orderBy(field: string, direction: 'asc' | 'desc' = 'asc'): this {
    this.sorts.push({ field, direction })
    return this
  }

  /** 未分页时取回的数量，默认 1000 */
  take(limit: number): this {
    this.limitValue = limit
    return this
  }

  /** 引擎的原生选项（Meilisearch 的 attributesToHighlight、Typesense 的 num_typos、SQL 的 mode 等） */
  options(options: Record<string, unknown>): this {
    Object.assign(this.engineOptions, options)
    return this
  }

  /** 搜索其它索引（同一模型的多个索引） */
  within(index: string): this {
    this.indexName = index
    return this
  }

  /** 加载模型时的查询约束（预加载关联、附加条件）；database 引擎直接作用于搜索查询 */
  constrain(callback: (query: ModelQuery<any>) => unknown): this {
    this.constraints.push(callback)
    return this
  }

  /** 引擎的原始响应 */
  async raw(): Promise<unknown> {
    return (await this.#search(1, this.limitValue ?? DEFAULT_LIMIT, false)).raw
  }

  /** 匹配的主键（按相关度） */
  async keys(): Promise<DocumentKey[]> {
    const result = await this.#search(1, this.limitValue ?? DEFAULT_LIMIT, false)
    return result.hits.map(hit => normalizeKey(this.model, hit.key))
  }

  /** 匹配的模型（按相关度） */
  async get(): Promise<M[]> {
    return this.#hydrate(await this.#search(1, this.limitValue ?? DEFAULT_LIMIT, false))
  }

  async first(): Promise<M | undefined> {
    return (await this.#hydrate(await this.#search(1, 1, false)))[0]
  }

  /** 分页，结构与 ORM 的 paginate() 相同；total 为引擎统计的匹配数 */
  async paginate(page = 1, perPage = 15): Promise<Paginated<M>> {
    const current = Math.max(1, Math.floor(page))
    const result = await this.#search(current, perPage, true)
    return {
      data: await this.#hydrate(result),
      total: result.total,
      page: current,
      perPage,
      lastPage: Math.max(1, Math.ceil(result.total / perPage)),
    }
  }

  /** 匹配数量 */
  async count(): Promise<number> {
    return (await this.#search(1, 1, true)).total
  }

  async #search(page: number, perPage: number, withTotal: boolean): Promise<SearchResult> {
    const manager = useSearchManager()
    const engine = manager.engine(engineNameOf(this.model, manager))
    const index = indexFor(this.model, manager, this.indexName)
    const filters = [...this.filters]
    // 单库多租户：外部引擎按租户列过滤（database 引擎由模型的全局作用域处理）
    const tenantColumn = (this.model as { belongsToTenant?: boolean | string }).belongsToTenant
    const scope = currentTenancy()
    if (tenantColumn && scope && engine.driver !== 'database') {
      filters.push({
        type: 'eq',
        field: tenantColumn === true
          ? 'tenantId'
          : tenantColumn,
        value: scope.id,
      })
    }
    const query: SearchQuery = {
      query: this.query,
      filters,
      sort: [...this.sorts],
      page,
      perPage,
      withTotal,
      options: {
        ...this.engineOptions,
        ...(engine.driver === 'database' && this.constraints.length && {
          modelQuery: (q: ModelQuery<any>) => this.constraints.forEach(constraint => constraint(q)),
        }),
      },
    }
    return engine.search(index, query)
  }

  /** 按主键加载模型并保持相关度顺序 */
  async #hydrate(result: SearchResult): Promise<M[]> {
    if (result.models)
      return result.models as M[]
    if (!result.hits.length)
      return []
    const keys = result.hits.map(hit => normalizeKey(this.model, hit.key))
    const key = this.model.primaryKeyName()!
    const query = new Query(this.model) as ModelQuery<any>
    query.whereIn(key as never, keys as never)
    for (const constraint of this.constraints)
      constraint(query)
    const models = await query.select() as Array<Model<any>>
    const byKey = new Map(models.map(model => [
      String(model.getKey()),
      model,
    ]))
    return keys.map(item => byKey.get(String(item))).filter(Boolean) as M[]
  }
}
