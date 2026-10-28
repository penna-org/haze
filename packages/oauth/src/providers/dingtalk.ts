import type { AuthorizeContext } from '../provider'
import type { MappedUser, OAuthToken } from '../types'
import { OAuthProvider } from '../provider'

type Json = Record<string, any>

/**
 * 钉钉（新版 OAuth2：login.dingtalk.com + api.dingtalk.com）：
 * - clientId / clientSecret 为应用的 Client ID（原 AppKey）/ Client Secret（原 AppSecret）；
 * - 换取令牌为 JSON 请求（clientId、clientSecret、code、grantType），响应字段为驼峰（accessToken、expireIn）；
 * - 用户信息接口使用 `x-acs-dingtalk-access-token` 头；user.id 为 unionId。
 */
export class DingTalkProvider extends OAuthProvider {
  protected override defaultScopes = ['openid']

  protected defaultEndpoints(): Record<string, string> {
    return {
      authorize: 'https://login.dingtalk.com/oauth2/auth',
      token: 'https://api.dingtalk.com/v1.0/oauth2/userAccessToken',
      user: 'https://api.dingtalk.com/v1.0/contact/users/me',
    }
  }

  protected override async authorizeParams(context: AuthorizeContext): Promise<Record<string, string>> {
    return {
      ...await super.authorizeParams(context),
      prompt: 'consent',
    }
  }

  protected override async exchangeCode(code: string): Promise<OAuthToken> {
    return this.#token({ code, grantType: 'authorization_code' })
  }

  override async refreshToken(refreshToken: string): Promise<OAuthToken> {
    return this.#token({ refreshToken, grantType: 'refresh_token' })
  }

  async #token(body: Record<string, string>): Promise<OAuthToken> {
    const data = await this.http(this.endpoints.token, {
      method: 'POST',
      json: {
        clientId: this.config.clientId,
        clientSecret: this.config.clientSecret,
        ...body,
      },
    })
    if (!data.accessToken)
      this.fail('The token response has no accessToken', data)
    return {
      accessToken: data.accessToken,
      refreshToken: data.refreshToken,
      expiresIn: data.expireIn === undefined
        ? undefined
        : Number(data.expireIn),
      raw: data,
    }
  }

  protected fetchUser(token: OAuthToken): Promise<Json> {
    return this.http(this.endpoints.user, {
      headers: { 'x-acs-dingtalk-access-token': token.accessToken },
    })
  }

  protected mapUser(raw: Json): MappedUser {
    return {
      id: raw.unionId ?? raw.openId,
      name: raw.nick,
      nickname: raw.nick,
      email: raw.email,
      avatar: raw.avatarUrl,
    }
  }
}
