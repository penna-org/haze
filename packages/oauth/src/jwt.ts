import type { JSONWebKeySet, JWTPayload } from 'jose'
import { createLocalJWKSet, errors, importPKCS8, jwtVerify, SignJWT } from 'jose'
import { DEFAULT_HTTP_TIMEOUT } from './config'

/** JWKS 缓存：jwks_uri → 公钥集合（10 分钟；找不到 kid 时强制刷新一次，应对密钥轮换） */
const jwksCache = new Map<string, { keys: JSONWebKeySet, expires: number, fetchedAt: number }>()
/** 进行中的 JWKS 请求：并发的校验共用同一次请求 */
const jwksInflight = new Map<string, Promise<JSONWebKeySet>>()
const JWKS_TTL = 10 * 60 * 1000
/** 强制刷新的冷却时间：随意伪造 kid 的令牌不能让每次校验都去请求一次 JWKS */
const JWKS_REFRESH_COOLDOWN = 30 * 1000

async function loadJwks(uri: string, fetcher: typeof fetch, force: boolean, timeout: number): Promise<JSONWebKeySet> {
  const cached = jwksCache.get(uri)
  const now = Date.now()
  if (cached && cached.expires > now && (!force || now - cached.fetchedAt < JWKS_REFRESH_COOLDOWN))
    return cached.keys
  let inflight = jwksInflight.get(uri)
  if (!inflight) {
    inflight = (async () => {
      const response = await fetcher(uri, {
        headers: { accept: 'application/json' },
        ...(timeout > 0 && {
          signal: AbortSignal.timeout(timeout),
        }),
      })
      if (!response.ok)
        throw new Error(`Failed to fetch JWKS from ${uri}: HTTP ${response.status}`)
      const keys = await response.json() as JSONWebKeySet
      if (!Array.isArray(keys?.keys))
        throw new TypeError(`Invalid JWKS from ${uri}`)
      jwksCache.set(uri, {
        keys,
        expires: Date.now() + JWKS_TTL,
        fetchedAt: Date.now(),
      })
      return keys
    })().finally(() => jwksInflight.delete(uri))
    jwksInflight.set(uri, inflight)
  }
  return inflight
}

/** 清空 JWKS 缓存（测试用） */
export function clearJwksCache(): void {
  jwksCache.clear()
  jwksInflight.clear()
}

export interface VerifyIdTokenOptions {
  /** 公钥集合地址（jwks_uri） */
  jwksUri: string
  /** 允许的签发者（iss） */
  issuer: string | string[]
  /** 受众（aud），一般为 client_id */
  audience: string | string[]
  /** 发起授权时的 nonce：提供时必须与令牌中的一致 */
  nonce?: string
  /** 允许的签名算法，默认 RS256 / ES256 及同族算法 */
  algorithms?: string[]
  /** 允许的时钟偏差（秒），默认 60 */
  clockTolerance?: number
  fetch?: typeof fetch
  /** 请求 JWKS 的超时（毫秒），默认 10000；0 不限 */
  timeout?: number
}

const DEFAULT_ALGORITHMS = [
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
  'ES256',
  'ES384',
  'ES512',
  'EdDSA',
]

/**
 * 校验 OpenID Connect 的 id_token：签名（JWKS）、iss、aud、exp / iat 与 nonce。
 * 失败时抛出错误（调用方转换为 OAuthException）。
 */
export async function verifyIdToken(token: string, options: VerifyIdTokenOptions): Promise<JWTPayload> {
  const fetcher = options.fetch ?? globalThis.fetch
  const verify = async (force: boolean): Promise<JWTPayload> => {
    const keys = createLocalJWKSet(await loadJwks(options.jwksUri, fetcher, force, options.timeout ?? DEFAULT_HTTP_TIMEOUT))
    const { payload } = await jwtVerify(token, keys, {
      issuer: options.issuer,
      audience: options.audience,
      algorithms: options.algorithms ?? DEFAULT_ALGORITHMS,
      clockTolerance: options.clockTolerance ?? 60,
    })
    return payload
  }
  let payload: JWTPayload
  try {
    payload = await verify(false)
  }
  catch (error) {
    if (!(error instanceof errors.JWKSNoMatchingKey))
      throw error
    payload = await verify(true)
  }
  if (options.nonce !== undefined && payload.nonce !== options.nonce)
    throw new Error('id_token nonce mismatch')
  return payload
}

export interface ClientSecretJwtOptions {
  /** PKCS#8 PEM 私钥 */
  privateKey: string
  algorithm?: string
  keyId?: string
  issuer: string
  subject: string
  audience: string
  /** 有效期（秒） */
  expiresIn: number
}

/** 生成以 JWT 形式的 client_secret（Apple：ES256，iss = Team ID，sub = Services ID） */
export async function signClientSecret(options: ClientSecretJwtOptions): Promise<string> {
  const algorithm = options.algorithm ?? 'ES256'
  const now = Math.floor(Date.now() / 1000)
  return new SignJWT({})
    .setProtectedHeader({
      alg: algorithm,
      ...(options.keyId && { kid: options.keyId }),
    })
    .setIssuer(options.issuer)
    .setSubject(options.subject)
    .setAudience(options.audience)
    .setIssuedAt(now)
    .setExpirationTime(now + options.expiresIn)
    .sign(await importPKCS8(normalizePem(options.privateKey, 'PRIVATE KEY'), algorithm))
}

/** 允许 .env 中用 `\n` 转义换行，或只给出 base64 主体（不带 PEM 头尾） */
export function normalizePem(value: string, label: string): string {
  const text = value.replace(/\\n/g, '\n').trim()
  if (text.includes('-----BEGIN'))
    return text
  const body = text.replace(/\s+/g, '').match(/.{1,64}/g)!.join('\n')
  return `-----BEGIN ${label}-----\n${body}\n-----END ${label}-----`
}
