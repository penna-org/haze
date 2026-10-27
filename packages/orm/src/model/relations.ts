import type { Model, ModelClass } from './model'
import { metaOf } from './meta'
import { ModelQuery } from './query'

/**
 * 关联关系。可直接 await 获取结果，也可继续构造查询：
 *
 * ```ts
 * const posts = await user.posts()
 * const recent = await user.posts().query().order('id', 'desc').limit(5).select()
 * ```
 */
export abstract class Relation<R extends Model, Result> implements PromiseLike<Result> {
  readonly parent: Model
  readonly related: ModelClass<R>

  constructor(parent: Model, related: ModelClass<R>) {
    this.parent = parent
    this.related = related
  }

  /** 受当前关联约束的查询 */
  abstract query(): ModelQuery<R>
  /** 获取关联结果 */
  abstract get(): Promise<Result>
  /** 批量预加载到一组父模型上 */
  abstract eagerLoad(parents: Model[], name: string, nested: string[]): Promise<void>

  then<A = Result, B = never>(onFulfilled?: ((value: Result) => A | PromiseLike<A>) | null, onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<A | B> {
    return this.get().then(onFulfilled, onRejected)
  }
}

abstract class HasOneOrMany<R extends Model, Result> extends Relation<R, Result> {
  constructor(parent: Model, related: ModelClass<R>, readonly foreignKey: string, readonly localKey: string) {
    super(parent, related)
  }

  query(): ModelQuery<R> {
    return new ModelQuery(this.related).where(this.foreignKey as never, this.parent.getAttr(this.localKey) as never)
  }

  protected async loadFor(parents: Model[], nested: string[]): Promise<Map<unknown, R[]>> {
    const keys = unique(parents.map(parent => parent.getAttr(this.localKey)))
    const groups = new Map<unknown, R[]>()
    if (!keys.length)
      return groups
    const children = await new ModelQuery(this.related).whereIn(this.foreignKey as never, keys as never).with(...nested as never[]).select()
    for (const child of children) {
      const key = child.getAttr(this.foreignKey)
      groups.set(key, [
        ...(groups.get(key) ?? []),
        child,
      ])
    }
    return groups
  }
}

export class HasMany<R extends Model> extends HasOneOrMany<R, R[]> {
  get(): Promise<R[]> {
    return this.query().select()
  }

  async eagerLoad(parents: Model[], name: string, nested: string[]): Promise<void> {
    const groups = await this.loadFor(parents, nested)
    for (const parent of parents)
      parent.setRelation(name, groups.get(parent.getAttr(this.localKey)) ?? [])
  }
}

export class HasOne<R extends Model> extends HasOneOrMany<R, R | null> {
  async get(): Promise<R | null> {
    return (await this.query().find()) ?? null
  }

  async eagerLoad(parents: Model[], name: string, nested: string[]): Promise<void> {
    const groups = await this.loadFor(parents, nested)
    for (const parent of parents)
      parent.setRelation(name, groups.get(parent.getAttr(this.localKey))?.[0] ?? null)
  }
}

export class BelongsTo<R extends Model> extends Relation<R, R | null> {
  constructor(parent: Model, related: ModelClass<R>, readonly foreignKey: string, readonly ownerKey: string) {
    super(parent, related)
  }

  query(): ModelQuery<R> {
    return new ModelQuery(this.related).where(this.ownerKey as never, this.parent.getAttr(this.foreignKey) as never)
  }

  async get(): Promise<R | null> {
    if (this.parent.getAttr(this.foreignKey) == null)
      return null
    return (await this.query().find()) ?? null
  }

  async eagerLoad(parents: Model[], name: string, nested: string[]): Promise<void> {
    const keys = unique(parents.map(parent => parent.getAttr(this.foreignKey)))
    const owners = keys.length
      ? await new ModelQuery(this.related).whereIn(this.ownerKey as never, keys as never).with(...nested as never[]).select()
      : []
    const byKey = new Map(owners.map(owner => [
      owner.getAttr(this.ownerKey),
      owner,
    ]))
    for (const parent of parents)
      parent.setRelation(name, byKey.get(parent.getAttr(this.foreignKey)) ?? null)
  }
}

/** 预加载：`['posts', 'posts.comments', 'profile']` 按第一段分组，其余作为嵌套关联 */
export async function loadRelations(models: Model[], names: string[]): Promise<void> {
  if (!models.length)
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
    const factory = (models[0] as unknown as Record<string, unknown>)[name]
    if (typeof factory !== 'function')
      throw new TypeError(`Relation "${name}" is not defined on ${models[0].constructor.name}`)
    const relation = factory.call(models[0]) as unknown
    if (!(relation instanceof Relation))
      throw new TypeError(`${models[0].constructor.name}.${name}() must return this.hasMany() / this.hasOne() / this.belongsTo()`)
    await relation.eagerLoad(models, name, nested)
  }
}

export function defaultKey(model: ModelClass<Model>): string {
  const key = metaOf(model).primaryKey
  if (!key)
    throw new Error(`Model ${model.name} has no single-column primary key; pass the key explicitly`)
  return key
}

function unique(values: unknown[]): unknown[] {
  return [
    ...new Set(values.filter(value => value !== null && value !== undefined)),
  ]
}
