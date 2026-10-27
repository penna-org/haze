import type { JWTPayload } from 'jose'
import type { HttpContext } from '../http/context'
import type { WebCryptoKey } from '../security/key'
import type { JwtGuardConfig } from './config'
import type { Credentials, UserProvider } from './provider'
import { importPKCS8, importSPKI, jwtVerify, SignJWT } from 'jose'
import { appKey } from '../security/key'
import { parseDuration } from '../utils'

export interface Guard<U = unknown> {
  readonly name: string
  /** 当前请求的用户（同一请求内缓存） */
  user: () => Promise<U | undefined>
  check: () => Promise<boolean>
  id: () => Promise<string | number | undefined>
  /** 校验凭据，成功返回用户（不登录） */
  validate: (credentials: Credentials) => Promise<U | undefined>
  logout: () => Promise<void>
  /** 直接指定当前用户（测试 actingAs、已在别处完成认证时） */
  setUser: (user: U | undefined) => void
}

abstract class BaseGuard<U> implements Guard<U> {
  #user: Promise<U | undefined> | undefined

  constructor(readonly name: string, protected ctx: HttpContext, protected provider: UserProvider<U>) {}

  user(): Promise<U | undefined> {
    this.#user ??= this.resolve()
    return this.#user
  }

  async check(): Promise<boolean> {
    return (await this.user()) !== undefined
  }

  async id(): Promise<string | number | undefined> {
    const user = await this.user()
    return user === undefined
      ? undefined
      : this.provider.getId(user)
  }

  async validate(credentials: Credentials): Promise<U | undefined> {
    const user = await this.provider.retrieveByCredentials(credentials) ?? undefined
    return user !== undefined && await this.provider.validateCredentials(user, credentials)
      ? user
      : undefined
  }

  setUser(user: U | undefined): void {
    this.#user = Promise.resolve(user)
  }

  abstract logout(): Promise<void>
  protected abstract resolve(): Promise<U | undefined>
}

export interface IssuedToken {
  token: string
  type: 'Bearer'
  /** 秒 */
  expiresIn: number
  expiresAt: Date
}

/** JWT（Bearer）认证：无状态，令牌中 sub 为用户 ID */
export class JwtGuard<U = unknown> extends BaseGuard<U> {
  #payload: JWTPayload | undefined

  constructor(name: string, ctx: HttpContext, provider: UserProvider<U>, readonly config: JwtGuardConfig) {
    super(name, ctx, provider)
  }

  /** 为用户签发令牌，可附加自定义声明 */
  async login(user: U, claims: Record<string, unknown> = {}): Promise<IssuedToken> {
    const algorithm = this.config.algorithm ?? 'HS256'
    const expiresIn = parseDuration(this.config.expiresIn ?? '2h')
    const now = Math.floor(Date.now() / 1000)
    let jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: algorithm, typ: 'JWT' })
      .setSubject(String(this.provider.getId(user)))
      .setIssuedAt(now)
      .setExpirationTime(now + expiresIn)
      .setJti(crypto.randomUUID())
    if (this.config.issuer)
      jwt = jwt.setIssuer(this.config.issuer)
    if (this.config.audience)
      jwt = jwt.setAudience(this.config.audience)
    const token = await jwt.sign(await this.#key('sign'))
    this.setUser(user)
    return {
      token,
      type: 'Bearer',
      expiresIn,
      expiresAt: new Date((now + expiresIn) * 1000),
    }
  }

  /** 校验凭据并签发令牌；失败返回 undefined */
  async attempt(credentials: Credentials, claims?: Record<string, unknown>): Promise<IssuedToken | undefined> {
    const user = await this.validate(credentials)
    return user === undefined
      ? undefined
      : this.login(user, claims)
  }

  /** 当前请求令牌中的声明（校验通过后可用） */
  async payload(): Promise<JWTPayload | undefined> {
    await this.user()
    return this.#payload
  }

  /** JWT 无状态：退出只清除本次请求的用户，令牌在过期前仍然有效（需要立即失效时请在业务中维护黑名单） */
  async logout(): Promise<void> {
    this.setUser(undefined)
  }

  protected async resolve(): Promise<U | undefined> {
    const token = this.#token()
    if (!token)
      return undefined
    try {
      const { payload } = await jwtVerify(token, await this.#key('verify'), {
        algorithms: [this.config.algorithm ?? 'HS256'],
        issuer: this.config.issuer,
        audience: this.config.audience,
      })
      if (payload.sub === undefined)
        return undefined
      this.#payload = payload
      return await this.provider.retrieveById(payload.sub) ?? undefined
    }
    catch {
      // 过期、签名不符、格式错误均视为未登录
      return undefined
    }
  }

  #token(): string | undefined {
    const header = this.ctx.header('authorization')
    const match = header && /^Bearer\s+(\S+)$/i.exec(header)
    if (match)
      return match[1]
    return this.config.cookie
      ? this.ctx.cookie(this.config.cookie)
      : undefined
  }

  async #key(use: 'sign' | 'verify'): Promise<Uint8Array | WebCryptoKey> {
    const algorithm = this.config.algorithm ?? 'HS256'
    if (algorithm.startsWith('HS'))
      return new TextEncoder().encode(this.config.secret ?? appKey(this.ctx.config))
    const pem = use === 'sign'
      ? this.config.privateKey
      : this.config.publicKey
    if (!pem) {
      throw new Error(`JWT guard "${this.name}": ${use === 'sign'
        ? 'privateKey'
        : 'publicKey'} is required for ${algorithm}`)
    }
    return use === 'sign'
      ? importPKCS8(pem, algorithm)
      : importSPKI(pem, algorithm)
  }
}

/** Session 认证：用户 ID 存在会话中（浏览器同源场景） */
export class SessionGuard<U = unknown> extends BaseGuard<U> {
  get #key(): string {
    return `auth.${this.name}`
  }

  /** 登录：重新生成会话 ID 并记录用户 */
  async login(user: U): Promise<void> {
    const session = await this.ctx.startSession()
    session.regenerate()
    session.set(this.#key, this.provider.getId(user))
    this.setUser(user)
  }

  /** 校验凭据并登录；返回是否成功 */
  async attempt(credentials: Credentials): Promise<boolean> {
    const user = await this.validate(credentials)
    if (user === undefined)
      return false
    await this.login(user)
    return true
  }

  async logout(): Promise<void> {
    const session = await this.ctx.startSession()
    session.invalidate()
    this.setUser(undefined)
  }

  protected async resolve(): Promise<U | undefined> {
    const id = (await this.ctx.startSession()).get<string | number>(this.#key)
    return id === undefined
      ? undefined
      : await this.provider.retrieveById(id) ?? undefined
  }
}
