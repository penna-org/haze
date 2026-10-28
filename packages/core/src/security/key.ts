import type { Config } from '../config/config'
import process from 'node:process'

const encoder = new TextEncoder()

/** Web Crypto 的密钥类型（不依赖 DOM lib） */
export type WebCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>

/**
 * 应用密钥（`APP_KEY`）：签名 Cookie、加密 Session、JWT 的默认密钥。
 * 用 `haze key:generate` 生成，至少 32 个字符。
 */
export function appKey(config?: Config): string {
  const key = config?.get<string | undefined>('app.key', undefined) ?? process.env.APP_KEY
  if (!key)
    throw new Error('APP_KEY is not set. Run `haze key:generate` to create one in .env')
  if (key.length < 32)
    throw new Error('APP_KEY must be at least 32 characters. Run `haze key:generate`')
  return key
}

/**
 * 轮换前的旧密钥（`app.previousKeys` 或逗号分隔的 `APP_PREVIOUS_KEYS`）：只用于解密与校验签名链接，
 * 新的加密与签名始终使用 APP_KEY。
 */
export function previousAppKeys(config?: Config): string[] {
  const keys = config?.get<string | string[] | undefined>('app.previousKeys', undefined) ?? process.env.APP_PREVIOUS_KEYS
  return (Array.isArray(keys)
    ? keys
    : (keys ?? '').split(','))
    .map(key => key.trim())
    .filter(Boolean)
}

/** 生成新的应用密钥（base64url，256 位） */
export function generateKey(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

const hmacKeys = new Map<string, Promise<WebCryptoKey>>()

function hmacKey(secret: string): Promise<WebCryptoKey> {
  let key = hmacKeys.get(secret)
  if (!key) {
    key = crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
    hmacKeys.set(secret, key)
  }
  return key
}

/** HMAC-SHA256 签名（base64url） */
export async function sign(value: string, secret: string): Promise<string> {
  const signature = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(value))
  return toBase64Url(new Uint8Array(signature))
}

/** 校验签名（常量时间比较由 Web Crypto 的 verify 保证） */
export async function verify(value: string, signature: string, secret: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64Url(signature) as Uint8Array<ArrayBuffer>, encoder.encode(value))
  }
  catch {
    return false
  }
}

/** 常量时间比较字符串（长度不同直接返回 false） */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length)
    return false
  let diff = 0
  for (let index = 0; index < a.length; index++)
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return diff === 0
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64Url(value: string): Uint8Array {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}
