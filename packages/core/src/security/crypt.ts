import type { Config } from '../config/config'
import type { WebCryptoKey } from './key'
import { useApp } from '../application'
import { getRequestStore } from '../request'
import { appKey, fromBase64Url, previousAppKeys, toBase64Url } from './key'

/** 载荷版本前缀：`v1.` + base64url(iv ‖ 密文 ‖ GCM 标签) */
const VERSION = 'v1'
const IV_LENGTH = 12
const encoder = new TextEncoder()
const decoder = new TextDecoder()
/** 附加认证数据：绑定版本，防止载荷被当作其它格式解析 */
const AAD = encoder.encode(`hazejs:crypt:${VERSION}`)

/** 载荷无效、被篡改，或不是由当前 / 旧密钥加密的 */
export class DecryptException extends Error {
  constructor(message = 'The payload is invalid.', options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'DecryptException'
  }
}

const keys = new Map<string, Promise<WebCryptoKey>>()

/** 从 APP_KEY 经 HKDF-SHA256 派生加密专用的 AES-256-GCM 密钥（与签名、Session 加密隔离） */
function deriveKey(secret: string): Promise<WebCryptoKey> {
  let key = keys.get(secret)
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']).then(base => crypto.subtle.deriveKey(
      {
        name: 'HKDF',
        hash: 'SHA-256',
        salt: new Uint8Array(0),
        info: encoder.encode('hazejs crypt'),
      },
      base,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    ))
    keys.set(secret, key)
  }
  return key
}

/**
 * 加密器：AES-256-GCM（Web Crypto，Node / Bun / Deno / Workers 通用），每次加密使用随机 IV。
 * 解密时依次尝试当前密钥与旧密钥（密钥轮换）。一般通过 `Crypt` 门面使用。
 */
export class Encrypter {
  readonly #key: string
  readonly #previous: string[]

  constructor(key: string, previousKeys: string[] = []) {
    this.#key = key
    this.#previous = previousKeys
  }

  /** 由配置创建（`app.key` / APP_KEY 与 `app.previousKeys` / APP_PREVIOUS_KEYS） */
  static fromConfig(config?: Config): Encrypter {
    return new Encrypter(appKey(config), previousAppKeys(config))
  }

  /** 加密任意可 JSON 序列化的值（Date 会变为字符串） */
  encrypt(value: unknown): Promise<string> {
    const json = JSON.stringify(value)
    if (json === undefined)
      throw new TypeError('Crypt.encrypt() requires a JSON-serializable value')
    return this.encryptString(json)
  }

  /** 解密 encrypt() 的结果 */
  async decrypt<T = unknown>(payload: string): Promise<T> {
    const json = await this.decryptString(payload)
    try {
      return JSON.parse(json) as T
    }
    catch (error) {
      throw new DecryptException('The payload is not valid JSON.', { cause: error })
    }
  }

  /** 加密字符串（不做 JSON 序列化） */
  async encryptString(value: string): Promise<string> {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH))
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD }, await deriveKey(this.#key), encoder.encode(value))
    const bytes = new Uint8Array(IV_LENGTH + cipher.byteLength)
    bytes.set(iv)
    bytes.set(new Uint8Array(cipher), IV_LENGTH)
    return `${VERSION}.${toBase64Url(bytes)}`
  }

  /** 解密 encryptString() 的结果；格式错误、被篡改或密钥不符时抛出 DecryptException */
  async decryptString(payload: string): Promise<string> {
    if (typeof payload !== 'string' || !payload.startsWith(`${VERSION}.`))
      throw new DecryptException()
    let bytes: Uint8Array
    try {
      bytes = fromBase64Url(payload.slice(VERSION.length + 1))
    }
    catch (error) {
      throw new DecryptException('The payload is invalid.', { cause: error })
    }
    // IV + 至少 16 字节的 GCM 标签
    if (bytes.length < IV_LENGTH + 16)
      throw new DecryptException()
    const iv = bytes.slice(0, IV_LENGTH)
    const data = bytes.slice(IV_LENGTH)
    for (const secret of [this.#key, ...this.#previous]) {
      try {
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: AAD }, await deriveKey(secret), data)
        return decoder.decode(plain)
      }
      catch {
        // 换下一个密钥
      }
    }
    throw new DecryptException('The MAC is invalid.')
  }
}

/** 当前生效的配置：请求内为请求（应用）的配置，否则为最近启动的应用 */
function currentConfig(): Config | undefined {
  const store = getRequestStore()
  if (store)
    return store.ctx.config
  try {
    return useApp().config
  }
  catch {
    // 没有启动应用（如独立脚本）：直接读取环境变量 APP_KEY / APP_PREVIOUS_KEYS
    return undefined
  }
}

function encrypter(): Encrypter {
  return Encrypter.fromConfig(currentConfig())
}

/**
 * 加密门面（AES-256-GCM，密钥派生自 APP_KEY）：
 *
 * ```ts
 * const token = await Crypt.encrypt({ userId: 1, scope: 'export' })
 * const data = await Crypt.decrypt<{ userId: number }>(token)
 * const secret = await Crypt.encryptString('plain text')
 * ```
 *
 * 载荷为 `v1.<base64url>`，可放进 URL、Cookie 与数据库；轮换 APP_KEY 时把旧密钥放进
 * `APP_PREVIOUS_KEYS`（逗号分隔），旧数据仍可解密。
 */
export const Crypt = {
  encrypt: (value: unknown): Promise<string> => encrypter().encrypt(value),
  decrypt: <T = unknown>(payload: string): Promise<T> => encrypter().decrypt<T>(payload),
  encryptString: (value: string): Promise<string> => encrypter().encryptString(value),
  decryptString: (payload: string): Promise<string> => encrypter().decryptString(payload),
}
