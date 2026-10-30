import type { CacheRepository } from '../cache/repository'
import type { Config } from '../config/config'
import type { MailDefinition } from '../mail/mailable'
import type { MaybePromise } from '../utils'
import type { ResetPasswordPayload } from './mails'
import type { ResolvedProvider } from './support'
import { CacheManager, useCacheManager } from '../cache/manager'
import { Mail } from '../mail/manager'
import { definePersistent } from '../persistent'
import { getContextContainer } from '../request'
import { Hash } from '../security/hash'
import { safeEqual } from '../security/key'
import { parseDuration } from '../utils'
import { PasswordResetCompleted, PasswordResetLinkSent } from './events'
import { ResetPasswordMail } from './mails'
import { authConfigOf, currentConfig, fieldOf, randomToken, resolveProvider, saveFields, sha256 } from './support'

/** 重置令牌的存储记录（token 为 SHA-256 摘要） */
export interface PasswordResetRecord {
  token: string
  createdAt: Date
}

/**
 * 重置令牌存储（按邮箱一条）：内置 memory 与 cache（`cachePasswordResetStore()`），
 * `@hazejs/orm` 的 `databasePasswordResetStore(() => passwordResetTokens)` 存到 password_reset_tokens 表。
 */
export interface PasswordResetStore {
  get: (email: string) => Promise<PasswordResetRecord | undefined>
  /** ttl：秒（缓存类存储据此过期，数据库存储忽略，读取时按 createdAt 判断） */
  put: (email: string, record: PasswordResetRecord, ttl: number) => Promise<void>
  delete: (email: string) => Promise<void>
}

/** 进程内存储（测试 / 单实例）；name 区分互不共享的存储 */
export function memoryPasswordResetStore(name = 'default'): PasswordResetStore {
  const rows = definePersistent(`auth:password-resets:${name}`, () => new Map<string, PasswordResetRecord>())
  return {
    async get(email) {
      const row = rows.get(email)
      return row && { ...row }
    },
    async put(email, record) {
      rows.set(email, { ...record })
    },
    async delete(email) {
      rows.delete(email)
    },
  }
}

/** 缓存存储（config/cache.ts 中的存储名，默认缓存的默认存储），过期自动清理 */
export function cachePasswordResetStore(store?: string): PasswordResetStore {
  const cache = (): CacheRepository => (getContextContainer()?.make(CacheManager) ?? useCacheManager()).store(store)
  const key = (email: string): string => `password-reset:${email}`
  return {
    async get(email) {
      const row = await cache().get<{ token: string, createdAt: string }>(key(email))
      return row && {
        token: row.token,
        createdAt: new Date(row.createdAt),
      }
    },
    async put(email, record, ttl) {
      await cache().set(key(email), {
        token: record.token,
        createdAt: record.createdAt.toISOString(),
      }, ttl)
    },
    async delete(email) {
      await cache().forget(key(email))
    },
  }
}

export interface ResetLinkParams {
  token: string
  email: string
  user: unknown
}

export interface PasswordResetConfig {
  /** 用户来源，默认取默认 Guard 的 provider */
  provider?: string
  /** 令牌存储：PasswordResetStore，或 config/cache.ts 中的缓存存储名；默认进程内存 */
  store?: PasswordResetStore | string
  /** 链接有效期，默认 `60m` */
  expire?: string | number
  /** 同一邮箱两次发送的最短间隔，默认 `60s`（0 关闭） */
  throttle?: string | number
  /** 邮箱字段，默认 `email` */
  email?: string
  /** 密码哈希字段，默认 `password` */
  password?: string
  /** 重置页面的路径（前端页面），链接为 `<path>?token=...&email=...`，默认 `/reset-password` */
  path?: string
  /** 完全自定义邮件中的链接 */
  url?: (params: ResetLinkParams) => MaybePromise<string>
  /** 替换默认的重置邮件 */
  mail?: MailDefinition<ResetPasswordPayload>
  /** 通过队列发送，默认 false */
  queue?: boolean
}

export type ResetLinkStatus = 'sent' | 'throttled' | 'invalid-user'
export type ResetStatus = 'reset' | 'invalid-token' | 'invalid-user'

export interface ResetInput {
  email: string
  token: string
  password: string
}

/** 自定义修改密码的方式（默认 Hash.make() 后写入 password 字段并保存） */
export type ResetCallback<U> = (user: U, password: string) => MaybePromise<void>

/** 找回密码：生成与校验重置令牌、发送邮件、修改密码 */
export class PasswordBroker<U = unknown> {
  readonly #config: PasswordResetConfig
  readonly #appConfig: Config
  readonly #users: ResolvedProvider<U>
  readonly #store: PasswordResetStore

  constructor(appConfig: Config = currentConfig()) {
    this.#appConfig = appConfig
    const auth = authConfigOf(appConfig)
    this.#config = auth.passwords ?? {}
    this.#users = resolveProvider<U>(auth, this.#config.provider)
    const store = this.#config.store
    this.#store = typeof store === 'string'
      ? cachePasswordResetStore(store)
      : store ?? memoryPasswordResetStore()
  }

  get #emailField(): string {
    return this.#config.email ?? 'email'
  }

  get #expire(): number {
    return parseDuration(this.#config.expire ?? '60m')
  }

  /** 按邮箱查找用户 */
  async user(email: string): Promise<U | undefined> {
    return await this.#users.provider.retrieveByCredentials({ [this.#emailField]: email }) ?? undefined
  }

  #emailOf(user: U): string {
    const email = fieldOf(user, this.#emailField)
    if (typeof email !== 'string' || !email)
      throw new Error(`Password reset: user has no "${this.#emailField}"`)
    return email
  }

  /** 为用户生成新的重置令牌（覆盖旧令牌），返回明文 */
  async createToken(user: U): Promise<string> {
    const token = randomToken(32)
    await this.#store.put(this.#emailOf(user), {
      token: await sha256(token),
      createdAt: new Date(),
    }, this.#expire)
    return token
  }

  /** 令牌是否有效（存在、未过期、摘要一致） */
  async tokenExists(user: U, token: string): Promise<boolean> {
    const record = await this.#store.get(this.#emailOf(user))
    if (!record || this.#expired(record.createdAt, this.#expire))
      return false
    return safeEqual(record.token, await sha256(token))
  }

  async deleteToken(user: U): Promise<void> {
    await this.#store.delete(this.#emailOf(user))
  }

  /** 最近发送过（在 throttle 间隔内） */
  async recentlyCreated(user: U): Promise<boolean> {
    const throttle = parseDuration(this.#config.throttle ?? '60s')
    if (!throttle)
      return false
    const record = await this.#store.get(this.#emailOf(user))
    return record !== undefined && !this.#expired(record.createdAt, throttle)
  }

  #expired(createdAt: Date, seconds: number): boolean {
    return new Date(createdAt).getTime() + seconds * 1000 <= Date.now()
  }

  /** 邮件中的重置链接 */
  async resetUrl(user: U, token: string): Promise<string> {
    const email = this.#emailOf(user)
    if (this.#config.url)
      return this.#config.url({ token, email, user })
    const query = new URLSearchParams({ token, email })
    const path = `${this.#config.path ?? '/reset-password'}?${query}`
    const base = this.#appConfig.get<string | undefined>('app.url', undefined)
    return base
      ? `${base.replace(/\/+$/, '')}${path}`
      : path
  }

  /**
   * 发送重置链接。返回值供接口决定提示（为避免泄露邮箱是否注册，一般对 invalid-user 也返回成功提示）：
   * - `sent`：已发送；
   * - `throttled`：间隔太短；
   * - `invalid-user`：邮箱不存在。
   */
  async sendLink(email: string): Promise<ResetLinkStatus> {
    const user = await this.user(email)
    if (user === undefined)
      return 'invalid-user'
    if (await this.recentlyCreated(user))
      return 'throttled'
    const token = await this.createToken(user)
    const payload: ResetPasswordPayload = {
      appName: this.#appConfig.get<string>('app.name', 'hazejs'),
      name: fieldOf(user, 'name') as string | undefined,
      url: await this.resetUrl(user, token),
      expiresInMinutes: Math.round(this.#expire / 60),
    }
    const pending = Mail.to(this.#emailOf(user))
    const mail = this.#config.mail ?? ResetPasswordMail
    if (this.#config.queue)
      await pending.queue(mail, payload)
    else
      await pending.send(mail, payload)
    await PasswordResetLinkSent.emit({
      user,
      id: this.#users.ref(user).id,
      email: this.#emailOf(user),
    })
    return 'sent'
  }

  /**
   * 校验令牌并修改密码，成功后删除令牌并触发 PasswordResetCompleted。
   * 默认把 `Hash.make(password)` 写入 password 字段并保存；需要同时吊销令牌、退出其它设备时传入 callback。
   */
  async reset(input: ResetInput, callback?: ResetCallback<U>): Promise<ResetStatus> {
    const user = await this.user(input.email)
    if (user === undefined)
      return 'invalid-user'
    if (!(await this.tokenExists(user, input.token)))
      return 'invalid-token'
    if (callback)
      await callback(user, input.password)
    else
      await saveFields(user, { [this.#config.password ?? 'password']: await Hash.make(input.password) })
    await this.deleteToken(user)
    await PasswordResetCompleted.emit({
      user,
      id: this.#users.ref(user).id,
      email: this.#emailOf(user),
    })
    return 'reset'
  }
}

/**
 * 找回密码门面（使用 config/auth.ts 的 passwords）：
 *
 * ```ts
 * await PasswordReset.sendLink(email)                      // 'sent' | 'throttled' | 'invalid-user'
 * await PasswordReset.reset({ email, token, password })    // 'reset' | 'invalid-token' | 'invalid-user'
 * ```
 */
export const PasswordReset = {
  sendLink: (email: string): Promise<ResetLinkStatus> => new PasswordBroker().sendLink(email),
  reset: <U = unknown>(input: ResetInput, callback?: ResetCallback<U>): Promise<ResetStatus> => new PasswordBroker<U>().reset(input, callback),
  createToken: <U>(user: U): Promise<string> => new PasswordBroker<U>().createToken(user),
  tokenExists: <U>(user: U, token: string): Promise<boolean> => new PasswordBroker<U>().tokenExists(user, token),
  deleteToken: <U>(user: U): Promise<void> => new PasswordBroker<U>().deleteToken(user),
  broker: <U = unknown>(): PasswordBroker<U> => new PasswordBroker<U>(),
}
