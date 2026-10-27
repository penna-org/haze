import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { H3Event, HTTPResponse } from 'h3'
import type { Container } from '../container/container'
import type { InjectionKey } from '../container/token'
import type { Session } from '../session/session'
import type { CookieOptions } from './cookie'
import { assertBodySize, deleteCookie, getCookie, getQuery, getRequestIP, HTTPError, readBody, redirect, setCookie } from 'h3'
import { Auth } from '../auth/auth'
import { Config } from '../config/config'
import { Scope } from '../container/container'
import { BadRequestException } from '../exception/exceptions'
import { Logger } from '../logger'
import { appKey, sign, verify } from '../security/key'
import { startSession } from '../session/session'
import { parseSize } from '../utils'
import { defaultCookieOptions } from './cookie'
import { formDataToObject, UploadedFile } from './upload'

/** 响应发出前的处理（ctx.onResponse），可返回新的 Response 替换 */
export type ResponseHook = (response: Response) => Response | void | Promise<Response | void>

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
  /** 带 requestId（多应用时还有 app）上下文的日志器 */
  logger: Logger
  /** 当前生效的配置：多应用时为 全局 + app/<name>/config 合并后的结果 */
  config: Config
  /** 当前请求所属应用（多应用模式），否则为 undefined */
  appName: string | undefined
  /** 请求开始时间（performance.now()） */
  readonly startedAt = performance.now()
  validated = {} as Validated<V>
  /** 请求体上限（字节），默认 config/app.ts 的 bodyLimit（1mb），`bodyLimit:10mb` 中间件可调整 */
  bodyLimit: number
  readonly #state = new Map<PropertyKey, unknown>()
  readonly #responseHooks: ResponseHook[] = []
  #body: Promise<unknown> | undefined
  #session: Promise<Session> | undefined
  #sessionValue: Session | undefined
  #auth: Auth | undefined

  constructor(event: H3Event, container: Container, options: { requestId?: string, logger?: Logger, config?: Config } = {}) {
    this.event = event
    this.container = container
    this.requestId = options.requestId ?? crypto.randomUUID()
    this.logger = options.logger ?? new Logger().child({ requestId: this.requestId })
    this.config = options.config ?? new Config()
    this.bodyLimit = parseSize(this.config.get<string | number>('app.bodyLimit', '1mb'))
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

  /**
   * 读取请求体（按 content-type 解析，多次调用返回同一结果）：JSON、urlencoded，
   * 以及 multipart（字段为字符串，文件为 UploadedFile）。超过 bodyLimit 时返回 413。
   */
  body<T = unknown>(): Promise<T> {
    this.#body ??= this.#readBody()
    return this.#body as Promise<T>
  }

  async #readBody(): Promise<unknown> {
    assertBodySize(this.event, this.bodyLimit)
    const type = this.header('content-type') ?? ''
    if (!type.toLowerCase().startsWith('multipart/form-data'))
      return readBody(this.event)
    try {
      // 限流包装后的请求在 undici 中会丢失 multipart 的类型：用计数后的流重新构造
      return formDataToObject(await new Response(this.event.req.body, {
        headers: { 'content-type': type },
      }).formData())
    }
    catch (error) {
      if (HTTPError.isError(error))
        throw error
      throw new BadRequestException('Invalid multipart form data')
    }
  }

  /** 上传的文件（同名多个时取第一个） */
  async file(name: string): Promise<UploadedFile | undefined> {
    return (await this.files(name))[0]
  }

  /** 上传的文件列表（`<input type="file" multiple>`） */
  async files(name: string): Promise<UploadedFile[]> {
    const body = await this.body<Record<string, unknown> | undefined>()
    const value = body?.[name]
    return (Array.isArray(value)
      ? value
      : [value]).filter((item): item is UploadedFile => item instanceof UploadedFile)
  }

  /** 客户端 IP（config/app.ts 的 trustProxy 为 true 时取 X-Forwarded-For） */
  get ip(): string | undefined {
    return getRequestIP(this.event, {
      xForwardedFor: this.config.get<boolean>('app.trustProxy', false),
    })
  }

  cookie(name: string): string | undefined {
    return getCookie(this.event, name)
  }

  setCookie(name: string, value: string, options: CookieOptions = {}): this {
    setCookie(this.event, name, value, {
      ...this.cookieDefaults(),
      ...options,
    })
    return this
  }

  deleteCookie(name: string, options: CookieOptions = {}): this {
    deleteCookie(this.event, name, {
      ...this.cookieDefaults(),
      ...options,
    })
    return this
  }

  /** 读取签名 Cookie，签名不符时返回 undefined */
  async signedCookie(name: string): Promise<string | undefined> {
    const raw = this.cookie(name)
    const index = raw?.lastIndexOf('.') ?? -1
    if (!raw || index <= 0)
      return undefined
    const value = raw.slice(0, index)
    return await verify(`${name}=${value}`, raw.slice(index + 1), appKey(this.config))
      ? value
      : undefined
  }

  /** 设置签名 Cookie（HMAC-SHA256，密钥为 APP_KEY），客户端可读但无法篡改 */
  async setSignedCookie(name: string, value: string, options: CookieOptions = {}): Promise<this> {
    return this.setCookie(name, `${value}.${await sign(`${name}=${value}`, appKey(this.config))}`, options)
  }

  /** 默认 Cookie 选项（config/app.ts 的 cookie 覆盖） */
  cookieDefaults(): CookieOptions {
    return {
      ...defaultCookieOptions(!this.config.get<boolean>('app.debug', false)),
      ...this.config.get<CookieOptions>('app.cookie', {}),
    }
  }

  /** 启动会话（幂等）；`session` 中间件即调用此方法 */
  startSession(): Promise<Session> {
    this.#session ??= startSession(this).then(session => (this.#sessionValue = session))
    return this.#session
  }

  /** 当前会话（需先经过 `session` 中间件或 `await ctx.startSession()`） */
  get session(): Session {
    if (!this.#sessionValue)
      throw new Error('Session is not started: add the "session" middleware or call await ctx.startSession()')
    return this.#sessionValue
  }

  /** 认证（config/auth.ts） */
  get auth(): Auth {
    this.#auth ??= new Auth(this)
    return this.#auth
  }

  /**
   * 响应发出前执行（统一格式化、异常渲染与出站拦截器之后）。后注册的先执行（洋葱模型：
   * 外层中间件注册的钩子最后执行，如 compress）。可修改 response.headers 或返回新的 Response。
   */
  onResponse(hook: ResponseHook): this {
    this.#responseHooks.push(hook)
    return this
  }

  /** @internal */
  get responseHooks(): readonly ResponseHook[] {
    return this.#responseHooks
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
