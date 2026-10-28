import type { AuthorizeContext, UserContext } from '../provider'
import type { BaseProviderConfig, MappedUser, OAuthToken } from '../types'
import { OAuthProvider } from '../provider'

export interface WeChatProviderConfig extends BaseProviderConfig {
  /** clientId 为 AppID，clientSecret 为 AppSecret */
  clientSecret: string
  /** 作为 user.id 的字段：`openid`（默认，每个应用不同）或 `unionid`（同一开放平台账号下一致） */
  idField?: 'openid' | 'unionid'
  /** userinfo 的语言：zh_CN（默认）/ zh_TW / en */
  lang?: string
}

type Json = Record<string, any>

/**
 * 微信开放平台 · 网站应用扫码登录（`snsapi_login`）。
 * - 授权参数为 appid（不是 client_id），地址以 `#wechat_redirect` 结尾，参数顺序固定；
 * - 换取令牌为 GET，响应没有 token_type，附带 openid / unionid；错误为 errcode / errmsg；
 * - 不支持 PKCE。
 */
export class WeChatProvider extends OAuthProvider<WeChatProviderConfig> {
  protected override defaultScopes = ['snsapi_login']
  protected override scopeSeparator = ','

  protected defaultEndpoints(): Record<string, string> {
    return {
      authorize: 'https://open.weixin.qq.com/connect/qrconnect',
      token: 'https://api.weixin.qq.com/sns/oauth2/access_token',
      refresh: 'https://api.weixin.qq.com/sns/oauth2/refresh_token',
      user: 'https://api.weixin.qq.com/sns/userinfo',
    }
  }

  protected override authorizeParams(context: AuthorizeContext): Record<string, string> {
    // 微信要求参数按此顺序
    return {
      appid: this.config.clientId,
      redirect_uri: context.redirectUri,
      response_type: 'code',
      scope: this.getScopes().join(this.scopeSeparator),
      state: context.state,
    }
  }

  protected override async buildAuthorizationUrl(params: Record<string, string>): Promise<string> {
    return `${await super.buildAuthorizationUrl(params)}#wechat_redirect`
  }

  protected override async exchangeCode(code: string): Promise<OAuthToken> {
    const data = await this.http(this.endpoints.token, {
      query: {
        appid: this.config.clientId,
        secret: this.config.clientSecret,
        code,
        grant_type: 'authorization_code',
      },
    })
    return this.parseToken(data)
  }

  override async refreshToken(refreshToken: string): Promise<OAuthToken> {
    const data = await this.http(this.endpoints.refresh, {
      query: {
        appid: this.config.clientId,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      },
    })
    return this.parseToken(data)
  }

  /** 令牌响应中的 openid；userFromToken() 时由 extra.openid 提供 */
  protected openid(token: OAuthToken, context: UserContext): string {
    const openid = token.raw.openid ?? context.extra.openid
    if (!openid)
      this.fail('openid is required (pass userFromToken(token, { openid }))')
    return String(openid)
  }

  protected async fetchUser(token: OAuthToken, context: UserContext): Promise<Json> {
    const user = await this.http(this.endpoints.user, {
      query: {
        access_token: token.accessToken,
        openid: this.openid(token, context),
        lang: this.config.lang ?? 'zh_CN',
      },
    })
    return { unionid: token.raw.unionid, ...user }
  }

  protected mapUser(raw: Json): MappedUser {
    return {
      id: this.config.idField === 'unionid'
        ? raw.unionid ?? raw.openid
        : raw.openid,
      name: raw.nickname,
      nickname: raw.nickname,
      avatar: raw.headimgurl,
    }
  }
}

/**
 * 微信公众号网页授权（在微信内打开的网页）：
 * - `snsapi_base`：静默授权，只能拿到 openid（不请求 userinfo）；
 * - `snsapi_userinfo`（默认）：需用户确认，可获取昵称与头像。
 */
export class WeChatMpProvider extends WeChatProvider {
  protected override defaultScopes = ['snsapi_userinfo']

  protected override defaultEndpoints(): Record<string, string> {
    return {
      ...super.defaultEndpoints(),
      authorize: 'https://open.weixin.qq.com/connect/oauth2/authorize',
    }
  }

  protected override async fetchUser(token: OAuthToken, context: UserContext): Promise<Json> {
    const openid = this.openid(token, context)
    // 静默授权的令牌无权调用 userinfo
    const scope = String(token.raw.scope ?? '')
    if (scope && !scope.includes('snsapi_userinfo'))
      return { openid, unionid: token.raw.unionid }
    return super.fetchUser(token, context)
  }
}
