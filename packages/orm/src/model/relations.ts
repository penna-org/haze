import type { Column, Table } from 'drizzle-orm'
import type { MongoModelQuery } from '../mongo/query'
import type { ModelQuery } from './query'
import type { ActiveRecord, RecordClass } from './record'
import { eq, getTableColumns, getTableName } from 'drizzle-orm'
import { atomically } from '../context'
import { DatabaseError } from '../errors'
import { QueryBuilder } from '../query/builder'
import { metaOf } from './meta'

/** 关联查询所需的最小接口（SQL 的 ModelQuery 与 Mongo 的 MongoModelQuery 都满足） */
export interface RelationQuery<R> {
  where: (field: never, value: never) => RelationQuery<R>
  whereIn: (field: never, values: never) => RelationQuery<R>
  with: (...relations: never[]) => RelationQuery<R>
  select: () => Promise<R[]>
  find: () => Promise<R | undefined>
}

/**
 * 记录类的查询类型：SQL 模型为 ModelQuery，Mongo 模型为 MongoModelQuery。
 * 通过品牌属性判断而非结构比较，避免互相引用的模型类型无限展开。
 */
export type QueryOf<R> = R extends { readonly '~table': any }
  ? ModelQuery<R & { readonly '~table': any }>
  : R extends { readonly '~collection': any }
    ? MongoModelQuery<R & { readonly '~collection': any }>
    : RelationQuery<R>

/** 关联统计函数 */
export type AggregateFn = 'count' | 'sum' | 'avg' | 'max' | 'min'

/** 预加载项：关联名（点号嵌套）或 `{ 关联名: 约束回调 }` */
export type EagerInput = string | Record<string, ((query: any) => unknown) | undefined>

type Constraint = ((query: any) => unknown) | undefined

/** SQL 模型查询上供关联使用的能力（Mongo 模型没有） */
interface SqlRelationQuery {
  columnOf: (key: string) => Column
  join: (table: Table, on: unknown) => SqlRelationQuery
  field: (fields: Record<string, unknown>) => SqlRelationQuery
  selectRows: () => Promise<Array<Record<string, unknown>>>
  aggregateBy: (groupKey: string, fn: AggregateFn, column?: string) => Promise<Map<unknown, unknown>>
}

function queryOf<R extends ActiveRecord>(related: RecordClass<R>): RelationQuery<R> {
  return (related as unknown as { query: () => RelationQuery<R> }).query()
}

function sqlQuery(query: unknown, label: string): SqlRelationQuery {
  if (typeof (query as Partial<SqlRelationQuery>).aggregateBy !== 'function')
    throw new DatabaseError(`${label} is only supported on SQL models`)
  return query as SqlRelationQuery
}

/** SQL 模型的表列 */
function columnsOf(record: RecordClass | ActiveRecord): Record<string, Column> {
  const model = (typeof record === 'function'
    ? record
    : record.constructor) as unknown as Parameters<typeof metaOf>[0]
  if (!(model as { table?: unknown }).table)
    throw new DatabaseError(`${model.name} is not a SQL model`)
  return metaOf(model).columns
}

function connectionOf(record: ActiveRecord): string | undefined {
  return (record.constructor as unknown as { connection?: string }).connection
}

/**
 * 关联关系。可直接 await 获取结果，也可继续构造查询：
 *
 * ```ts
 * const posts = await user.posts()
 * const recent = await user.posts().query().order('id', 'desc').limit(5).select()
 * ```
 *
 * 定义关联时可以附加条件：`return this.hasMany(Post, 'userId').where('status', 1).order('id', 'desc')`
 */
export abstract class Relation<R extends ActiveRecord, Result> implements PromiseLike<Result> {
  readonly parent: ActiveRecord
  readonly related: RecordClass<R>
  protected constraints: Array<(query: any) => unknown> = []
  protected bindings: Record<string, string> | undefined
  protected defaultValue: Record<string, unknown> | undefined

  constructor(parent: ActiveRecord, related: RecordClass<R>) {
    this.parent = parent
    this.related = related
  }

  /** 受当前关联约束的查询（返回关联模型自己的查询类型） */
  abstract query(): QueryOf<R>
  /** 获取关联结果 */
  abstract get(): Promise<Result>
  /** 批量预加载到一组父记录上 */
  abstract eagerLoad(parents: ActiveRecord[], name: string, nested: EagerInput[], constraint?: Constraint): Promise<void>

  /** 关联统计（withCount / withSum 等）：把结果写入每个父记录的 alias 字段 */
  async eagerAggregate(_parents: ActiveRecord[], _alias: string, _fn: AggregateFn, _column?: string, _constraint?: Constraint): Promise<void> {
    throw new DatabaseError(`${this.constructor.name} does not support relation aggregates`)
  }

  /** 与父表关联的相关子查询（has / hasWhere 使用） */
  existsQuery(): SqlRelationQuery {
    throw new DatabaseError(`${this.constructor.name} does not support has() / hasWhere()`)
  }

  /** 附加查询条件（作用于该关联的所有查询） */
  where(...args: unknown[]): this {
    this.constraints.push(query => query.where(...args))
    return this
  }

  whereIn(field: string, values: readonly unknown[]): this {
    this.constraints.push(query => query.whereIn(field, values))
    return this
  }

  order(...args: unknown[]): this {
    this.constraints.push(query => query.order(...args))
    return this
  }

  /** 任意查询约束：`.tap(q => q.withTrashed())` */
  tap(callback: (query: QueryOf<R>) => unknown): this {
    this.constraints.push(callback as (query: any) => unknown)
    return this
  }

  then<A = Result, B = never>(onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.get().then(onFulfilled, onRejected)
  }

  /** 关联模型的新查询（已应用关联上定义的条件） */
  protected newQuery(): QueryOf<R> {
    const query = queryOf(this.related)
    for (const constraint of this.constraints)
      constraint(query)
    return query as QueryOf<R>
  }

  /** 新的关联模型实例 */
  protected make(): R {
    const Related = this.related
    return new Related()
  }

  /** 设置预加载 / 懒加载的结果（一对一关联应用 bind 与默认值） */
  protected assign(parent: ActiveRecord, name: string, value: unknown): void {
    parent.setRelation(name, value)
    if (this.bindings)
      parent.bindRelation(name, this.bindings)
  }

  protected orDefault(value: R | undefined | null): R | null {
    if (value)
      return value
    if (!this.defaultValue)
      return null
    const record = this.make()
    record.fill(this.defaultValue)
    return record
  }
}

/** 一对一关联共有：bind() 与 withDefault() */
abstract class SingleRelation<R extends ActiveRecord> extends Relation<R, R | null> {
  /**
   * 把关联的字段绑定到父记录输出：`bind(['bio'])`、`bind({ authorName: 'name' })`
   * （仅影响序列化，父记录的 JSON 中不再嵌套该关联）
   */
  bind(fields: string[] | Record<string, string>): this {
    this.bindings = Array.isArray(fields)
      ? Object.fromEntries(fields.map(field => [field, field]))
      : fields
    return this
  }

  /** 关联不存在时返回一个空模型（可指定默认数据），而不是 null */
  withDefault(data: Record<string, unknown> = {}): this {
    this.defaultValue = data
    return this
  }
}

/** 预加载的公共流程：按关联键分组，回调中设置结果 */
async function loadGrouped<R extends ActiveRecord>(query: RelationQuery<R>, nested: EagerInput[], constraint: Constraint, groupKey: (child: R) => unknown): Promise<Map<unknown, R[]>> {
  query.with(...nested as never[])
  constraint?.(query)
  const groups = new Map<unknown, R[]>()
  for (const child of await query.select()) {
    const key = keyOf(groupKey(child))
    groups.set(key, [
      ...(groups.get(key) ?? []),
      child,
    ])
  }
  return groups
}

/** 统计结果写入父记录（无数据时 count / sum 为 0，其余为 null） */
function assignAggregates(parents: ActiveRecord[], alias: string, fn: AggregateFn, values: Map<unknown, unknown>, keyOfParent: (parent: ActiveRecord) => unknown): void {
  for (const parent of parents) {
    const value = values.get(keyOf(keyOfParent(parent)))
    parent.syncAttr(alias, value === undefined || value === null
      ? (fn === 'count' || fn === 'sum'
          ? 0
          : null)
      : (fn === 'max' || fn === 'min'
          ? value
          : Number(value)))
  }
}

abstract class HasOneOrMany<R extends ActiveRecord, Result> extends Relation<R, Result> {
  constructor(parent: ActiveRecord, related: RecordClass<R>, readonly foreignKey: string, readonly localKey: string) {
    super(parent, related)
  }

  query(): QueryOf<R> {
    return (this.newQuery() as RelationQuery<R>).where(this.foreignKey as never, this.parent.getRaw(this.localKey) as never) as QueryOf<R>
  }

  override async eagerAggregate(parents: ActiveRecord[], alias: string, fn: AggregateFn, column?: string, constraint?: Constraint): Promise<void> {
    const keys = unique(parents.map(parent => parent.getRaw(this.localKey)))
    const query = (this.newQuery() as RelationQuery<R>).whereIn(this.foreignKey as never, keys as never)
    constraint?.(query)
    const values = keys.length
      ? await sqlQuery(query, 'withCount()').aggregateBy(this.foreignKey, fn, column)
      : new Map()
    assignAggregates(parents, alias, fn, values, parent => parent.getRaw(this.localKey))
  }

  override existsQuery(): SqlRelationQuery {
    const query = sqlQuery(this.newQuery(), 'has()') as SqlRelationQuery & RelationQuery<R>
    whereSql(query, eq(query.columnOf(this.foreignKey), columnsOf(this.parent)[this.localKey]))
    return query
  }

  /** 保存一条关联记录（自动设置外键）：`await user.posts().save({ title: 'Hi' })` */
  async save(data: R | Record<string, unknown>): Promise<R> {
    const record = data instanceof (this.related as unknown as typeof ActiveRecord)
      ? data as R
      : this.make().fill(data as Record<string, unknown>) as R
    record.setAttr(this.foreignKey, this.parent.getRaw(this.localKey))
    await (record as unknown as { save: () => Promise<unknown> }).save()
    return record
  }

  /** save() 的别名 */
  create(data: Record<string, unknown>): Promise<R> {
    return this.save(data)
  }

  /** 批量保存（在事务中执行） */
  async saveAll(list: Array<R | Record<string, unknown>>): Promise<R[]> {
    const run = async (): Promise<R[]> => {
      const saved: R[] = []
      for (const item of list)
        saved.push(await this.save(item))
      return saved
    }
    return atomically(run, connectionOf(this.parent))
  }

  protected loadFor(parents: ActiveRecord[], nested: EagerInput[], constraint: Constraint): Promise<Map<unknown, R[]>> {
    const keys = unique(parents.map(parent => parent.getRaw(this.localKey)))
    if (!keys.length)
      return Promise.resolve(new Map())
    const query = (this.newQuery() as RelationQuery<R>).whereIn(this.foreignKey as never, keys as never)
    return loadGrouped(query, nested, constraint, child => child.getRaw(this.foreignKey))
  }
}

export class HasMany<R extends ActiveRecord> extends HasOneOrMany<R, R[]> {
  get(): Promise<R[]> {
    return (this.query() as RelationQuery<R>).select()
  }

  async eagerLoad(parents: ActiveRecord[], name: string, nested: EagerInput[], constraint?: Constraint): Promise<void> {
    const groups = await this.loadFor(parents, nested, constraint)
    for (const parent of parents)
      this.assign(parent, name, groups.get(keyOf(parent.getRaw(this.localKey))) ?? [])
  }
}

export class HasOne<R extends ActiveRecord> extends HasOneOrMany<R, R | null> {
  async get(): Promise<R | null> {
    return this.orDefault(await (this.query() as RelationQuery<R>).find())
  }

  async eagerLoad(parents: ActiveRecord[], name: string, nested: EagerInput[], constraint?: Constraint): Promise<void> {
    const groups = await this.loadFor(parents, nested, constraint)
    for (const parent of parents)
      this.assign(parent, name, this.orDefault(groups.get(keyOf(parent.getRaw(this.localKey)))?.[0]))
  }

  bind(fields: string[] | Record<string, string>): this {
    return SingleRelation.prototype.bind.call(this, fields) as this
  }

  withDefault(data: Record<string, unknown> = {}): this {
    return SingleRelation.prototype.withDefault.call(this, data) as this
  }
}

export class BelongsTo<R extends ActiveRecord> extends SingleRelation<R> {
  constructor(parent: ActiveRecord, related: RecordClass<R>, readonly foreignKey: string, readonly ownerKey: string) {
    super(parent, related)
  }

  query(): QueryOf<R> {
    return (this.newQuery() as RelationQuery<R>).where(this.ownerKey as never, this.parent.getRaw(this.foreignKey) as never) as QueryOf<R>
  }

  async get(): Promise<R | null> {
    if (this.parent.getRaw(this.foreignKey) == null)
      return this.orDefault(null)
    return this.orDefault(await (this.query() as RelationQuery<R>).find())
  }

  async eagerLoad(parents: ActiveRecord[], name: string, nested: EagerInput[], constraint?: Constraint): Promise<void> {
    const keys = unique(parents.map(parent => parent.getRaw(this.foreignKey)))
    const groups = keys.length
      ? await loadGrouped((this.newQuery() as RelationQuery<R>).whereIn(this.ownerKey as never, keys as never), nested, constraint, owner => owner.getRaw(this.ownerKey))
      : new Map<unknown, R[]>()
    for (const parent of parents)
      this.assign(parent, name, this.orDefault(groups.get(keyOf(parent.getRaw(this.foreignKey)))?.[0]))
  }

  override async eagerAggregate(parents: ActiveRecord[], alias: string, fn: AggregateFn, column?: string, constraint?: Constraint): Promise<void> {
    const keys = unique(parents.map(parent => parent.getRaw(this.foreignKey)))
    const query = (this.newQuery() as RelationQuery<R>).whereIn(this.ownerKey as never, keys as never)
    constraint?.(query)
    const values = keys.length
      ? await sqlQuery(query, 'withCount()').aggregateBy(this.ownerKey, fn, column)
      : new Map()
    assignAggregates(parents, alias, fn, values, parent => parent.getRaw(this.foreignKey))
  }

  override existsQuery(): SqlRelationQuery {
    const query = sqlQuery(this.newQuery(), 'has()') as SqlRelationQuery & RelationQuery<R>
    whereSql(query, eq(query.columnOf(this.ownerKey), columnsOf(this.parent)[this.foreignKey]))
    return query
  }

  /** 关联到另一条记录并保存父记录：`await post.author().associate(user)` */
  async associate(owner: R): Promise<ActiveRecord> {
    this.parent.setAttr(this.foreignKey, owner.getRaw(this.ownerKey))
    await (this.parent as unknown as { save: () => Promise<unknown> }).save()
    return this.parent
  }

  /** 解除关联（外键置为 null）并保存父记录 */
  async dissociate(): Promise<ActiveRecord> {
    this.parent.setAttr(this.foreignKey, null)
    await (this.parent as unknown as { save: () => Promise<unknown> }).save()
    return this.parent
  }
}

/** 中间表的数据：attach(id, data) / sync({ 1: data }) */
type PivotInput = unknown | unknown[] | ActiveRecord | ActiveRecord[]

export interface SyncResult {
  attached: unknown[]
  detached: unknown[]
  updated: unknown[]
}

/**
 * 多对多（中间表为 drizzle 表）：
 *
 * ```ts
 * roles() {
 *   return this.belongsToMany(Role, userRoles, 'roleId', 'userId')
 * }
 *
 * await user.roles()                       // 每个 Role 带有 getRelation('pivot')（中间表数据）
 * await user.roles().attach([1, 2], { grantedAt: new Date() })
 * await user.roles().sync([2, 3])
 * ```
 */
export class BelongsToMany<R extends ActiveRecord> extends Relation<R, R[]> {
  readonly pivotName: string

  /** pivot 为中间表，foreignKey / localKey 为中间表中指向关联模型 / 当前模型的列 */
  constructor(parent: ActiveRecord, related: RecordClass<R>, readonly pivot: Table, readonly foreignKey: string, readonly localKey: string, readonly parentKey: string, readonly relatedKey: string) {
    super(parent, related)
    this.pivotName = getTableName(pivot)
  }

  /** 按中间表的字段过滤：`wherePivot('status', 1)` */
  wherePivot(field: string, ...args: unknown[]): this {
    this.constraints.push(query => query.where(`${this.pivotName}.${field}`, ...args))
    return this
  }

  query(): QueryOf<R> {
    return this.joined().where(`${this.pivotName}.${this.localKey}` as never, this.parent.getRaw(this.parentKey) as never) as unknown as QueryOf<R>
  }

  async get(): Promise<R[]> {
    const groups = await this.fetch([
      this.parent.getRaw(this.parentKey),
    ], [], undefined)
    return groups.get(keyOf(this.parent.getRaw(this.parentKey))) ?? []
  }

  async eagerLoad(parents: ActiveRecord[], name: string, nested: EagerInput[], constraint?: Constraint): Promise<void> {
    const groups = await this.fetch(unique(parents.map(parent => parent.getRaw(this.parentKey))), nested, constraint)
    for (const parent of parents)
      this.assign(parent, name, groups.get(keyOf(parent.getRaw(this.parentKey))) ?? [])
  }

  override async eagerAggregate(parents: ActiveRecord[], alias: string, fn: AggregateFn, column?: string, constraint?: Constraint): Promise<void> {
    const keys = unique(parents.map(parent => parent.getRaw(this.parentKey)))
    const query = this.joined().whereIn(`${this.pivotName}.${this.localKey}` as never, keys as never)
    constraint?.(query)
    const values = keys.length
      ? await sqlQuery(query, 'withCount()').aggregateBy(`${this.pivotName}.${this.localKey}`, fn, column)
      : new Map()
    assignAggregates(parents, alias, fn, values, parent => parent.getRaw(this.parentKey))
  }

  override existsQuery(): SqlRelationQuery {
    const query = this.joined()
    whereSql(query, eq(getTableColumns(this.pivot)[this.localKey], columnsOf(this.parent)[this.parentKey]))
    return query as unknown as SqlRelationQuery
  }

  /** 添加关联：`attach(1)`、`attach([1, 2], { role: 'owner' })`、`attach(role)`、`attach({ 1: { role: 'owner' } })` */
  async attach(ids: PivotInput | Record<string, Record<string, unknown>>, data: Record<string, unknown> = {}): Promise<void> {
    const rows = this.pivotRows(ids, data)
    if (rows.length)
      await this.pivotQuery().insert(rows as never)
  }

  /** 移除关联（不传 ids 时移除全部） */
  async detach(ids?: PivotInput): Promise<number> {
    const query = this.pivotQuery().where(this.localKey as never, this.parent.getRaw(this.parentKey) as never)
    if (ids !== undefined)
      query.whereIn(this.foreignKey as never, this.idsOf(ids) as never)
    return query.delete()
  }

  /** 同步为给定的关联（多余的移除、缺少的添加；传对象时同时更新中间表数据） */
  async sync(ids: PivotInput | Record<string, Record<string, unknown>>, detaching = true): Promise<SyncResult> {
    const wanted = new Map(this.pivotRows(ids, {}).map(row => [
      keyOf(row[this.foreignKey]),
      row,
    ]))
    const run = async (): Promise<SyncResult> => {
      const current = await this.pivotQuery().where(this.localKey as never, this.parent.getRaw(this.parentKey) as never).column(this.foreignKey as never) as unknown[]
      const existing = new Set(current.map(keyOf))
      const result: SyncResult = { attached: [], detached: [], updated: [] }
      if (detaching) {
        result.detached = current.filter(id => !wanted.has(keyOf(id)))
        if (result.detached.length)
          await this.detach(result.detached)
      }
      for (const [key, row] of wanted) {
        const id = row[this.foreignKey]
        if (!existing.has(key)) {
          await this.pivotQuery().insert(row as never)
          result.attached.push(id)
          continue
        }
        const extra = Object.keys(row).filter(field => field !== this.localKey && field !== this.foreignKey)
        if (extra.length) {
          await this.pivotQuery().where(this.localKey as never, row[this.localKey] as never).where(this.foreignKey as never, id as never).update(Object.fromEntries(extra.map(field => [field, row[field]])))
          result.updated.push(id)
        }
      }
      return result
    }
    return atomically(run, connectionOf(this.parent))
  }

  /** 创建关联模型（或使用已有模型）并添加关联 */
  async save(data: R | Record<string, unknown>, pivot: Record<string, unknown> = {}): Promise<R> {
    let record = data as R
    if (!(data instanceof (this.related as unknown as typeof ActiveRecord))) {
      record = this.make().fill(data as Record<string, unknown>) as R
      await (record as unknown as { save: () => Promise<unknown> }).save()
    }
    await this.attach(record, pivot)
    return record
  }

  async saveAll(list: Array<R | Record<string, unknown>>, pivot: Record<string, unknown> = {}): Promise<R[]> {
    const run = async (): Promise<R[]> => {
      const saved: R[] = []
      for (const item of list)
        saved.push(await this.save(item, pivot))
      return saved
    }
    return atomically(run, connectionOf(this.parent))
  }

  /** 关联模型的查询，已连接中间表 */
  protected joined(): ModelQuery<any> {
    const query = this.newQuery() as unknown as ModelQuery<any>
    return query.join(this.pivot, eq(getTableColumns(this.pivot)[this.foreignKey], query.columnOf(this.relatedKey)))
  }

  /** 查询关联模型与中间表数据，按父记录的键分组；中间表数据放在每个模型的 pivot 关联上 */
  protected async fetch(keys: unknown[], nested: EagerInput[], constraint: Constraint): Promise<Map<unknown, R[]>> {
    const groups = new Map<unknown, R[]>()
    if (!keys.length)
      return groups
    const query = this.joined().whereIn(`${this.pivotName}.${this.localKey}` as never, keys as never)
    constraint?.(query)
    const pivotColumns = getTableColumns(this.pivot)
    query.field({
      ...metaOf(this.related as never).columns,
      ...Object.fromEntries(Object.entries(pivotColumns).map(([key, column]) => [`pivot__${key}`, column])),
    })
    const rows = await query.selectRows()
    const models: R[] = []
    for (const row of rows) {
      const attributes: Record<string, unknown> = {}
      const pivot: Record<string, unknown> = {}
      for (const [key, value] of Object.entries(row)) {
        if (key.startsWith('pivot__'))
          pivot[key.slice('pivot__'.length)] = value
        else
          attributes[key] = value
      }
      const model = (this.related as unknown as { hydrate: (row: Record<string, unknown>) => R }).hydrate(attributes)
      model.setRelation('pivot', pivot)
      models.push(model)
      const key = keyOf(pivot[this.localKey])
      groups.set(key, [
        ...(groups.get(key) ?? []),
        model,
      ])
    }
    if (nested.length)
      await loadRelations(models, nested)
    return groups
  }

  protected pivotQuery(): QueryBuilder<Table> {
    return new QueryBuilder(this.pivot, {
      connection: connectionOf(this.parent),
    })
  }

  protected idsOf(ids: PivotInput): unknown[] {
    return ([] as unknown[]).concat(ids).map(id => id instanceof (this.related as unknown as typeof ActiveRecord)
      ? (id as R).getRaw(this.relatedKey)
      : id)
  }

  protected pivotRows(ids: unknown, data: Record<string, unknown>): Array<Record<string, unknown>> {
    const parentId = this.parent.getRaw(this.parentKey)
    if (parentId === undefined || parentId === null)
      throw new DatabaseError(`Save ${this.parent.constructor.name} before attaching ${this.related.name}`)
    const entries: Array<[unknown, Record<string, unknown>]> = ids !== null && typeof ids === 'object' && !Array.isArray(ids) && !(ids instanceof (this.related as unknown as typeof ActiveRecord))
      ? Object.entries(ids as Record<string, Record<string, unknown>>).map(([id, extra]) => [
          id,
          {
            ...data,
            ...extra,
          },
        ])
      : this.idsOf(ids as PivotInput).map(id => [id, data])
    const column = getTableColumns(this.pivot)[this.foreignKey]
    return entries.map(([id, extra]) => ({
      ...extra,
      [this.localKey]: parentId,
      // 对象形式的键是字符串：按中间表列的类型转换
      [this.foreignKey]: typeof id === 'string' && column?.dataType === 'number'
        ? Number(id)
        : id,
    }))
  }
}

/**
 * 远程一对多：`country.hasManyThrough(Post, User, 'countryId', 'userId')`
 * （Country → User.countryId，User → Post.userId）
 */
export class HasManyThrough<R extends ActiveRecord, Result = R[]> extends Relation<R, Result> {
  readonly throughTable: Table
  readonly throughName: string

  /** through 为中间模型，firstKey 为中间模型上指向当前模型的列，secondKey 为关联模型上指向中间模型的列 */
  constructor(parent: ActiveRecord, related: RecordClass<R>, readonly through: RecordClass, readonly firstKey: string, readonly secondKey: string, readonly localKey: string, readonly throughKey: string) {
    super(parent, related)
    this.throughTable = (through as unknown as { table: Table }).table
    this.throughName = getTableName(this.throughTable)
  }

  query(): QueryOf<R> {
    return this.joined().where(`${this.throughName}.${this.firstKey}` as never, this.parent.getRaw(this.localKey) as never) as unknown as QueryOf<R>
  }

  async get(): Promise<Result> {
    const groups = await this.fetch([
      this.parent.getRaw(this.localKey),
    ], [], undefined)
    return this.result(groups.get(keyOf(this.parent.getRaw(this.localKey))) ?? [])
  }

  async eagerLoad(parents: ActiveRecord[], name: string, nested: EagerInput[], constraint?: Constraint): Promise<void> {
    const groups = await this.fetch(unique(parents.map(parent => parent.getRaw(this.localKey))), nested, constraint)
    for (const parent of parents)
      this.assign(parent, name, this.result(groups.get(keyOf(parent.getRaw(this.localKey))) ?? []))
  }

  override async eagerAggregate(parents: ActiveRecord[], alias: string, fn: AggregateFn, column?: string, constraint?: Constraint): Promise<void> {
    const keys = unique(parents.map(parent => parent.getRaw(this.localKey)))
    const query = this.joined().whereIn(`${this.throughName}.${this.firstKey}` as never, keys as never)
    constraint?.(query)
    const values = keys.length
      ? await sqlQuery(query, 'withCount()').aggregateBy(`${this.throughName}.${this.firstKey}`, fn, column)
      : new Map()
    assignAggregates(parents, alias, fn, values, parent => parent.getRaw(this.localKey))
  }

  override existsQuery(): SqlRelationQuery {
    const query = this.joined()
    whereSql(query, eq(getTableColumns(this.throughTable)[this.firstKey], columnsOf(this.parent)[this.localKey]))
    return query as unknown as SqlRelationQuery
  }

  protected result(models: R[]): Result {
    return models as Result
  }

  protected joined(): ModelQuery<any> {
    const query = this.newQuery() as unknown as ModelQuery<any>
    return query.join(this.throughTable, eq(getTableColumns(this.throughTable)[this.throughKey], query.columnOf(this.secondKey)))
  }

  protected async fetch(keys: unknown[], nested: EagerInput[], constraint: Constraint): Promise<Map<unknown, R[]>> {
    const groups = new Map<unknown, R[]>()
    if (!keys.length)
      return groups
    const query = this.joined().whereIn(`${this.throughName}.${this.firstKey}` as never, keys as never)
    constraint?.(query)
    query.field({
      ...metaOf(this.related as never).columns,
      through__key: getTableColumns(this.throughTable)[this.firstKey],
    })
    const models: R[] = []
    for (const { through__key: through, ...row } of await query.selectRows()) {
      const model = (this.related as unknown as { hydrate: (row: Record<string, unknown>) => R }).hydrate(row)
      models.push(model)
      groups.set(keyOf(through), [
        ...(groups.get(keyOf(through)) ?? []),
        model,
      ])
    }
    if (nested.length)
      await loadRelations(models, nested)
    return groups
  }
}

/** 远程一对一 */
export class HasOneThrough<R extends ActiveRecord> extends HasManyThrough<R, R | null> {
  protected override result(models: R[]): R | null {
    return this.orDefault(models[0])
  }

  withDefault(data: Record<string, unknown> = {}): this {
    this.defaultValue = data
    return this
  }
}

/** `'commentable'` → ['commentableType', 'commentableId'] */
export function morphKeys(morph: string | [string, string]): [string, string] {
  return Array.isArray(morph)
    ? morph
    : [`${morph}Type`, `${morph}Id`]
}

abstract class MorphOneOrMany<R extends ActiveRecord, Result> extends Relation<R, Result> {
  constructor(parent: ActiveRecord, related: RecordClass<R>, readonly typeField: string, readonly idField: string, readonly type: string, readonly localKey: string) {
    super(parent, related)
  }

  query(): QueryOf<R> {
    return (this.newQuery() as RelationQuery<R>)
      .where(this.typeField as never, this.type as never)
      .where(this.idField as never, this.parent.getRaw(this.localKey) as never) as QueryOf<R>
  }

  override async eagerAggregate(parents: ActiveRecord[], alias: string, fn: AggregateFn, column?: string, constraint?: Constraint): Promise<void> {
    const keys = unique(parents.map(parent => parent.getRaw(this.localKey)))
    const query = (this.newQuery() as RelationQuery<R>).where(this.typeField as never, this.type as never).whereIn(this.idField as never, keys as never)
    constraint?.(query)
    const values = keys.length
      ? await sqlQuery(query, 'withCount()').aggregateBy(this.idField, fn, column)
      : new Map()
    assignAggregates(parents, alias, fn, values, parent => parent.getRaw(this.localKey))
  }

  override existsQuery(): SqlRelationQuery {
    const query = sqlQuery(this.newQuery(), 'has()') as SqlRelationQuery & RelationQuery<R>
    query.where(this.typeField as never, this.type as never)
    whereSql(query, eq(query.columnOf(this.idField), columnsOf(this.parent)[this.localKey]))
    return query
  }

  /** 保存一条关联记录（自动设置类型与 id） */
  async save(data: R | Record<string, unknown>): Promise<R> {
    const record = data instanceof (this.related as unknown as typeof ActiveRecord)
      ? data as R
      : this.make().fill(data as Record<string, unknown>) as R
    record.setAttr(this.typeField, this.type)
    record.setAttr(this.idField, this.parent.getRaw(this.localKey))
    await (record as unknown as { save: () => Promise<unknown> }).save()
    return record
  }

  create(data: Record<string, unknown>): Promise<R> {
    return this.save(data)
  }

  protected loadFor(parents: ActiveRecord[], nested: EagerInput[], constraint: Constraint): Promise<Map<unknown, R[]>> {
    const keys = unique(parents.map(parent => parent.getRaw(this.localKey)))
    if (!keys.length)
      return Promise.resolve(new Map())
    const query = (this.newQuery() as RelationQuery<R>).where(this.typeField as never, this.type as never).whereIn(this.idField as never, keys as never)
    return loadGrouped(query, nested, constraint, child => child.getRaw(this.idField))
  }
}

export class MorphMany<R extends ActiveRecord> extends MorphOneOrMany<R, R[]> {
  get(): Promise<R[]> {
    return (this.query() as RelationQuery<R>).select()
  }

  async eagerLoad(parents: ActiveRecord[], name: string, nested: EagerInput[], constraint?: Constraint): Promise<void> {
    const groups = await this.loadFor(parents, nested, constraint)
    for (const parent of parents)
      this.assign(parent, name, groups.get(keyOf(parent.getRaw(this.localKey))) ?? [])
  }
}

export class MorphOne<R extends ActiveRecord> extends MorphOneOrMany<R, R | null> {
  async get(): Promise<R | null> {
    return this.orDefault(await (this.query() as RelationQuery<R>).find())
  }

  async eagerLoad(parents: ActiveRecord[], name: string, nested: EagerInput[], constraint?: Constraint): Promise<void> {
    const groups = await this.loadFor(parents, nested, constraint)
    for (const parent of parents)
      this.assign(parent, name, this.orDefault(groups.get(keyOf(parent.getRaw(this.localKey)))?.[0]))
  }

  bind(fields: string[] | Record<string, string>): this {
    return SingleRelation.prototype.bind.call(this, fields) as this
  }

  withDefault(data: Record<string, unknown> = {}): this {
    return SingleRelation.prototype.withDefault.call(this, data) as this
  }
}

/** 多态所属：按 type 字段决定关联的模型 */
export class MorphTo<R extends ActiveRecord> extends SingleRelation<R> {
  constructor(parent: ActiveRecord, readonly models: Record<string, RecordClass>, readonly typeField: string, readonly idField: string) {
    super(parent, Object.values(models)[0] as RecordClass<R>)
  }

  /** 当前记录对应的模型类 */
  modelFor(type: unknown): RecordClass<R> | undefined {
    return this.models[String(type)] as RecordClass<R> | undefined
  }

  query(): QueryOf<R> {
    const model = this.modelFor(this.parent.getRaw(this.typeField))
    if (!model)
      throw new DatabaseError(`morphTo: unknown type "${String(this.parent.getRaw(this.typeField))}" on ${this.parent.constructor.name}`)
    const query = queryOf(model)
    for (const constraint of this.constraints)
      constraint(query)
    return query.where(defaultKey(model) as never, this.parent.getRaw(this.idField) as never) as QueryOf<R>
  }

  async get(): Promise<R | null> {
    if (!this.modelFor(this.parent.getRaw(this.typeField)) || this.parent.getRaw(this.idField) == null)
      return this.orDefault(null)
    return this.orDefault(await (this.query() as RelationQuery<R>).find())
  }

  async eagerLoad(parents: ActiveRecord[], name: string, nested: EagerInput[], constraint?: Constraint): Promise<void> {
    const byType = new Map<string, ActiveRecord[]>()
    for (const parent of parents) {
      const type = String(parent.getRaw(this.typeField))
      byType.set(type, [
        ...(byType.get(type) ?? []),
        parent,
      ])
    }
    const found = new Map<string, R>()
    for (const [type, group] of byType) {
      const model = this.modelFor(type)
      const ids = unique(group.map(parent => parent.getRaw(this.idField)))
      if (!model || !ids.length)
        continue
      const key = defaultKey(model)
      const query = queryOf(model)
      for (const item of this.constraints)
        item(query)
      const owners = await loadGrouped(query.whereIn(key as never, ids as never), nested, constraint, owner => owner.getRaw(key))
      for (const [id, [owner]] of owners)
        found.set(`${type}:${String(id)}`, owner as R)
    }
    for (const parent of parents)
      this.assign(parent, name, this.orDefault(found.get(`${String(parent.getRaw(this.typeField))}:${String(keyOf(parent.getRaw(this.idField)))}`)))
  }

  /** 关联到另一条记录并保存父记录 */
  async associate(owner: ActiveRecord): Promise<ActiveRecord> {
    const type = Object.entries(this.models).find(([, model]) => owner instanceof model)?.[0]
    if (!type)
      throw new DatabaseError(`morphTo: ${owner.constructor.name} is not one of ${Object.keys(this.models).join(', ')}`)
    this.parent.setAttr(this.typeField, type)
    this.parent.setAttr(this.idField, owner.getKey())
    await (this.parent as unknown as { save: () => Promise<unknown> }).save()
    return this.parent
  }

  async dissociate(): Promise<ActiveRecord> {
    this.parent.setAttr(this.typeField, null)
    this.parent.setAttr(this.idField, null)
    await (this.parent as unknown as { save: () => Promise<unknown> }).save()
    return this.parent
  }
}

/** 取记录上名为 name 的关联 */
export function relationOf(record: ActiveRecord, name: string): Relation<ActiveRecord, unknown> {
  const factory = (record as unknown as Record<string, unknown>)[name]
  if (typeof factory !== 'function')
    throw new TypeError(`Relation "${name}" is not defined on ${record.constructor.name}`)
  const relation = factory.call(record) as unknown
  if (!(relation instanceof Relation))
    throw new TypeError(`${record.constructor.name}.${name}() must return a relation (this.hasMany() / this.belongsTo() / ...)`)
  return relation
}

/** 预加载项 → 关联名 → { 约束, 嵌套项 } */
function eagerTree(items: EagerInput[]): Map<string, { constraint?: Constraint, nested: EagerInput[] }> {
  const tree = new Map<string, { constraint?: Constraint, nested: EagerInput[] }>()
  const add = (path: string, constraint: Constraint): void => {
    const [head, ...rest] = path.split('.')
    const node = tree.get(head) ?? { nested: [] }
    if (rest.length) {
      node.nested.push(constraint
        ? { [rest.join('.')]: constraint }
        : rest.join('.'))
    }
    else if (constraint) {
      node.constraint = constraint
    }
    tree.set(head, node)
  }
  for (const item of items) {
    if (typeof item === 'string') {
      add(item, undefined)
      continue
    }
    for (const [path, constraint] of Object.entries(item))
      add(path, constraint)
  }
  return tree
}

/** 预加载：`['posts', 'posts.comments', { profile: q => ... }]` 按第一段分组，其余作为嵌套关联 */
export async function loadRelations(records: ActiveRecord[], items: EagerInput[]): Promise<void> {
  if (!records.length)
    return
  for (const [name, node] of eagerTree(items))
    await relationOf(records[0], name).eagerLoad(records, name, node.nested, node.constraint)
}

export function defaultKey(record: RecordClass): string {
  const key = (record as unknown as { primaryKeyName: () => string | undefined }).primaryKeyName()
  if (!key)
    throw new Error(`${record.name} has no single-column primary key; pass the key explicitly`)
  return key
}

/**
 * 关联键的比较值：ObjectId 等对象按字符串比较；
 * 数字、BigInt 与字符串统一为字符串（雪花 ID 可能一侧是 BigInt / 字符串，另一侧是 number）
 */
export function keyOf(value: unknown): unknown {
  if (value && typeof value === 'object' && typeof (value as { toHexString?: unknown }).toHexString === 'function')
    return (value as { toHexString: () => string }).toHexString()
  if (typeof value === 'bigint' || typeof value === 'number')
    return String(value)
  return value
}

/** 以 drizzle 表达式追加条件（where 的单参数形式） */
function whereSql(query: unknown, condition: unknown): void {
  (query as { where: (condition: unknown) => unknown }).where(condition)
}

function unique(values: unknown[]): unknown[] {
  const seen = new Map<unknown, unknown>()
  for (const value of values) {
    if (value !== null && value !== undefined && !seen.has(keyOf(value)))
      seen.set(keyOf(value), value)
  }
  return [
    ...seen.values(),
  ]
}
