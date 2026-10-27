import type { UserProvider } from './provider'

export type JwtAlgorithm = 'HS256' | 'HS384' | 'HS512' | 'RS256' | 'RS384' | 'RS512' | 'PS256' | 'ES256' | 'ES384' | 'ES512' | 'EdDSA'

export interface JwtGuardConfig {
  driver: 'jwt'
  /** providers 中的名字 */
  provider: string
  /** 签名算法，默认 HS256 */
  algorithm?: JwtAlgorithm
  /** HS* 的密钥，默认 APP_KEY */
  secret?: string
  /** RS / PS / ES / EdDSA：PKCS#8 私钥（签发）与 SPKI 公钥（校验），PEM 格式 */
  privateKey?: string
  publicKey?: string
  /** 有效期，默认 `2h` */
  expiresIn?: string | number
  issuer?: string
  audience?: string | string[]
  /** 同时从该 Cookie 读取令牌（浏览器场景），默认只读 Authorization: Bearer */
  cookie?: string
}

export interface SessionGuardConfig {
  driver: 'session'
  provider: string
}

export type GuardConfig = JwtGuardConfig | SessionGuardConfig

export interface AuthConfig<P extends Record<string, UserProvider<any>> = Record<string, UserProvider<any>>> {
  /** 默认 Guard */
  default: string
  guards: Record<string, GuardConfig>
  providers: P
}

/** `config/auth.ts` 的默认导出（保留 providers 的类型，`ctx.auth.user()` 据此推导用户类型） */
export function defineAuthConfig<P extends Record<string, UserProvider<any>>>(config: AuthConfig<P> | (() => AuthConfig<P>)): AuthConfig<P> | (() => AuthConfig<P>) {
  return config
}
