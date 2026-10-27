import type { BelongsTo, HasMany, HasOne, Relation } from './relations'
import { pascalCase } from '../utils'
import { BelongsTo as BelongsToRelation, defaultKey, HasMany as HasManyRelation, HasOne as HasOneRelation, loadRelations } from './relations'

/** 记录的字段名（SQL 模型为表的列，Mongo 模型为文档字段） */
export type FieldOf<R> = R extends { readonly '~row': infer Row } ? keyof Row & string : string

/** 记录上返回关联的方法名 */
type OwnKey<M> = Exclude<keyof M, keyof ActiveRecord | `~${string}`>

export type RelationName<M> = {
  [K in OwnKey<M>]: M[K] extends () => Relation<any, any> ? K : never
}[OwnKey<M>] & string

export type RelationResult<F> = F extends () => Relation<any, infer Result> ? Result : never

/** 关联所需的类信息（构造器 + 查询入口） */
export type RecordClass<R extends ActiveRecord = ActiveRecord> = (new () => R) & { readonly name: string }

export type Hook = 'onBeforeWrite' | 'onAfterWrite' | 'onBeforeInsert' | 'onAfterInsert' | 'onBeforeUpdate' | 'onAfterUpdate'
  | 'onBeforeDelete' | 'onAfterDelete' | 'onBeforeRestore' | 'onAfterRestore'

/**
 * SQL 模型（Model）与 MongoDB 模型（MongoModel）共用的基类：
 * 属性与脏检查、访问器 / 修改器、关联、序列化与事件。
 *
 * 内部状态使用 `$` 前缀的受保护字段，避免与真实字段名冲突。
 */
export abstract class ActiveRecord<TRow extends object = any> {
  /** 仅用于类型推导 */
  declare readonly '~row': TRow
  /** 序列化时隐藏的字段 */
  static hidden: readonly string[] = []
  /** 序列化时追加的虚拟字段（需定义 getXxxAttr） */
  static append: readonly string[] = []

  protected $attributes: Record<string, unknown> = {}
  protected $original: Record<string, unknown> = {}
  protected $relations: Record<string, unknown> = {}
  protected $exists = false

  /** 主键字段名（子类实现） */
  static primaryKeyName(): string | undefined {
    return undefined
  }

  /** 由数据库行 / 文档构造已存在的记录 */
  static hydrate<M extends ActiveRecord>(this: new () => M, row: Record<string, unknown>): M {
    const record = new this()
    record.$attributes = { ...row }
    record.$original = { ...row }
    record.$exists = true
    return record
  }

  get exists(): boolean {
    return this.$exists
  }

  /** 主键值 */
  getKey(): unknown {
    const key = (this.constructor as typeof ActiveRecord).primaryKeyName()
    return key ? this.$attributes[key] : undefined
  }

  /** 读取属性（经过 getXxxAttr 访问器） */
  getAttr(key: string): unknown {
    const accessor = (this as unknown as Record<string, unknown>)[`get${pascalCase(key)}Attr`]
    const value = this.$attributes[key]
    return typeof accessor === 'function'
      ? accessor.call(this, value, this.$attributes)
      : value
  }

  /** 写入属性（经过 setXxxAttr 修改器） */
  setAttr(key: string, value: unknown): this {
    const mutator = (this as unknown as Record<string, unknown>)[`set${pascalCase(key)}Attr`]
    this.$attributes[key] = typeof mutator === 'function'
      ? mutator.call(this, value, this.$attributes)
      : value
    return this
  }

  /** 原始属性（不经过访问器） */
  getRaw(key: string): unknown {
    return this.$attributes[key]
  }

  /** 批量赋值（SQL 模型忽略表中不存在的列） */
  fill(data: Record<string, unknown>): this {
    for (const [key, value] of Object.entries(data)) {
      if (this.acceptsAttribute(key))
        this.setAttr(key, value)
    }
    return this
  }

  isDirty(key?: string): boolean {
    const dirty = this.getDirty()
    return key
      ? key in dirty
      : Object.keys(dirty).length > 0
  }

  /** 自上次同步以来修改过的字段 */
  getDirty(): Record<string, unknown> {
    const dirty: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(this.$attributes)) {
      if (!this.$exists || !sameValue(value, this.$original[key]))
        dirty[key] = value
    }
    return dirty
  }

  getOriginal(key?: string): unknown {
    return key
      ? this.$original[key]
      : { ...this.$original }
  }

  // ---------------------------------------------------------------- 关联

  /** 加载关联（可嵌套）：`await user.load('posts.comments')` */
  async load(...relations: Array<RelationName<this> | `${RelationName<this>}.${string}`>): Promise<this> {
    await loadRelations([this], relations)
    return this
  }

  /** 已加载的关联结果 */
  getRelation<K extends RelationName<this>>(name: K): RelationResult<this[K]> | undefined {
    return this.$relations[name] as RelationResult<this[K]> | undefined
  }

  setRelation(name: string, value: unknown): this {
    this.$relations[name] = value
    return this
  }

  // 关联目标 R 不加 `extends ActiveRecord` 约束：结构比较会展开互相引用的模型类型导致循环，
  // 以 `R & ActiveRecord` 交叉类型满足内部约束

  protected hasMany<R>(related: new () => R, foreignKey: FieldOf<R>, localKey?: keyof TRow & string): HasMany<R & ActiveRecord> {
    return new HasManyRelation(this, related as unknown as RecordClass<R & ActiveRecord>, foreignKey, localKey ?? defaultKey(this.constructor as RecordClass))
  }

  protected hasOne<R>(related: new () => R, foreignKey: FieldOf<R>, localKey?: keyof TRow & string): HasOne<R & ActiveRecord> {
    return new HasOneRelation(this, related as unknown as RecordClass<R & ActiveRecord>, foreignKey, localKey ?? defaultKey(this.constructor as RecordClass))
  }

  protected belongsTo<R>(related: new () => R, foreignKey: keyof TRow & string, ownerKey?: FieldOf<R>): BelongsTo<R & ActiveRecord> {
    return new BelongsToRelation(this, related as unknown as RecordClass<R & ActiveRecord>, foreignKey, ownerKey ?? defaultKey(related as unknown as RecordClass))
  }

  // ---------------------------------------------------------------- 序列化

  /** 序列化：应用访问器、隐藏字段、追加字段与已加载的关联 */
  toJSON(): Record<string, unknown> {
    const record = this.constructor as typeof ActiveRecord
    const hidden = new Set(record.hidden)
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(this.$attributes)) {
      if (!hidden.has(key))
        result[key] = this.getAttr(key)
    }
    for (const key of record.append)
      result[key] = this.getAttr(key)
    for (const [key, value] of Object.entries(this.$relations)) {
      if (!hidden.has(key)) {
        result[key] = Array.isArray(value)
          ? value.map(serialize)
          : serialize(value)
      }
    }
    return result
  }

  // ---------------------------------------------------------------- 供子类使用

  /** 是否接受批量赋值的字段 */
  protected acceptsAttribute(_key: string): boolean {
    return true
  }

  protected async runHook(name: Hook): Promise<void> {
    const hook = (this as unknown as Record<string, unknown>)[name]
    if (typeof hook === 'function')
      await hook.call(this)
  }

  /** 写入成功后同步原始值 */
  protected syncOriginal(): void {
    this.$original = { ...this.$attributes }
  }
}

function serialize(value: unknown): unknown {
  return value instanceof ActiveRecord
    ? value.toJSON()
    : value
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime()
  // ObjectId 等值对象
  if (a && b && typeof a === 'object' && typeof (a as { equals?: unknown }).equals === 'function')
    return (a as { equals: (other: unknown) => boolean }).equals(b)
  return Object.is(a, b)
}
