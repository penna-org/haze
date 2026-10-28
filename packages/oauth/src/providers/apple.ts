import type { CookieOptions } from '@hazejs/core'
import type { AuthorizeContext, UserContext } from '../provider'
import type { MappedUser, OAuthToken, OAuthUser } from '../types'
import type { OidcProviderConfig } from './oidc'
import { signClientSecret } from '../jwt'
import { OidcProvider } from './oidc'

export interface AppleProviderConfig extends Omit<OidcProviderConfig, 'issuer' | 'userinfo'> {
  /** Services ID（网页登录）或 Bundle ID（App 内登录），即 client_id */
  clientId: string
  /** Apple Developer 的 Team ID（client secret JWT 的 iss） */
  teamId?: string
  /** Sign in with Apple 私钥的 Key ID（JWT 头的 kid） */
  keyId?: string
  /** 私钥（.p8 文件内容，PKCS#8 PEM；也可以只给 base64 主体或用 \n 转义换行） */
  privateKey?: string
  /** client secret JWT 的有效期（秒），默认 1 小时，Apple 允许最长 6 个月 */
  secretTtl?: number
}

type Json = Record<string, any>

const AUDIENCE = 'https://appleid.apple.com'
/** 生成的 client secret 缓存（按 Team / Key / Client），过期前 5 分钟重新生成 */
const secrets = new Map<string, { secret: string, expires: number }>()

/**
 * Sign in with Apple：
 * - 请求 name / email 时必须使用 `response_mode=form_post`，回调为跨站 POST，
 *   因此 state Cookie 使用 SameSite=None; Secure，回调路由需排除在 csrf 之外；
 * - client_secret 是用 .p8 私钥（ES256）签名的 JWT，按需生成并缓存；
 * - 没有 userinfo 接口：用户来自校验后的 id_token，姓名只在首次授权时随表单字段 `user` 返回。
 */
export class AppleProvider extends OidcProvider<AppleProviderConfig & { issuer: string }> {
  protected override defaultScopes = ['name', 'email']
  protected override supportsPkce = false

  protected override defaultEndpoints(): Record<string, string> {
    return {
      authorize: 'https://appleid.apple.com/auth/authorize',
      token: 'https://appleid.apple.com/auth/token',
      jwks: 'https://appleid.apple.com/auth/keys',
    }
  }

  protected override async issuers(): Promise<string> {
    return 'https://appleid.apple.com'
  }

  protected override async authorizeParams(context: AuthorizeContext): Promise<Record<string, string>> {
    const params = await super.authorizeParams(context)
    return this.getScopes().length
      ? { ...params, response_mode: 'form_post' }
      : params
  }

  protected override stateCookieOptions(): CookieOptions {
    return {
      ...super.stateCookieOptions(),
      sameSite: 'none',
      secure: true,
    }
  }

  /** client_secret：配置了现成的 JWT 时直接使用，否则用私钥生成 */
  protected override async clientSecret(): Promise<string> {
    if (this.config.clientSecret)
      return this.config.clientSecret
    const { teamId, keyId, privateKey, clientId } = this.config
    if (!teamId || !keyId || !privateKey)
      throw new Error(`OAuth provider "${this.name}": teamId, keyId and privateKey are required to sign the Apple client secret`)
    const cacheKey = `${teamId}:${keyId}:${clientId}`
    const cached = secrets.get(cacheKey)
    if (cached && cached.expires - 300 > Date.now() / 1000)
      return cached.secret
    const ttl = this.config.secretTtl ?? 3600
    const secret = await signClientSecret({
      privateKey,
      algorithm: 'ES256',
      keyId,
      issuer: teamId,
      subject: clientId,
      audience: AUDIENCE,
      expiresIn: ttl,
    })
    secrets.set(cacheKey, { secret, expires: Math.floor(Date.now() / 1000) + ttl })
    return secret
  }

  /** 生成 client secret JWT（可用于调试或在其它服务中复用） */
  createClientSecret(): Promise<string> {
    return this.clientSecret()
  }

  /** App 内登录：直接传入客户端拿到的 identityToken（id_token）校验并取得用户 */
  override async userFromToken(token: string | (Partial<OAuthToken> & { accessToken: string }), extra: Record<string, string> = {}): Promise<OAuthUser> {
    return super.userFromToken(typeof token === 'string'
      ? { accessToken: '', idToken: token }
      : token, extra)
  }

  protected override async fetchUser(token: OAuthToken, context: UserContext): Promise<Json> {
    if (!token.idToken)
      this.fail('Apple did not return an id_token')
    const claims: Json = await this.verifyIdToken(token.idToken, context.nonce)
    // 首次授权时表单中带有 user：{"name":{"firstName","lastName"},"email"}
    let user: Json | undefined
    if (context.params.user) {
      try {
        user = JSON.parse(context.params.user)
      }
      catch {}
    }
    return user
      ? { ...claims, user }
      : claims
  }

  protected override mapUser(raw: Json): MappedUser {
    const name = raw.user?.name
      ? [raw.user.name.firstName, raw.user.name.lastName].filter(Boolean).join(' ')
      : undefined
    return {
      id: raw.sub,
      name,
      email: raw.email ?? raw.user?.email,
    }
  }
}
