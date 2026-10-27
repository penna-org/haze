import type { Table } from 'drizzle-orm'
import type { WhereCondition } from '../query/conditions'
import type { ColumnKey, Insert, Operator, Paginated, Row } from '../types'
import type { ModelSettings, TimestampOptions } from './meta'
import type { RecordClass, RelationName } from './record'
import { getTableColumns } from 'drizzle-orm'
import { DatabaseError } from '../errors'
import { QueryBuilder } from '../query/builder'
import { nowFor } from '../utils'
import { metaOf } from './meta'
import { ModelQuery } from './query'
import { ActiveRecord } from './record'
import { defaultKey } from './relations'

/** 通过品牌属性读取模型的表类型（避免结构比较时展开关联类型导致循环） */
export type TableOf<M> = M extends { readonly '~table': infer T } ? T : never

/**
 * 泛型约束只检查品牌属性：用 `M extends Model` 会做结构比较，
 * 在互相引用的模型之间展开关联类型导致循环
 */
export interface ModelLike { readonly '~table': any }

/** 模型类（构造器 + 静态配置） */
export type ModelClass<M extends ModelLike = Model<any>> = (new () => M) & ModelSettings

type WhereArgs<T extends Table>
  = | [condition: WhereCondition<T>]
    | [column: ColumnKey<T>, value: unknown]
    | [column: ColumnKey<T>, operator: Operator, value: unknown]

/** Model.define(table) 返回的基类：实例拥有表的全部列属性 */
export type DefinedModel<T extends Table> = Omit<typeof Model, 'prototype'> & (new () => Model<T> & Row<T>)

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
export class Model<T extends Table = Table> extends ActiveRecord<Row<T>> {
  /** 仅用于类型推导 */
  declare readonly '~table': T
  declare static table: Table
  /** 使用的连接名，默认使用 config/database.ts 的 default */
  static connection: string | undefined = undefined
  /** 软删除：true 使用 deletedAt 列，或指定列名 */
  static softDelete: boolean | string = false
  /** 自动维护 createdAt / updatedAt（列存在时），可指定列名或设为 false */
  static timestamps: boolean | TimestampOptions = true

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

  static override primaryKeyName(): string | undefined {
    return metaOf(this as unknown as ModelSettings).primaryKey
  }

  // ---------------------------------------------------------------- 静态查询入口

  static query<M extends ModelLike>(this: ModelClass<M>): ModelQuery<M> {
    return new ModelQuery(this)
  }

  static where<M extends ModelLike>(this: ModelClass<M>, ...args: WhereArgs<TableOf<M> & Table>): ModelQuery<M> {
    return (new ModelQuery(this).where as (...a: unknown[]) => ModelQuery<M>)(...args)
  }

  static whereIn<M extends ModelLike, K extends ColumnKey<TableOf<M> & Table>>(this: ModelClass<M>, column: K, values: ReadonlyArray<Row<TableOf<M> & Table>[K]>): ModelQuery<M> {
    return new ModelQuery(this).whereIn(column, values)
  }

  static order<M extends ModelLike>(this: ModelClass<M>, column: ColumnKey<TableOf<M> & Table>, direction: 'asc' | 'desc' = 'asc'): ModelQuery<M> {
    return new ModelQuery(this).order(column, direction)
  }

  static with<M extends ModelLike>(this: ModelClass<M>, ...relations: Array<RelationName<M> | `${RelationName<M>}.${string}`>): ModelQuery<M> {
    return new ModelQuery(this).with(...relations)
  }

  static scope<M extends ModelLike>(this: ModelClass<M>, name: string, ...args: unknown[]): ModelQuery<M> {
    return new ModelQuery(this).scope(name, ...args)
  }

  static withTrashed<M extends ModelLike>(this: ModelClass<M>): ModelQuery<M> {
    return new ModelQuery(this).withTrashed()
  }

  static onlyTrashed<M extends ModelLike>(this: ModelClass<M>): ModelQuery<M> {
    return new ModelQuery(this).onlyTrashed()
  }

  static find<M extends ModelLike>(this: ModelClass<M>, id: unknown): Promise<M | undefined> {
    return new ModelQuery(this).find(id)
  }

  static findOrFail<M extends ModelLike>(this: ModelClass<M>, id: unknown): Promise<M> {
    return new ModelQuery(this).findOrFail(id)
  }

  static all<M extends ModelLike>(this: ModelClass<M>): Promise<M[]> {
    return new ModelQuery(this).select()
  }

  static paginate<M extends ModelLike>(this: ModelClass<M>, page?: number, perPage?: number): Promise<Paginated<M>> {
    return new ModelQuery(this).paginate(page, perPage)
  }

  static count<M extends ModelLike>(this: ModelClass<M>): Promise<number> {
    return new ModelQuery(this).count()
  }

  /** 创建并保存（会触发事件与时间戳） */
  static async create<M extends ModelLike>(this: ModelClass<M>, data: Partial<Insert<TableOf<M> & Table>>): Promise<M> {
    const model = new this()
    const record = model as unknown as Model
    record.fill(data as Record<string, unknown>)
    await record.save()
    return model
  }

  /** 按主键删除（逐个触发事件与软删除），返回删除数量 */
  static async destroy<M extends ModelLike>(this: ModelClass<M>, ids: unknown | unknown[]): Promise<number> {
    const list = Array.isArray(ids)
      ? ids
      : [ids]
    const models = list.length
      ? await new ModelQuery(this).whereIn(defaultKey(this as unknown as RecordClass) as never, list as never).select()
      : []
    for (const model of models)
      await (model as unknown as Model).delete()
    return models.length
  }

  // ---------------------------------------------------------------- 持久化

  /** 新模型插入，已存在模型更新修改过的字段 */
  async save(): Promise<this> {
    const meta = this.#meta()
    await this.runHook('onBeforeWrite')

    if (!this.$exists) {
      await this.runHook('onBeforeInsert')
      for (const key of [meta.createdAt, meta.updatedAt]) {
        if (key && this.$attributes[key] == null)
          this.$attributes[key] = nowFor(meta.columns[key])
      }
      const [row] = await this.#builder().insert(pickColumns(this.$attributes, meta.columns) as never)
      if (row) {
        this.$attributes = {
          ...this.$attributes,
          ...row,
        }
      }
      this.$exists = true
      this.syncOriginal()
      await this.runHook('onAfterInsert')
    }
    else {
      const dirty = pickColumns(this.getDirty(), meta.columns)
      if (Object.keys(dirty).length) {
        await this.runHook('onBeforeUpdate')
        if (meta.updatedAt && !(meta.updatedAt in dirty))
          dirty[meta.updatedAt] = this.$attributes[meta.updatedAt] = nowFor(meta.columns[meta.updatedAt])
        await this.#whereKey().update(dirty)
        this.syncOriginal()
        await this.runHook('onAfterUpdate')
      }
    }

    await this.runHook('onAfterWrite')
    return this
  }

  /** 删除：启用软删除时只标记删除时间 */
  async delete(): Promise<boolean> {
    if (!this.$exists)
      return false
    const meta = this.#meta()
    await this.runHook('onBeforeDelete')
    if (meta.softDelete) {
      const value = nowFor(meta.columns[meta.softDelete])
      await this.#whereKey().update({ [meta.softDelete]: value })
      this.$attributes[meta.softDelete] = value
      this.$original[meta.softDelete] = value
    }
    else {
      await this.#whereKey().delete()
      this.$exists = false
    }
    await this.runHook('onAfterDelete')
    return true
  }

  /** 物理删除 */
  async forceDelete(): Promise<boolean> {
    if (!this.$exists)
      return false
    await this.runHook('onBeforeDelete')
    await this.#whereKey().delete()
    this.$exists = false
    await this.runHook('onAfterDelete')
    return true
  }

  /** 恢复软删除 */
  async restore(): Promise<this> {
    const { softDelete } = this.#meta()
    if (!softDelete)
      return this
    await this.runHook('onBeforeRestore')
    await this.#whereKey().update({ [softDelete]: null })
    this.$attributes[softDelete] = null
    this.$original[softDelete] = null
    await this.runHook('onAfterRestore')
    return this
  }

  trashed(): boolean {
    const { softDelete } = this.#meta()
    return softDelete
      ? this.$attributes[softDelete] != null
      : false
  }

  /** 从数据库重新读取 */
  async refresh(): Promise<this> {
    const row = await this.#whereKey().find()
    if (!row)
      throw new DatabaseError(`${this.constructor.name} ${String(this.getKey())} no longer exists`)
    this.$attributes = { ...row as Record<string, unknown> }
    this.syncOriginal()
    return this
  }

  // ---------------------------------------------------------------- 内部

  protected override acceptsAttribute(key: string): boolean {
    return key in this.#meta().columns
  }

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
    return this.#builder().where(key as never, this.$original[key] ?? this.$attributes[key] as never)
  }
}

/** 由数据库行构造模型（供 ModelQuery 使用） */
export function hydrateModel<M extends ModelLike>(model: ModelClass<M>, row: Record<string, unknown>): M {
  return (Model.hydrate as (this: ModelClass<M>, row: Record<string, unknown>) => M).call(model, row)
}

function pickColumns(values: Record<string, unknown>, columns: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([key]) => key in columns))
}
