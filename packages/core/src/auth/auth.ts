import type { ResolvedConfigSchema } from '../config/config'
import type { HttpContext } from '../http/context'
import type { AuthConfig } from './config'
import type { Guard } from './guards'
import type { UserProvider } from './provider'
import type { PersonalAccessToken } from './tokens'
import { JwtGuard, SessionGuard, TokenGuard } from './guards'

/** 认证用户的类型：由 config/auth.ts 的 providers 推导（typegen 生成配置类型后生效） */
export type AuthUser = ResolvedConfigSchema extends { auth: { providers: infer P } }
  ? P[keyof P] extends UserProvider<infer U> ? U : unknown
  : unknown

export type AnyGuard<U = AuthUser> = JwtGuard<U> | SessionGuard<U> | TokenGuard<U>

/**
 * 请求内的认证入口（`ctx.auth`）。不指定 Guard 时使用默认 Guard（`auth:<guard>` 中间件通过的那个优先）。
 */
export class Auth<U = AuthUser> {
  readonly #ctx: HttpContext
  readonly #guards = new Map<string, AnyGuard<U>>()
  #current: string | undefined

  constructor(ctx: HttpContext) {
    this.#ctx = ctx
  }

  get config(): AuthConfig {
    const config = this.#ctx.config.get<AuthConfig | undefined>('auth', undefined)
    if (!config?.guards)
      throw new Error('Auth is not configured: create config/auth.ts with defineAuthConfig()')
    return config
  }

  /** 当前默认 Guard 的名字 */
  get defaultGuard(): string {
    return this.#current ?? this.config.default
  }

  guard(name: string = this.defaultGuard): AnyGuard<U> {
    let guard = this.#guards.get(name)
    if (!guard) {
      const config = this.config.guards[name]
      if (!config)
        throw new Error(`Auth guard "${name}" is not defined in config/auth.ts`)
      const provider = this.config.providers[config.provider] as UserProvider<U> | undefined
      if (!provider)
        throw new Error(`Auth provider "${config.provider}" (guard "${name}") is not defined in config/auth.ts`)
      guard = config.driver === 'jwt'
        ? new JwtGuard<U>(name, this.#ctx, provider, config)
        : config.driver === 'token'
          ? new TokenGuard<U>(name, this.#ctx, provider, config)
          : new SessionGuard<U>(name, this.#ctx, provider)
      this.#guards.set(name, guard)
    }
    return guard
  }

  /** 取 JWT Guard（类型收窄，可 `login()` 签发令牌） */
  jwt(name: string = this.defaultGuard): JwtGuard<U> {
    const guard = this.guard(name)
    if (!(guard instanceof JwtGuard))
      throw new TypeError(`Auth guard "${name}" is not a jwt guard`)
    return guard
  }

  /** 取 Session Guard */
  session(name: string = this.defaultGuard): SessionGuard<U> {
    const guard = this.guard(name)
    if (!(guard instanceof SessionGuard))
      throw new TypeError(`Auth guard "${name}" is not a session guard`)
    return guard
  }

  /** 取个人访问令牌 Guard（签发、列出、吊销令牌） */
  token(name?: string): TokenGuard<U> {
    name ??= this.#tokenGuardName()
    const guard = this.guard(name)
    if (!(guard instanceof TokenGuard))
      throw new TypeError(`Auth guard "${name}" is not a token guard`)
    return guard
  }

  /**
   * 当前请求是否具备该能力：
   * - 通过 token Guard 认证：检查令牌的 abilities；
   * - 通过 jwt / session 认证（第一方客户端）：始终为 true；
   * - 未认证：false。
   */
  async tokenCan(ability: string): Promise<boolean> {
    const guard = this.guard()
    if (guard instanceof TokenGuard)
      return guard.tokenCan(ability)
    return guard.check()
  }

  /** 当前请求使用的个人访问令牌（不是 token Guard 认证时为 undefined） */
  async currentAccessToken(): Promise<PersonalAccessToken | undefined> {
    const guard = this.guard()
    return guard instanceof TokenGuard
      ? guard.currentAccessToken()
      : undefined
  }

  #tokenGuardName(): string {
    if (this.config.guards[this.defaultGuard]?.driver === 'token')
      return this.defaultGuard
    const name = Object.keys(this.config.guards).find(key => this.config.guards[key].driver === 'token')
    if (!name)
      throw new Error('No token guard is defined in config/auth.ts (driver: \'token\')')
    return name
  }

  /** 本次请求后续使用的默认 Guard（auth 中间件在某个 Guard 通过后设置） */
  shouldUse(name: string): this {
    this.#current = name
    return this
  }

  user(): Promise<U | undefined> {
    return this.guard().user()
  }

  check(): Promise<boolean> {
    return this.guard().check()
  }

  id(): Promise<string | number | undefined> {
    return this.guard().id()
  }

  logout(): Promise<void> {
    return this.guard().logout()
  }
}

export type { Guard }
