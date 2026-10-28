import type { ExchangeContext } from '../provider'
import type { BaseProviderConfig, MappedUser, OAuthToken } from '../types'
import { OAuthProvider } from '../provider'

export interface FeishuProviderConfig extends BaseProviderConfig {
  /** `feishu`（默认，open.feishu.cn）或 `lark`（海外版，open.larksuite.com） */
  domain?: 'feishu' | 'lark'
  /** 作为 user.id 的字段：`open_id`（默认，每个应用不同）、`union_id`（同一开发者下一致）、`user_id`（租户内） */
  idField?: 'open_id' | 'union_id' | 'user_id'
}

type Json = Record<string, any>

/**
 * 飞书 / Lark 网页应用登录：authen v1 授权页 + v2 令牌接口（OAuth 2.0 标准字段，支持 PKCE），
 * 用户信息来自 `authen/v1/user_info`（user_access_token）。接口以 `code` 非 0 表示失败。
 * 需要 refresh_token 时在 scopes 中加入 `offline_access`。
 */
export class FeishuProvider extends OAuthProvider<FeishuProviderConfig> {
  protected override supportsPkce = true

  protected defaultEndpoints(): Record<string, string> {
    const lark = this.config.domain === 'lark'
    const accounts = lark ? 'https://accounts.larksuite.com' : 'https://accounts.feishu.cn'
    const open = lark ? 'https://open.larksuite.com' : 'https://open.feishu.cn'
    return {
      authorize: `${accounts}/open-apis/authen/v1/authorize`,
      token: `${open}/open-apis/authen/v2/oauth/token`,
      user: `${open}/open-apis/authen/v1/user_info`,
    }
  }

  protected override async exchangeCode(code: string, context: ExchangeContext): Promise<OAuthToken> {
    return this.#token({
      grant_type: 'authorization_code',
      code,
      redirect_uri: context.redirectUri,
      code_verifier: context.codeVerifier,
    })
  }

  override async refreshToken(refreshToken: string): Promise<OAuthToken> {
    return this.#token({ grant_type: 'refresh_token', refresh_token: refreshToken })
  }

  async #token(body: Record<string, string | undefined>): Promise<OAuthToken> {
    const data = await this.http(this.endpoints.token, {
      method: 'POST',
      json: {
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        ...body,
      },
    })
    if (data.code !== undefined && Number(data.code) !== 0)
      this.fail('Token request failed', data)
    return this.parseToken(data)
  }

  protected async fetchUser(token: OAuthToken): Promise<Json> {
    const data = await this.http(this.endpoints.user, { bearer: token.accessToken })
    if (Number(data.code) !== 0 || !data.data)
      this.fail('user_info failed', data)
    return data.data
  }

  protected mapUser(raw: Json): MappedUser {
    return {
      id: raw[this.config.idField ?? 'open_id'] ?? raw.open_id,
      name: raw.name,
      nickname: raw.en_name || raw.name,
      email: raw.email || raw.enterprise_email,
      avatar: raw.avatar_big ?? raw.avatar_url,
    }
  }
}
