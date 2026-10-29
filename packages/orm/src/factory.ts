import type { Faker } from '@faker-js/faker'
import type { Table } from 'drizzle-orm'
import type { ModelClass, ModelLike, TableOf } from './model/model'
import type { ActiveRecord, RelationName } from './model/record'
import type { Insert } from './types'
import { atomically, currentDatabaseManager } from './context'
import { DatabaseError } from './errors'
import { BelongsTo, BelongsToMany, HasMany, HasOne, MorphMany, MorphOne, MorphTo, relationOf } from './model/relations'

/**
 * 工厂生成的属性：模型表的插入类型（全部可选，外键等可由 for() / has() 填充）。
 * 先取出具体的表类型再推导：`TableOf<M> & Table` 会让列变成字符串索引签名
 */
export type FactoryAttributes<M> = Partial<TableOf<M> extends infer T extends Table ? Insert<T> : never>

/**
 * 属性值：普通值；`(attributes) => 值` 在其余属性确定后计算（可为异步）；
 * 另一个工厂表示先创建该模型，取其主键（`userId: UserFactory`）
 */
export type FactoryValue<M, V> = V | ((attributes: FactoryAttributes<M>) => V | Promise<V>) | Factory<any, any, any>

/** definition / state 返回的属性，值可以是 FactoryValue */
export type FactoryInput<M> = {
  [K in keyof FactoryAttributes<M>]?: FactoryValue<M, FactoryAttributes<M>[K]>
}

/** 定义与状态回调的上下文 */
export interface FactoryContext {
  /** faker 实例（按 config/database.ts 的 factories.locale 或 .locale()）；未安装 @faker-js/faker 时访问即抛错 */
  readonly faker: Faker
  /** 该工厂生成的第 n 个模型（从 1 开始，跨调用递增） */
  readonly n: number
  /** 本次调用中的下标（count(3) 时为 0、1、2） */
  readonly index: number
  /**
   * 序列值：`sequence(n => \`user${n}@example.com\`)`，或按 n 轮流取值：`sequence('a', 'b')`
   */
  sequence: {
    <V>(next: (n: number) => V): V
    <V>(...values: V[]): V
  }
}

export type FactoryDefinition<M> = (ctx: FactoryContext) => FactoryInput<M>

/** 状态：要覆盖的属性，或 `(当前属性, ctx) => 要覆盖的属性` */
export type FactoryState<M> = FactoryInput<M> | ((attributes: FactoryAttributes<M>, ctx: FactoryContext) => FactoryInput<M>)

/** hasAttached() 的中间表数据：对象，或 `(关联模型, 父模型) => 对象` */
export type PivotAttributes = Record<string, unknown> | ((related: any, parent: any) => Record<string, unknown>)

type Many<M, Counted extends boolean> = Counted extends true ? M[] : M

type AnyFactory = Factory<any, any, any>

interface ParentSpec {
  parent: AnyFactory | ActiveRecord
  relation?: string
}

interface ChildSpec {
  /** 工厂，或 hasAttached() 中已存在的模型 */
  children: AnyFactory | ActiveRecord[]
  relation?: string
  pivot?: PivotAttributes
}

interface FactoryOptions<M> {
  definition: FactoryDefinition<M>
  /** 已命名的状态（state(name, value) 定义） */
  named: ReadonlyMap<string, FactoryState<M>>
  /** 跨克隆共享的序号 */
  counter: { n: number }
  count?: number
  states: ReadonlyArray<FactoryState<M>>
  parents: readonly ParentSpec[]
  children: readonly ChildSpec[]
  afterMake: ReadonlyArray<(model: M) => unknown>
  afterCreate: ReadonlyArray<(model: M) => unknown>
  locale?: string
}

type FakerModule = Record<string, unknown> & { faker: Faker }

let fakerModule: Promise<FakerModule | Error> | undefined

/** 按需加载 @faker-js/faker（可选 peer 依赖）；未安装时返回错误，在访问 ctx.faker 时抛出 */
async function loadFaker(locale: string | undefined): Promise<Faker | Error> {
  fakerModule ??= import('@faker-js/faker').then(
    module => module as unknown as FakerModule,
    (error: unknown) => new DatabaseError('Model factories need @faker-js/faker for ctx.faker. Install it with: pnpm add -D @faker-js/faker', { cause: error }),
  )
  const module = await fakerModule
  if (module instanceof Error || !locale) {
    return module instanceof Error
      ? module
      : module.faker
  }
  // zh_CN / zh-CN / ZH_CN → 导出 fakerZH_CN
  const key = locale.replace(/-/g, '_').toLowerCase()
  const found = Object.entries(module).find(([name]) => name.startsWith('faker') && name.slice('faker'.length).toLowerCase() === key)
  if (!found)
    throw new DatabaseError(`Unknown faker locale "${locale}" (e.g. en, en_US, zh_CN, zh_TW, ja, de)`)
  return found[1] as Faker
}

function contextFor(faker: Faker | Error, n: number, index: number): FactoryContext {
  return {
    get faker(): Faker {
      if (faker instanceof Error)
        throw faker
      return faker
    },
    n,
    index,
    sequence: ((...values: unknown[]) => values.length === 1 && typeof values[0] === 'function'
      ? (values[0] as (n: number) => unknown)(n)
      : values[(n - 1) % values.length]) as FactoryContext['sequence'],
  }
}

function camelCase(name: string): string {
  return name.charAt(0).toLowerCase() + name.slice(1)
}

/** 关联名的候选：User → user；has() 另加复数形式 users / categories / boxes */
function relationCandidates(model: { name: string }, plural: boolean): string[] {
  const base = camelCase(model.name)
  if (!plural)
    return [base]
  return [
    `${base}s`,
    /[^aeiou]y$/.test(base)
      ? `${base.slice(0, -1)}ies`
      : `${base}es`,
    base,
  ]
}

function guessRelation(record: ActiveRecord, related: { name: string }, method: string, plural: boolean): string {
  const name = relationCandidates(related, plural).find(candidate => typeof (record as unknown as Record<string, unknown>)[candidate] === 'function')
  if (!name)
    throw new DatabaseError(`${record.constructor.name} has no relation for ${related.name}; pass the relation name: ${method}(..., '${relationCandidates(related, plural)[0]}')`)
  return name
}

function asList<T>(value: T | T[]): T[] {
  return Array.isArray(value)
    ? value
    : [value]
}

/**
 * 模型工厂（`database/factories/*.ts`）：
 *
 * ```ts
 * export default defineFactory(User, ({ faker, sequence }) => ({
 *   name: faker.person.fullName(),
 *   email: sequence(n => `user${n}@example.com`),
 * })).state('admin', { role: 'admin' })
 *
 * await UserFactory.count(3).create()
 * await UserFactory.state('admin').make({ name: 'Ada' })
 * ```
 *
 * 每个链式方法都返回新的工厂，不修改原工厂。
 */
export class Factory<M extends ModelLike, S extends string = never, Counted extends boolean = false> {
  readonly model: ModelClass<M>
  readonly #options: FactoryOptions<M>

  constructor(model: ModelClass<M>, options: FactoryOptions<M>) {
    this.model = model
    this.#options = options
  }

  // ---------------------------------------------------------------- 配置（返回新工厂）

  /** 生成数量：make() / create() 返回数组 */
  count(count: number): Factory<M, S, true> {
    return this.#with({ count }) as unknown as Factory<M, S, true>
  }

  /** 应用已命名的状态：`state('admin')` */
  state(name: S): Factory<M, S, Counted>
  /** 定义命名状态（通常写在 defineFactory() 之后）：`state('admin', { role: 'admin' })` */
  state<N extends string>(name: N, state: FactoryState<M>): Factory<M, S | N, Counted>
  /** 应用匿名状态：`state({ role: 'admin' })` 或 `state((attrs, ctx) => ({ ... }))` */
  state(state: FactoryState<M>): Factory<M, S, Counted>
  state(name: string | FactoryState<M>, state?: FactoryState<M>): AnyFactory {
    if (typeof name !== 'string') {
      return this.#with({
        states: [...this.#options.states, name],
      })
    }
    if (state !== undefined) {
      return this.#with({
        named: new Map(this.#options.named).set(name, state),
      })
    }
    const named = this.#options.named.get(name)
    if (!named)
      throw new DatabaseError(`Factory for ${this.model.name} has no state "${name}"`)
    return this.#with({
      states: [...this.#options.states, named],
    })
  }

  /** 轮流应用的状态（按本次调用中的下标）：`count(4).sequence({ role: 'a' }, { role: 'b' })` */
  sequence(...states: Array<FactoryInput<M> | ((ctx: FactoryContext) => FactoryInput<M>)>): Factory<M, S, Counted> {
    if (!states.length)
      return this
    return this.state((_attributes, ctx) => {
      const state = states[ctx.index % states.length]
      return typeof state === 'function'
        ? state(ctx)
        : state
    })
  }

  /**
   * 所属关联（belongsTo / morphTo）：传入工厂时先创建父模型（本次调用中只创建一个），
   * 传入模型时直接使用；关联名默认为父模型类名的小驼峰（User → user）
   */
  for(parent: AnyFactory | ActiveRecord, relation?: RelationName<M>): Factory<M, S, Counted> {
    return this.#with({
      parents: [
        ...this.#options.parents,
        { parent, relation },
      ],
    })
  }

  /**
   * 子关联（hasMany / hasOne / morphMany / morphOne，也可用于 belongsToMany）：create() 后为每个模型创建子模型。
   * 关联名默认为子模型类名的复数（Post → posts）
   */
  has(children: AnyFactory, relation?: RelationName<M>): Factory<M, S, Counted> {
    return this.#with({
      children: [
        ...this.#options.children,
        { children, relation },
      ],
    })
  }

  /** 多对多（belongsToMany）：创建关联模型（或使用已有模型）并写入中间表数据 */
  hasAttached(children: AnyFactory | ActiveRecord | ActiveRecord[], relation?: RelationName<M> | PivotAttributes, pivot?: PivotAttributes): Factory<M, S, Counted> {
    if (relation !== undefined && typeof relation !== 'string') {
      pivot = relation
      relation = undefined
    }
    return this.#with({
      children: [
        ...this.#options.children,
        {
          children: children instanceof Factory
            ? children
            : asList(children as ActiveRecord | ActiveRecord[]),
          relation,
          pivot: pivot ?? {},
        },
      ],
    })
  }

  /** make() 之后（create() 时也会先调用，在保存之前） */
  afterMake(callback: (model: M) => unknown): Factory<M, S, Counted> {
    return this.#with({
      afterMake: [...this.#options.afterMake, callback],
    })
  }

  /** create() 保存（含 has() 子模型）之后 */
  afterCreate(callback: (model: M) => unknown): Factory<M, S, Counted> {
    return this.#with({
      afterCreate: [...this.#options.afterCreate, callback],
    })
  }

  /** faker 的语言（覆盖 config/database.ts 的 factories.locale）：`locale('zh_CN')` */
  locale(locale: string): Factory<M, S, Counted> {
    return this.#with({ locale })
  }

  // ---------------------------------------------------------------- 生成

  /** 只生成属性（不实例化模型、不保存）；for() 传入工厂时仍会创建父模型 */
  async raw(overrides?: FactoryInput<M>): Promise<Many<FactoryAttributes<M>, Counted>> {
    const list = await this.#attributes(this.#overridesList(overrides))
    return (this.#options.count === undefined
      ? list[0]
      : list) as Many<FactoryAttributes<M>, Counted>
  }

  /** 生成模型但不保存（has() 子关联只在 create() 时创建） */
  async make(overrides?: FactoryInput<M>): Promise<Many<M, Counted>> {
    const models = await this.#make(this.#overridesList(overrides))
    return (this.#options.count === undefined
      ? models[0]
      : models) as Many<M, Counted>
  }

  /** 生成并保存；数量大于 1 或带有关联时在一个事务中写入 */
  async create(overrides?: FactoryInput<M>): Promise<Many<M, Counted>> {
    const models = await this.#create(this.#overridesList(overrides))
    return (this.#options.count === undefined
      ? models[0]
      : models) as Many<M, Counted>
  }

  /** 生成多个（不保存）：`makeMany(3)` 或每项一个覆盖值 `makeMany([{ ... }, { ... }])` */
  makeMany(list: number | Array<FactoryInput<M>>): Promise<M[]> {
    return this.#make(this.#manyList(list))
  }

  /** 生成并保存多个：`createMany(3)` 或 `createMany([{ name: 'Ada' }, { name: 'Bob' }])` */
  createMany(list: number | Array<FactoryInput<M>>): Promise<M[]> {
    return this.#create(this.#manyList(list))
  }

  // ---------------------------------------------------------------- 内部

  #with(patch: Partial<FactoryOptions<M>>): AnyFactory {
    return new Factory(this.model, {
      ...this.#options,
      ...patch,
    })
  }

  #overridesList(overrides: FactoryInput<M> | undefined): Array<FactoryInput<M> | undefined> {
    return Array.from<FactoryInput<M> | undefined>({ length: this.#options.count ?? 1 }).fill(overrides)
  }

  #manyList(list: number | Array<FactoryInput<M>>): Array<FactoryInput<M> | undefined> {
    return typeof list === 'number'
      ? Array.from<FactoryInput<M> | undefined>({ length: list }).fill(undefined)
      : list
  }

  /** 每个模型的属性：definition → 状态（含 sequence）→ for() 的外键 → 覆盖值，最后求值惰性属性 */
  async #attributes(overrides: Array<FactoryInput<M> | undefined>): Promise<Array<FactoryAttributes<M>>> {
    const options = this.#options
    const faker = await loadFaker(options.locale ?? currentDatabaseManager()?.config.factories?.locale)
    const parents = await this.#parentAttributes()
    const list: Array<FactoryAttributes<M>> = []
    for (const [index, override] of overrides.entries()) {
      const ctx = contextFor(faker, ++options.counter.n, index)
      let attributes: Record<string, unknown> = {
        ...options.definition(ctx),
      }
      for (const state of options.states) {
        Object.assign(attributes, typeof state === 'function'
          ? state(attributes as FactoryAttributes<M>, ctx)
          : state)
      }
      attributes = {
        ...attributes,
        ...parents,
        ...override,
      }
      list.push(await expand(attributes) as FactoryAttributes<M>)
    }
    return list
  }

  async #make(overrides: Array<FactoryInput<M> | undefined>): Promise<M[]> {
    const models: M[] = []
    for (const attributes of await this.#attributes(overrides)) {
      const Model = this.model
      const model = new Model()
      const record = model as unknown as ActiveRecord
      record.fill(attributes as Record<string, unknown>)
      for (const callback of this.#options.afterMake)
        await callback(model)
      models.push(model)
    }
    return models
  }

  async #create(overrides: Array<FactoryInput<M> | undefined>): Promise<M[]> {
    const run = async (): Promise<M[]> => {
      const models = await this.#make(overrides)
      for (const model of models)
        await (model as unknown as { save: () => Promise<unknown> }).save()
      for (const model of models)
        await this.#createChildren(model as unknown as ActiveRecord)
      for (const model of models) {
        for (const callback of this.#options.afterCreate)
          await callback(model)
      }
      return models
    }
    const options = this.#options
    const related = options.children.length > 0 || options.parents.some(spec => spec.parent instanceof Factory)
    return overrides.length > 1 || related
      ? atomically(run, this.model.connection)
      : run()
  }

  /** for()：按 belongsTo / morphTo 关联填充外键（与多态类型） */
  async #parentAttributes(): Promise<Record<string, unknown>> {
    const attributes: Record<string, unknown> = {}
    if (!this.#options.parents.length)
      return attributes
    const Model = this.model
    const probe = new Model() as unknown as ActiveRecord
    for (const spec of this.#options.parents) {
      const relatedModel = spec.parent instanceof Factory
        ? spec.parent.model
        : spec.parent.constructor as { name: string }
      const name = spec.relation ?? guessRelation(probe, relatedModel, 'for', false)
      const relation = relationOf(probe, name)
      const owner = spec.parent instanceof Factory
        ? asList(await spec.parent.create() as ActiveRecord | ActiveRecord[])[0]
        : spec.parent
      if (relation instanceof BelongsTo) {
        attributes[relation.foreignKey] = owner.getRaw(relation.ownerKey)
      }
      else if (relation instanceof MorphTo) {
        const type = Object.entries(relation.models).find(([, model]) => owner instanceof model)?.[0]
        if (!type)
          throw new DatabaseError(`${Model.name}.${name}(): ${owner.constructor.name} is not one of ${Object.keys(relation.models).join(', ')}`)
        attributes[relation.typeField] = type
        attributes[relation.idField] = owner.getKey()
      }
      else {
        throw new DatabaseError(`${Model.name}.${name}() is not a belongsTo / morphTo relation; use has() for child relations`)
      }
    }
    return attributes
  }

  /** has() / hasAttached()：父模型保存后创建子模型 */
  async #createChildren(parent: ActiveRecord): Promise<void> {
    for (const spec of this.#options.children) {
      const childModel = spec.children instanceof Factory
        ? spec.children.model
        : (spec.children[0]?.constructor ?? { name: 'Model' }) as { name: string }
      const name = spec.relation ?? guessRelation(parent, childModel, spec.pivot ? 'hasAttached' : 'has', true)
      const relation = relationOf(parent, name)
      if (relation instanceof BelongsToMany) {
        const related = spec.children instanceof Factory
          ? asList(await spec.children.create() as ActiveRecord | ActiveRecord[])
          : spec.children
        const pivot = spec.pivot ?? {}
        if (typeof pivot === 'function') {
          for (const model of related)
            await relation.attach(model, pivot(model, parent))
        }
        else if (related.length) {
          await relation.attach(related, pivot)
        }
        continue
      }
      if (!(spec.children instanceof Factory))
        throw new DatabaseError(`${parent.constructor.name}.${name}() is not a belongsToMany relation; hasAttached() needs one`)
      let state: Record<string, unknown>
      if (relation instanceof HasMany || relation instanceof HasOne) {
        state = {
          [relation.foreignKey]: parent.getRaw(relation.localKey),
        }
      }
      else if (relation instanceof MorphMany || relation instanceof MorphOne) {
        state = {
          [relation.typeField]: relation.type,
          [relation.idField]: parent.getRaw(relation.localKey),
        }
      }
      else {
        throw new DatabaseError(`${parent.constructor.name}.${name}() is not a hasMany / hasOne / morphMany / morphOne / belongsToMany relation; use for() for belongsTo`)
      }
      await spec.children.state(state).create()
    }
  }
}

/** 求值惰性属性：工厂 → 创建后取主键；函数 → 以已确定的属性调用 */
async function expand(attributes: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(attributes)) {
    if (value instanceof Factory)
      result[key] = asList(await value.create() as ActiveRecord | ActiveRecord[])[0].getKey()
    else if (typeof value !== 'function')
      result[key] = value
  }
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === 'function' && !(value instanceof Factory))
      result[key] = await (value as (attributes: Record<string, unknown>) => unknown)(result)
  }
  return result
}

/**
 * 定义模型工厂（`database/factories/UserFactory.ts`），在数据填充与测试中使用：
 *
 * ```ts
 * import { defineFactory } from '@hazejs/orm'
 * import { User } from '~/app/model/User'
 *
 * export default defineFactory(User, ({ faker, sequence }) => ({
 *   name: faker.person.fullName(),
 *   email: sequence(n => `user${n}@example.com`),
 * })).state('admin', { role: 'admin' })
 * ```
 *
 * faker 来自可选依赖 `@faker-js/faker`（`pnpm add -D @faker-js/faker`），按需加载。
 */
export function defineFactory<M extends ModelLike>(model: ModelClass<M>, definition: FactoryDefinition<M>): Factory<M> {
  return new Factory(model, {
    definition,
    named: new Map(),
    counter: { n: 0 },
    states: [],
    parents: [],
    children: [],
    afterMake: [],
    afterCreate: [],
  })
}
