import type { Document, ObjectId, WithId } from 'mongodb'
import type { TimestampOptions } from '../model/meta'
import type { RelationName } from '../model/record'
import type { Operator, Paginated } from '../types'
import type { MongoWhere } from './query'
import { DatabaseError } from '../errors'
import { ActiveRecord } from '../model/record'
import { MongoModelQuery, MongoQuery } from './query'

/** Mongo 模型类上的静态配置 */
export interface MongoModelSettings {
  readonly name: string
  collection: string
  connection?: string
  softDelete: boolean | string
  timestamps: boolean | TimestampOptions
}

/** 泛型约束只检查品牌属性（原因同 SQL 的 ModelLike） */
export interface MongoModelLike { readonly '~collection': any }

export type MongoModelClass<M extends MongoModelLike = MongoModel<any>> = (new () => M) & MongoModelSettings

/** 文档类型 */
export type DocOf<M> = M extends { readonly '~collection': infer D } ? D : never

type MongoField<T> = (keyof T & string) | '_id'

type MongoWhereArgs<T>
  = | [condition: MongoWhere<T>]
    | [field: MongoField<T>, value: unknown]
    | [field: MongoField<T>, operator: Operator, value: unknown]

/** MongoModel.define<Doc>(collection) 返回的基类：实例拥有文档的全部字段 */
export type DefinedMongoModel<T extends Document> = Omit<typeof MongoModel, 'prototype'> & (new () => MongoModel<T> & WithId<T>)

export interface MongoModelMeta {
  softDelete: string | undefined
  createdAt: string | undefined
  updatedAt: string | undefined
}

/** 解析软删除与时间戳字段（文档无固定结构，按配置决定） */
export function metaOfMongo(model: MongoModelSettings): MongoModelMeta {
  const timestamps: TimestampOptions = model.timestamps === false
    ? { createdAt: false, updatedAt: false }
    : model.timestamps === true
      ? {}
      : model.timestamps
  return {
    softDelete: model.softDelete
      ? (typeof model.softDelete === 'string'
          ? model.softDelete
          : 'deletedAt')
      : undefined,
    createdAt: timestamps.createdAt === false
      ? undefined
      : (timestamps.createdAt ?? 'createdAt'),
    updatedAt: timestamps.updatedAt === false
      ? undefined
      : (timestamps.updatedAt ?? 'updatedAt'),
  }
}

/**
 * MongoDB 模型，API 与 SQL 的 Model 一致：
 *
 * ```ts
 * interface UserDoc { name: string, email: string, status: number }
 *
 * export class User extends MongoModel.define<UserDoc>('users') {
 *   static override softDelete = true
 *   posts() {
 *     return this.hasMany(Post, 'userId')
 *   }
 * }
 *
 * const user = await User.findOrFail('6650…')   // 字符串 _id 自动转为 ObjectId
 * await User.where('status', 1).with('posts').paginate(1, 20)
 * ```
 */
export class MongoModel<T extends Document = Document> extends ActiveRecord<WithId<T>> {
  /** 仅用于类型推导 */
  declare readonly '~collection': T
  declare static collection: string
  static connection: string | undefined = undefined
  /** 软删除：true 使用 deletedAt 字段，或指定字段名 */
  static softDelete: boolean | string = false
  /** 自动维护 createdAt / updatedAt，可指定字段名或设为 false */
  static timestamps: boolean | TimestampOptions = true

  constructor() {
    super()
    // 文档没有固定结构：未声明的属性读写转为 getAttr / setAttr
    return new Proxy(this, {
      get(target, property, receiver) {
        if (typeof property === 'symbol' || property in target)
          return Reflect.get(target, property, receiver)
        return target.getAttr(property)
      },
      set(target, property, value, receiver) {
        if (typeof property === 'symbol' || property in target)
          return Reflect.set(target, property, value, receiver)
        target.setAttr(property, value)
        return true
      },
    })
  }

  /** 声明模型对应的集合：`class User extends MongoModel.define<UserDoc>('users') {}` */
  static define<T extends Document>(collection: string): DefinedMongoModel<T> {
    class Defined extends MongoModel<T> {
      static override collection = collection
    }
    return Defined as unknown as DefinedMongoModel<T>
  }

  static override primaryKeyName(): string {
    return '_id'
  }

  // ---------------------------------------------------------------- 静态查询入口

  static query<M extends MongoModelLike>(this: MongoModelClass<M>): MongoModelQuery<M> {
    return new MongoModelQuery(this)
  }

  static where<M extends MongoModelLike>(this: MongoModelClass<M>, ...args: MongoWhereArgs<DocOf<M>>): MongoModelQuery<M> {
    return (new MongoModelQuery(this).where as (...a: unknown[]) => MongoModelQuery<M>)(...args)
  }

  static whereIn<M extends MongoModelLike>(this: MongoModelClass<M>, field: (keyof DocOf<M> & string) | '_id', values: readonly unknown[]): MongoModelQuery<M> {
    return new MongoModelQuery(this).whereIn(field as never, values)
  }

  static order<M extends MongoModelLike>(this: MongoModelClass<M>, field: (keyof DocOf<M> & string) | '_id', direction: 'asc' | 'desc' = 'asc'): MongoModelQuery<M> {
    return new MongoModelQuery(this).order(field as never, direction)
  }

  static with<M extends MongoModelLike>(this: MongoModelClass<M>, ...relations: Array<RelationName<M> | `${RelationName<M>}.${string}`>): MongoModelQuery<M> {
    return new MongoModelQuery(this).with(...relations)
  }

  static scope<M extends MongoModelLike>(this: MongoModelClass<M>, name: string, ...args: unknown[]): MongoModelQuery<M> {
    return new MongoModelQuery(this).scope(name, ...args)
  }

  static withTrashed<M extends MongoModelLike>(this: MongoModelClass<M>): MongoModelQuery<M> {
    return new MongoModelQuery(this).withTrashed()
  }

  static onlyTrashed<M extends MongoModelLike>(this: MongoModelClass<M>): MongoModelQuery<M> {
    return new MongoModelQuery(this).onlyTrashed()
  }

  static find<M extends MongoModelLike>(this: MongoModelClass<M>, id: unknown): Promise<M | undefined> {
    return new MongoModelQuery(this).find(id)
  }

  static findOrFail<M extends MongoModelLike>(this: MongoModelClass<M>, id: unknown): Promise<M> {
    return new MongoModelQuery(this).findOrFail(id)
  }

  static all<M extends MongoModelLike>(this: MongoModelClass<M>): Promise<M[]> {
    return new MongoModelQuery(this).select()
  }

  static paginate<M extends MongoModelLike>(this: MongoModelClass<M>, page?: number, perPage?: number): Promise<Paginated<M>> {
    return new MongoModelQuery(this).paginate(page, perPage)
  }

  static count<M extends MongoModelLike>(this: MongoModelClass<M>): Promise<number> {
    return new MongoModelQuery(this).count()
  }

  static async create<M extends MongoModelLike>(this: MongoModelClass<M>, data: Partial<DocOf<M>>): Promise<M> {
    const model = new this()
    const record = model as unknown as MongoModel
    record.fill(data as Record<string, unknown>)
    await record.save()
    return model
  }

  static async destroy<M extends MongoModelLike>(this: MongoModelClass<M>, ids: unknown | unknown[]): Promise<number> {
    const list = Array.isArray(ids)
      ? ids
      : [ids]
    const models = list.length
      ? await new MongoModelQuery(this).whereIn('_id' as never, list).select()
      : []
    for (const model of models)
      await (model as unknown as MongoModel).delete()
    return models.length
  }

  // ---------------------------------------------------------------- 持久化

  /** 保存；可传入要写入的数据。before 事件返回 false 时不写入 */
  async save(data?: Partial<T>): Promise<this> {
    if (data)
      this.fill(data as Record<string, unknown>)
    const meta = this.$meta()
    if (!await this.runHook('onBeforeWrite'))
      return this

    if (!this.$exists) {
      if (!await this.runHook('onBeforeInsert'))
        return this
      const now = new Date()
      for (const key of [meta.createdAt, meta.updatedAt]) {
        if (key && this.$attributes[key] == null)
          this.$attributes[key] = now
      }
      const id = await this.$query().insertGetId(this.$attributes as never)
      this.$attributes._id = id
      this.$exists = true
      this.syncOriginal()
      await this.runHook('onAfterInsert')
    }
    else {
      const { _id: _ignored, ...dirty } = this.getDirty()
      if (Object.keys(dirty).length) {
        if (!await this.runHook('onBeforeUpdate'))
          return this
        if (meta.updatedAt && !(meta.updatedAt in dirty))
          dirty[meta.updatedAt] = this.$attributes[meta.updatedAt] = new Date()
        await this.$whereKey().update(dirty)
        this.syncOriginal()
        await this.runHook('onAfterUpdate')
      }
    }

    await this.runHook('onAfterWrite')
    return this
  }

  async delete(): Promise<boolean> {
    if (!this.$exists)
      return false
    const { softDelete } = this.$meta()
    if (!await this.runHook('onBeforeDelete'))
      return false
    if (softDelete) {
      const now = new Date()
      await this.$whereKey().update({ [softDelete]: now })
      this.$attributes[softDelete] = now
      this.$original[softDelete] = now
    }
    else {
      await this.$whereKey().delete()
      this.$exists = false
    }
    await this.runHook('onAfterDelete')
    return true
  }

  async forceDelete(): Promise<boolean> {
    if (!this.$exists)
      return false
    if (!await this.runHook('onBeforeDelete'))
      return false
    await this.$whereKey().delete()
    this.$exists = false
    await this.runHook('onAfterDelete')
    return true
  }

  async restore(): Promise<this> {
    const { softDelete } = this.$meta()
    if (!softDelete)
      return this
    if (!await this.runHook('onBeforeRestore'))
      return this
    await this.$whereKey().update({ [softDelete]: null })
    this.$attributes[softDelete] = null
    this.$original[softDelete] = null
    await this.runHook('onAfterRestore')
    return this
  }

  trashed(): boolean {
    const { softDelete } = this.$meta()
    return softDelete
      ? this.$attributes[softDelete] != null
      : false
  }

  async refresh(): Promise<this> {
    const doc = await this.$whereKey().find()
    if (!doc)
      throw new DatabaseError(`${this.constructor.name} ${String(this.getKey())} no longer exists`)
    this.$attributes = { ...doc }
    this.syncOriginal()
    return this
  }

  /** 文档主键（ObjectId） */
  get id(): ObjectId | undefined {
    return this.$attributes._id as ObjectId | undefined
  }

  // ---------------------------------------------------------------- 内部（不使用 #私有成员：实例是 Proxy）

  protected $meta(): MongoModelMeta {
    return metaOfMongo(this.constructor as unknown as MongoModelSettings)
  }

  protected $query(): MongoQuery<Document> {
    const model = this.constructor as unknown as MongoModelSettings
    return new MongoQuery(model.collection, { connection: model.connection })
  }

  protected $whereKey(): MongoQuery<Document> {
    return this.$query().where('_id', this.$attributes._id)
  }
}

/** 由文档构造模型（供 MongoModelQuery 使用） */
export function hydrateMongoModel<M extends MongoModelLike>(model: MongoModelClass<M>, doc: Document): M {
  return (MongoModel.hydrate as (this: MongoModelClass<M>, row: Record<string, unknown>) => M).call(model, doc)
}
