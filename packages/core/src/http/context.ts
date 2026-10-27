import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { H3Event, HTTPResponse } from 'h3'
import type { Container } from '../container/container'
import type { InjectionKey } from '../container/token'
import { getQuery, readBody, redirect } from 'h3'
import { Scope } from '../container/container'
import { Logger } from '../logger'

export interface ValidationTargets {
  body?: StandardSchemaV1
  query?: StandardSchemaV1
  params?: StandardSchemaV1
  headers?: StandardSchemaV1
}

export type Validated<V extends ValidationTargets> = {
  [K in keyof V]: V[K] extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<V[K]> : never
}

/**
 * 请求级状态（中间件之间传递数据），可声明合并获得类型：
 *
 * ```ts
 * declare module '@think-h3/core' {
 *   interface ContextState { user: User }
 * }
 * ```
 */
export interface ContextState {}

const kContext = Symbol.for('think-h3.context')

/** 对 H3Event 的薄封装；`ctx.event` 可直接用于 h3 的全部工具函数 */
export class HttpContext<V extends ValidationTargets = ValidationTargets> {
  static scope = Scope.Request

  readonly event: H3Event
  readonly container: Container
  /** 请求 ID（沿用 x-request-id 或自动生成），会写入响应头与日志 */
  readonly requestId: string
  /** 带 requestId 上下文的日志器 */
  readonly logger: Logger
  /** 请求开始时间（performance.now()） */
  readonly startedAt = performance.now()
  validated = {} as Validated<V>
  readonly #state = new Map<PropertyKey, unknown>()
  #body: Promise<unknown> | undefined

  constructor(event: H3Event, container: Container, options: { requestId?: string, logger?: Logger } = {}) {
    this.event = event
    this.container = container
    this.requestId = options.requestId ?? crypto.randomUUID()
    this.logger = options.logger ?? new Logger().child({ requestId: this.requestId })
  }

  get req(): H3Event['req'] {
    return this.event.req
  }

  get url(): URL {
    return this.event.url
  }

  get method(): string {
    return this.event.req.method
  }

  get path(): string {
    return this.event.url.pathname
  }

  param(name: string): string | undefined {
    return this.event.context.params?.[name]
  }

  params(): Record<string, string> {
    return { ...this.event.context.params }
  }

  query(): Record<string, string | string[]>
  query(name: string): string | undefined
  query(name?: string): unknown {
    const query = getQuery(this.event) as Record<string, string | string[]>
    if (name === undefined)
      return query
    const value = query[name]
    return Array.isArray(value)
      ? value[0]
      : value
  }

  /** 读取请求体（自动按 content-type 解析，多次调用返回同一结果） */
  body<T = unknown>(): Promise<T> {
    this.#body ??= readBody(this.event)
    return this.#body as Promise<T>
  }

  header(name: string): string | undefined {
    return this.event.req.headers.get(name) ?? undefined
  }

  get<K extends keyof ContextState>(key: K): ContextState[K] | undefined
  get<T = unknown>(key: PropertyKey): T | undefined
  get(key: PropertyKey): unknown {
    return this.#state.get(key)
  }

  set<K extends keyof ContextState>(key: K, value: ContextState[K]): this
  set(key: PropertyKey, value: unknown): this
  set(key: PropertyKey, value: unknown): this {
    this.#state.set(key, value)
    return this
  }

  status(code: number, text?: string): this {
    this.event.res.status = code
    if (text !== undefined)
      this.event.res.statusText = text
    return this
  }

  setHeader(name: string, value: string): this {
    this.event.res.headers.set(name, value)
    return this
  }

  created<T>(data: T): T {
    this.status(201)
    return data
  }

  noContent(): null {
    this.status(204)
    return null
  }

  redirect(location: string, status = 302): HTTPResponse {
    return redirect(location, status)
  }

  make<T>(key: InjectionKey<T>): T {
    return this.container.make(key)
  }
}

export function setHttpContext(event: H3Event, ctx: HttpContext): void {
  (event.context as Record<symbol, unknown>)[kContext] = ctx
}

export function getHttpContext(event: H3Event): HttpContext | undefined {
  return (event.context as Record<symbol, unknown>)[kContext] as HttpContext | undefined
}
