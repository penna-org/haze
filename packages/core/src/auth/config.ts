import type { JWTPayload } from 'jose'
import type { HttpContext } from '../http/context'
import type { MaybePromise } from '../utils'
import type { PasskeyConfig } from './passkeys'
import type { PasswordResetConfig } from './passwords'
import type { UserProvider } from './provider'
import type { TokenStore } from './tokens'
import type { TwoFactorConfig } from './two-factor'
import type { VerificationConfig } from './verification'

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
  /** 有效期，默认 `2h`；函数形式在每次签发时求值（如读取运行时可修改的设置） */
  expiresIn?: string | number | ((ctx: HttpContext) => MaybePromise<string | number>)
  issuer?: string
  audience?: string | string[]
  /** 同时从该 Cookie 读取令牌（浏览器场景），默认只读 Authorization: Bearer */
  cookie?: string
  /**
   * 由令牌的声明取得当前用户，代替 provider 的 `retrieveById(sub)`：可以读取自定义声明（如会话 ID）与请求头，
   * 在这里检查会话是否已被吊销、用户是否被禁用等。返回 undefined / null 视为未登录；
   * 抛出的 HttpException（如带业务码的 401、403）原样作为响应，不会被当成“未登录”
   */
  resolveUser?: (payload: JWTPayload, ctx: HttpContext) => MaybePromise<unknown>
  /** 带有这些声明的令牌不能用于认证（如用同一密钥签发的找回密码凭证上的 `purpose`） */
  rejectClaims?: string[]
}

export interface SessionGuardConfig {
  driver: 'session'
  provider: string
}

/** 个人访问令牌（Sanctum 风格）：Authorization: Bearer <id|secret>，服务端只保存摘要 */
export interface TokenGuardConfig {
  driver: 'token'
  provider: string
  /** 令牌存储，默认进程内存；生产环境用 `@hazejs/orm` 的 databaseTokenStore() */
  store?: TokenStore
  /** 写入 tokenable_type 的用户类型，默认为 provider 名 */
  type?: string
  /** 新令牌的默认有效期（如 `'30d'`），省略时永不过期 */
  expiresIn?: string | number
  /** 明文令牌的前缀（便于 GitHub 等平台的密钥扫描识别），如 `'haze_'` */
  prefix?: string
}

export type GuardConfig = JwtGuardConfig | SessionGuardConfig | TokenGuardConfig

export interface AuthConfig<P extends Record<string, UserProvider<any>> = Record<string, UserProvider<any>>> {
  /** 默认 Guard */
  default: string
  guards: Record<string, GuardConfig>
  providers: P
  /** 邮箱验证（签名链接） */
  verification?: VerificationConfig
  /** 找回密码 */
  passwords?: PasswordResetConfig
  /** TOTP 两步验证 */
  twoFactor?: TwoFactorConfig
  /** 通行密钥（WebAuthn，需安装 @simplewebauthn/server） */
  passkeys?: PasskeyConfig
}

/** `config/auth.ts` 的默认导出（保留 providers 的类型，`ctx.auth.user()` 据此推导用户类型） */
export function defineAuthConfig<P extends Record<string, UserProvider<any>>>(config: AuthConfig<P> | (() => AuthConfig<P>)): AuthConfig<P> | (() => AuthConfig<P>) {
  return config
}
