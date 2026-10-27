import type { ClientSession, Document, Filter, Sort, WithId } from 'mongodb'
import type { ActiveRecord, RelationName } from '../model/record'
import type { Direction, Operator, Paginated } from '../types'
import type { MongoSession } from './context'
import type { DocOf, MongoModelClass, MongoModelLike } from './model'
import { ObjectId } from 'mongodb'
import { DatabaseError, ModelNotFoundException, translateDatabaseError } from '../errors'
import { loadRelations } from '../model/relations'
import { isPlainObject, pascalCase } from '../utils'
import { resolveMongo } from './context'
import { hydrateMongoModel, metaOfMongo } from './model'

type Field<T> = (keyof T & string) | '_id'

export type MongoWhere<T> = { [K in Field<T>]?: unknown } | ((group: MongoQuery<T>) => unknown)

interface Part {
  bool: 'and' | 'or'
  filter: Document
}

export interface MongoQueryOptions {
  connection?: string
}

/** 把字符串形式的 _id 转为 ObjectId（其它字段原样保留） */
export function toObjectId(value: unknown): unknown {
  return typeof value === 'string' && ObjectId.isValid(value) && value.length === 24
    ? new ObjectId(value)
    : value
}

/** SQL LIKE 模式 → 正则：% 任意长度，_ 单个字符 */
function likeToRegex(pattern: string): RegExp {
  const source = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/%/g, '.*').replace(/_/g, '.')
  return new RegExp(`^${source}$`)
}

/**
 * MongoDB 查询构造器，方法与 SQL 的 Db.table() 一致：
 *
 * ```ts
 * await Mongo.collection<UserDoc>('users').where('status', 1).order('createdAt', 'desc').paginate(1, 20)
 * ```
 *
 * Mongo 特有能力：`aggregate(pipeline)`、`where({ tags: { $all: ['a'] } })` 直接使用查询运算符。
 */
export class MongoQuery<T = Document, R = WithId<T>> {
  readonly collectionName: string
  protected connectionName: string | undefined
  protected parts: Part[] = []
  protected sorts: Array<[string, 1 | -1]> = []
  protected limitValue: number | undefined
  protected offsetValue: number | undefined
  protected fields: string[] | undefined

  constructor(collection: string, options: MongoQueryOptions = {}) {
    this.collectionName = collection
    this.connectionName = options.connection
  }

  connection(name: string): this {
    this.connectionName = name
    return this
  }

  // ---------------------------------------------------------------- 条件

  where(condition: MongoWhere<T>): this
  where(field: Field<T>, value: unknown): this
  where(field: Field<T>, operator: Operator, value: unknown): this
  where(...args: unknown[]): this {
    return this.addCondition('and', args)
  }

  orWhere(condition: MongoWhere<T>): this
  orWhere(field: Field<T>, value: unknown): this
  orWhere(field: Field<T>, operator: Operator, value: unknown): this
  orWhere(...args: unknown[]): this {
    return this.addCondition('or', args)
  }

  whereIn(field: Field<T>, values: readonly unknown[]): this {
    return this.pushCondition('and', {
      [field]: {
        $in: this.normalizeList(field, values),
      },
    })
  }

  whereNotIn(field: Field<T>, values: readonly unknown[]): this {
    return this.pushCondition('and', {
      [field]: {
        $nin: this.normalizeList(field, values),
      },
    })
  }

  /** 字段为 null 或不存在 */
  whereNull(field: Field<T>): this {
    return this.pushCondition('and', { [field]: null })
  }

  whereNotNull(field: Field<T>): this {
    return this.pushCondition('and', {
      [field]: { $ne: null },
    })
  }

  whereBetween(field: Field<T>, range: [unknown, unknown]): this {
    return this.pushCondition('and', {
      [field]: { $gte: range[0], $lte: range[1] },
    })
  }

  whereNotBetween(field: Field<T>, range: [unknown, unknown]): this {
    return this.pushCondition('and', {
      $or: [
        {
          [field]: { $lt: range[0] },
        },
        {
          [field]: { $gt: range[1] },
        },
      ],
    })
  }

  /** SQL 风格的 LIKE 模式（% 与 _），区分大小写 */
  whereLike(field: Field<T>, pattern: string): this {
    return this.pushCondition('and', {
      [field]: {
        $regex: likeToRegex(pattern),
      },
    })
  }

  whereNotLike(field: Field<T>, pattern: string): this {
    return this.pushCondition('and', {
      [field]: {
        $not: likeToRegex(pattern),
      },
    })
  }

  when<V>(value: V, callback: (query: this, value: NonNullable<V>) => unknown): this {
    if (value !== undefined && value !== null && value !== false && value !== '')
      callback(this, value as NonNullable<V>)
    return this
  }

  /** 当前条件组成的过滤器 */
  buildFilter(): Document {
    let result: Document | undefined
    for (const part of this.parts) {
      result = result === undefined
        ? part.filter
        : {
            [part.bool === 'and'
              ? '$and'
              : '$or']: [result, part.filter],
          }
    }
    return result ?? {}
  }

  get hasConditions(): boolean {
    return this.parts.length > 0
  }

  // ---------------------------------------------------------------- 排序与分页

  order(field: Field<T>, direction?: Direction): this
  order(fields: Partial<Record<Field<T>, Direction>>): this
  order(field: string | Record<string, Direction | undefined>, direction: Direction = 'asc'): this {
    if (typeof field === 'string') {
      this.sorts.push([
        field,
        direction === 'desc'
          ? -1
          : 1,
      ])
    }
    else {
      for (const [key, dir] of Object.entries(field)) this.order(key as Field<T>, dir ?? 'asc')
    }
    return this
  }

  limit(value: number): this {
    this.limitValue = value
    return this
  }

  offset(value: number): this {
    this.offsetValue = value
    return this
  }

  page(page: number, perPage = 15): this {
    return this.limit(perPage).offset((Math.max(1, page) - 1) * perPage)
  }

  field(...fields: Array<Field<T>>): this {
    this.fields = fields
    return this
  }

  // ---------------------------------------------------------------- 读取

  async select(): Promise<R[]> {
    const mongo = await this.session()
    const cursor = mongo.db.collection(this.collectionName).find(this.scopedFilter(), {
      session: mongo.session,
      projection: this.fields
        ? Object.fromEntries(this.fields.map(field => [field, 1]))
        : undefined,
      sort: this.sorts.length ? this.sorts as Sort : undefined,
      skip: this.offsetValue,
      limit: this.limitValue,
    })
    return this.transform(await cursor.toArray())
  }

  async find(): Promise<R | undefined> {
    const [first] = await this.clone().limit(1).select()
    return first
  }

  async findOrFail(): Promise<R> {
    const result = await this.find()
    if (result === undefined)
      throw new ModelNotFoundException(this.label())
    return result
  }

  async value(field: Field<T>): Promise<unknown> {
    const doc = await this.clone().field(field).find() as Document | undefined
    return doc?.[field]
  }

  async column(field: Field<T>): Promise<unknown[]> {
    const docs = await this.clone().field(field).select() as Document[]
    return docs.map(doc => doc[field])
  }

  async count(): Promise<number> {
    const mongo = await this.session()
    return mongo.db.collection(this.collectionName).countDocuments(this.scopedFilter(), { session: mongo.session })
  }

  async sum(field: Field<T>): Promise<number> {
    return Number(await this.group({ $sum: `$${field}` }) ?? 0)
  }

  async avg(field: Field<T>): Promise<number | null> {
    const value = await this.group({ $avg: `$${field}` })
    return value === null || value === undefined
      ? null
      : Number(value)
  }

  async max(field: Field<T>): Promise<unknown> {
    return (await this.group({ $max: `$${field}` })) ?? null
  }

  async min(field: Field<T>): Promise<unknown> {
    return (await this.group({ $min: `$${field}` })) ?? null
  }

  async exists(): Promise<boolean> {
    return (await this.count()) > 0
  }

  async paginate(page = 1, perPage = 15): Promise<Paginated<R>> {
    const current = Math.max(1, Math.floor(page))
    const total = await this.count()
    const data = await this.clone().page(current, perPage).select()
    return {
      data,
      total,
      page: current,
      perPage,
      lastPage: Math.max(1, Math.ceil(total / perPage)),
    }
  }

  async chunk(size: number, callback: (docs: R[], page: number) => unknown): Promise<void> {
    for (let page = 1; ; page++) {
      const docs = await this.clone().page(page, size).select()
      if (!docs.length || (await callback(docs, page)) === false || docs.length < size)
        return
    }
  }

  /** 聚合管道（自动在开头加上当前条件的 $match） */
  async aggregate<O extends Document = Document>(pipeline: Document[]): Promise<O[]> {
    const mongo = await this.session()
    const filter = this.scopedFilter()
    const stages = Object.keys(filter).length
      ? [
          { $match: filter },
          ...pipeline,
        ]
      : pipeline
    return mongo.db.collection(this.collectionName).aggregate<O>(stages, { session: mongo.session }).toArray()
  }

  // ---------------------------------------------------------------- 写入

  /** 插入一条或多条，返回带 _id 的文档 */
  async insert(docs: Partial<T> | Array<Partial<T>>): Promise<Array<WithId<T>>> {
    const list = (Array.isArray(docs)
      ? docs
      : [docs]).map(doc => ({ ...doc })) as Document[]
    if (!list.length)
      return []
    const mongo = await this.session()
    const result = await this.write(() => mongo.db.collection(this.collectionName).insertMany(list, { session: mongo.session }))
    return list.map((doc, index) => ({ ...doc, _id: result.insertedIds[index] })) as Array<WithId<T>>
  }

  async insertGetId(doc: Partial<T>): Promise<ObjectId> {
    const [inserted] = await this.insert(doc)
    return inserted._id as ObjectId
  }

  /** 按条件更新（普通字段使用 $set，也可直接传 $inc / $push 等运算符），返回匹配数量 */
  async update(values: Partial<T> | Document, options: { all?: boolean } = {}): Promise<number> {
    const filter = this.writableFilter('update', options)
    const update = Object.keys(values).some(key => key.startsWith('$'))
      ? values
      : { $set: values }
    const mongo = await this.session()
    const result = await this.write(() => mongo.db.collection(this.collectionName).updateMany(filter, update, { session: mongo.session }))
    return result.matchedCount
  }

  async delete(options: { all?: boolean } = {}): Promise<number> {
    const filter = this.writableFilter('delete', options)
    const mongo = await this.session()
    const result = await this.write(() => mongo.db.collection(this.collectionName).deleteMany(filter, { session: mongo.session }))
    return result.deletedCount
  }

  increment(field: Field<T>, step = 1): Promise<number> {
    return this.update({
      $inc: { [field]: step },
    })
  }

  decrement(field: Field<T>, step = 1): Promise<number> {
    return this.update({
      $inc: { [field]: -step },
    })
  }

  /** 生成的过滤器（调试用） */
  toFilter(): Filter<Document> {
    return this.scopedFilter()
  }

  clone(): this {
    const copy = Object.create(Object.getPrototypeOf(this)) as this
    Object.assign(copy, this)
    copy.parts = [...this.parts]
    copy.sorts = [...this.sorts]
    copy.fields = this.fields && [...this.fields]
    return copy
  }

  // ---------------------------------------------------------------- 供子类使用

  protected scopedFilter(): Document {
    return this.buildFilter()
  }

  protected async transform(docs: Document[]): Promise<R[]> {
    return docs as R[]
  }

  protected label(): string {
    return this.collectionName
  }

  protected session(): Promise<MongoSession> {
    return resolveMongo(this.connectionName)
  }

  protected pushCondition(bool: Part['bool'], filter: Document): this {
    this.parts.push({ bool, filter })
    return this
  }

  protected addCondition(bool: Part['bool'], args: unknown[]): this {
    const filter = this.parseCondition(args)
    return filter
      ? this.pushCondition(bool, filter)
      : this
  }

  protected parseCondition(args: unknown[]): Document | undefined {
    if (args.length === 1) {
      const [condition] = args
      if (typeof condition === 'function') {
        const group = new MongoQuery<T>(this.collectionName)
        condition(group)
        return group.hasConditions
          ? group.buildFilter()
          : undefined
      }
      if (isPlainObject(condition)) {
        const entries = Object.entries(condition).map(([field, value]) => this.compare(field, '=', value))
        return entries.length > 1
          ? { $and: entries }
          : entries[0]
      }
      throw new TypeError('where() expects a field, an object or a callback')
    }
    if (args.length === 2)
      return this.compare(args[0] as string, '=', args[1])
    return this.compare(args[0] as string, args[1] as Operator, args[2])
  }

  protected compare(field: string, operator: Operator, raw: unknown): Document {
    const value = this.normalize(field, raw)
    switch (operator) {
      case '=':
        if (Array.isArray(value)) {
          return {
            [field]: {
              $in: this.normalizeList(field, value),
            },
          }
        }
        // { $gt: 1 } 等运算符对象原样使用
        return { [field]: value }
      case '!=':
      case '<>':
        return {
          [field]: Array.isArray(value)
            ? {
                $nin: this.normalizeList(field, value),
              }
            : { $ne: value },
        }
      case '>': return {
        [field]: { $gt: value },
      }
      case '>=': return {
        [field]: { $gte: value },
      }
      case '<': return {
        [field]: { $lt: value },
      }
      case '<=': return {
        [field]: { $lte: value },
      }
      case 'like': return {
        [field]: {
          $regex: likeToRegex(String(raw)),
        },
      }
      case 'not like': return {
        [field]: {
          $not: likeToRegex(String(raw)),
        },
      }
      case 'in': return {
        [field]: {
          $in: this.normalizeList(field, raw as unknown[]),
        },
      }
      case 'not in': return {
        [field]: {
          $nin: this.normalizeList(field, raw as unknown[]),
        },
      }
      case 'between': return {
        [field]: { $gte: (raw as unknown[])[0], $lte: (raw as unknown[])[1] },
      }
      case 'not between': return {
        $or: [
          {
            [field]: { $lt: (raw as unknown[])[0] },
          },
          {
            [field]: { $gt: (raw as unknown[])[1] },
          },
        ],
      }
      default:
        throw new Error(`Unsupported operator "${String(operator)}"`)
    }
  }

  protected normalize(field: string, value: unknown): unknown {
    return field === '_id'
      ? toObjectId(value)
      : value
  }

  protected normalizeList(field: string, values: readonly unknown[]): unknown[] {
    return values.map(value => this.normalize(field, value))
  }

  protected async write<V>(run: () => Promise<V>): Promise<V> {
    try {
      return await run()
    }
    catch (error) {
      throw translateDatabaseError(error)
    }
  }

  protected writableFilter(action: string, options: { all?: boolean }): Document {
    const filter = this.scopedFilter()
    if (!Object.keys(filter).length && !options.all)
      throw new DatabaseError(`Refusing to ${action} all documents of "${this.collectionName}" without conditions. Pass { all: true } to confirm.`)
    return filter
  }

  protected async group(accumulator: Document): Promise<unknown> {
    const [row] = await this.aggregate<{ value: unknown }>([
      {
        $group: { _id: null, value: accumulator },
      },
    ])
    return row?.value
  }
}

type TrashedMode = 'without' | 'with' | 'only'

/** Mongo 模型查询：结果为模型实例，应用软删除范围，支持预加载与作用域 */
export class MongoModelQuery<M extends MongoModelLike> extends MongoQuery<DocOf<M>, M> {
  readonly model: MongoModelClass<M>
  protected trashed: TrashedMode = 'without'
  protected eager: string[] = []

  constructor(model: MongoModelClass<M>) {
    super(model.collection, { connection: model.connection })
    this.model = model
  }

  withTrashed(): this {
    this.trashed = 'with'
    return this
  }

  onlyTrashed(): this {
    this.trashed = 'only'
    return this
  }

  with(...relations: Array<RelationName<M> | `${RelationName<M>}.${string}`>): this {
    this.eager.push(...relations)
    return this
  }

  scope(name: string, ...args: unknown[]): this {
    const method = (this.model as unknown as Record<string, unknown>)[`scope${pascalCase(name)}`]
    if (typeof method !== 'function')
      throw new TypeError(`Scope "${name}" is not defined on ${this.model.name} (expected static scope${pascalCase(name)}(query))`)
    method.call(this.model, this, ...args)
    return this
  }

  /** 按 _id 查询（字符串自动转为 ObjectId）；不传时取第一条 */
  override async find(id?: unknown): Promise<M | undefined> {
    if (id === undefined)
      return super.find()
    const [first] = await this.clone().where('_id' as never, id).limit(1).select()
    return first
  }

  override async findOrFail(id?: unknown): Promise<M> {
    const model = await this.find(id)
    if (!model)
      throw new ModelNotFoundException(this.model.name, id)
    return model
  }

  /** 批量删除：启用软删除时只标记删除时间 */
  override async delete(options: { all?: boolean } = {}): Promise<number> {
    const { softDelete } = metaOfMongo(this.model)
    if (softDelete && this.trashed !== 'only') {
      return this.update({
        [softDelete]: new Date(),
      }, options)
    }
    return super.delete(options)
  }

  async forceDelete(options: { all?: boolean } = {}): Promise<number> {
    return super.delete(options)
  }

  async restore(options: { all?: boolean } = {}): Promise<number> {
    const { softDelete } = metaOfMongo(this.model)
    if (!softDelete)
      return 0
    return this.withTrashed().update({ [softDelete]: null }, options)
  }

  protected override scopedFilter(): Document {
    const filter = this.buildFilter()
    const { softDelete } = metaOfMongo(this.model)
    if (!softDelete || this.trashed === 'with')
      return filter
    const scope = {
      [softDelete]: this.trashed === 'only'
        ? { $ne: null }
        : null,
    }
    return Object.keys(filter).length
      ? {
          $and: [filter, scope],
        }
      : scope
  }

  protected override async transform(docs: Document[]): Promise<M[]> {
    const models = docs.map(doc => hydrateMongoModel(this.model, doc))
    if (this.eager.length)
      await loadRelations(models as unknown as ActiveRecord[], this.eager)
    return models
  }

  protected override label(): string {
    return this.model.name
  }

  override clone(): this {
    const copy = super.clone()
    copy.eager = [...this.eager]
    return copy
  }
}

export type { ClientSession }
