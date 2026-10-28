import type { ExchangeContext, UserContext } from '../provider'
import type { BaseProviderConfig, MappedUser, OAuthToken } from '../types'
import { OAuthProvider } from '../provider'

export interface QQProviderConfig extends BaseProviderConfig {
  /** clientId 为 APP ID，clientSecret 为 APP Key */
  clientSecret: string
  /** 作为 user.id 的字段：`openid`（默认）或 `unionid`（需申请 unionid 权限） */
  idField?: 'openid' | 'unionid'
}

type Json = Record<string, any>

/**
 * QQ 互联（graph.qq.com）：
 * - 换取令牌为 GET，带 `fmt=json` 返回 JSON（否则为 urlencoded / JSONP）；
 * - openid 需再请求 `/oauth2.0/me`（`unionid=1` 同时返回 unionid）；
 * - get_user_info 需要 oauth_consumer_key（APP ID）与 openid，错误为非 0 的 ret。
 */
export class QQProvider extends OAuthProvider<QQProviderConfig> {
  protected override defaultScopes = ['get_user_info']
  protected override scopeSeparator = ','

  protected defaultEndpoints(): Record<string, string> {
    return {
      authorize: 'https://graph.qq.com/oauth2.0/authorize',
      token: 'https://graph.qq.com/oauth2.0/token',
      me: 'https://graph.qq.com/oauth2.0/me',
      user: 'https://graph.qq.com/user/get_user_info',
    }
  }

  protected override async exchangeCode(code: string, context: ExchangeContext): Promise<OAuthToken> {
    const data = await this.http(this.endpoints.token, {
      query: {
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        code,
        redirect_uri: context.redirectUri,
        fmt: 'json',
      },
    })
    return this.parseToken(data)
  }

  override async refreshToken(refreshToken: string): Promise<OAuthToken> {
    const data = await this.http(this.endpoints.token, {
      query: {
        grant_type: 'refresh_token',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: refreshToken,
        fmt: 'json',
      },
    })
    return this.parseToken(data)
  }

  protected async fetchUser(token: OAuthToken, _context: UserContext): Promise<Json> {
    const me = await this.http(this.endpoints.me, {
      query: { access_token: token.accessToken, unionid: 1, fmt: 'json' },
    })
    if (!me.openid)
      this.fail('/oauth2.0/me returned no openid', me)
    const user = await this.http(this.endpoints.user, {
      query: {
        access_token: token.accessToken,
        oauth_consumer_key: this.config.clientId,
        openid: me.openid,
      },
    })
    if (user.ret !== undefined && Number(user.ret) !== 0)
      this.fail('get_user_info failed', user)
    return { ...user, openid: me.openid, unionid: me.unionid }
  }

  protected mapUser(raw: Json): MappedUser {
    return {
      id: this.config.idField === 'unionid'
        ? raw.unionid ?? raw.openid
        : raw.openid,
      name: raw.nickname,
      nickname: raw.nickname,
      avatar: raw.figureurl_qq_2 || raw.figureurl_qq_1 || raw.figureurl_2 || raw.figureurl_qq,
    }
  }
}
