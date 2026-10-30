import type { CacheRepository } from '../cache/repository'
import type { Config } from '../config/config'
import type { HttpContext } from '../http/context'
import type { SessionGuard } from './guards'
import type { Credentials } from './provider'
import type { ResolvedProvider } from './support'
import { CacheManager } from '../cache/manager'
import { ConflictException } from '../exception/exceptions'
import { definePersistent } from '../persistent'
import { Encrypter } from '../security/crypt'
import { safeEqual } from '../security/key'
import { parseDuration } from '../utils'
import { TwoFactorDisabled, TwoFactorEnabled, TwoFactorFailed } from './events'
import { authConfigOf, currentConfig, fieldOf, resolveProvider, sha256 } from './support'

// ---------------------------------------------------------------- RFC 4648 base32

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

/** base32 编码（无填充，认证器 App 通用的格式） */
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0)
    output += ALPHABET[(value << (5 - bits)) & 31]
  return output
}

/** base32 解码（忽略大小写、空格与填充） */
export function base32Decode(input: string): Uint8Array {
  const clean = input.toUpperCase().replace(/[\s=-]/g, '')
  const bytes: number[] = []
  let bits = 0
  let value = 0
  for (const char of clean) {
    const index = ALPHABET.indexOf(char)
    if (index === -1)
      throw new Error(`Invalid base32 character "${char}"`)
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return new Uint8Array(bytes)
}

// ---------------------------------------------------------------- RFC 4226 / 6238

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512'

export interface TotpOptions {
  /** 位数，默认 6 */
  digits?: number
  /** 时间步长（秒），默认 30 */
  period?: number
  /** HMAC 算法，默认 SHA1（绝大多数认证器 App 只支持 SHA1） */
  algorithm?: TotpAlgorithm
  /** 当前时间（毫秒），默认 Date.now()（测试用） */
  time?: number
}

const HASHES: Record<TotpAlgorithm, string> = { SHA1: 'SHA-1', SHA256: 'SHA-256', SHA512: 'SHA-512' }

function secretBytes(secret: string | Uint8Array): Uint8Array {
  return typeof secret === 'string'
    ? base32Decode(secret)
    : secret
}

/** HOTP（RFC 4226）：counter 为 8 字节大端整数 */
export async function hotp(secret: string | Uint8Array, counter: number, options: Pick<TotpOptions, 'digits' | 'algorithm'> = {}): Promise<string> {
  const digits = options.digits ?? 6
  const message = new Uint8Array(8)
  const view = new DataView(message.buffer)
  view.setUint32(0, Math.floor(counter / 2 ** 32))
  view.setUint32(4, counter >>> 0)
  const key = await crypto.subtle.importKey('raw', secretBytes(secret) as Uint8Array<ArrayBuffer>, { name: 'HMAC', hash: HASHES[options.algorithm ?? 'SHA1'] }, false, ['sign'])
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message))
  // 动态截断
  const offset = mac[mac.length - 1] & 0x0F
  const binary = ((mac[offset] & 0x7F) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3]
  return String(binary % 10 ** digits).padStart(digits, '0')
}

/** 当前时间所在的时间步 */
export function totpStep(options: Pick<TotpOptions, 'period' | 'time'> = {}): number {
  return Math.floor((options.time ?? Date.now()) / 1000 / (options.period ?? 30))
}

/** 计算 TOTP（RFC 6238） */
export function totp(secret: string | Uint8Array, options: TotpOptions = {}): Promise<string> {
  return hotp(secret, totpStep(options), options)
}

export interface VerifyTotpOptions extends TotpOptions {
  /** 允许前后偏差的时间步数，默认 1（±30 秒） */
  window?: number
  /** 上次成功使用的时间步：不接受该步及更早的验证码（防重放） */
  afterStep?: number | null
}

/** 校验验证码，返回匹配的时间步（不匹配为 undefined） */
export async function verifyTotp(secret: string | Uint8Array, code: string, options: VerifyTotpOptions = {}): Promise<number | undefined> {
  const digits = options.digits ?? 6
  const normalized = code.replace(/\s/g, '')
  if (!new RegExp(`^\\d{${digits}}$`).test(normalized))
    return undefined
  const current = totpStep(options)
  const window = options.window ?? 1
  let matched: number | undefined
  // 遍历整个窗口（不提前返回），减少时间差异
  for (let step = current - window; step <= current + window; step++) {
    if (step < 0 || (options.afterStep !== undefined && options.afterStep !== null && step <= options.afterStep))
      continue
    if (safeEqual(await hotp(secret, step, options), normalized) && matched === undefined)
      matched = step
  }
  return matched
}

/** 生成随机密钥（base32，默认 20 字节 = 160 位，RFC 4226 推荐） */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(bytes)))
}

export interface OtpauthUriOptions extends Pick<TotpOptions, 'digits' | 'period' | 'algorithm'> {
  secret: string
  /** 发行方（App 中显示的服务名） */
  issuer: string
  /** 账号（邮箱 / 用户名） */
  account: string
}

/** 认证器 App 扫码用的 `otpauth://totp/...` 地址（在前端用二维码库渲染） */
export function otpauthUri(options: OtpauthUriOptions): string {
  const label = `${encodeURIComponent(options.issuer)}:${encodeURIComponent(options.account)}`
  const query = new URLSearchParams({
    secret: options.secret,
    issuer: options.issuer,
    algorithm: options.algorithm ?? 'SHA1',
    digits: String(options.digits ?? 6),
    period: String(options.period ?? 30),
  })
  return `otpauth://totp/${label}?${query.toString().replace(/\+/g, '%20')}`
}

/** 生成恢复码（`xxxxx-xxxxx`，小写 base32 字符） */
export function generateRecoveryCodes(count = 8): string[] {
  return Array.from({ length: count }, () => {
    const code = base32Encode(crypto.getRandomValues(new Uint8Array(7))).slice(0, 10).toLowerCase()
    return `${code.slice(0, 5)}-${code.slice(5)}`
  })
}

// ---------------------------------------------------------------- 存储

/** 两步验证记录：secret 以 APP_KEY 加密，恢复码只保存 SHA-256 摘要 */
export interface TwoFactorRecord {
  secret: string
  recoveryCodes: string[]
  /** 确认（首次输入正确验证码）的时间；为 null 时尚未启用 */
  confirmedAt: Date | null
  /** 上次成功使用的时间步（防重放） */
  lastUsedStep: number | null
}

/**
 * 两步验证存储：内置 `memoryTwoFactorStore()`，
 * `@hazejs/orm` 的 `databaseTwoFactorStore(() => twoFactorSecrets)` 存到 two_factor_secrets 表。
 */
export interface TwoFactorStore {
  get: (userType: string, userId: string) => Promise<TwoFactorRecord | undefined>
  set: (userType: string, userId: string, record: TwoFactorRecord) => Promise<void>
  delete: (userType: string, userId: string) => Promise<void>
}

/** 进程内存储（测试 / 单实例）；name 区分互不共享的存储 */
export function memoryTwoFactorStore(name = 'default'): TwoFactorStore {
  const rows = definePersistent(`auth:two-factor:${name}`, () => new Map<string, TwoFactorRecord>())
  const key = (type: string, id: string): string => `${type}:${id}`
  return {
    async get(type, id) {
      const row = rows.get(key(type, id))
      return row && {
        ...row,
        recoveryCodes: [...row.recoveryCodes],
      }
    },
    async set(type, id, record) {
      rows.set(key(type, id), {
        ...record,
        recoveryCodes: [...record.recoveryCodes],
      })
    },
    async delete(type, id) {
      rows.delete(key(type, id))
    },
  }
}

export interface TwoFactorConfig extends Pick<TotpOptions, 'digits' | 'period' | 'algorithm'> {
  provider?: string
  store?: TwoFactorStore
  /** 认证器 App 中显示的服务名，默认 config/app.ts 的 name */
  issuer?: string
  /** 允许偏差的时间步数，默认 1 */
  window?: number
  /** 恢复码数量，默认 8 */
  recoveryCodes?: number
  /** 账号名字段（otpauth 地址中的 account），默认 `email` */
  account?: string
  /** 登录后等待输入验证码的有效期，默认 `5m` */
  challengeTtl?: string | number
  /**
   * 允许输错验证码的次数，默认 5。次数按用户记在缓存中（不在客户端持有的会话 Cookie 里），保留 challengeTtl；
   * 超过后在此期间无法完成挑战，重新输入密码也不行
   */
  maxAttempts?: number
  /** 记录失败次数的缓存存储（config/cache.ts 中的名称），默认使用默认存储 */
  cacheStore?: string
}

export interface TwoFactorSetup {
  /** base32 密钥（手动输入用） */
  secret: string
  /** otpauth:// 地址（前端渲染为二维码） */
  uri: string
  /** 明文恢复码，只在此时可见 */
  recoveryCodes: string[]
}

export type TwoFactorAttempt<U>
  = | { status: 'authenticated', user: U }
    | { status: 'two-factor', user: U }
    | { status: 'failed' }

export interface ChallengeInput {
  code?: string
  recoveryCode?: string
}

interface PendingLogin {
  guard: string
  id: string | number
  expiresAt: number
}

const PENDING_KEY = '_two_factor_login'

/** TOTP 两步验证（RFC 6238）：启用 / 确认 / 校验 / 恢复码，以及 Session 登录的挑战流程 */
export class TwoFactorAuthenticator<U = unknown> {
  readonly #config: TwoFactorConfig
  readonly #appConfig: Config
  readonly #users: ResolvedProvider<U>
  readonly #store: TwoFactorStore

  constructor(appConfig: Config = currentConfig()) {
    this.#appConfig = appConfig
    const auth = authConfigOf(appConfig)
    this.#config = auth.twoFactor ?? {}
    this.#users = resolveProvider<U>(auth, this.#config.provider)
    this.#store = this.#config.store ?? memoryTwoFactorStore()
  }

  get #encrypter(): Encrypter {
    return Encrypter.fromConfig(this.#appConfig)
  }

  #totp(): VerifyTotpOptions {
    return {
      digits: this.#config.digits,
      period: this.#config.period,
      algorithm: this.#config.algorithm,
      window: this.#config.window,
    }
  }

  async #record(user: U): Promise<TwoFactorRecord | undefined> {
    const ref = this.#users.ref(user)
    return this.#store.get(ref.type, ref.id)
  }

  async #save(user: U, record: TwoFactorRecord): Promise<void> {
    const ref = this.#users.ref(user)
    await this.#store.set(ref.type, ref.id, record)
  }

  async #hashCodes(codes: string[]): Promise<string[]> {
    return Promise.all(codes.map(code => sha256(code.trim().toLowerCase())))
  }

  /**
   * 生成新密钥与恢复码（尚未启用，需用 confirm() 输入一次正确的验证码）。
   * 已启用（已确认）时抛出 409，避免持有会话的人悄悄关掉两步验证；确需更换密钥时传 `{ force: true }`
   * （建议先用 verify() 校验一次当前的验证码）。
   */
  async enable(user: U, options: { force?: boolean } = {}): Promise<TwoFactorSetup> {
    if (!options.force && (await this.#record(user))?.confirmedAt)
      throw new ConflictException('两步验证已启用')
    const secret = generateTotpSecret()
    const recoveryCodes = generateRecoveryCodes(this.#config.recoveryCodes ?? 8)
    await this.#save(user, {
      secret: await this.#encrypter.encryptString(secret),
      recoveryCodes: await this.#hashCodes(recoveryCodes),
      confirmedAt: null,
      lastUsedStep: null,
    })
    return {
      secret,
      uri: this.#uri(user, secret),
      recoveryCodes,
    }
  }

  #uri(user: U, secret: string): string {
    const account = fieldOf(user, this.#config.account ?? 'email')
    return otpauthUri({
      secret,
      issuer: this.#config.issuer ?? this.#appConfig.get<string>('app.name', 'hazejs'),
      account: typeof account === 'string' && account
        ? account
        : this.#users.ref(user).id,
      digits: this.#config.digits,
      period: this.#config.period,
      algorithm: this.#config.algorithm,
    })
  }

  /** 当前密钥的 otpauth:// 地址（未生成时为 undefined） */
  async uri(user: U): Promise<string | undefined> {
    const record = await this.#record(user)
    return record && this.#uri(user, await this.#encrypter.decryptString(record.secret))
  }

  /** 首次输入正确验证码后启用，触发 TwoFactorEnabled */
  async confirm(user: U, code: string): Promise<boolean> {
    const record = await this.#record(user)
    if (!record)
      return false
    const step = await verifyTotp(await this.#encrypter.decryptString(record.secret), code, {
      ...this.#totp(),
      afterStep: record.lastUsedStep,
    })
    if (step === undefined)
      return false
    await this.#save(user, {
      ...record,
      confirmedAt: new Date(),
      lastUsedStep: step,
    })
    await TwoFactorEnabled.emit({ user, id: this.#users.ref(user).id })
    return true
  }

  /** 关闭两步验证（删除密钥与恢复码），触发 TwoFactorDisabled */
  async disable(user: U): Promise<void> {
    const ref = this.#users.ref(user)
    await this.#store.delete(ref.type, ref.id)
    await TwoFactorDisabled.emit({ user, id: ref.id })
  }

  /** 是否已启用（已确认） */
  async enabled(user: U): Promise<boolean> {
    return Boolean((await this.#record(user))?.confirmedAt)
  }

  /** 校验验证码（只对已启用的用户有效）；同一时间步的验证码只能使用一次 */
  async verify(user: U, code: string): Promise<boolean> {
    const record = await this.#record(user)
    if (!record?.confirmedAt)
      return false
    const step = await verifyTotp(await this.#encrypter.decryptString(record.secret), code, {
      ...this.#totp(),
      afterStep: record.lastUsedStep,
    })
    if (step === undefined) {
      await TwoFactorFailed.emit({ user, id: this.#users.ref(user).id })
      return false
    }
    await this.#save(user, { ...record, lastUsedStep: step })
    return true
  }

  /** 使用恢复码（用后作废） */
  async useRecoveryCode(user: U, code: string): Promise<boolean> {
    const record = await this.#record(user)
    if (!record?.confirmedAt)
      return false
    const [hash] = await this.#hashCodes([code])
    const index = record.recoveryCodes.findIndex(item => safeEqual(item, hash))
    if (index === -1) {
      await TwoFactorFailed.emit({ user, id: this.#users.ref(user).id })
      return false
    }
    await this.#save(user, {
      ...record,
      recoveryCodes: record.recoveryCodes.filter((_, i) => i !== index),
    })
    return true
  }

  /** 重新生成恢复码（旧的全部作废），返回明文 */
  async regenerateRecoveryCodes(user: U): Promise<string[]> {
    const record = await this.#record(user)
    if (!record)
      throw new Error('Two-factor authentication is not enabled for this user')
    const codes = generateRecoveryCodes(this.#config.recoveryCodes ?? 8)
    await this.#save(user, { ...record, recoveryCodes: await this.#hashCodes(codes) })
    return codes
  }

  /** 剩余的恢复码数量 */
  async remainingRecoveryCodes(user: U): Promise<number> {
    return (await this.#record(user))?.recoveryCodes.length ?? 0
  }

  // ---------------------------------------------------------------- Session 登录挑战

  #sessionGuard(ctx: HttpContext, guard?: string): SessionGuard<U> {
    return ctx.auth.session(guard) as unknown as SessionGuard<U>
  }

  get #maxAttempts(): number {
    return this.#config.maxAttempts ?? 5
  }

  /** 挑战有效期（秒） */
  get #challengeTtl(): number {
    return parseDuration(this.#config.challengeTtl ?? '5m')
  }

  #cache(ctx: HttpContext): CacheRepository {
    return ctx.make(CacheManager).store(this.#config.cacheStore)
  }

  /** 失败次数按用户记在缓存里：默认的 cookie 会话驱动把会话存在客户端，重放登录时的旧 Cookie 不能重置计数 */
  #attemptsKey(pending: PendingLogin): string {
    return `two-factor:attempts:${pending.guard}:${pending.id}`
  }

  /**
   * 第一步：校验账号密码。未启用两步验证时直接登录（`authenticated`）；
   * 已启用时只在会话中记录待验证的用户（`two-factor`），等待 challenge()。
   */
  async attempt(ctx: HttpContext, credentials: Credentials, options: { guard?: string } = {}): Promise<TwoFactorAttempt<U>> {
    const guard = this.#sessionGuard(ctx, options.guard)
    const user = await guard.validate(credentials)
    if (user === undefined)
      return { status: 'failed' }
    if (!(await this.enabled(user))) {
      await guard.login(user)
      return { status: 'authenticated', user }
    }
    const session = await ctx.startSession()
    const pending: PendingLogin = {
      guard: guard.name,
      id: this.#users.provider.getId(user),
      expiresAt: Date.now() + this.#challengeTtl * 1000,
    }
    session.set(PENDING_KEY, pending)
    return { status: 'two-factor', user }
  }

  /** 是否有等待输入验证码的登录 */
  async hasPendingChallenge(ctx: HttpContext): Promise<boolean> {
    return (await this.#pending(ctx)) !== undefined
  }

  async #pending(ctx: HttpContext): Promise<PendingLogin | undefined> {
    const session = await ctx.startSession()
    const pending = session.get<PendingLogin>(PENDING_KEY)
    if (!pending)
      return undefined
    if (pending.expiresAt <= Date.now()) {
      session.forget(PENDING_KEY)
      return undefined
    }
    if (await this.#cache(ctx).get<number>(this.#attemptsKey(pending), 0) >= this.#maxAttempts) {
      session.forget(PENDING_KEY)
      return undefined
    }
    return pending
  }

  /**
   * 第二步：输入验证码或恢复码。成功时通过 Session Guard 登录并返回用户；
   * 失败返回 undefined（输错 maxAttempts 次后清除挑战，并在 challengeTtl 内拒绝该用户再次挑战）。
   */
  async challenge(ctx: HttpContext, input: ChallengeInput): Promise<U | undefined> {
    const pending = await this.#pending(ctx)
    if (!pending)
      return undefined
    const session = await ctx.startSession()
    const user = await this.#users.provider.retrieveById(pending.id) ?? undefined
    if (user === undefined) {
      session.forget(PENDING_KEY)
      return undefined
    }
    const passed = input.recoveryCode
      ? await this.useRecoveryCode(user, input.recoveryCode)
      : input.code
        ? await this.verify(user, input.code)
        : false
    if (!passed) {
      const attempts = await this.#cache(ctx).increment(this.#attemptsKey(pending), 1, this.#challengeTtl)
      if (attempts >= this.#maxAttempts)
        session.forget(PENDING_KEY)
      return undefined
    }
    session.forget(PENDING_KEY)
    await this.#cache(ctx).forget(this.#attemptsKey(pending))
    await this.#sessionGuard(ctx, pending.guard).login(user)
    return user
  }
}

/**
 * 两步验证门面（使用 config/auth.ts 的 twoFactor）：
 *
 * ```ts
 * const { uri, recoveryCodes } = await TwoFactor.enable(user)   // 前端用 uri 渲染二维码
 * await TwoFactor.confirm(user, '123456')
 * const result = await TwoFactor.attempt(ctx, credentials)       // status: 'two-factor' 时进入挑战
 * const user = await TwoFactor.challenge(ctx, { code })
 * ```
 */
export const TwoFactor = {
  enable: <U>(user: U, options?: { force?: boolean }): Promise<TwoFactorSetup> => new TwoFactorAuthenticator<U>().enable(user, options),
  confirm: <U>(user: U, code: string): Promise<boolean> => new TwoFactorAuthenticator<U>().confirm(user, code),
  disable: <U>(user: U): Promise<void> => new TwoFactorAuthenticator<U>().disable(user),
  enabled: <U>(user: U): Promise<boolean> => new TwoFactorAuthenticator<U>().enabled(user),
  verify: <U>(user: U, code: string): Promise<boolean> => new TwoFactorAuthenticator<U>().verify(user, code),
  uri: <U>(user: U): Promise<string | undefined> => new TwoFactorAuthenticator<U>().uri(user),
  useRecoveryCode: <U>(user: U, code: string): Promise<boolean> => new TwoFactorAuthenticator<U>().useRecoveryCode(user, code),
  regenerateRecoveryCodes: <U>(user: U): Promise<string[]> => new TwoFactorAuthenticator<U>().regenerateRecoveryCodes(user),
  remainingRecoveryCodes: <U>(user: U): Promise<number> => new TwoFactorAuthenticator<U>().remainingRecoveryCodes(user),
  attempt: <U = unknown>(ctx: HttpContext, credentials: Credentials, options?: { guard?: string }): Promise<TwoFactorAttempt<U>> =>
    new TwoFactorAuthenticator<U>(ctx.config).attempt(ctx, credentials, options),
  challenge: <U = unknown>(ctx: HttpContext, input: ChallengeInput): Promise<U | undefined> => new TwoFactorAuthenticator<U>(ctx.config).challenge(ctx, input),
  hasPendingChallenge: (ctx: HttpContext): Promise<boolean> => new TwoFactorAuthenticator(ctx.config).hasPendingChallenge(ctx),
  authenticator: <U = unknown>(): TwoFactorAuthenticator<U> => new TwoFactorAuthenticator<U>(),
}
