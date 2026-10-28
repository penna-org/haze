import type { SchemaLike } from '../openapi/types'
import type { HttpContext } from './context'
import { getRequestStore } from '../request'
import { isPlainObject } from '../utils'

const kMissing = Symbol.for('hazejs.resource.missing')
const kResource = Symbol.for('hazejs.resource')

/** when() 等条件不成立时的占位值：所在字段从输出中移除 */
export interface MissingValue {
  readonly [kMissing]: true
}

// 不可枚举：`...when(false, {...})` 展开时不会带出任何字段
const MISSING = Object.defineProperty({}, kMissing, { value: true, enumerable: false }) as MissingValue

function isMissing(value: unknown): value is MissingValue {
  return typeof value === 'object' && value !== null && kMissing in value
}

type Lazy<T> = T | (() => T)

function evaluate<T>(value: Lazy<T>): T {
  return typeof value === 'function'
    ? (value as () => T)()
    : value
}

/** 输出类型：解开 Promise / 嵌套资源，when() 等条件字段变为可选 */
export type ResourceValue<T>
  = T extends MissingValue ? never
    : T extends PendingResource<infer U> ? U
      : T extends PromiseLike<infer U> ? ResourceValue<U>
        : T extends { toJSON: (...args: any[]) => any } ? T
          : T extends (...args: any[]) => any ? T
            : T extends readonly (infer E)[] ? Array<ResourceValue<E>>
              : T extends object ? ResourceObject<T>
                : T

type OptionalKeys<T> = { [K in keyof T]: MissingValue extends Awaited<T[K]> ? K : never }[keyof T]

type Simplify<T> = { [K in keyof T]: T[K] } & {}

type ResourceObject<T> = Simplify<{
  [K in Exclude<keyof T, OptionalKeys<T>>]: ResourceValue<T[K]>
} & {
  [K in OptionalKeys<T>]?: ResourceValue<T[K]>
}>

/** 偏移分页（ORM 的 paginate()）资源输出 */
export interface PaginatedResource<D> {
  data: D[]
  meta: { total: number, page: number, perPage: number, lastPage: number, from: number | null, to: number | null }
  links: { first: string, last: string, prev: string | null, next: string | null }
}

/** 游标分页（ORM 的 paginateX()）资源输出 */
export interface CursorPaginatedResource<D> {
  data: D[]
  meta: { perPage: number, hasMore: boolean, lastId: unknown }
  links: { next: string | null }
}

interface OffsetPage<M> {
  data: readonly M[]
  total: number
  page: number
  perPage: number
  lastPage: number
}

interface CursorPage<M> {
  data: readonly M[]
  perPage: number
  lastId: unknown
  hasMore: boolean
}

export type ResourceTransform<M, R> = (item: M, ctx: HttpContext) => R

export interface ApiResourceOptions {
  /** 输出 schema（Standard Schema 或 JSON Schema），用于 OpenAPI：`.doc({ response: UserResource.schema })` */
  schema?: SchemaLike
  /** 分页链接中的页码参数名，默认 `page` */
  pageName?: string
  /** 游标分页链接中的游标参数名，默认 `lastId` */
  cursorName?: string
}

export interface ApiResource<M, D> {
  readonly [kResource]: true
  readonly schema?: SchemaLike
  /** 转换单个对象；null / undefined 输出 null */
  make: <T extends M | null | undefined>(item: T) => PendingResource<T extends M ? D : null>
  /** 转换数组，或 ORM 的分页结果（保留 meta / links） */
  collection: {
    (page: OffsetPage<M>): PendingResource<PaginatedResource<D>>
    (page: CursorPage<M>): PendingResource<CursorPaginatedResource<D>>
    (items: Iterable<M>): PendingResource<D[]>
  }
}

/** 资源定义的输出类型：`ResourceData<typeof UserResource>` */
export type ResourceData<R> = R extends ApiResource<any, infer D> ? D : never

/**
 * 尚未求值的资源（PromiseLike）：控制器直接返回即可，也可 `await` 得到普通对象，
 * 或用 `additional()` 追加顶层字段。
 */
export class PendingResource<T> implements PromiseLike<T> {
  readonly #resolve: () => Promise<unknown>
  #additional: Record<string, unknown> | undefined
  #promise: Promise<T> | undefined

  constructor(resolve: () => Promise<unknown>) {
    this.#resolve = resolve
  }

  /**
   * 追加顶层字段：分页结果与 data / meta / links 并列；单个对象与数组会包装为 `{ data, ...extra }`
   */
  additional<E extends Record<string, unknown>>(extra: E): PendingResource<(T extends { data: any, meta: any } ? T : { data: T }) & ResourceObject<E>> {
    this.#additional = {
      ...this.#additional,
      ...extra,
    }
    return this as never
  }

  /** 求值（只执行一次） */
  resolve(): Promise<T> {
    this.#promise ??= (async () => {
      const value = await this.#resolve()
      if (!this.#additional)
        return value as T
      const extra = await resolveValue(this.#additional) as Record<string, unknown>
      return (isPage(value)
        ? {
            ...value,
            ...extra,
          }
        : { data: value, ...extra }) as T
    })()
    return this.#promise
  }

  then<R1 = T, R2 = never>(onfulfilled?: ((value: T) => R1 | PromiseLike<R1>) | null, onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null): Promise<R1 | R2> {
    return this.resolve().then(onfulfilled, onrejected)
  }
}

function isPage(value: unknown): value is { data: unknown[], meta: unknown } {
  return isPlainObject(value) && Array.isArray(value.data) && 'meta' in value
}

/** 当前正在转换的对象（whenLoaded('relation') 读取），只在转换函数的同步部分有效 */
let current: { item: unknown } | undefined

function currentContext(): HttpContext {
  const ctx = getRequestStore()?.ctx
  if (ctx)
    return ctx
  // 请求之外（队列、命令）也能使用资源，只是不能访问 ctx
  return new Proxy({} as HttpContext, {
    get(_, key) {
      throw new Error(`Resource accessed ctx.${String(key)} outside of a request`)
    },
  })
}

/**
 * 定义 API 资源：把模型转换为接口输出，字段可以是 Promise、嵌套资源或条件字段。
 *
 * ```ts
 * export const UserResource = defineResource((user: User, ctx) => ({
 *   id: user.id,
 *   name: user.name,
 *   email: when(ctx.get('userId') === user.id, user.email),
 *   posts: whenLoaded('posts', PostResource),
 *   ...merge(user.role === 'admin', { permissions: user.permissions }),
 * }))
 *
 * return UserResource.make(user)
 * return UserResource.collection(await User.paginate(page, 20))
 * ```
 */
export function defineResource<M, R>(transform: ResourceTransform<M, R>, options: ApiResourceOptions = {}): ApiResource<M, ResourceValue<Awaited<R>>> {
  const run = async (item: unknown, ctx: HttpContext): Promise<unknown> => {
    if (item === null || item === undefined)
      return null
    const previous = current
    current = { item }
    let output: unknown
    try {
      output = transform(item as M, ctx)
    }
    finally {
      current = previous
    }
    return resolveValue(output)
  }

  const many = (items: Iterable<unknown>, ctx: HttpContext): Promise<unknown[]> =>
    Promise.all(Array.from(items, item => run(item, ctx)))

  const resource = {
    [kResource]: true as const,
    schema: options.schema,
    make: (item: unknown) => new PendingResource(() => run(item, currentContext())),
    collection: (input: unknown) => new PendingResource(async () => {
      const ctx = currentContext()
      if (isOffsetPage(input)) {
        const { data, total, page, perPage, lastPage } = input
        const link = pageLink(ctx, options.pageName ?? 'page')
        const from = data.length
          ? (page - 1) * perPage + 1
          : null
        return {
          data: await many(data, ctx),
          meta: {
            total,
            page,
            perPage,
            lastPage,
            from,
            to: from === null
              ? null
              : from + data.length - 1,
          },
          links: {
            first: link(1),
            last: link(lastPage),
            prev: page > 1
              ? link(page - 1)
              : null,
            next: page < lastPage
              ? link(page + 1)
              : null,
          },
        }
      }
      if (isCursorPage(input)) {
        const { data, perPage, lastId, hasMore } = input
        return {
          data: await many(data, ctx),
          meta: { perPage, hasMore, lastId },
          links: {
            next: hasMore && lastId !== undefined && lastId !== null
              ? pageLink(ctx, options.cursorName ?? 'lastId')(lastId)
              : null,
          },
        }
      }
      return many(input as Iterable<unknown>, ctx)
    }),
  }
  return resource as unknown as ApiResource<M, ResourceValue<Awaited<R>>>
}

export function isResource(value: unknown): value is ApiResource<any, any> {
  return typeof value === 'object' && value !== null && kResource in value
}

function isOffsetPage(value: unknown): value is OffsetPage<unknown> {
  return isPlainObject(value) && Array.isArray(value.data) && typeof value.total === 'number' && typeof value.page === 'number' && typeof value.lastPage === 'number'
}

function isCursorPage(value: unknown): value is CursorPage<unknown> {
  return isPlainObject(value) && Array.isArray(value.data) && typeof value.hasMore === 'boolean' && 'lastId' in value
}

/** 当前请求路径 + 替换后的分页参数（站内相对链接）；请求之外只有查询串 */
function pageLink(ctx: HttpContext, name: string): (value: unknown) => string {
  let url: URL | undefined
  try {
    url = new URL(ctx.req.url)
  }
  catch {
    url = undefined
  }
  return (value) => {
    const params = new URLSearchParams(url?.search)
    params.set(name, String(value))
    return `${url?.pathname ?? ''}?${params}`
  }
}

/** 递归求值：Promise、嵌套资源、数组与普通对象，移除 MissingValue */
async function resolveValue(value: unknown): Promise<unknown> {
  if (isMissing(value))
    return MISSING
  if (value instanceof PendingResource || isThenable(value))
    return resolveValue(await value)
  if (Array.isArray(value)) {
    const items = await Promise.all(value.map(resolveValue))
    return items.filter(item => !isMissing(item))
  }
  if (isPlainObject(value)) {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolveValue(item)] as const))
    return Object.fromEntries(entries.filter(([, item]) => !isMissing(item)))
  }
  return value
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (typeof value === 'object' || typeof value === 'function') && value !== null && typeof (value as PromiseLike<unknown>).then === 'function'
}

/**
 * 条件字段：条件成立时输出 value（函数形式惰性求值），否则从输出中移除该字段（或使用 fallback）。
 * 条件可以是 Promise：`email: when(ctx.can('viewEmail', user), user.email)`
 */
export function when<T>(condition: boolean, value: Lazy<T>): T | MissingValue
export function when<T, F>(condition: boolean, value: Lazy<T>, fallback: Lazy<F>): T | F
export function when<T>(condition: PromiseLike<boolean>, value: Lazy<T>): Promise<T | MissingValue>
export function when<T, F>(condition: PromiseLike<boolean>, value: Lazy<T>, fallback: Lazy<F>): Promise<T | F>
export function when(condition: boolean | PromiseLike<boolean>, value: Lazy<unknown>, ...fallback: [Lazy<unknown>?]): unknown {
  const pick = (ok: boolean): unknown => ok
    ? evaluate(value)
    : fallback.length
      ? evaluate(fallback[0])
      : MISSING
  return isThenable(condition)
    ? Promise.resolve(condition).then(pick)
    : pick(condition)
}

/** 值不为 null / undefined 时输出，否则移除该字段 */
export function whenNotNull<T>(value: T): NonNullable<T> | MissingValue {
  return value === null || value === undefined
    ? MISSING
    : value as NonNullable<T>
}

type RelationTransform = ApiResource<any, any> | ((value: any) => unknown)

/**
 * 关联已加载（`with('posts')` / `load('posts')`）时输出，否则移除该字段，避免 N+1 查询。
 * 第二个参数可传资源（数组按 collection、单个按 make 转换）或函数。
 *
 * - `whenLoaded('posts', PostResource)`：作用于正在转换的对象（须在转换函数的同步部分调用）
 * - `whenLoaded(user, 'posts')`：显式指定对象（可在 await 之后使用）
 */
export function whenLoaded(relation: string, transform?: RelationTransform): any
export function whenLoaded(item: object, relation: string, transform?: RelationTransform): any
export function whenLoaded(...args: unknown[]): unknown {
  let item: unknown
  if (typeof args[0] === 'string') {
    if (!current)
      throw new Error('whenLoaded(relation) must be called synchronously inside a resource; use whenLoaded(item, relation) after await')
    item = current.item
  }
  else {
    item = args.shift()
  }
  const [relation, transform] = args as [string, RelationTransform | undefined]
  const record = item as { hasRelation?: (name: string) => boolean, getRelation?: (name: string) => unknown } & Record<string, unknown>
  let value: unknown
  if (typeof record.hasRelation === 'function') {
    if (!record.hasRelation(relation))
      return MISSING
    value = record.getRelation!(relation)
  }
  else {
    if (record[relation] === undefined)
      return MISSING
    value = record[relation]
  }
  if (!transform || value === null || value === undefined)
    return value ?? null
  if (isResource(transform)) {
    return Array.isArray(value)
      ? transform.collection(value)
      : transform.make(value)
  }
  return transform(value)
}

/**
 * 合并一组字段（展开到对象中）：`...merge({ a, b })`、`...merge(isAdmin, () => ({ secret }))`。
 * 条件不成立时不输出任何字段；值可以是 Promise 或嵌套资源。
 */
export function merge<T extends object>(value: Lazy<T>): T
export function merge<T extends object>(condition: boolean, value: Lazy<T>): Partial<T>
export function merge(...args: unknown[]): object {
  if (args.length === 1)
    return evaluate(args[0] as Lazy<object>)
  return args[0]
    ? evaluate(args[1] as Lazy<object>)
    : {}
}
