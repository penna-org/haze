import type { MongoModelQuery } from '../mongo/query'
import type { ModelQuery } from './query'
import type { ActiveRecord, RecordClass } from './record'

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

function queryOf<R extends ActiveRecord>(related: RecordClass<R>): RelationQuery<R> {
  return (related as unknown as { query: () => RelationQuery<R> }).query()
}

/**
 * 关联关系。可直接 await 获取结果，也可继续构造查询：
 *
 * ```ts
 * const posts = await user.posts()
 * const recent = await user.posts().query().order('id', 'desc').limit(5).select()
 * ```
 */
export abstract class Relation<R extends ActiveRecord, Result> implements PromiseLike<Result> {
  readonly parent: ActiveRecord
  readonly related: RecordClass<R>

  constructor(parent: ActiveRecord, related: RecordClass<R>) {
    this.parent = parent
    this.related = related
  }

  /** 受当前关联约束的查询（返回关联模型自己的查询类型） */
  abstract query(): QueryOf<R>
  /** 获取关联结果 */
  abstract get(): Promise<Result>
  /** 批量预加载到一组父记录上 */
  abstract eagerLoad(parents: ActiveRecord[], name: string, nested: string[]): Promise<void>

  then<A = Result, B = never>(onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.get().then(onFulfilled, onRejected)
  }
}

abstract class HasOneOrMany<R extends ActiveRecord, Result> extends Relation<R, Result> {
  constructor(parent: ActiveRecord, related: RecordClass<R>, readonly foreignKey: string, readonly localKey: string) {
    super(parent, related)
  }

  query(): QueryOf<R> {
    return queryOf(this.related).where(this.foreignKey as never, this.parent.getRaw(this.localKey) as never) as QueryOf<R>
  }

  protected async loadFor(parents: ActiveRecord[], nested: string[]): Promise<Map<unknown, R[]>> {
    const keys = unique(parents.map(parent => parent.getRaw(this.localKey)))
    const groups = new Map<unknown, R[]>()
    if (!keys.length)
      return groups
    const children = await queryOf(this.related).whereIn(this.foreignKey as never, keys as never).with(...nested as never[]).select()
    for (const child of children) {
      const key = keyOf(child.getRaw(this.foreignKey))
      groups.set(key, [
        ...(groups.get(key) ?? []),
        child,
      ])
    }
    return groups
  }
}

export class HasMany<R extends ActiveRecord> extends HasOneOrMany<R, R[]> {
  get(): Promise<R[]> {
    return (this.query() as RelationQuery<R>).select()
  }

  async eagerLoad(parents: ActiveRecord[], name: string, nested: string[]): Promise<void> {
    const groups = await this.loadFor(parents, nested)
    for (const parent of parents)
      parent.setRelation(name, groups.get(keyOf(parent.getRaw(this.localKey))) ?? [])
  }
}

export class HasOne<R extends ActiveRecord> extends HasOneOrMany<R, R | null> {
  async get(): Promise<R | null> {
    return (await (this.query() as RelationQuery<R>).find()) ?? null
  }

  async eagerLoad(parents: ActiveRecord[], name: string, nested: string[]): Promise<void> {
    const groups = await this.loadFor(parents, nested)
    for (const parent of parents)
      parent.setRelation(name, groups.get(keyOf(parent.getRaw(this.localKey)))?.[0] ?? null)
  }
}

export class BelongsTo<R extends ActiveRecord> extends Relation<R, R | null> {
  constructor(parent: ActiveRecord, related: RecordClass<R>, readonly foreignKey: string, readonly ownerKey: string) {
    super(parent, related)
  }

  query(): QueryOf<R> {
    return queryOf(this.related).where(this.ownerKey as never, this.parent.getRaw(this.foreignKey) as never) as QueryOf<R>
  }

  async get(): Promise<R | null> {
    if (this.parent.getRaw(this.foreignKey) == null)
      return null
    return (await (this.query() as RelationQuery<R>).find()) ?? null
  }

  async eagerLoad(parents: ActiveRecord[], name: string, nested: string[]): Promise<void> {
    const keys = unique(parents.map(parent => parent.getRaw(this.foreignKey)))
    const owners = keys.length
      ? await queryOf(this.related).whereIn(this.ownerKey as never, keys as never).with(...nested as never[]).select()
      : []
    const byKey = new Map(owners.map(owner => [
      keyOf(owner.getRaw(this.ownerKey)),
      owner,
    ]))
    for (const parent of parents)
      parent.setRelation(name, byKey.get(keyOf(parent.getRaw(this.foreignKey))) ?? null)
  }
}

/** 预加载：`['posts', 'posts.comments', 'profile']` 按第一段分组，其余作为嵌套关联 */
export async function loadRelations(records: ActiveRecord[], names: string[]): Promise<void> {
  if (!records.length)
    return
  const tree = new Map<string, string[]>()
  for (const name of names) {
    const [head, ...rest] = name.split('.')
    const nested = tree.get(head) ?? []
    if (rest.length)
      nested.push(rest.join('.'))
    tree.set(head, nested)
  }

  for (const [name, nested] of tree) {
    const factory = (records[0] as unknown as Record<string, unknown>)[name]
    if (typeof factory !== 'function')
      throw new TypeError(`Relation "${name}" is not defined on ${records[0].constructor.name}`)
    const relation = factory.call(records[0]) as unknown
    if (!(relation instanceof Relation))
      throw new TypeError(`${records[0].constructor.name}.${name}() must return this.hasMany() / this.hasOne() / this.belongsTo()`)
    await relation.eagerLoad(records, name, nested)
  }
}

export function defaultKey(record: RecordClass): string {
  const key = (record as unknown as { primaryKeyName: () => string | undefined }).primaryKeyName()
  if (!key)
    throw new Error(`${record.name} has no single-column primary key; pass the key explicitly`)
  return key
}

/** 关联键的比较值：ObjectId 等对象按字符串比较 */
export function keyOf(value: unknown): unknown {
  if (value && typeof value === 'object' && typeof (value as { toHexString?: unknown }).toHexString === 'function')
    return (value as { toHexString: () => string }).toHexString()
  return value
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
