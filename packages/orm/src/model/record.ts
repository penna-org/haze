import type { BelongsTo, HasMany, HasOne, MorphMany, MorphOne, MorphTo, Relation } from './relations'
import { pascalCase } from '../utils'
import { BelongsTo as BelongsToRelation, defaultKey, HasMany as HasManyRelation, HasOne as HasOneRelation, loadRelations, morphKeys, MorphMany as MorphManyRelation, MorphOne as MorphOneRelation, MorphTo as MorphToRelation } from './relations'

/** 记录的字段名（SQL 模型为表的列，Mongo 模型为文档字段） */
export type FieldOf<R> = R extends { readonly '~row': infer Row } ? keyof Row & string : string

/** 记录上返回关联的方法名 */
type OwnKey<M> = Exclude<keyof M, keyof ActiveRecord | `~${string}`>

export type RelationName<M> = {
  [K in OwnKey<M>]: M[K] extends () => Relation<any, any> ? K : never
}[OwnKey<M>] & string

export type RelationResult<F> = F extends () => Relation<any, infer Result> ? Result : never

/** 预加载项：关联名（可用点号嵌套），或 `{ 关联名: query => 约束 }` */
export type EagerLoad<M> = RelationName<M> | `${RelationName<M>}.${string}` | { [K in RelationName<M> | `${RelationName<M>}.${string}`]?: (query: any) => unknown }

/** 关联所需的类信息（构造器 + 查询入口） */
export type RecordClass<R extends ActiveRecord = ActiveRecord> = (new () => R) & { readonly name: string }

export type Hook = 'onBeforeWrite' | 'onAfterWrite' | 'onBeforeInsert' | 'onAfterInsert' | 'onBeforeUpdate' | 'onAfterUpdate'
  | 'onBeforeDelete' | 'onAfterDelete' | 'onBeforeRestore' | 'onAfterRestore'

type AttrTransform = (value: any, data: Record<string, any>) => unknown

/** 模型事件观察者：before 事件返回 false 时取消操作 */
export type ModelObserver<R = ActiveRecord> = (record: R, event: Hook) => unknown

const observers = new WeakMap<object, Set<ModelObserver<any>>>()

/**
 * 在模型类（含子类）上注册事件观察者，供扩展包使用（如全文搜索的索引同步）；返回取消注册的函数。
 * 观察者在模型自身的 onXxx 事件方法之后执行。
 */
export function observeModel<R extends ActiveRecord>(model: abstract new () => R, observer: ModelObserver<R>): () => void {
  let set = observers.get(model)
  if (!set)
    observers.set(model, set = new Set())
  set.add(observer)
  return () => void set.delete(observer)
}

/** 序列化选项：`posts.title` 这类带点号的字段作用于关联 */
interface SerializeOptions {
  hidden?: readonly string[]
  visible?: readonly string[]
}

/**
 * SQL 模型（Model）与 MongoDB 模型（MongoModel）共用的基类：
 * 属性与脏检查、访问器 / 修改器、关联、序列化与事件。
 *
 * 内部状态使用 `$` 前缀的受保护字段，避免与真实字段名冲突。
 */
export abstract class ActiveRecord<TRow extends object = any> {
  /** 仅用于类型推导 */
  declare readonly '~row': TRow
  /** 序列化时隐藏的字段（`posts.title` 隐藏关联的字段） */
  static hidden: readonly string[] = []
  /** 序列化时只输出的字段（为空表示全部） */
  static visible: readonly string[] = []
  /** 序列化时追加的虚拟字段（需定义 getXxxAttr） */
  static append: readonly string[] = []

  protected $attributes: Record<string, unknown> = {}
  protected $original: Record<string, unknown> = {}
  protected $relations: Record<string, unknown> = {}
  protected $exists = false
  /** 实例级的序列化设置（hidden() / visible() / append()） */
  protected $hidden: string[] | undefined
  protected $visible: string[] | undefined
  protected $append: string[] | undefined
  /** withAttr() 定义的动态访问器 */
  protected $withAttr: Record<string, AttrTransform> = {}
  /** 关联绑定到当前记录的字段：关联名 → { 输出字段: 关联字段 } */
  protected $bindings: Record<string, Record<string, string>> = {}

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

  /** 是否为空记录（findOrEmpty() 未找到时） */
  isEmpty(): boolean {
    return !this.$exists && Object.keys(this.$attributes).length === 0
  }

  /** 主键值 */
  getKey(): unknown {
    const key = (this.constructor as typeof ActiveRecord).primaryKeyName()
    return key ? this.$attributes[key] : undefined
  }

  /** 读取属性（经过 withAttr() / getXxxAttr 访问器） */
  getAttr(key: string): unknown {
    const value = this.$attributes[key]
    const dynamic = this.$withAttr[key]
    if (dynamic)
      return dynamic.call(this, value, this.$attributes)
    const accessor = (this as unknown as Record<string, unknown>)[`get${pascalCase(key)}Attr`]
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

  /** 全部原始属性 */
  getData(): Record<string, unknown> {
    return { ...this.$attributes }
  }

  /** 写入属性但不视为修改（关联统计等查询附带的数据） */
  syncAttr(key: string, value: unknown): this {
    this.$attributes[key] = value
    this.$original[key] = value
    return this
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

  /** 动态访问器：`user.withAttr('name', value => value.toUpperCase())` */
  withAttr(name: string, transform: AttrTransform): this
  withAttr(transforms: Record<string, AttrTransform>): this
  withAttr(name: string | Record<string, AttrTransform>, transform?: AttrTransform): this {
    Object.assign(this.$withAttr, typeof name === 'string'
      ? { [name]: transform! }
      : name)
    return this
  }

  // ---------------------------------------------------------------- 关联

  /** 加载关联（可嵌套、可带约束）：`await user.load('posts.comments', { profile: q => q.field('id', 'bio') })` */
  async load(...relations: Array<EagerLoad<this>>): Promise<this> {
    await loadRelations([this], relations as never)
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

  /** 关联是否已加载 */
  hasRelation(name: string): boolean {
    return name in this.$relations
  }

  /** 把一对一关联的字段绑定到当前记录输出（关联的 bind() 设置） */
  bindRelation(name: string, fields: Record<string, string>): this {
    this.$bindings[name] = fields
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

  /**
   * 多态一对多：`this.morphMany(Comment, 'commentable')` 使用 Comment 的 commentableType / commentableId 字段，
   * 也可传入 `['type', 'targetId']`；type 默认为当前模型类名
   */
  protected morphMany<R>(related: new () => R, morph: string | [FieldOf<R>, FieldOf<R>], type?: string): MorphMany<R & ActiveRecord> {
    const [typeField, idField] = morphKeys(morph)
    return new MorphManyRelation(this, related as unknown as RecordClass<R & ActiveRecord>, typeField, idField, type ?? this.constructor.name, defaultKey(this.constructor as RecordClass))
  }

  /** 多态一对一 */
  protected morphOne<R>(related: new () => R, morph: string | [FieldOf<R>, FieldOf<R>], type?: string): MorphOne<R & ActiveRecord> {
    const [typeField, idField] = morphKeys(morph)
    return new MorphOneRelation(this, related as unknown as RecordClass<R & ActiveRecord>, typeField, idField, type ?? this.constructor.name, defaultKey(this.constructor as RecordClass))
  }

  /**
   * 多态所属：`this.morphTo('commentable', { User, Post })`，
   * 键为 type 字段中保存的值，值为对应的模型类
   */
  protected morphTo<M extends Record<string, new () => any>>(morph: string | [keyof TRow & string, keyof TRow & string], models: M): MorphTo<InstanceType<M[keyof M]> & ActiveRecord> {
    const [typeField, idField] = morphKeys(morph)
    return new MorphToRelation(this, models as unknown as Record<string, RecordClass>, typeField, idField) as unknown as MorphTo<InstanceType<M[keyof M]> & ActiveRecord>
  }

  // ---------------------------------------------------------------- 序列化

  /** 序列化时隐藏的字段（merge 为 true 时与模型上的 hidden 合并） */
  hidden(fields: readonly string[], merge = false): this {
    this.$hidden = merge
      ? [
          ...(this.$hidden ?? (this.constructor as typeof ActiveRecord).hidden),
          ...fields,
        ]
      : [...fields]
    return this
  }

  /** 序列化时只输出的字段 */
  visible(fields: readonly string[], merge = false): this {
    this.$visible = merge
      ? [
          ...(this.$visible ?? (this.constructor as typeof ActiveRecord).visible),
          ...fields,
        ]
      : [...fields]
    return this
  }

  /** 序列化时追加的虚拟字段 */
  append(fields: readonly string[], merge = false): this {
    this.$append = merge
      ? [
          ...(this.$append ?? (this.constructor as typeof ActiveRecord).append),
          ...fields,
        ]
      : [...fields]
    return this
  }

  /** 序列化：应用访问器、隐藏 / 只输出字段、追加字段与已加载的关联 */
  toJSON(): Record<string, unknown> {
    return this.serialize({})
  }

  /** toJSON() 的别名（ThinkPHP 写法） */
  toArray(): Record<string, unknown> {
    return this.toJSON()
  }

  protected serialize(options: SerializeOptions): Record<string, unknown> {
    const record = this.constructor as typeof ActiveRecord
    const [hidden, nestedHidden] = splitNested(options.hidden ?? this.$hidden ?? record.hidden)
    const visibleList = options.visible ?? this.$visible ?? record.visible
    const [visible, nestedVisible] = splitNested(visibleList)
    const shown = (key: string): boolean => !hidden.has(key) && (!visibleList.length || visible.has(key) || nestedVisible.has(key))

    const result: Record<string, unknown> = {}
    for (const key of Object.keys(this.$attributes)) {
      if (shown(key))
        result[key] = this.getAttr(key)
    }
    for (const key of this.$append ?? record.append) {
      if (shown(key))
        result[key] = this.getAttr(key)
    }
    for (const [key, value] of Object.entries(this.$relations)) {
      const bindings = this.$bindings[key]
      if (bindings) {
        for (const [target, field] of Object.entries(bindings)) {
          if (shown(target)) {
            result[target] = value instanceof ActiveRecord
              ? value.getAttr(field)
              : (value as Record<string, unknown> | null)?.[field] ?? null
          }
        }
        continue
      }
      if (!shown(key))
        continue
      const child: SerializeOptions = {
        hidden: nestedHidden.get(key),
        visible: nestedVisible.get(key),
      }
      result[key] = Array.isArray(value)
        ? value.map(item => serializeValue(item, child))
        : serializeValue(value, child)
    }
    return result
  }

  // ---------------------------------------------------------------- 供子类使用

  /** 是否接受批量赋值的字段 */
  protected acceptsAttribute(_key: string): boolean {
    return true
  }

  /** 执行事件方法与 observeModel() 注册的观察者；before 事件返回 false 时取消操作（返回 false） */
  protected async runHook(name: Hook): Promise<boolean> {
    const hook = (this as unknown as Record<string, unknown>)[name]
    if (typeof hook === 'function' && (await hook.call(this)) === false)
      return false
    // 观察者注册在模型类上，对子类同样生效
    for (let target: unknown = this.constructor; target; target = Object.getPrototypeOf(target)) {
      for (const observer of observers.get(target as object) ?? []) {
        if ((await observer(this, name)) === false)
          return false
      }
    }
    return true
  }

  /** 写入成功后同步原始值 */
  protected syncOriginal(): void {
    this.$original = { ...this.$attributes }
  }
}

/** `['email', 'posts.title']` → 本层字段集合 + 关联名 → 子字段 */
function splitNested(fields: readonly string[]): [Set<string>, Map<string, string[]>] {
  const own = new Set<string>()
  const nested = new Map<string, string[]>()
  for (const field of fields) {
    const dot = field.indexOf('.')
    if (dot === -1) {
      own.add(field)
    }
    else {
      const head = field.slice(0, dot)
      nested.set(head, [
        ...(nested.get(head) ?? []),
        field.slice(dot + 1),
      ])
    }
  }
  return [own, nested]
}

function serializeValue(value: unknown, options: SerializeOptions): unknown {
  if (!(value instanceof ActiveRecord))
    return value
  return options.hidden || options.visible
    ? (value as unknown as { serialize: (options: SerializeOptions) => unknown }).serialize(options)
    : value.toJSON()
}

function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date && b instanceof Date)
    return a.getTime() === b.getTime()
  // ObjectId 等值对象
  if (a && b && typeof a === 'object' && typeof (a as { equals?: unknown }).equals === 'function')
    return (a as { equals: (other: unknown) => boolean }).equals(b)
  return Object.is(a, b)
}
