import type { CacheRepository } from '../cache/repository'
import type { Config } from '../config/config'
import type { HttpContext } from '../http/context'
import type { ResolvedProvider } from './support'
import { CacheManager } from '../cache/manager'
import { BadRequestException, UnauthorizedException } from '../exception/exceptions'
import { definePersistent } from '../persistent'
import { fromBase64Url, toBase64Url } from '../security/key'
import { authConfigOf, currentConfig, fieldOf, resolveProvider } from './support'

type SimpleWebAuthn = typeof import('@simplewebauthn/server')

let loaded: Promise<SimpleWebAuthn> | undefined

/** 按需加载 @simplewebauthn/server（可选依赖） */
function webauthn(): Promise<SimpleWebAuthn> {
  loaded ??= import('@simplewebauthn/server').catch((error: unknown) => {
    loaded = undefined
    throw new Error('Passkeys require @simplewebauthn/server. Install it with: pnpm add @simplewebauthn/server', { cause: error })
  })
  return loaded
}

/** 已注册的通行密钥（公钥为 COSE 格式的 base64url） */
export interface PasskeyCredential {
  /** 凭据 ID（base64url） */
  id: string
  userType: string
  userId: string
  /** 用户起的名字（如“MacBook 指纹”） */
  name: string | null
  publicKey: string
  /** 签名计数器（检测克隆的认证器） */
  counter: number
  transports: string[]
  /** `multiDevice` 为可同步的通行密钥（iCloud 钥匙串、Google 密码管理器等） */
  deviceType: 'singleDevice' | 'multiDevice'
  backedUp: boolean
  /** 认证器型号标识 */
  aaguid: string | null
  createdAt: Date
  lastUsedAt: Date | null
}

/**
 * 凭据存储：内置 `memoryPasskeyStore()`，
 * `@hazejs/orm` 的 `databasePasskeyStore(() => webauthnCredentials)` 存到 webauthn_credentials 表。
 */
export interface PasskeyStore {
  create: (credential: PasskeyCredential) => Promise<void>
  find: (id: string) => Promise<PasskeyCredential | undefined>
  list: (userType: string, userId: string) => Promise<PasskeyCredential[]>
  update: (id: string, values: Partial<Pick<PasskeyCredential, 'name' | 'counter' | 'backedUp' | 'lastUsedAt'>>) => Promise<void>
  delete: (id: string) => Promise<boolean>
}

/** 进程内存储（测试 / 单实例）；name 区分互不共享的存储 */
export function memoryPasskeyStore(name = 'default'): PasskeyStore {
  const rows = definePersistent(`auth:passkeys:${name}`, () => new Map<string, PasskeyCredential>())
  const copy = (row: PasskeyCredential): PasskeyCredential => ({
    ...row,
    transports: [...row.transports],
  })
  return {
    async create(credential) {
      rows.set(credential.id, copy(credential))
    },
    async find(id) {
      const row = rows.get(id)
      return row && copy(row)
    },
    async list(type, userId) {
      return [
        ...rows.values(),
      ].filter(row => row.userType === type && row.userId === userId).map(copy)
    },
    async update(id, values) {
      const row = rows.get(id)
      if (row)
        Object.assign(row, values)
    },
    async delete(id) {
      return rows.delete(id)
    },
  }
}

export interface PasskeyConfig {
  provider?: string
  store?: PasskeyStore
  /** 依赖方名称（浏览器提示中显示），默认 config/app.ts 的 name */
  rpName?: string
  /** 依赖方 ID（域名，不含协议和端口），默认取 APP_URL 或请求的主机名 */
  rpID?: string
  /** 允许的来源（含协议与端口），默认取 APP_URL 或请求的 origin */
  origin?: string | string[]
  /**
   * 挑战（challenge）的保存位置：
   * - `session`（默认）：会话中，适合浏览器同源场景；
   * - `cache`：缓存中，以挑战值为键，适合无会话的 API（Bearer 令牌）
   */
  challenge?: 'session' | 'cache'
  /** challenge 为 cache 时使用的缓存存储名 */
  cacheStore?: string
  /** 浏览器等待用户操作的时长（毫秒），默认 60000；挑战同样在此时间后失效 */
  timeout?: number
  /** 用户验证（指纹 / PIN）：默认 `preferred` */
  userVerification?: 'required' | 'preferred' | 'discouraged'
  /** 可发现凭据（无需先输入用户名即可登录）：默认 `preferred` */
  residentKey?: 'required' | 'preferred' | 'discouraged'
  /** 用户名字段（认证器中显示），默认 `email` */
  userName?: string
  /** 显示名字段，默认 `name` */
  displayName?: string
}

/** 浏览器 `@simplewebauthn/browser` 返回的 JSON（startRegistration / startAuthentication 的结果） */
export interface PasskeyResponseJSON {
  id: string
  rawId: string
  type: string
  response: { clientDataJSON: string, [key: string]: unknown }
  [key: string]: unknown
}

/** 传给浏览器 startRegistration / startAuthentication 的选项 JSON */
export type PasskeyOptionsJSON = Record<string, unknown> & { challenge: string }

type ChallengeKind = 'registration' | 'authentication'

interface StoredChallenge {
  challenge: string
  expiresAt: number
  /** 注册时为发起注册的用户 */
  userId?: string
}

/** 从 clientDataJSON 中取出挑战值 */
function challengeOf(response: PasskeyResponseJSON): string | undefined {
  try {
    const data = JSON.parse(new TextDecoder().decode(fromBase64Url(response.response.clientDataJSON))) as { challenge?: unknown }
    return typeof data.challenge === 'string'
      ? data.challenge
      : undefined
  }
  catch {
    return undefined
  }
}

/** WebAuthn 通行密钥：注册与登录的选项生成和响应校验（基于 @simplewebauthn/server） */
export class PasskeyManager<U = unknown> {
  readonly #config: PasskeyConfig
  readonly #appConfig: Config
  readonly #users: ResolvedProvider<U>
  readonly #store: PasskeyStore
  readonly #ctx: HttpContext | undefined

  constructor(ctx?: HttpContext, appConfig: Config = ctx?.config ?? currentConfig()) {
    this.#ctx = ctx
    this.#appConfig = appConfig
    const auth = authConfigOf(appConfig)
    this.#config = auth.passkeys ?? {}
    this.#users = resolveProvider<U>(auth, this.#config.provider)
    this.#store = this.#config.store ?? memoryPasskeyStore()
  }

  get store(): PasskeyStore {
    return this.#store
  }

  get #context(): HttpContext {
    if (!this.#ctx)
      throw new Error('Passkey ceremonies need the request context: use Passkeys.*(ctx, ...)')
    return this.#ctx
  }

  get #timeout(): number {
    return this.#config.timeout ?? 60_000
  }

  /** APP_URL 或当前请求的地址 */
  #baseUrl(): URL {
    const url = this.#appConfig.get<string | undefined>('app.url', undefined)
    return new URL(url ?? this.#context.req.url)
  }

  #rpID(): string {
    return this.#config.rpID ?? this.#baseUrl().hostname
  }

  #origin(): string | string[] {
    return this.#config.origin ?? this.#baseUrl().origin
  }

  // ---------------------------------------------------------------- 挑战

  async #saveChallenge(kind: ChallengeKind, value: StoredChallenge): Promise<void> {
    if (this.#config.challenge === 'cache') {
      await this.#cache().set(`webauthn:${kind}:${value.challenge}`, value, Math.ceil(this.#timeout / 1000))
      return
    }
    const session = await this.#context.startSession()
    session.set(`_webauthn_${kind}`, value)
  }

  /** 取出并作废挑战（一次性），与响应中的挑战值一致且未过期才返回 */
  async #consumeChallenge(kind: ChallengeKind, response: PasskeyResponseJSON): Promise<StoredChallenge | undefined> {
    const challenge = challengeOf(response)
    if (!challenge)
      return undefined
    let stored: StoredChallenge | undefined
    if (this.#config.challenge === 'cache') {
      stored = await this.#cache().pull<StoredChallenge>(`webauthn:${kind}:${challenge}`)
    }
    else {
      const session = await this.#context.startSession()
      stored = session.pull<StoredChallenge>(`_webauthn_${kind}`)
    }
    if (!stored || stored.challenge !== challenge || stored.expiresAt <= Date.now())
      return undefined
    // 会话模式下再在缓存中登记一次：默认的 cookie 会话驱动把会话存在客户端，重放旧 Cookie 也不能复用挑战
    if (this.#config.challenge !== 'cache' && !(await this.#cache().add(`webauthn:used:${challenge}`, 1, Math.ceil(this.#timeout / 1000))))
      return undefined
    return stored
  }

  #cache(): CacheRepository {
    return this.#context.make(CacheManager).store(this.#config.cacheStore)
  }

  // ---------------------------------------------------------------- 注册

  /** 注册选项（传给浏览器的 startRegistration），已注册的凭据会被排除 */
  async registrationOptions(user: U, options: { authenticatorAttachment?: 'platform' | 'cross-platform' } = {}): Promise<PasskeyOptionsJSON> {
    const { generateRegistrationOptions } = await webauthn()
    const ref = this.#users.ref(user)
    const existing = await this.#store.list(ref.type, ref.id)
    const userName = fieldOf(user, this.#config.userName ?? 'email')
    const displayName = fieldOf(user, this.#config.displayName ?? 'name')
    const result = await generateRegistrationOptions({
      rpName: this.#config.rpName ?? this.#appConfig.get<string>('app.name', 'hazejs'),
      rpID: this.#rpID(),
      // 用户句柄：稳定的用户 ID（同一账号在认证器中覆盖而不是重复保存）
      userID: new TextEncoder().encode(`${ref.type}:${ref.id}`),
      userName: typeof userName === 'string' && userName
        ? userName
        : ref.id,
      userDisplayName: typeof displayName === 'string'
        ? displayName
        : '',
      timeout: this.#timeout,
      attestationType: 'none',
      excludeCredentials: existing.map(credential => ({ id: credential.id, transports: credential.transports })),
      authenticatorSelection: {
        residentKey: this.#config.residentKey ?? 'preferred',
        userVerification: this.#config.userVerification ?? 'preferred',
        authenticatorAttachment: options.authenticatorAttachment,
      },
    })
    await this.#saveChallenge('registration', { challenge: result.challenge, expiresAt: Date.now() + this.#timeout, userId: ref.id })
    return result as unknown as PasskeyOptionsJSON
  }

  /** 校验注册响应并保存凭据；失败抛出 400 */
  async verifyRegistration(user: U, response: PasskeyResponseJSON, options: { name?: string } = {}): Promise<PasskeyCredential> {
    const { verifyRegistrationResponse } = await webauthn()
    const ref = this.#users.ref(user)
    const stored = await this.#consumeChallenge('registration', response)
    if (!stored || stored.userId !== ref.id)
      throw new BadRequestException('通行密钥注册已过期，请重试')
    let verification: Awaited<ReturnType<SimpleWebAuthn['verifyRegistrationResponse']>>
    try {
      verification = await verifyRegistrationResponse({
        response: response as never,
        expectedChallenge: stored.challenge,
        expectedOrigin: this.#origin(),
        expectedRPID: this.#rpID(),
        requireUserVerification: this.#config.userVerification === 'required',
      })
    }
    catch (error) {
      throw new BadRequestException('通行密钥注册失败', { cause: error })
    }
    if (!verification.verified)
      throw new BadRequestException('通行密钥注册失败')
    const info = verification.registrationInfo
    if (await this.#store.find(info.credential.id))
      throw new BadRequestException('该通行密钥已注册')
    const credential: PasskeyCredential = {
      id: info.credential.id,
      userType: ref.type,
      userId: ref.id,
      name: options.name ?? null,
      publicKey: toBase64Url(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
      aaguid: info.aaguid ?? null,
      createdAt: new Date(),
      lastUsedAt: null,
    }
    await this.#store.create(credential)
    return credential
  }

  // ---------------------------------------------------------------- 登录

  /** 登录选项（传给浏览器的 startAuthentication）；传入 user 时只允许其已注册的凭据，否则使用可发现凭据 */
  async authenticationOptions(options: { user?: U } = {}): Promise<PasskeyOptionsJSON> {
    const { generateAuthenticationOptions } = await webauthn()
    const allow = options.user === undefined
      ? undefined
      : await this.credentials(options.user)
    const result = await generateAuthenticationOptions({
      rpID: this.#rpID(),
      timeout: this.#timeout,
      userVerification: this.#config.userVerification ?? 'preferred',
      allowCredentials: allow?.map(credential => ({ id: credential.id, transports: credential.transports })),
    })
    await this.#saveChallenge('authentication', {
      challenge: result.challenge,
      expiresAt: Date.now() + this.#timeout,
      userId: options.user === undefined
        ? undefined
        : this.#users.ref(options.user).id,
    })
    return result as unknown as PasskeyOptionsJSON
  }

  /** 校验登录响应，更新签名计数器，返回用户与凭据；失败抛出 401 */
  async verifyAuthentication(response: PasskeyResponseJSON): Promise<{ user: U, credential: PasskeyCredential }> {
    const { verifyAuthenticationResponse } = await webauthn()
    const stored = await this.#consumeChallenge('authentication', response)
    if (!stored)
      throw new UnauthorizedException('通行密钥登录已过期，请重试')
    const credential = typeof response.id === 'string'
      ? await this.#store.find(response.id)
      : undefined
    if (!credential || credential.userType !== this.#users.type || (stored.userId !== undefined && stored.userId !== credential.userId))
      throw new UnauthorizedException('通行密钥无效')
    let verification: Awaited<ReturnType<SimpleWebAuthn['verifyAuthenticationResponse']>>
    try {
      verification = await verifyAuthenticationResponse({
        response: response as never,
        expectedChallenge: stored.challenge,
        expectedOrigin: this.#origin(),
        expectedRPID: this.#rpID(),
        credential: {
          id: credential.id,
          publicKey: fromBase64Url(credential.publicKey) as Uint8Array<ArrayBuffer>,
          counter: credential.counter,
          transports: credential.transports as never,
        },
        requireUserVerification: this.#config.userVerification === 'required',
      })
    }
    catch (error) {
      throw new UnauthorizedException('通行密钥验证失败', { cause: error })
    }
    if (!verification.verified)
      throw new UnauthorizedException('通行密钥验证失败')
    const user = await this.#users.provider.retrieveById(credential.userId) ?? undefined
    if (user === undefined)
      throw new UnauthorizedException('通行密钥无效')
    const values = {
      counter: verification.authenticationInfo.newCounter,
      backedUp: verification.authenticationInfo.credentialBackedUp,
      lastUsedAt: new Date(),
    }
    await this.#store.update(credential.id, values)
    return {
      user,
      credential: {
        ...credential,
        ...values,
      },
    }
  }

  // ---------------------------------------------------------------- 管理

  /** 用户已注册的通行密钥 */
  credentials(user: U): Promise<PasskeyCredential[]> {
    const ref = this.#users.ref(user)
    return this.#store.list(ref.type, ref.id)
  }

  /** 重命名（只能修改自己的凭据） */
  async rename(user: U, id: string, name: string): Promise<boolean> {
    if (!(await this.#owned(user, id)))
      return false
    await this.#store.update(id, { name })
    return true
  }

  /** 删除（只能删除自己的凭据） */
  async delete(user: U, id: string): Promise<boolean> {
    return await this.#owned(user, id) && this.#store.delete(id)
  }

  async #owned(user: U, id: string): Promise<boolean> {
    const ref = this.#users.ref(user)
    const credential = await this.#store.find(id)
    return credential !== undefined && credential.userType === ref.type && credential.userId === ref.id
  }
}

/**
 * 通行密钥门面（需安装 `@simplewebauthn/server`；浏览器端使用 `@simplewebauthn/browser`）：
 *
 * ```ts
 * // 注册（已登录）
 * const options = await Passkeys.registrationOptions(ctx, user)
 * await Passkeys.verifyRegistration(ctx, user, await ctx.body(), { name: 'MacBook' })
 * // 登录
 * const options = await Passkeys.authenticationOptions(ctx)
 * const user = await Passkeys.login(ctx, await ctx.body())
 * ```
 */
export const Passkeys = {
  registrationOptions: <U>(ctx: HttpContext, user: U, options?: { authenticatorAttachment?: 'platform' | 'cross-platform' }): Promise<PasskeyOptionsJSON> =>
    new PasskeyManager<U>(ctx).registrationOptions(user, options),
  verifyRegistration: <U>(ctx: HttpContext, user: U, response: PasskeyResponseJSON, options?: { name?: string }): Promise<PasskeyCredential> =>
    new PasskeyManager<U>(ctx).verifyRegistration(user, response, options),
  authenticationOptions: <U>(ctx: HttpContext, options?: { user?: U }): Promise<PasskeyOptionsJSON> =>
    new PasskeyManager<U>(ctx).authenticationOptions(options),
  verifyAuthentication: <U = unknown>(ctx: HttpContext, response: PasskeyResponseJSON): Promise<{ user: U, credential: PasskeyCredential }> =>
    new PasskeyManager<U>(ctx).verifyAuthentication(response),
  /** 校验登录响应并通过 Session Guard 登录（JWT / token 场景请用 verifyAuthentication 后自行签发） */
  login: async <U = unknown>(ctx: HttpContext, response: PasskeyResponseJSON, options: { guard?: string } = {}): Promise<U> => {
    const { user } = await new PasskeyManager<U>(ctx).verifyAuthentication(response)
    await ctx.auth.session(options.guard).login(user as never)
    return user
  },
  credentials: <U>(user: U): Promise<PasskeyCredential[]> => new PasskeyManager<U>().credentials(user),
  rename: <U>(user: U, id: string, name: string): Promise<boolean> => new PasskeyManager<U>().rename(user, id, name),
  delete: <U>(user: U, id: string): Promise<boolean> => new PasskeyManager<U>().delete(user, id),
  manager: <U = unknown>(ctx?: HttpContext): PasskeyManager<U> => new PasskeyManager<U>(ctx),
}
