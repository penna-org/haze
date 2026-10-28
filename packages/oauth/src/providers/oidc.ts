import type { JWTPayload } from 'jose'
import type { UserContext } from '../provider'
import type { BaseProviderConfig, MappedUser, OAuthToken } from '../types'
import { OAuthException } from '../errors'
import { verifyIdToken } from '../jwt'
import { OAuthProvider } from '../provider'

export interface OidcProviderConfig extends BaseProviderConfig {
  /** 签发者（issuer），discovery 文档位于 `<issuer>/.well-known/openid-configuration` */
  issuer: string
  /** 再请求 userinfo 接口补充资料，默认 true（存在 userinfo_endpoint 时） */
  userinfo?: boolean
  /** id_token 允许的签名算法，默认 RS256 / ES256 等非对称算法 */
  algorithms?: string[]
}

/** discovery 文档中用到的字段 */
export interface OidcDiscovery {
  issuer: string
  authorization_endpoint: string
  token_endpoint: string
  userinfo_endpoint?: string
  jwks_uri: string
  [key: string]: unknown
}

/** discovery 缓存（按 issuer，进程内） */
const discoveries = new Map<string, Promise<OidcDiscovery>>()

/** 清空 discovery 缓存（测试用） */
export function clearDiscoveryCache(): void {
  discoveries.clear()
}

type Json = Record<string, any>

/**
 * 通用 OpenID Connect 驱动：discovery 读取接口地址，PKCE + nonce，
 * id_token 用 JWKS 校验签名、iss、aud 与 nonce，再按需合并 userinfo。
 * Google 与 Apple 基于它实现。
 */
export class OidcProvider<C extends OidcProviderConfig = OidcProviderConfig> extends OAuthProvider<C> {
  protected override defaultScopes = ['openid', 'profile', 'email']
  protected override supportsPkce = true
  protected override usesNonce = true

  protected defaultEndpoints(): Record<string, string> {
    return {}
  }

  /** 允许的 iss（默认为 discovery 中的 issuer） */
  protected async issuers(): Promise<string | string[]> {
    return (await this.discover()).issuer
  }

  /** 读取并缓存 discovery 文档 */
  discover(): Promise<OidcDiscovery> {
    const issuer = this.config.issuer?.replace(/\/+$/, '')
    if (!issuer)
      throw new Error(`OAuth provider "${this.name}": issuer is required`)
    let discovery = discoveries.get(issuer)
    if (!discovery) {
      discovery = this.http<OidcDiscovery>(`${issuer}/.well-known/openid-configuration`).then((document) => {
        if (!document.authorization_endpoint || !document.token_endpoint || !document.jwks_uri)
          this.fail('Invalid OpenID Connect discovery document', document)
        if (document.issuer.replace(/\/+$/, '') !== issuer)
          this.fail(`Discovery issuer "${document.issuer}" does not match "${issuer}"`)
        return document
      })
      // 失败时不缓存，下次重试
      discovery.catch(() => discoveries.delete(issuer))
      discoveries.set(issuer, discovery)
    }
    return discovery
  }

  protected override async endpoint(key: string): Promise<string> {
    const configured = this.endpoints[key]
    if (configured)
      return configured
    const discovery = await this.discover()
    const url = {
      authorize: discovery.authorization_endpoint,
      token: discovery.token_endpoint,
      userinfo: discovery.userinfo_endpoint,
      jwks: discovery.jwks_uri,
    }[key]
    if (!url)
      throw new Error(`OAuth provider "${this.name}": endpoint "${key}" is not available`)
    return url
  }

  /** 校验 id_token 并返回声明 */
  async verifyIdToken(idToken: string, nonce?: string): Promise<JWTPayload> {
    try {
      return await verifyIdToken(idToken, {
        jwksUri: await this.endpoint('jwks'),
        issuer: await this.issuers(),
        audience: this.config.clientId,
        nonce,
        algorithms: this.config.algorithms,
        fetch: this.options.fetch,
      })
    }
    catch (error) {
      if (error instanceof OAuthException)
        throw error
      throw new OAuthException(this.name, `Invalid id_token: ${(error as Error).message}`, { code: 'invalid_id_token', cause: error })
    }
  }

  protected async fetchUser(token: OAuthToken, context: UserContext): Promise<Json> {
    let claims: Json = {}
    if (token.idToken) {
      // 有状态的授权码流程中必须带回同一个 nonce
      claims = await this.verifyIdToken(token.idToken, context.nonce)
    }
    else if (context.nonce) {
      this.fail('The token response has no id_token')
    }
    const userinfo = await this.userinfo(token)
    if (userinfo && claims.sub && userinfo.sub !== claims.sub)
      this.fail('userinfo sub does not match id_token sub')
    const merged = {
      ...claims,
      ...userinfo,
    }
    if (merged.sub === undefined)
      this.fail('Neither id_token nor userinfo returned a subject')
    return merged
  }

  /** 请求 userinfo（未开启或没有该接口时返回 undefined） */
  protected async userinfo(token: OAuthToken): Promise<Json | undefined> {
    if (this.config.userinfo === false)
      return undefined
    let url: string
    try {
      url = await this.endpoint('userinfo')
    }
    catch {
      return undefined
    }
    return this.http(url, { bearer: token.accessToken })
  }

  protected mapUser(raw: Json): MappedUser {
    return {
      id: raw.sub,
      name: raw.name ?? ([raw.given_name, raw.family_name].filter(Boolean).join(' ') || undefined),
      nickname: raw.preferred_username ?? raw.nickname,
      email: raw.email,
      avatar: raw.picture,
    }
  }
}

/** Google 的配置（issuer 固定，无需填写） */
export type GoogleProviderConfig = Omit<OidcProviderConfig, 'issuer'>

/** Google（OpenID Connect）：固定接口地址，无需 discovery 请求 */
export class GoogleProvider extends OidcProvider {
  protected override defaultEndpoints(): Record<string, string> {
    return {
      authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
      token: 'https://oauth2.googleapis.com/token',
      userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
      jwks: 'https://www.googleapis.com/oauth2/v3/certs',
    }
  }

  protected override async issuers(): Promise<string[]> {
    return ['https://accounts.google.com', 'accounts.google.com']
  }
}
