const encoder = new TextEncoder()
const decoder = new TextDecoder()

type WebCryptoKey = Awaited<ReturnType<typeof crypto.subtle.importKey>>

export function base64url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64url(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/-/g, '+').replace(/_/g, '/'))
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

export function fromBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replace(/\s+/g, ''))
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}

export function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes)
    binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** 随机字符串（base64url），用于 state、nonce 与 PKCE code_verifier */
export function randomString(bytes = 32): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** PKCE：code_challenge = BASE64URL(SHA256(code_verifier)) */
export async function codeChallenge(verifier: string): Promise<string> {
  return base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(verifier))))
}

/** 常量时间比较 */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length)
    return false
  let diff = 0
  for (let index = 0; index < a.length; index++)
    diff |= a.charCodeAt(index) ^ b.charCodeAt(index)
  return diff === 0
}

const stateKeys = new Map<string, Promise<WebCryptoKey>>()

/** state Cookie 的加密密钥：由 APP_KEY 经 HKDF 派生，与签名 Cookie / Session 的用途分开 */
function stateKey(secret: string): Promise<WebCryptoKey> {
  let key = stateKeys.get(secret)
  if (!key) {
    key = (async () => {
      const material = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey'])
      return crypto.subtle.deriveKey(
        {
          name: 'HKDF',
          hash: 'SHA-256',
          salt: encoder.encode('hazejs-oauth'),
          info: encoder.encode('oauth-state'),
        },
        material,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
      )
    })()
    stateKeys.set(secret, key)
  }
  return key
}

/** AES-GCM 加密（附加数据绑定 Cookie 名，防止不同驱动的 Cookie 互换） */
export async function seal(value: unknown, secret: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const data = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: encoder.encode(aad),
  }, await stateKey(secret), encoder.encode(JSON.stringify(value)))
  const out = new Uint8Array(iv.length + data.byteLength)
  out.set(iv)
  out.set(new Uint8Array(data), iv.length)
  return base64url(out)
}

/** 解密，失败（篡改、密钥变化）返回 undefined */
export async function unseal<T>(value: string, secret: string, aad: string): Promise<T | undefined> {
  try {
    const bytes = fromBase64url(value)
    const data = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: bytes.slice(0, 12),
      additionalData: encoder.encode(aad),
    }, await stateKey(secret), bytes.slice(12))
    return JSON.parse(decoder.decode(data)) as T
  }
  catch {
    return undefined
  }
}
