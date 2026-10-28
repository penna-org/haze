// 前端使用的类型安全 HTTP 客户端（`@hazejs/core/client`）：只依赖 fetch，不引入服务端代码
import type { RawValue } from './http/response'

/**
 * 命名路由的输入输出类型，由 `haze typegen`（开发服务器自动执行）生成到 `.haze/types/haze.d.ts`：
 *
 * ```ts
 * 'api.users.show': { method: 'GET', path: '/api/users/:id', params: { id: string | number }, output: ... }
 * ```
 */
export interface GeneratedRoutes {}

export interface RouteSpec {
  method: string
  path: string
  params?: unknown
  query?: unknown
  body?: unknown
  output?: unknown
}

/** 运行时路由清单（`.haze/routes.ts`，由 `haze typegen` 生成） */
export type RouteManifest = Record<string, { readonly method: string, readonly path: string, readonly envelope?: boolean }>

/** 校验 schema 的输入类型（Standard Schema 的 `types.input`） */
export type SchemaInput<S> = S extends { readonly '~standard': { readonly types?: infer T } }
  ? NonNullable<T> extends { readonly input: infer I } ? I : unknown
  : unknown

// 不依赖 DOM lib（服务端 tsconfig 同样可用）
type HeadersInit = ConstructorParameters<typeof Headers>[0]
type BodyInit = NonNullable<RequestInit['body']>

type Empty = Record<never, never>

type IsAny<T> = 0 extends 1 & T ? true : false

/** 处理器返回值经 JSON 序列化后的类型：展开 raw()、调用 toJSON()（模型、Date）、去掉函数 */
export type Serialize<T> = IsAny<T> extends true
  ? any
  : unknown extends T
    ? unknown
    : T extends RawValue<infer V>
      ? Serialize<V>
      : T extends Response | ReadableStream | ArrayBuffer | Blob
        ? unknown
        : T extends { toJSON: (...args: any[]) => infer J }
          ? Serialize<J>
          : T extends string | number | boolean | null
            ? T
            : T extends undefined
              ? null
              : T extends readonly (infer U)[]
                ? Serialize<U>[]
                : T extends object
                  // JSON 会丢掉值为 undefined 的属性
                  ? { [K in keyof T as T[K] extends (...args: any[]) => any ? never : K]: Serialize<Exclude<T[K], undefined>> }
                  : unknown

type Field<R, K extends 'params' | 'query' | 'body'> = R extends { [P in K]: infer T }
  ? [T] extends [undefined | never]
      ? { [P in K]?: never }
      : Empty extends T
        ? { [P in K]?: T }
        : { [P in K]: T }
  : { [P in K]?: K extends 'body' ? unknown : Record<string, unknown> }

export type RequestOptions<R> = Field<R, 'params'> & Field<R, 'query'> & Field<R, 'body'> & {
  headers?: HeadersInit
  signal?: AbortSignal
  /** 其它 fetch 选项 */
  init?: Omit<RequestInit, 'method' | 'body' | 'headers' | 'signal'>
}

type RequiredKeys<T> = { [K in keyof T]-?: Empty extends Pick<T, K> ? never : K }[keyof T]

type Args<R> = [RequiredKeys<RequestOptions<R>>] extends [never]
  ? [options?: RequestOptions<R>]
  : [options: RequestOptions<R>]

export type RouteOutput<R> = R extends { output: infer O } ? Serialize<Awaited<O>> : unknown

type Routes<M> = [keyof M] extends [never] ? Record<string, RouteSpec> : M

export interface ClientOptions {
  /** 路由清单：`import { routes } from '../.haze/routes'` */
  routes: RouteManifest
  /** 接口地址，默认同源（空字符串） */
  baseURL?: string
  /** 每个请求都携带的请求头，可为函数（如读取最新的令牌） */
  headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>)
  fetch?: typeof globalThis.fetch
  /** 默认 `same-origin` */
  credentials?: RequestInit['credentials']
  /** 成功响应是否为统一响应格式 `{ code, message, data }`，默认 true（对应 app.response.envelope） */
  envelope?: boolean
  /** 自定义 ResponseFormatter 时，从响应体中取出数据 */
  unwrap?: (body: unknown, response: Response) => unknown
}

export interface Client<M = GeneratedRoutes> {
  <N extends keyof Routes<M> & string>(name: N, ...args: Args<Routes<M>[N]>): Promise<RouteOutput<Routes<M>[N]>>
  /** 只生成地址（含 query），不发请求 */
  url: <N extends keyof Routes<M> & string>(name: N, options?: Pick<RequestOptions<Routes<M>[N]>, 'params' | 'query'>) => string
}

/** 非 2xx 响应：携带状态码与错误响应体（含 422 的 `errors`） */
export class ClientError extends Error {
  readonly status: number
  readonly response: Response
  /** 解析后的响应体 */
  readonly body: unknown
  readonly code: unknown
  readonly errors: Array<{ target?: string, path: string, message: string }> | undefined

  constructor(response: Response, body: unknown) {
    const record = isObject(body)
      ? body
      : {}
    super(typeof record.message === 'string'
      ? record.message
      : `Request failed with status ${response.status}`)
    this.name = 'ClientError'
    this.status = response.status
    this.response = response
    this.body = body
    this.code = record.code ?? record.status ?? response.status
    this.errors = Array.isArray(record.errors)
      ? record.errors as ClientError['errors']
      : undefined
  }
}

/**
 * 创建类型安全的客户端：按路由名请求，返回解包后的 `data`。
 *
 * ```ts
 * import { createClient } from '@hazejs/core/client'
 * import { routes } from '../.haze/routes'
 *
 * const api = createClient({ routes, baseURL: '/' })
 * const user = await api('api.users.show', { params: { id: 1 } })
 * ```
 */
export function createClient<M = GeneratedRoutes>(options: ClientOptions): Client<M> {
  const fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
  const base = (options.baseURL ?? '').replace(/\/+$/, '')

  const url = (name: string, input: { params?: unknown, query?: unknown } = {}): string => {
    const route = options.routes[name]
    if (!route)
      throw new Error(`Route "${name}" is not defined`)
    return base + buildPath(name, route.path, input.params as Record<string, unknown> | undefined) + buildQuery(input.query as Record<string, unknown> | undefined)
  }

  const request = async (name: string, input: RequestOptions<RouteSpec> = {}): Promise<unknown> => {
    const route = options.routes[name]
    const target = url(name, input)
    const headers = new Headers(typeof options.headers === 'function'
      ? await options.headers()
      : options.headers)
    new Headers(input.headers).forEach((value, key) => headers.set(key, value))
    if (!headers.has('accept'))
      headers.set('accept', 'application/json')

    const body = encodeBody(input.body, headers)
    const response = await fetcher(target, {
      credentials: options.credentials ?? 'same-origin',
      ...input.init,
      method: route.method,
      headers,
      body,
      signal: input.signal,
    })
    const parsed = await parseBody(response)
    if (!response.ok)
      throw new ClientError(response, parsed)
    if (options.unwrap)
      return options.unwrap(parsed, response)
    if (options.envelope === false || route.envelope === false)
      return parsed
    return isObject(parsed) && 'data' in parsed && 'code' in parsed
      ? parsed.data
      : parsed
  }

  return Object.assign(request, { url }) as unknown as Client<M>
}

function buildPath(name: string, template: string, params: Record<string, unknown> = {}): string {
  return template.replace(/\*{0,2}:(\w+)/g, (_, key: string) => {
    const value = params[key]
    if (value === undefined || value === null)
      throw new Error(`Missing param "${key}" for route "${name}"`)
    return encodeURIComponent(String(value))
  })
}

function buildQuery(query: Record<string, unknown> | undefined): string {
  if (!query)
    return ''
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(query)) {
    for (const item of Array.isArray(value)
      ? value
      : [value]) {
      if (item !== undefined && item !== null)
        search.append(key, String(item))
    }
  }
  const text = search.toString()
  return text
    ? `?${text}`
    : ''
}

/** 对象中含 File / Blob 时自动转为 multipart，其它对象按 JSON 发送 */
function encodeBody(body: unknown, headers: Headers): BodyInit | undefined {
  if (body === undefined || body === null)
    return undefined
  if (typeof body === 'string' || body instanceof FormData || body instanceof Blob || body instanceof URLSearchParams || body instanceof ArrayBuffer || ArrayBuffer.isView(body) || body instanceof ReadableStream)
    return body as BodyInit
  if (isObject(body) && Object.values(body).some(value => value instanceof Blob || (Array.isArray(value) && value.some(item => item instanceof Blob)))) {
    const form = new FormData()
    for (const [key, value] of Object.entries(body)) {
      for (const item of Array.isArray(value)
        ? value
        : [value]) {
        if (item === undefined || item === null)
          continue
        form.append(key, item instanceof Blob
          ? item
          : typeof item === 'object'
            ? JSON.stringify(item)
            : String(item))
      }
    }
    return form
  }
  if (!headers.has('content-type'))
    headers.set('content-type', 'application/json')
  return JSON.stringify(body)
}

async function parseBody(response: Response): Promise<unknown> {
  if (response.status === 204 || response.status === 205)
    return undefined
  const text = await response.text()
  if (!text)
    return undefined
  const type = response.headers.get('content-type') ?? ''
  if (type.includes('json')) {
    try {
      return JSON.parse(text)
    }
    catch {
      return text
    }
  }
  return text
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
