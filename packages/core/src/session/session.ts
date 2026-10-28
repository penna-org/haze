import type { HttpContext } from '../http/context'
import type { CookieOptions } from '../http/cookie'
import type { WebCryptoKey } from '../security/key'
import type { SessionData, SessionStore } from './store'
import { getCookie } from 'h3'
import { CacheManager } from '../cache/manager'
import { mutableResponse, serializeCookie } from '../http/cookie'
import { appKey, fromBase64Url, sign, toBase64Url, verify } from '../security/key'
import { tenantSessionKey } from '../tenancy/context'
import { jsonReplacer, parseDuration } from '../utils'
import { cacheSessionStore, memorySessionStore } from './store'

export interface SessionConfig {
  /**
   * - `cookie`（默认）：数据加密（AES-GCM，密钥派生自 APP_KEY）后存在 Cookie 中，无状态、Edge 可用，上限约 4KB
   * - `memory`：数据在进程内存，Cookie 只保存签名的会话 ID（单实例）
   * - 自定义 SessionStore：Redis、KV、数据库等
   */
  driver: 'cookie' | 'memory' | 'cache' | SessionStore
  /** driver 为 cache 时使用的缓存存储（config/cache.ts 的 stores），默认缓存的默认存储 */
  store?: string
  /** Cookie 名，默认 `haze_session` */
  cookie: string
  /** 有效期，默认 `2h` */
  lifetime: string | number
  /** 覆盖默认 Cookie 选项（httpOnly、SameSite=Lax、生产环境 Secure） */
  cookieOptions?: CookieOptions
}

export const defaultSessionConfig: SessionConfig = {
  driver: 'cookie',
  cookie: 'haze_session',
  lifetime: '2h',
}

/** `config/session.ts` 的默认导出 */
export function defineSessionConfig(config: Partial<SessionConfig> | (() => Partial<SessionConfig>)): Partial<SessionConfig> | (() => Partial<SessionConfig>) {
  return config
}

const FLASH = '_flash'
/** Cookie 值的上限（单个 Cookie 约 4096 字节，留出属性的空间） */
const MAX_COOKIE_VALUE = 3800

interface FlashState {
  old: string[]
  new: string[]
}

let memoryStore: SessionStore | undefined

/**
 * 请求内的会话。由 `session` 中间件（或 `await ctx.startSession()`）启动，
 * 响应发出前有修改才写回（新会话没有数据时不设置 Cookie）。
 */
export class Session {
  #id: string
  #data: SessionData
  #dirty = false
  #invalidated = false
  /** 重新生成 ID 前的旧 ID（服务端存储需删除） */
  #previousId: string | undefined

  constructor(id: string, data: SessionData) {
    this.#id = id
    this.#data = data
  }

  get id(): string {
    return this.#id
  }

  /** 是否有未写回的修改 */
  get dirty(): boolean {
    return this.#dirty
  }

  get<T = unknown>(key: string, fallback?: T): T | undefined {
    return (key in this.#data
      ? this.#data[key]
      : fallback) as T | undefined
  }

  has(key: string): boolean {
    return key in this.#data && this.#data[key] !== undefined
  }

  all(): SessionData {
    const { [FLASH]: _, ...data } = this.#data
    return data
  }

  set(key: string, value: unknown): this {
    this.#data[key] = value
    this.#dirty = true
    return this
  }

  forget(key: string): this {
    if (key in this.#data) {
      delete this.#data[key]
      this.#dirty = true
    }
    return this
  }

  /** 读取并删除 */
  pull<T = unknown>(key: string, fallback?: T): T | undefined {
    const value = this.get(key, fallback)
    this.forget(key)
    return value
  }

  /** 清空数据（保留会话 ID） */
  flush(): this {
    this.#data = {}
    this.#dirty = true
    return this
  }

  /** 闪存：只在下一次请求中可读 */
  flash(key: string, value: unknown): this {
    const flash = this.#flash()
    this.#data[key] = value
    flash.new = [
      ...new Set([...flash.new, key]),
    ]
    flash.old = flash.old.filter(name => name !== key)
    this.#dirty = true
    return this
  }

  /** 重新生成会话 ID（登录 / 提权时调用，防止会话固定攻击），数据保留 */
  regenerate(): this {
    this.#previousId ??= this.#id
    this.#id = newSessionId()
    this.#dirty = true
    return this
  }

  /** 清空数据并重新生成 ID（退出登录） */
  invalidate(): this {
    this.flush()
    this.regenerate()
    this.#invalidated = true
    return this
  }

  /** @internal */
  ageFlash(): void {
    const flash = this.#data[FLASH] as FlashState | undefined
    if (!flash || (!flash.old.length && !flash.new.length))
      return
    this.#data[FLASH] = { old: flash.new, new: [] }
    for (const key of flash.old)
      delete this.#data[key]
    this.#dirty = true
  }

  /** @internal */
  snapshot(): { id: string, data: SessionData, previousId: string | undefined, invalidated: boolean } {
    return {
      id: this.#id,
      data: this.#data,
      previousId: this.#previousId,
      invalidated: this.#invalidated,
    }
  }

  #flash(): FlashState {
    const flash = (this.#data[FLASH] ??= { old: [], new: [] }) as FlashState
    return flash
  }
}

function newSessionId(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(24)))
}

function resolveStore(ctx: HttpContext, config: SessionConfig): SessionStore | undefined {
  const { driver } = config
  if (driver === 'cookie')
    return undefined
  if (driver === 'memory') {
    memoryStore ??= memorySessionStore()
    return memoryStore
  }
  if (driver === 'cache')
    return cacheSessionStore(ctx.make(CacheManager).store(config.store))
  return driver
}

/** 启动会话：读取 Cookie、加载数据，并注册响应前的写回 */
export async function startSession(ctx: HttpContext): Promise<Session> {
  const config = {
    ...defaultSessionConfig,
    ...ctx.config.get<Partial<SessionConfig>>('session', {}),
  }
  // 多租户：每个租户使用独立的 Cookie 名与派生密钥，会话不能跨租户使用
  const tenant = tenantSessionKey()
  if (tenant)
    config.cookie = `${config.cookie}_${tenant.replace(/\W/g, '_')}`
  const secret = tenant
    ? `${appKey(ctx.config)}:tenant:${tenant}`
    : appKey(ctx.config)
  const lifetime = parseDuration(config.lifetime)
  const store = resolveStore(ctx, config)
  const raw = getCookie(ctx.event, config.cookie)

  let session: Session | undefined
  if (raw) {
    if (store) {
      const id = await unsignId(raw, secret)
      const data = id && await store.get(id)
      if (id && data)
        session = new Session(id, data)
    }
    else {
      const payload = await decrypt(raw, secret)
      if (payload && payload.exp > Date.now())
        session = new Session(payload.id, payload.data)
    }
  }
  const isNew = !session
  session ??= new Session(newSessionId(), {})
  session.ageFlash()

  ctx.onResponse(async (response) => {
    const { id, data, previousId, invalidated } = session.snapshot()
    const empty = !Object.keys(data).some(key => key !== FLASH)
    if (!session.dirty && !isNew)
      return
    // 新会话没有数据：不设置 Cookie
    if (isNew && empty && !invalidated)
      return
    const cookieOptions = {
      ...ctx.cookieDefaults(),
      ...config.cookieOptions,
    }
    const next = mutableResponse(response)
    if (store && previousId)
      await store.destroy(previousId)
    if (empty) {
      if (store)
        await store.destroy(id)
      next.headers.append('set-cookie', serializeCookie(config.cookie, '', { ...cookieOptions, maxAge: 0 }))
      return next
    }
    let value: string
    if (store) {
      await store.set(id, data, lifetime)
      value = `${id}.${await sign(id, secret)}`
    }
    else {
      value = await encrypt({ id, data, exp: Date.now() + lifetime * 1000 }, secret)
      if (value.length > MAX_COOKIE_VALUE)
        throw new Error(`Session data is too large for the cookie driver (${value.length} bytes). Store less data or use a server-side SessionStore`)
    }
    next.headers.append('set-cookie', serializeCookie(config.cookie, value, { ...cookieOptions, maxAge: lifetime }))
    return next
  })
  return session
}

async function unsignId(raw: string, secret: string): Promise<string | undefined> {
  const index = raw.lastIndexOf('.')
  if (index <= 0)
    return undefined
  const id = raw.slice(0, index)
  return await verify(id, raw.slice(index + 1), secret)
    ? id
    : undefined
}

interface CookiePayload {
  id: string
  data: SessionData
  exp: number
}

const encoder = new TextEncoder()
const aesKeys = new Map<string, Promise<WebCryptoKey>>()

/** 从 APP_KEY 派生 Session 专用的 AES-GCM 密钥（与签名用途隔离） */
function aesKey(secret: string): Promise<WebCryptoKey> {
  let key = aesKeys.get(secret)
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']).then(base => crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: encoder.encode('hazejs session'),
      },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    ))
    aesKeys.set(secret, key)
  }
  return key
}

async function encrypt(payload: CookiePayload, secret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(secret), encoder.encode(JSON.stringify(payload, jsonReplacer)))
  const bytes = new Uint8Array(iv.length + cipher.byteLength)
  bytes.set(iv)
  bytes.set(new Uint8Array(cipher), iv.length)
  return toBase64Url(bytes)
}

async function decrypt(value: string, secret: string): Promise<CookiePayload | undefined> {
  try {
    const bytes = fromBase64Url(value)
    const plain = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: bytes.slice(0, 12),
    }, await aesKey(secret), bytes.slice(12))
    return JSON.parse(new TextDecoder().decode(plain)) as CookiePayload
  }
  catch {
    return undefined
  }
}
