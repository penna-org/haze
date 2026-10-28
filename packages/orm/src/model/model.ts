import type { Table } from 'drizzle-orm'
import type { TransactionConfig } from '../context'
import type { WhereCondition, WhereObject } from '../query/conditions'
import type { AnyDatabase, ColumnKey, Insert, Operator, Paginated, Row } from '../types'
import type { ModelSettings, TimestampOptions } from './meta'
import type { RelationCondition } from './query'
import type { EagerLoad, FieldOf, RecordClass, RelationName } from './record'
import { currentTenancy } from '@hazejs/core'
import { getTableColumns, sql } from 'drizzle-orm'
import { atomically, transaction } from '../context'
import { DatabaseError, OptimisticLockException } from '../errors'
import { QueryBuilder } from '../query/builder'
import { isPlainObject, nowFor } from '../utils'
import { metaOf } from './meta'
import { ModelQuery } from './query'
import { ActiveRecord } from './record'
import { BelongsToMany, defaultKey, HasManyThrough, HasOneThrough } from './relations'

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
 * 事件：定义 `onBeforeInsert()`、`onAfterUpdate()` 等方法（before 事件返回 false 时取消写入）。
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
  /** 只读字段：创建后不再更新 */
  static readonly: readonly string[] = []
  /** 乐观锁：true 使用 lockVersion 列，或指定列名 */
  static optimLock: boolean | string = false
  /** 全局作用域：对应 `static scopeXxx(query)`，所有查询自动应用，`withoutGlobalScope()` 关闭 */
  static globalScope: readonly string[] = []
  /**
   * 多租户（单库 + 租户 ID 列）：true 使用 tenantId 列，或指定列名。
   * 租户上下文中查询自动加上 `tenantId = 当前租户`（全局作用域 `tenant`，`withoutGlobalScope(['tenant'])` 关闭），
   * 新建时自动填充
   */
  static belongsToTenant: boolean | string = false

  /** 允许批量赋值的字段（allowField() 设置） */
  protected $allowField: string[] | undefined
  /** 强制更新（即使没有修改） */
  protected $force = false
  /** inc() / dec() 累积、save() 时原子更新的增量 */
  protected $increments: Record<string, number> = {}

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

  static with<M extends ModelLike>(this: ModelClass<M>, ...relations: Array<EagerLoad<M>>): ModelQuery<M> {
    return new ModelQuery(this).with(...relations)
  }

  static withCount<M extends ModelLike>(this: ModelClass<M>, relation: RelationName<M> | Array<RelationName<M>>, constraint?: (query: any) => unknown, alias?: string): ModelQuery<M> {
    return new ModelQuery(this).withCount(relation, constraint, alias)
  }

  static has<M extends ModelLike>(this: ModelClass<M>, relation: RelationName<M>, operator?: Operator, value?: number): ModelQuery<M> {
    return new ModelQuery(this).has(relation, operator, value)
  }

  static hasWhere<M extends ModelLike>(this: ModelClass<M>, relation: RelationName<M>, condition?: RelationCondition): ModelQuery<M> {
    return new ModelQuery(this).hasWhere(relation, condition)
  }

  static scope<M extends ModelLike>(this: ModelClass<M>, name: string, ...args: unknown[]): ModelQuery<M> {
    return new ModelQuery(this).scope(name, ...args)
  }

  static withSearch<M extends ModelLike>(this: ModelClass<M>, fields: readonly string[], data?: Record<string, unknown>): ModelQuery<M> {
    return new ModelQuery(this).withSearch(fields, data)
  }

  static withoutGlobalScope<M extends ModelLike>(this: ModelClass<M>, names?: string[]): ModelQuery<M> {
    return new ModelQuery(this).withoutGlobalScope(names)
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

  /** 查询不到时返回空模型（`isEmpty()` 为 true） */
  static findOrEmpty<M extends ModelLike>(this: ModelClass<M>, id: unknown): Promise<M> {
    return new ModelQuery(this).findOrEmpty(id)
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

  /** 在模型所用连接的事务中执行 */
  static transaction<R>(this: ModelSettings, callback: (tx: AnyDatabase) => Promise<R>, config?: TransactionConfig): Promise<R> {
    return transaction(callback, this.connection, config)
  }

  /** 创建并保存（会触发事件与时间戳）；allowField 限制可写入的字段 */
  static async create<M extends ModelLike>(this: ModelClass<M>, data: Partial<Insert<TableOf<M> & Table>>, allowField?: Array<ColumnKey<TableOf<M> & Table>>): Promise<M> {
    const model = new this()
    const record = model as unknown as Model
    if (allowField)
      record.allowField(allowField)
    record.fill(data as Record<string, unknown>)
    await record.save()
    return model
  }

  /**
   * 逐条更新（触发事件与时间戳），返回更新的数量：
   * `User.update({ status: 0 }, { role: 'guest' })`，或按数据中的主键 `User.update({ id: 1, name: 'Ada' })`
   */
  static async update<M extends ModelLike>(this: ModelClass<M>, data: Partial<Insert<TableOf<M> & Table>>, where?: WhereCondition<TableOf<M> & Table>): Promise<number> {
    const key = defaultKey(this as unknown as RecordClass)
    const { [key]: id, ...values } = data as Record<string, unknown>
    const query = new ModelQuery(this)
    if (where)
      query.where(where)
    else if (id !== undefined)
      query.where(key as never, id as never)
    else
      throw new DatabaseError(`${this.name}.update() needs a condition or a primary key in the data`)
    const models = await query.select()
    for (const model of models)
      await (model as unknown as Model).save(values as never)
    return models.length
  }

  /** 批量保存（在事务中）：带主键且存在的更新，其余新增 */
  static async saveAll<M extends ModelLike>(this: ModelClass<M>, list: Array<Partial<Insert<TableOf<M> & Table>>>): Promise<M[]> {
    const key = defaultKey(this as unknown as RecordClass)
    return atomically(async () => {
      const saved: M[] = []
      for (const data of list) {
        const id = (data as Record<string, unknown>)[key]
        const existing = id === undefined || id === null
          ? undefined
          : await new ModelQuery(this).find(id)
        const model = existing ?? new this()
        await (model as unknown as Model).save(data as never)
        saved.push(model)
      }
      return saved
    }, this.connection)
  }

  /**
   * 逐个删除（触发事件与软删除），返回删除数量：
   * `destroy(1)`、`destroy([1, 2])`、`destroy({ status: 0 })`、`destroy(q => q.where('age', '<', 18))`
   */
  static destroy<M extends ModelLike>(this: ModelClass<M>, condition: ((query: ModelQuery<M>) => unknown) | WhereObject<TableOf<M> & Table>): Promise<number>
  static destroy<M extends ModelLike>(this: ModelClass<M>, ids: unknown): Promise<number>
  static async destroy<M extends ModelLike>(this: ModelClass<M>, ids: unknown): Promise<number> {
    const query = new ModelQuery(this)
    if (typeof ids === 'function')
      ids(query)
    else if (isPlainObject(ids))
      query.where(ids as WhereObject<TableOf<M> & Table>)
    else
      query.whereIn(defaultKey(this as unknown as RecordClass) as never, ([] as unknown[]).concat(ids) as never)
    const models = await query.select()
    for (const model of models)
      await (model as unknown as Model).delete()
    return models.length
  }

  // ---------------------------------------------------------------- 持久化

  /** 限制 fill() / save(data) 可写入的字段 */
  allowField(fields: ReadonlyArray<keyof Row<T> & string>): this {
    this.$allowField = [...fields]
    return this
  }

  /** 强制更新：即使没有修改也执行 update（会刷新 updatedAt） */
  force(value = true): this {
    this.$force = value
    return this
  }

  /** 保存时原子自增：`await post.inc('views').save()` */
  inc(field: keyof Row<T> & string, step = 1): this {
    this.$increments[field] = (this.$increments[field] ?? 0) + step
    return this
  }

  dec(field: keyof Row<T> & string, step = 1): this {
    return this.inc(field, -step)
  }

  /**
   * 新模型插入，已存在模型更新修改过的字段；可传入要写入的数据。
   * before 事件返回 false 时不写入。
   */
  async save(data?: Partial<Insert<T>>): Promise<this> {
    if (data)
      this.fill(data as Record<string, unknown>)
    const meta = this.#meta()
    if (!await this.runHook('onBeforeWrite'))
      return this

    if (!this.$exists) {
      // 多租户：新建时填充当前租户 ID
      const tenant = meta.tenantColumn && currentTenancy()
      if (tenant && this.$attributes[meta.tenantColumn!] == null)
        this.$attributes[meta.tenantColumn!] = tenant.id
      if (!await this.runHook('onBeforeInsert'))
        return this
      for (const key of [meta.createdAt, meta.updatedAt]) {
        if (key && this.$attributes[key] == null)
          this.$attributes[key] = nowFor(meta.columns[key])
      }
      if (meta.lockVersion && this.$attributes[meta.lockVersion] == null)
        this.$attributes[meta.lockVersion] = 0
      for (const [key, step] of Object.entries(this.$increments))
        this.$attributes[key] = Number(this.$attributes[key] ?? 0) + step
      this.$increments = {}
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
      const readonly = (this.constructor as typeof Model).readonly
      const dirty = pickColumns(this.getDirty(), meta.columns)
      for (const key of readonly)
        delete dirty[key]
      const increments = Object.entries(this.$increments)
      if (Object.keys(dirty).length || increments.length || this.$force) {
        if (!await this.runHook('onBeforeUpdate'))
          return this
        if (meta.updatedAt && !(meta.updatedAt in dirty))
          dirty[meta.updatedAt] = this.$attributes[meta.updatedAt] = nowFor(meta.columns[meta.updatedAt])
        const values: Record<string, unknown> = { ...dirty }
        for (const [key, step] of increments)
          values[key] = sql`${meta.columns[key]} + ${step}`
        let query = this.#whereKey()
        const lock = meta.lockVersion
        if (lock) {
          const version = Number(this.$original[lock] ?? 0)
          query = query.where(lock as never, this.$original[lock] as never)
          values[lock] = this.$attributes[lock] = version + 1
        }
        if (Object.keys(values).length && await query.update(values) === 0 && lock)
          throw new OptimisticLockException(this.constructor.name)
        for (const [key, step] of increments)
          this.$attributes[key] = Number(this.$original[key] ?? 0) + step
        this.$increments = {}
        this.$force = false
        // 只读字段的修改不会写入，恢复原值
        for (const key of readonly) {
          if (key in this.$original)
            this.$attributes[key] = this.$original[key]
        }
        this.syncOriginal()
        await this.runHook('onAfterUpdate')
      }
    }

    await this.runHook('onAfterWrite')
    return this
  }

  /** 删除：启用软删除时只标记删除时间；before 事件返回 false 时取消 */
  async delete(): Promise<boolean> {
    if (!this.$exists)
      return false
    const meta = this.#meta()
    if (!await this.runHook('onBeforeDelete'))
      return false
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
    if (!await this.runHook('onBeforeDelete'))
      return false
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
    if (!await this.runHook('onBeforeRestore'))
      return this
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

  // ---------------------------------------------------------------- SQL 专有关联

  /**
   * 多对多：`this.belongsToMany(Role, userRoles, 'roleId', 'userId')`
   *
   * userRoles 为中间表（drizzle 表），roleId / userId 为中间表中指向关联模型 / 当前模型的列
   */
  protected belongsToMany<R, P extends Table>(related: new () => R, pivot: P, foreignKey: ColumnKey<P>, localKey: ColumnKey<P>): BelongsToMany<R & ActiveRecord> {
    return new BelongsToMany(this, related as unknown as RecordClass<R & ActiveRecord>, pivot, foreignKey, localKey, defaultKey(this.constructor as RecordClass), defaultKey(related as unknown as RecordClass))
  }

  /**
   * 远程一对多：`this.hasManyThrough(Post, User, 'countryId', 'userId')`
   *
   * User 为中间模型，countryId 为中间模型上指向当前模型的列，userId 为关联模型上指向中间模型的列
   */
  protected hasManyThrough<R, Th>(related: new () => R, through: new () => Th, firstKey: FieldOf<Th>, secondKey: FieldOf<R>, localKey?: keyof Row<T> & string, throughKey?: FieldOf<Th>): HasManyThrough<R & ActiveRecord> {
    return new HasManyThrough(this, related as unknown as RecordClass<R & ActiveRecord>, through as unknown as RecordClass, firstKey, secondKey, localKey ?? defaultKey(this.constructor as RecordClass), throughKey ?? defaultKey(through as unknown as RecordClass))
  }

  /** 远程一对一 */
  protected hasOneThrough<R, Th>(related: new () => R, through: new () => Th, firstKey: FieldOf<Th>, secondKey: FieldOf<R>, localKey?: keyof Row<T> & string, throughKey?: FieldOf<Th>): HasOneThrough<R & ActiveRecord> {
    return new HasOneThrough(this, related as unknown as RecordClass<R & ActiveRecord>, through as unknown as RecordClass, firstKey, secondKey, localKey ?? defaultKey(this.constructor as RecordClass), throughKey ?? defaultKey(through as unknown as RecordClass))
  }

  // ---------------------------------------------------------------- 内部

  protected override acceptsAttribute(key: string): boolean {
    return key in this.#meta().columns && (!this.$allowField || this.$allowField.includes(key))
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
