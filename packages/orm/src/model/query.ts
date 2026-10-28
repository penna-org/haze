import type { Column, SQL, Table } from 'drizzle-orm'
import type { BuildContext } from '../query/conditions'
import type { Operator, Paginated } from '../types'
import type { ModelClass, ModelLike, TableOf } from './model'
import type { ActiveRecord, EagerLoad, RelationName } from './record'
import type { AggregateFn, EagerInput } from './relations'
import { avg, count, getTableColumns, isNotNull, isNull, max, min, sql, sum } from 'drizzle-orm'
import { ModelNotFoundException } from '../errors'
import { andAll, QueryBuilder } from '../query/builder'
import { nowFor, pascalCase } from '../utils'
import { metaOf } from './meta'
import { hydrateModel } from './model'
import { keyOf, loadRelations, relationOf } from './relations'

type TrashedMode = 'without' | 'with' | 'only'

/** 关联条件：对象 / drizzle 表达式，或接收关联模型查询的回调 */
export type RelationCondition = Record<string, unknown> | SQL | ((query: any) => unknown)

interface AggregateItem {
  relation: string
  fn: AggregateFn
  column?: string
  alias: string
  constraint?: (query: any) => unknown
}

const aggregates: Record<AggregateFn, (column: Column | SQL) => SQL> = {
  count: column => count(column),
  sum: column => sum(column),
  avg: column => avg(column),
  max: column => max(column),
  min: column => min(column),
}

/** 模型查询：结果为模型实例，自动应用软删除与全局作用域，支持预加载关联与作用域 */
export class ModelQuery<M extends ModelLike> extends QueryBuilder<TableOf<M> & Table, M> {
  readonly model: ModelClass<M>
  protected trashed: TrashedMode = 'without'
  protected eager: EagerInput[] = []
  protected aggregateItems: AggregateItem[] = []
  /** 关闭的全局作用域（true 为全部关闭） */
  protected withoutScopes: Set<string> | true | undefined
  protected visibility: { hidden?: string[], visible?: string[], append?: string[] } = {}

  constructor(model: ModelClass<M>) {
    super(metaOf(model).table as TableOf<M> & Table, { connection: model.connection })
    this.model = model
  }

  /** 包含已软删除的数据 */
  withTrashed(): this {
    this.trashed = 'with'
    return this
  }

  /** 只查询已软删除的数据 */
  onlyTrashed(): this {
    this.trashed = 'only'
    return this
  }

  /**
   * 预加载关联：`with('posts', 'posts.comments', 'profile')`；
   * 带约束：`with({ posts: q => q.where('status', 1).order('id', 'desc') })`
   */
  with(...relations: Array<EagerLoad<M>>): this {
    this.eager.push(...relations as EagerInput[])
    return this
  }

  /** 调用模型上的 `static scopeXxx(query, ...args)`：`scope('active')` */
  scope(name: string, ...args: unknown[]): this {
    const method = (this.model as unknown as Record<string, unknown>)[`scope${pascalCase(name)}`]
    if (typeof method !== 'function')
      throw new TypeError(`Scope "${name}" is not defined on ${this.model.name} (expected static scope${pascalCase(name)}(query))`)
    method.call(this.model, this, ...args)
    return this
  }

  /** 关闭全局作用域：不传参数时全部关闭 */
  withoutGlobalScope(names?: string[]): this {
    if (!names) {
      this.withoutScopes = true
    }
    else if (this.withoutScopes !== true) {
      this.withoutScopes = new Set([
        ...(this.withoutScopes ?? []),
        ...names,
      ])
    }
    return this
  }

  /**
   * 搜索器：对每个字段调用模型上的 `static searchXxxAttr(query, value, data)`，
   * 未定义搜索器的字段在 data 中有值时按相等查询：
   *
   * ```ts
   * await User.withSearch(['name', 'createdAt'], ctx.query()).select()
   * ```
   */
  withSearch(fields: readonly string[], data: Record<string, unknown> = {}): this {
    for (const field of fields) {
      const searcher = (this.model as unknown as Record<string, unknown>)[`search${pascalCase(field)}Attr`]
      const value = data[field]
      if (typeof searcher === 'function')
        searcher.call(this.model, this, value, data)
      else if (value !== undefined && value !== null && value !== '')
        this.where(field as never, value as never)
    }
    return this
  }

  // ---------------------------------------------------------------- 关联统计与关联条件

  /**
   * 关联数量写入每个模型：`withCount('posts')` → `postsCount`；
   * 可带约束与别名：`withCount('posts', q => q.where('status', 1), 'publishedCount')`
   */
  withCount(relation: RelationName<M> | Array<RelationName<M>>, constraint?: (query: any) => unknown, alias?: string): this {
    for (const name of ([] as string[]).concat(relation)) {
      this.aggregateItems.push({
        relation: name,
        fn: 'count',
        alias: alias ?? `${name}Count`,
        constraint,
      })
    }
    return this
  }

  /** 关联字段求和：`withSum('posts', 'views')` → `postsSum` */
  withSum(relation: RelationName<M>, column: string, constraint?: (query: any) => unknown, alias?: string): this {
    return this.withAggregate('sum', relation, column, constraint, alias)
  }

  withAvg(relation: RelationName<M>, column: string, constraint?: (query: any) => unknown, alias?: string): this {
    return this.withAggregate('avg', relation, column, constraint, alias)
  }

  withMax(relation: RelationName<M>, column: string, constraint?: (query: any) => unknown, alias?: string): this {
    return this.withAggregate('max', relation, column, constraint, alias)
  }

  withMin(relation: RelationName<M>, column: string, constraint?: (query: any) => unknown, alias?: string): this {
    return this.withAggregate('min', relation, column, constraint, alias)
  }

  /**
   * 按关联数量筛选：`has('posts')`（至少一条）、`has('posts', '>=', 3)`、`has('posts', '=', 0)`
   */
  has(relation: RelationName<M>, operator: Operator = '>=', value = 1): this {
    if (operator === '>=' && value === 1)
      return this.whereExists(this.relationExists(relation))
    if ((operator === '=' && value === 0) || (operator === '<' && value === 1))
      return this.whereNotExists(this.relationExists(relation))
    if (!['=', '!=', '<>', '>', '>=', '<', '<='].includes(operator))
      throw new Error(`Unsupported operator "${operator}" for has()`)
    const query = this.relationExists(relation)
    query.field({
      value: count(),
    })
    return this.pushFragment('and', ctx => sql`(${query.buildSubquery(ctx)}) ${sql.raw(operator)} ${value}`)
  }

  /** 不存在关联数据：`hasNot('posts')`，可附加关联的条件 */
  hasNot(relation: RelationName<M>, condition?: RelationCondition): this {
    return this.whereNotExists(this.relationExists(relation, condition))
  }

  /**
   * 按关联的条件筛选：
   * - `hasWhere('posts', { status: 1 })`
   * - `hasWhere('posts', q => q.where('views', '>', 100))`
   */
  hasWhere(relation: RelationName<M>, condition?: RelationCondition): this {
    return this.whereExists(this.relationExists(relation, condition))
  }

  /** 与前面的条件以 OR 连接的 hasWhere() */
  hasWhereOr(relation: RelationName<M>, condition?: RelationCondition): this {
    const query = this.relationExists(relation, condition)
    return this.pushFragment('or', ctx => sql`exists ${query.buildSubquery(ctx)}`)
  }

  // ---------------------------------------------------------------- 输出

  /** 结果模型序列化时隐藏的字段 */
  hidden(fields: readonly string[]): this {
    this.visibility.hidden = [...fields]
    return this
  }

  /** 结果模型序列化时只输出的字段 */
  visible(fields: readonly string[]): this {
    this.visibility.visible = [...fields]
    return this
  }

  /** 结果模型序列化时追加的字段 */
  append(fields: readonly string[]): this {
    this.visibility.append = [...fields]
    return this
  }

  // ---------------------------------------------------------------- 读取与写入

  /** 按主键查询；不传主键时取第一条 */
  override async find(id?: unknown): Promise<M | undefined> {
    if (id === undefined)
      return super.find()
    return this.clone().where(this.primaryKey() as never, id as never).limit(1).select().then(rows => rows[0])
  }

  override async findOrFail(id?: unknown): Promise<M> {
    const model = await this.find(id)
    if (!model)
      throw new ModelNotFoundException(this.model.name, id)
    return model
  }

  /** 查询不到时返回空模型（`model.isEmpty()` 为 true） */
  async findOrEmpty(id?: unknown): Promise<M> {
    return (await this.find(id)) ?? this.blank() as unknown as M
  }

  override paginate(page = 1, perPage = 15): Promise<Paginated<M>> {
    return super.paginate(page, perPage)
  }

  /** 批量删除：启用软删除时只标记删除时间；也可按主键删除 `delete([1, 2])` */
  override async delete(target: { all?: boolean } | unknown = {}): Promise<number> {
    const [query, options] = this.deleteTarget(target)
    const { softDelete, columns } = metaOf(this.model)
    if (softDelete && query.trashed !== 'only') {
      return query.update({
        [softDelete]: nowFor(columns[softDelete]),
      }, options)
    }
    return QueryBuilder.prototype.delete.call(query, options)
  }

  /** 物理删除（忽略软删除） */
  async forceDelete(target: { all?: boolean } | unknown = {}): Promise<number> {
    return super.delete(target)
  }

  /** 恢复软删除的数据 */
  async restore(options: { all?: boolean } = {}): Promise<number> {
    const { softDelete } = metaOf(this.model)
    if (!softDelete)
      return 0
    return this.withTrashed().update({ [softDelete]: null }, options)
  }

  /** 按分组键统计（关联统计内部使用）：分组值 → 统计值 */
  async aggregateBy(groupKey: string, fn: AggregateFn, column?: string): Promise<Map<unknown, unknown>> {
    const ctx = await this.context()
    const query = this.clone().resetFields()
    query.orders = []
    query.limitValue = query.offsetValue = undefined
    query.eager = []
    query.aggregateItems = []
    query.field({
      key: query.fieldOf(groupKey, ctx),
      value: fn === 'count' && !column
        ? count()
        : aggregates[fn](query.fieldOf(column ?? groupKey, ctx)),
    }).group(groupKey as never)
    const rows = await query.selectRows()
    return new Map(rows.map(row => [
      keyOf(row.key),
      row.value,
    ]))
  }

  override clone(): this {
    const copy = super.clone()
    copy.eager = [...this.eager]
    copy.aggregateItems = [...this.aggregateItems]
    copy.withoutScopes = this.withoutScopes instanceof Set
      ? new Set(this.withoutScopes)
      : this.withoutScopes
    copy.visibility = { ...this.visibility }
    return copy
  }

  // ---------------------------------------------------------------- 内部

  protected withAggregate(fn: AggregateFn, relation: string, column: string, constraint?: (query: any) => unknown, alias?: string): this {
    this.aggregateItems.push({
      relation,
      fn,
      column,
      alias: alias ?? `${relation}${pascalCase(fn)}`,
      constraint,
    })
    return this
  }

  /** 关联的相关子查询（与当前表的行关联） */
  protected relationExists(name: string, condition?: unknown): QueryBuilder<Table, any> {
    // 子查询只用于判断存在 / 计数：去掉关联定义上的排序与分页
    const query = (relationOf(this.blank(), name).existsQuery() as unknown as QueryBuilder<Table, any>).removeOption('order').removeOption('limit')
    if (typeof condition === 'function' && !(condition as { getSQL?: unknown }).getSQL)
      (condition as (query: unknown) => unknown)(query)
    else if (condition !== undefined)
      query.where(condition as never)
    return query
  }

  protected override scopedWhere(ctx: BuildContext): SQL | undefined {
    const { softDelete } = metaOf(this.model)
    const trashed = !softDelete || this.trashed === 'with'
      ? undefined
      : this.trashed === 'only'
        ? isNotNull(this.columnOf(softDelete))
        : isNull(this.columnOf(softDelete))
    return andAll(this.buildWhere(ctx), trashed, this.globalWhere(ctx))
  }

  /** 全局作用域（static globalScope = ['status']）组合成的条件，与其它条件以 AND 连接 */
  protected globalWhere(ctx: BuildContext): SQL | undefined {
    const names = (this.model as unknown as { globalScope?: readonly string[] }).globalScope ?? []
    if (!names.length || this.withoutScopes === true)
      return undefined
    const scoped = new ModelQuery(this.model)
    scoped.withoutScopes = true
    scoped.source = this.source
    for (const name of names) {
      if (!this.withoutScopes?.has(name))
        scoped.scope(name)
    }
    return scoped.buildWhere(ctx)
  }

  /** join 时只取当前表的列（模型的属性） */
  protected override defaultSelection(): Record<string, Column> | undefined {
    return this.joins.length
      ? getTableColumns(this.source)
      : undefined
  }

  protected override async transform(rows: Array<Record<string, unknown>>): Promise<M[]> {
    const models = rows.map(row => hydrateModel(this.model, row))
    const records = models as unknown as ActiveRecord[]
    if (this.eager.length)
      await loadRelations(records, this.eager)
    for (const item of this.aggregateItems)
      await relationOf(this.blank(), item.relation).eagerAggregate(records, item.alias, item.fn, item.column, item.constraint)
    const { hidden, visible, append } = this.visibility
    const hasAttrs = Object.keys(this.attrs).length > 0
    if (hidden || visible || append || hasAttrs) {
      for (const record of records) {
        if (hidden)
          record.hidden(hidden)
        if (visible)
          record.visible(visible)
        if (append)
          record.append(append)
        if (hasAttrs)
          record.withAttr(this.attrs)
      }
    }
    return models
  }

  protected override label(): string {
    return this.model.name
  }

  /** 空模型实例（取关联定义、findOrEmpty） */
  protected blank(): ActiveRecord {
    const Model = this.model
    return new Model() as unknown as ActiveRecord
  }

  protected primaryKey(): string {
    const key = metaOf(this.model).primaryKey
    if (!key)
      throw new Error(`Model ${this.model.name} has no single-column primary key`)
    return key
  }
}
