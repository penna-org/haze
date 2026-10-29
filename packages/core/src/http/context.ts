import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { H3Event, HTTPResponse } from 'h3'
import type { ModelAbility, PlainAbility } from '../auth/gate'
import type { Container } from '../container/container'
import type { InjectionKey } from '../container/token'
import type { TranslationKey, TranslationParams } from '../i18n/manager'
import type { SignatureOptions } from '../routing/signed'
import type { Session } from '../session/session'
import type { Tenant } from '../tenancy/config'
import type { Component, ViewNode } from '../view/jsx'
import type { ViewResponseInit } from '../view/view'
import type { CookieOptions } from './cookie'
import { assertBodySize, deleteCookie, getCookie, getQuery, getRequestIP, getRequestURL, HTTPError, readBody, redirect, setCookie } from 'h3'
import { Auth } from '../auth/auth'
import { Gate } from '../auth/gate'
import { Config } from '../config/config'
import { Scope } from '../container/container'
import { BadRequestException } from '../exception/exceptions'
import { requestLocale, setRequestLocale, useI18n } from '../i18n/manager'
import { Logger } from '../logger'
import { csrfToken } from '../middleware/builtin/csrf'
import { hasValidSignature } from '../routing/signed'
import { appKey, sign, verify } from '../security/key'
import { startSession } from '../session/session'
import { currentTenant } from '../tenancy/context'
import { parseSize } from '../utils'
import { contextView } from '../view/view'
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
 * declare module '@hazejs/core' {
 *   interface ContextState { user: User }
 * }
 * ```
 */
export interface ContextState {}

const kContext = Symbol.for('hazejs.context')

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

  /** 当前租户（多租户中间件识别），没有租户时为 undefined */
  get tenant(): Tenant | undefined {
    return currentTenant()
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

  /** 路由参数（已 URL 解码：`/files/%E6%96%87` → `文`） */
  param(name: string): string | undefined {
    const value = this.event.context.params?.[name]
    return value === undefined
      ? undefined
      : decodeParam(value)
  }

  params(): Record<string, string> {
    return Object.fromEntries(Object.entries(this.event.context.params ?? {}).map(([name, value]) => [
      name,
      decodeParam(value),
    ]))
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

  /**
   * 客户端访问的地址（协议 + 主机，如 `https://admin.example.com`）：config/app.ts 的 trustProxy 为 true 时
   * 取反向代理传来的 X-Forwarded-Proto / X-Forwarded-Host，用于生成给浏览器的绝对地址
   */
  get origin(): string {
    const trust = this.config.get<boolean>('app.trustProxy', false)
    return getRequestURL(this.event, { xForwardedHost: trust, xForwardedProto: trust }).origin
  }

  /** 是否为 https 请求（同样遵循 trustProxy），如决定 Cookie 是否加 Secure */
  get secure(): boolean {
    return this.origin.startsWith('https:')
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

  /** 当前用户是否拥有能力：`await ctx.can('update', post)`、`ctx.can('create', Post)`、`ctx.can('admin.access')` */
  can<M extends object>(ability: ModelAbility<M>, model: M, ...args: unknown[]): Promise<boolean>
  can<C extends abstract new (...args: any[]) => any>(ability: ModelAbility<InstanceType<C>>, model: C, ...args: unknown[]): Promise<boolean>
  can(ability: PlainAbility, ...args: unknown[]): Promise<boolean>
  async can(ability: string, ...args: unknown[]): Promise<boolean> {
    return this.make(Gate).allows(await this.#gateUser(), ability, ...args)
  }

  cannot<M extends object>(ability: ModelAbility<M>, model: M, ...args: unknown[]): Promise<boolean>
  cannot<C extends abstract new (...args: any[]) => any>(ability: ModelAbility<InstanceType<C>>, model: C, ...args: unknown[]): Promise<boolean>
  cannot(ability: PlainAbility, ...args: unknown[]): Promise<boolean>
  async cannot(ability: string, ...args: unknown[]): Promise<boolean> {
    return this.make(Gate).denies(await this.#gateUser(), ability, ...args)
  }

  /** 无权限时抛出：未登录 401，已登录 403（消息取自策略的 deny()） */
  authorize<M extends object>(ability: ModelAbility<M>, model: M, ...args: unknown[]): Promise<void>
  authorize<C extends abstract new (...args: any[]) => any>(ability: ModelAbility<InstanceType<C>>, model: C, ...args: unknown[]): Promise<void>
  authorize(ability: PlainAbility, ...args: unknown[]): Promise<void>
  async authorize(ability: string, ...args: unknown[]): Promise<void> {
    return this.make(Gate).authorize(await this.#gateUser(), ability, ...args)
  }

  /** 当前会话的 CSRF token（服务端渲染表单时放入隐藏字段 `_token`） */
  csrfToken(): Promise<string> {
    return csrfToken(this)
  }

  /** 当前请求的语言：按 config/i18n.ts 的 detect（查询参数、Cookie、Accept-Language）检测，可用 setLocale() 修改 */
  get locale(): string {
    return requestLocale(this)
  }

  set locale(locale: string) {
    setRequestLocale(this, locale)
  }

  /** 设置本次请求的语言（之后的 t()、校验错误与异常消息都使用该语言） */
  setLocale(locale: string): this {
    setRequestLocale(this, locale)
    return this
  }

  /** 按本次请求的语言翻译：`ctx.t('messages.welcome', { name })` */
  t<K extends TranslationKey>(key: K, params?: TranslationParams): string {
    return useI18n().translate(key, params, this.locale)
  }

  /** 请求 URL 是否带有有效的签名（router.signedUrl() 生成，未过期且未被篡改） */
  hasValidSignature(options?: SignatureOptions): Promise<boolean> {
    return hasValidSignature(this, options)
  }

  /** 授权使用的用户：未配置 config/auth.ts 时视为未登录 */
  async #gateUser(): Promise<unknown> {
    return this.config.get('auth', undefined)
      ? this.auth.user()
      : undefined
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

  /**
   * 渲染 TSX 视图为 HTML 响应（`text/html`，不经过统一响应格式）：
   *
   * ```tsx
   * return ctx.view(<Home user={user} />, { status: 200, headers: { 'cache-control': 'no-store' } })
   * return ctx.view(Home, { user })        // 组件 + props
   * return ctx.view('admin/Dashboard', {}) // app/view/admin/Dashboard.tsx
   * ```
   */
  view(node: ViewNode, init?: ViewResponseInit): Promise<Response>
  view<P>(component: Component<P> | string, props?: P, init?: ViewResponseInit): Promise<Response>
  view(input: ViewNode | Component<any> | string, propsOrInit?: unknown, init?: ViewResponseInit): Promise<Response> {
    return contextView(this, input, propsOrInit as Record<string, unknown> | undefined, init)
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

/** 路由参数按 URL 解码；不是合法的编码（如单独的 `%`）时原样返回 */
function decodeParam(value: string): string {
  if (!value.includes('%'))
    return value
  try {
    return decodeURIComponent(value)
  }
  catch {
    return value
  }
}
