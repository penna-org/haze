import type { Table } from 'drizzle-orm'
import type { WhereCondition } from '../query/conditions'
import type { ColumnKey, Insert, Operator, Paginated, Row } from '../types'
import type { ModelSettings, TimestampOptions } from './meta'
import type { Relation } from './relations'
import { getTableColumns } from 'drizzle-orm'
import { DatabaseError } from '../errors'
import { QueryBuilder } from '../query/builder'
import { nowFor, pascalCase } from '../utils'
import { metaOf } from './meta'
import { ModelQuery } from './query'
import { BelongsTo, defaultKey, HasMany, HasOne, loadRelations } from './relations'

/** 通过品牌属性读取模型的表类型（避免结构比较时展开关联类型导致循环） */
export type TableOf<M> = M extends { readonly '~table': infer T } ? T : never

/** 模型类（构造器 + 静态配置） */
export type ModelClass<M extends Model = Model> = (new () => M) & ModelSettings

/** 模型上返回关联的方法名 */
export type RelationName<M> = {
  [K in Exclude<keyof M, keyof Model>]: M[K] extends () => Relation<any, any> ? K : never
}[Exclude<keyof M, keyof Model>] & string

export type RelationResult<F> = F extends () => Relation<any, infer Result> ? Result : never

type WhereArgs<T extends Table>
  = | [condition: WhereCondition<T>]
    | [column: ColumnKey<T>, value: unknown]
    | [column: ColumnKey<T>, operator: Operator, value: unknown]

/** Model.define(table) 返回的基类：实例拥有表的全部列属性 */
export type DefinedModel<T extends Table> = Omit<typeof Model, 'prototype'> & (new () => Model<T> & Row<T>)

type Hook = 'onBeforeWrite' | 'onAfterWrite' | 'onBeforeInsert' | 'onAfterInsert' | 'onBeforeUpdate' | 'onAfterUpdate'
  | 'onBeforeDelete' | 'onAfterDelete' | 'onBeforeRestore' | 'onAfterRestore'

/**
 * ThinkPHP 风格模型，表结构来自 drizzle：
 *
 * ```ts
 * export class User extends Model.define(users) {
 *   static override softDelete = true
 *   static override hidden = ['password']
 *
 *   posts() {
 *     return this.hasMany(Post, 'userId')
 *   }
 *
 *   static scopeActive(query: ModelQuery<User>) {
 *     query.where('status', 1)
 *   }
 * }
 *
 * const user = await User.findOrFail(1)
 * user.name = 'Ada'
 * await user.save()
 * await User.where('status', 1).with('posts').order('id', 'desc').paginate(1, 20)
 * ```
 *
 * 访问器 / 修改器：定义 `getNameAttr(value, data)` / `setNameAttr(value, data)`；
 * 事件：定义 `onBeforeInsert()`、`onAfterUpdate()` 等方法。
 */
export class Model<T extends Table = Table> {
  /** 仅用于类型推导 */
  declare readonly '~table': T
  declare static table: Table
  /** 使用的连接名，默认使用 config/database.ts 的 default */
  static connection: string | undefined = undefined
  /** 软删除：true 使用 deletedAt 列，或指定列名 */
  static softDelete: boolean | string = false
  /** 自动维护 createdAt / updatedAt（列存在时），可指定列名或设为 false */
  static timestamps: boolean | TimestampOptions = true
  /** 序列化时隐藏的字段 */
  static hidden: readonly string[] = []
  /** 序列化时追加的虚拟字段（需定义 getXxxAttr） */
  static append: readonly string[] = []

  #attributes: Record<string, unknown> = {}
  #original: Record<string, unknown> = {}
  #relations: Record<string, unknown> = {}
  #exists = false

  /** 声明模型对应的表：`class User extends Model.define(users) {}` */
  static define<T extends Table>(table: T): DefinedModel<T> {
    class Defined extends Model<T> {
      static override table = table
    }
    for (const key of Object.keys(getTableColumns(table))) {
      Object.defineProperty(Defined.prototype, key, {
        get(this: Model) {
          return this.getAttr(key)
        },
        set(this: Model, value: unknown) {
          this.setAttr(key, value)
        },
        configurable: true,
        enumerable: false,
      })
    }
    return Defined as unknown as DefinedModel<T>
  }

  // ---------------------------------------------------------------- 静态查询入口

  static query<M extends Model>(this: ModelClass<M>): ModelQuery<M> {
    return new ModelQuery(this)
  }

  static where<M extends Model>(this: ModelClass<M>, ...args: WhereArgs<TableOf<M> & Table>): ModelQuery<M> {
    return (new ModelQuery(this).where as (...a: unknown[]) => ModelQuery<M>)(...args)
  }

  static whereIn<M extends Model, K extends ColumnKey<TableOf<M> & Table>>(this: ModelClass<M>, column: K, values: ReadonlyArray<Row<TableOf<M> & Table>[K]>): ModelQuery<M> {
    return new ModelQuery(this).whereIn(column, values)
  }

  static order<M extends Model>(this: ModelClass<M>, column: ColumnKey<TableOf<M> & Table>, direction: 'asc' | 'desc' = 'asc'): ModelQuery<M> {
    return new ModelQuery(this).order(column, direction)
  }

  static with<M extends Model>(this: ModelClass<M>, ...relations: Array<RelationName<M> | `${RelationName<M>}.${string}`>): ModelQuery<M> {
    return new ModelQuery(this).with(...relations)
  }

  static scope<M extends Model>(this: ModelClass<M>, name: string, ...args: unknown[]): ModelQuery<M> {
    return new ModelQuery(this).scope(name, ...args)
  }

  static withTrashed<M extends Model>(this: ModelClass<M>): ModelQuery<M> {
    return new ModelQuery(this).withTrashed()
  }

  static onlyTrashed<M extends Model>(this: ModelClass<M>): ModelQuery<M> {
    return new ModelQuery(this).onlyTrashed()
  }

  static find<M extends Model>(this: ModelClass<M>, id: unknown): Promise<M | undefined> {
    return new ModelQuery(this).find(id)
  }

  static findOrFail<M extends Model>(this: ModelClass<M>, id: unknown): Promise<M> {
    return new ModelQuery(this).findOrFail(id)
  }

  static all<M extends Model>(this: ModelClass<M>): Promise<M[]> {
    return new ModelQuery(this).select()
  }

  static paginate<M extends Model>(this: ModelClass<M>, page?: number, perPage?: number): Promise<Paginated<M>> {
    return new ModelQuery(this).paginate(page, perPage)
  }

  static count<M extends Model>(this: ModelClass<M>): Promise<number> {
    return new ModelQuery(this).count()
  }

  /** 创建并保存（会触发事件与时间戳） */
  static async create<M extends Model>(this: ModelClass<M>, data: Partial<Insert<TableOf<M> & Table>>): Promise<M> {
    const model = new this()
    model.fill(data as Record<string, unknown>)
    await model.save()
    return model
  }

  /** 按主键删除（逐个触发事件与软删除），返回删除数量 */
  static async destroy<M extends Model>(this: ModelClass<M>, ids: unknown | unknown[]): Promise<number> {
    const list = Array.isArray(ids)
      ? ids
      : [ids]
    const models = list.length
      ? await new ModelQuery(this).whereIn(defaultKey(this as unknown as ModelClass) as never, list as never).select()
      : []
    for (const model of models)
      await model.delete()
    return models.length
  }

  /** 由数据库行构造已存在的模型 */
  static hydrate<M extends Model>(this: ModelClass<M>, row: Record<string, unknown>): M {
    const model = new this()
    model.#attributes = { ...row }
    model.#original = { ...row }
    model.#exists = true
    return model
  }

  // ---------------------------------------------------------------- 属性

  get exists(): boolean {
    return this.#exists
  }

  /** 主键值 */
  getKey(): unknown {
    const key = this.#meta().primaryKey
    return key ? this.#attributes[key] : undefined
  }

  /** 读取属性（经过 getXxxAttr 访问器） */
  getAttr(key: string): unknown {
    const accessor = (this as unknown as Record<string, unknown>)[`get${pascalCase(key)}Attr`]
    const value = this.#attributes[key]
    return typeof accessor === 'function'
      ? accessor.call(this, value, this.#attributes)
      : value
  }

  /** 写入属性（经过 setXxxAttr 修改器） */
  setAttr(key: string, value: unknown): this {
    const mutator = (this as unknown as Record<string, unknown>)[`set${pascalCase(key)}Attr`]
    this.#attributes[key] = typeof mutator === 'function'
      ? mutator.call(this, value, this.#attributes)
      : value
    return this
  }

  /** 原始属性（不经过访问器） */
  getRaw(key: string): unknown {
    return this.#attributes[key]
  }

  /** 批量赋值（忽略表中不存在的字段） */
  fill(data: Record<string, unknown>): this {
    const { columns } = this.#meta()
    for (const [key, value] of Object.entries(data)) {
      if (key in columns)
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
    for (const [key, value] of Object.entries(this.#attributes)) {
      if (!this.#exists || !sameValue(value, this.#original[key]))
        dirty[key] = value
    }
    return dirty
  }

  getOriginal(key?: string): unknown {
    return key
      ? this.#original[key]
      : { ...this.#original }
  }

  // ---------------------------------------------------------------- 持久化

  /** 新模型插入，已存在模型更新修改过的字段 */
  async save(): Promise<this> {
    const meta = this.#meta()
    await this.#hook('onBeforeWrite')

    if (!this.#exists) {
      await this.#hook('onBeforeInsert')
      for (const key of [meta.createdAt, meta.updatedAt]) {
        if (key && this.#attributes[key] == null)
          this.#attributes[key] = nowFor(meta.columns[key])
      }
      const values = pickColumns(this.#attributes, meta.columns)
      const [row] = await this.#builder().insert(values as never)
      if (row) {
        this.#attributes = {
          ...this.#attributes,
          ...row,
        }
      }
      this.#exists = true
      this.#original = { ...this.#attributes }
      await this.#hook('onAfterInsert')
    }
    else {
      const dirty = pickColumns(this.getDirty(), meta.columns)
      if (Object.keys(dirty).length) {
        await this.#hook('onBeforeUpdate')
        if (meta.updatedAt && !(meta.updatedAt in dirty))
          dirty[meta.updatedAt] = this.#attributes[meta.updatedAt] = nowFor(meta.columns[meta.updatedAt])
        await this.#whereKey().update(dirty)
        this.#original = { ...this.#attributes }
        await this.#hook('onAfterUpdate')
      }
    }

    await this.#hook('onAfterWrite')
    return this
  }

  /** 删除：启用软删除时只标记删除时间 */
  async delete(): Promise<boolean> {
    if (!this.#exists)
      return false
    const meta = this.#meta()
    await this.#hook('onBeforeDelete')
    if (meta.softDelete) {
      const value = nowFor(meta.columns[meta.softDelete])
      await this.#whereKey().update({ [meta.softDelete]: value })
      this.#attributes[meta.softDelete] = value
      this.#original[meta.softDelete] = value
    }
    else {
      await this.#whereKey().delete()
      this.#exists = false
    }
    await this.#hook('onAfterDelete')
    return true
  }

  /** 物理删除 */
  async forceDelete(): Promise<boolean> {
    if (!this.#exists)
      return false
    await this.#hook('onBeforeDelete')
    await this.#whereKey().delete()
    this.#exists = false
    await this.#hook('onAfterDelete')
    return true
  }

  /** 恢复软删除 */
  async restore(): Promise<this> {
    const { softDelete } = this.#meta()
    if (!softDelete)
      return this
    await this.#hook('onBeforeRestore')
    await this.#whereKey().update({ [softDelete]: null })
    this.#attributes[softDelete] = null
    this.#original[softDelete] = null
    await this.#hook('onAfterRestore')
    return this
  }

  trashed(): boolean {
    const { softDelete } = this.#meta()
    return softDelete
      ? this.#attributes[softDelete] != null
      : false
  }

  /** 从数据库重新读取 */
  async refresh(): Promise<this> {
    const row = await this.#whereKey().find()
    if (!row)
      throw new DatabaseError(`${this.constructor.name} ${String(this.getKey())} no longer exists`)
    this.#attributes = { ...row as Record<string, unknown> }
    this.#original = { ...this.#attributes }
    return this
  }

  // ---------------------------------------------------------------- 关联

  /** 加载关联（可嵌套）：`await user.load('posts.comments')` */
  async load(...relations: Array<RelationName<this> | `${RelationName<this>}.${string}`>): Promise<this> {
    await loadRelations([this], relations)
    return this
  }

  /** 已加载的关联结果 */
  getRelation<K extends RelationName<this>>(name: K): RelationResult<this[K]> | undefined {
    return this.#relations[name] as RelationResult<this[K]> | undefined
  }

  setRelation(name: string, value: unknown): this {
    this.#relations[name] = value
    return this
  }

  protected hasMany<R extends Model>(related: ModelClass<R>, foreignKey: ColumnKey<TableOf<R> & Table>, localKey?: ColumnKey<T>): HasMany<R> {
    return new HasMany(this, related, foreignKey, localKey ?? defaultKey(this.constructor as ModelClass))
  }

  protected hasOne<R extends Model>(related: ModelClass<R>, foreignKey: ColumnKey<TableOf<R> & Table>, localKey?: ColumnKey<T>): HasOne<R> {
    return new HasOne(this, related, foreignKey, localKey ?? defaultKey(this.constructor as ModelClass))
  }

  protected belongsTo<R extends Model>(related: ModelClass<R>, foreignKey: ColumnKey<T>, ownerKey?: ColumnKey<TableOf<R> & Table>): BelongsTo<R> {
    return new BelongsTo(this, related, foreignKey, ownerKey ?? defaultKey(related as unknown as ModelClass))
  }

  // ---------------------------------------------------------------- 序列化

  /** 序列化：应用访问器、隐藏字段、追加字段与已加载的关联 */
  toJSON(): Record<string, unknown> {
    const model = this.constructor as unknown as ModelSettings
    const hidden = new Set(model.hidden)
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(this.#attributes)) {
      if (!hidden.has(key))
        result[key] = this.getAttr(key)
    }
    for (const key of model.append)
      result[key] = this.getAttr(key)
    for (const [key, value] of Object.entries(this.#relations)) {
      if (!hidden.has(key)) {
        result[key] = Array.isArray(value)
          ? value.map(serialize)
          : serialize(value)
      }
    }
    return result
  }

  // ---------------------------------------------------------------- 内部

  #meta(): ReturnType<typeof metaOf> {
    return metaOf(this.constructor as unknown as ModelSettings)
  }

  #builder(): QueryBuilder<Table> {
    const model = this.constructor as unknown as ModelSettings
    return new QueryBuilder(model.table, { connection: model.connection })
  }

  #whereKey(): QueryBuilder<Table> {
    const key = this.#meta().primaryKey
    if (!key)
      throw new DatabaseError(`${this.constructor.name} has no single-column primary key`)
    return this.#builder().where(key as never, this.#original[key] ?? this.#attributes[key] as never)
  }

  async #hook(name: Hook): Promise<void> {
    const hook = (this as unknown as Record<string, unknown>)[name]
    if (typeof hook === 'function')
      await hook.call(this)
  }
}

/** 由数据库行构造模型（供 ModelQuery 使用） */
export function hydrateModel<M extends Model>(model: ModelClass<M>, row: Record<string, unknown>): M {
  return (Model.hydrate as (this: ModelClass<M>, row: Record<string, unknown>) => M).call(model, row)
}

function serialize(value: unknown): unknown {
  return value instanceof Model
    ? value.toJSON()
    : value
}

function pickColumns(values: Record<string, unknown>, columns: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => key in columns))
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime()
  return Object.is(a, b)
}
