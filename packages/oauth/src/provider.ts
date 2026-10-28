import type { CookieOptions, HttpContext } from '@hazejs/core'
import type { BaseProviderConfig, DriverOptions, MappedUser, OAuthToken, OAuthUser } from './types'
import { appKey } from '@hazejs/core'
import { codeChallenge, randomString, safeEqual, seal, unseal } from './crypto'
import { InvalidStateException, OAuthException } from './errors'

/** 发起授权时保存的状态（加密存入 Cookie，或存入会话） */
export interface OAuthState {
  /** state */
  s: string
  /** PKCE code_verifier */
  v?: string
  /** OIDC nonce */
  n?: string
  /** 本次使用的 redirect_uri（换取令牌时必须一致） */
  r: string
  /** 过期时间（Unix 秒） */
  e: number
}

/** 解析用户信息时可用的上下文 */
export interface UserContext {
  /** 回调参数（query 或 form_post 的表单） */
  params: Record<string, string>
  /** 发起授权时的 nonce（stateless 时没有） */
  nonce?: string
  /** userFromToken() 传入的附加参数（如微信的 openid） */
  extra: Record<string, string>
}

export interface AuthorizeContext {
  state: string
  redirectUri: string
  codeChallenge?: string
  nonce?: string
}

export interface ExchangeContext {
  redirectUri: string
  codeVerifier?: string
  params: Record<string, string>
}

export interface HttpOptions {
  method?: string
  query?: Record<string, string | number | undefined>
  /** application/x-www-form-urlencoded 请求体 */
  form?: Record<string, string | undefined>
  /** JSON 请求体 */
  json?: unknown
  headers?: Record<string, string>
  /** Authorization: Bearer */
  bearer?: string
}

type Json = Record<string, any>

/**
 * OAuth 2.0 驱动基类：实现授权地址、state / PKCE / nonce、换取令牌与用户映射的通用流程，
 * 各家驱动覆盖默认接口地址、参数名与用户信息的获取和映射。
 *
 * 实例为一次性的构造器：`OAuth.driver('github')` 每次返回新实例，
 * `scopes()` / `with()` / `stateless()` 只影响本次调用。
 */
export abstract class OAuthProvider<C extends BaseProviderConfig = BaseProviderConfig> {
  /** 默认 scope */
  protected defaultScopes: string[] = []
  /** scope 分隔符 */
  protected scopeSeparator = ' '
  /** 是否默认使用 PKCE（config 的 pkce 可覆盖） */
  protected supportsPkce = false
  /** 是否在授权请求中带上 nonce（OpenID Connect） */
  protected usesNonce = false
  /** 回调中授权码的参数名（支付宝为 auth_code） */
  protected codeParam = 'code'

  #scopes: string[] | undefined
  #parameters: Record<string, string> = {}
  #stateless: boolean
  #redirect: string | undefined

  constructor(readonly name: string, readonly config: C, protected readonly options: DriverOptions) {
    if (!config.clientId)
      throw new Error(`OAuth provider "${name}": clientId is required`)
    this.#stateless = config.stateless ?? false
  }

  /** 默认接口地址（config 的 endpoints 按键覆盖） */
  protected abstract defaultEndpoints(): Record<string, string>

  /** 取得原始用户信息 */
  protected abstract fetchUser(token: OAuthToken, context: UserContext): Promise<Json>

  /** 原始用户信息 → 统一字段 */
  protected abstract mapUser(raw: Json, token: OAuthToken, context: UserContext): MappedUser

  get endpoints(): Record<string, string> {
    return {
      ...this.defaultEndpoints(),
      ...this.config.endpoints,
    }
  }

  /** 取接口地址（OIDC 驱动在未配置时从 discovery 文档读取） */
  protected async endpoint(key: string): Promise<string> {
    const url = this.endpoints[key]
    if (!url)
      throw new Error(`OAuth provider "${this.name}": endpoint "${key}" is not configured`)
    return url
  }

  /** 追加 scope（与默认值合并去重） */
  scopes(scopes: string | string[]): this {
    this.#scopes = [
      ...new Set([
        ...this.getScopes(),
        ...[scopes].flat(),
      ]),
    ]
    return this
  }

  /** 替换全部 scope */
  setScopes(scopes: string | string[]): this {
    this.#scopes = [
      ...new Set([scopes].flat()),
    ]
    return this
  }

  getScopes(): string[] {
    return this.#scopes ?? this.config.scopes ?? this.defaultScopes
  }

  /** 附加授权参数：`.with({ prompt: 'consent' })` */
  with(parameters: Record<string, string>): this {
    Object.assign(this.#parameters, parameters)
    return this
  }

  /** 不保存 / 校验 state（同时不使用 PKCE 与 nonce） */
  stateless(value = true): this {
    this.#stateless = value
    return this
  }

  get isStateless(): boolean {
    return this.#stateless
  }

  /** 覆盖本次的回调地址 */
  redirectUrl(url: string): this {
    this.#redirect = url
    return this
  }

  /** 本次是否使用 PKCE */
  get usesPkce(): boolean {
    return !this.#stateless && (this.config.pkce ?? this.supportsPkce)
  }

  /**
   * 生成授权地址并保存 state（前后端分离时可把地址返回给前端跳转）。
   * 有状态模式下会写入 Cookie / 会话，因此必须在同一个响应中返回给浏览器。
   */
  async authorizationUrl(ctx: HttpContext): Promise<string> {
    const redirectUri = this.resolveRedirect(ctx)
    const state = randomString()
    const verifier = this.usesPkce
      ? randomString(48)
      : undefined
    const nonce = this.usesNonce && !this.#stateless
      ? randomString()
      : undefined
    if (!this.#stateless) {
      await this.saveState(ctx, {
        s: state,
        v: verifier,
        n: nonce,
        r: redirectUri,
        e: Math.floor(Date.now() / 1000) + this.options.stateTtl,
      })
    }
    const params = await this.authorizeParams({
      state,
      redirectUri,
      codeChallenge: verifier && await codeChallenge(verifier),
      nonce,
    })
    return this.buildAuthorizationUrl({
      ...params,
      ...this.config.parameters,
      ...this.#parameters,
    })
  }

  /** 跳转到第三方授权页 */
  async redirect(ctx: HttpContext): Promise<ReturnType<HttpContext['redirect']>> {
    return ctx.redirect(await this.authorizationUrl(ctx))
  }

  /** 处理回调：校验 state、用授权码换取令牌并取得用户信息 */
  async user(ctx: HttpContext): Promise<OAuthUser> {
    const params = await this.callbackParams(ctx)
    if (params.error) {
      throw new OAuthException(this.name, params.error_description || params.error, {
        code: params.error,
      })
    }
    let state: OAuthState | undefined
    if (!this.#stateless) {
      state = await this.pullState(ctx)
      if (!state || !params.state || !safeEqual(state.s, params.state))
        throw new InvalidStateException(this.name)
    }
    const code = params[this.codeParam]
    if (!code)
      throw new OAuthException(this.name, `Missing "${this.codeParam}" in the callback`, { code: 'missing_code' })
    const token = await this.exchangeCode(code, {
      redirectUri: state?.r ?? this.resolveRedirect(ctx),
      codeVerifier: state?.v,
      params,
    })
    return this.resolveUser(token, { params, nonce: state?.n, extra: {} })
  }

  /**
   * 用已有的访问令牌取得用户（移动端 SDK 登录后把令牌交给服务端）。
   * `extra` 为部分驱动需要的附加参数，如微信 / QQ 的 `{ openid }`。
   */
  async userFromToken(token: string | (Partial<OAuthToken> & { accessToken: string }), extra: Record<string, string> = {}): Promise<OAuthUser> {
    const normalized: OAuthToken = typeof token === 'string'
      ? { accessToken: token, raw: {} }
      : { raw: {}, ...token }
    return this.resolveUser(normalized, { params: {}, extra })
  }

  /** 用 refresh_token 换取新令牌（标准 OAuth 2.0；不支持的驱动会抛错） */
  async refreshToken(refreshToken: string): Promise<OAuthToken> {
    const data = await this.http(await this.endpoint('token'), {
      method: 'POST',
      form: {
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.config.clientId,
        client_secret: await this.clientSecret(),
      },
    })
    return this.parseToken(data)
  }

  /** 换取令牌时使用的 client_secret（Apple 按需生成 JWT） */
  protected async clientSecret(): Promise<string | undefined> {
    return this.config.clientSecret
  }

  protected async resolveUser(token: OAuthToken, context: UserContext): Promise<OAuthUser> {
    const raw = await this.fetchUser(token, context)
    const mapped = this.mapUser(raw, token, context)
    if (mapped.id === undefined || mapped.id === null || mapped.id === '')
      throw new OAuthException(this.name, 'The provider did not return a user id', { code: 'missing_user_id', data: raw })
    return {
      provider: this.name,
      id: String(mapped.id),
      name: mapped.name || null,
      nickname: mapped.nickname || null,
      email: mapped.email || null,
      avatar: mapped.avatar || null,
      raw,
      token,
    }
  }

  /** 授权地址的参数（标准 OAuth 2.0；微信等驱动覆盖参数名） */
  protected authorizeParams(context: AuthorizeContext): Record<string, string> | Promise<Record<string, string>> {
    const scopes = this.getScopes()
    return {
      client_id: this.config.clientId,
      redirect_uri: context.redirectUri,
      response_type: 'code',
      ...(scopes.length && {
        scope: scopes.join(this.scopeSeparator),
      }),
      state: context.state,
      ...(context.codeChallenge && {
        code_challenge: context.codeChallenge,
        code_challenge_method: 'S256',
      }),
      ...(context.nonce && { nonce: context.nonce }),
    }
  }

  protected async buildAuthorizationUrl(params: Record<string, string>): Promise<string> {
    const url = new URL(await this.endpoint('authorize'))
    for (const [key, value] of Object.entries(params))
      url.searchParams.set(key, value)
    return url.href
  }

  /** 用授权码换取令牌（标准 OAuth 2.0：表单 POST 到 token 接口） */
  protected async exchangeCode(code: string, context: ExchangeContext): Promise<OAuthToken> {
    const data = await this.http(await this.endpoint('token'), {
      method: 'POST',
      form: {
        grant_type: 'authorization_code',
        code,
        redirect_uri: context.redirectUri,
        client_id: this.config.clientId,
        client_secret: await this.clientSecret(),
        code_verifier: context.codeVerifier,
      },
    })
    return this.parseToken(data)
  }

  /** 标准令牌响应 → OAuthToken */
  protected parseToken(data: Json): OAuthToken {
    if (typeof data.access_token !== 'string' || !data.access_token)
      this.fail('The token response has no access_token', data)
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token || undefined,
      expiresIn: data.expires_in === undefined
        ? undefined
        : Number(data.expires_in),
      idToken: data.id_token || undefined,
      tokenType: data.token_type || undefined,
      scope: data.scope || undefined,
      raw: data,
    }
  }

  /**
   * 请求第三方接口并解析 JSON（兼容 QQ 的 `callback( {...} )` 与 urlencoded 响应）。
   * HTTP 4xx / 5xx 或响应中带 error 字段时抛出 OAuthException。
   */
  protected async http<T = Json>(url: string, options: HttpOptions = {}): Promise<T> {
    const target = new URL(url)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value !== undefined)
        target.searchParams.set(key, String(value))
    }
    const headers: Record<string, string> = { 'accept': 'application/json', 'user-agent': 'hazejs-oauth', ...options.headers }
    if (options.bearer)
      headers.authorization = `Bearer ${options.bearer}`
    let body: string | undefined
    if (options.form) {
      headers['content-type'] = 'application/x-www-form-urlencoded'
      body = new URLSearchParams(Object.entries(options.form).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1] !== '')).toString()
    }
    else if (options.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.json)
    }
    let response: Response
    try {
      response = await this.options.fetch(target.href, { method: options.method ?? 'GET', headers, body })
    }
    catch (error) {
      throw new OAuthException(this.name, `Request to ${target.origin}${target.pathname} failed`, { status: 502, code: 'provider_unreachable', cause: error })
    }
    const text = await response.text()
    const data = parseBody(text)
    if (!response.ok) {
      const status = response.status >= 500
        ? 502
        : 400
      this.fail(`${target.pathname} returned HTTP ${response.status}`, data, status)
    }
    if (data && typeof data.error === 'string' && data.error)
      this.fail(data.error_description || data.error, data)
    // 微信 / 企业微信：HTTP 200 + 非 0 的 errcode
    if (data && typeof data.errcode === 'number' && data.errcode !== 0)
      this.fail(`${target.pathname} failed`, data)
    return data as T
  }

  /** 抛出带第三方错误信息的 OAuthException */
  protected fail(message: string, data?: Json, status?: number): never {
    const detail = data && (data.error_description || data.errmsg || data.msg || data.message || data.error)
    const code = data && (data.error ?? data.errcode ?? data.code ?? data.ret)
    throw new OAuthException(this.name, detail && typeof detail === 'string' && detail !== message
      ? `${message}: ${detail}`
      : message, {
      code: typeof code === 'string' || typeof code === 'number'
        ? code
        : undefined,
      status,
      data,
    })
  }

  /** 回调地址：绝对 URL 原样使用，站内路径以 APP_URL 或请求的 origin 补全 */
  protected resolveRedirect(ctx: HttpContext): string {
    const redirect = this.#redirect ?? this.config.redirect
    if (!redirect)
      throw new Error(`OAuth provider "${this.name}": redirect is required`)
    if (/^https?:\/\//i.test(redirect))
      return redirect
    const base = ctx.config.get<string | undefined>('app.url', undefined) ?? ctx.url.origin
    return `${base.replace(/\/+$/, '')}/${redirect.replace(/^\/+/, '')}`
  }

  /** 回调参数：query，POST（form_post）时合并请求体 */
  protected async callbackParams(ctx: HttpContext): Promise<Record<string, string>> {
    const params: Record<string, string> = {}
    for (const [key, value] of Object.entries(ctx.query())) {
      params[key] = Array.isArray(value)
        ? value[0]
        : value
    }
    if (ctx.method === 'POST') {
      const body = await ctx.body<unknown>()
      if (body && typeof body === 'object') {
        for (const [key, value] of Object.entries(body)) {
          if (typeof value === 'string')
            params[key] = value
        }
      }
    }
    return params
  }

  /** state Cookie 名：`<前缀>_<驱动名>`，多个驱动可以同时进行授权 */
  protected get stateCookie(): string {
    return `${this.options.cookie}_${this.name.replace(/\W/g, '_')}`
  }

  /** state Cookie 的选项（form_post 回调是跨站 POST，Apple 覆盖为 SameSite=None） */
  protected stateCookieOptions(): CookieOptions {
    return {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      maxAge: this.options.stateTtl,
    }
  }

  protected async saveState(ctx: HttpContext, state: OAuthState): Promise<void> {
    if (this.options.stateStore === 'session') {
      (await ctx.startSession()).set(`_oauth.${this.name}`, state)
      return
    }
    ctx.setCookie(this.stateCookie, await seal(state, appKey(ctx.config), this.stateCookie), this.stateCookieOptions())
  }

  /** 取出并清除保存的 state（只能使用一次），过期时返回 undefined */
  protected async pullState(ctx: HttpContext): Promise<OAuthState | undefined> {
    let state: OAuthState | undefined
    if (this.options.stateStore === 'session') {
      state = (await ctx.startSession()).pull<OAuthState>(`_oauth.${this.name}`)
    }
    else {
      const raw = ctx.cookie(this.stateCookie)
      if (raw) {
        state = await unseal<OAuthState>(raw, appKey(ctx.config), this.stateCookie)
        const { maxAge: _, ...options } = this.stateCookieOptions()
        ctx.deleteCookie(this.stateCookie, options)
      }
    }
    return state && state.e > Date.now() / 1000
      ? state
      : undefined
  }
}

function parseBody(text: string): Json {
  const trimmed = text.trim()
  if (!trimmed)
    return {}
  // QQ 旧接口：callback( {...} );
  const jsonp = /^callback\(\s*(\{[\s\S]*\})\s*\);?$/.exec(trimmed)
  try {
    if (jsonp)
      return JSON.parse(jsonp[1])
    if (trimmed.startsWith('{') || trimmed.startsWith('['))
      return JSON.parse(trimmed)
  }
  catch {}
  // urlencoded（GitHub / QQ 未指定 JSON 时）
  if (/^[\w.-]+=/.test(trimmed))
    return Object.fromEntries(new URLSearchParams(trimmed))
  return { body: trimmed }
}
