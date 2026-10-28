import type { AuthorizeContext, UserContext } from '../provider'
import type { BaseProviderConfig, MappedUser, OAuthToken, OAuthUser } from '../types'
import { OAuthException } from '../errors'
import { OAuthProvider } from '../provider'

export interface WeComProviderConfig extends BaseProviderConfig {
  /** clientId 为企业 ID（corpid），clientSecret 为应用的 Secret（corpsecret） */
  clientSecret: string
  /** 应用的 AgentId */
  agentId: string | number
  /**
   * - `qr`（默认）：浏览器中扫码登录（login.work.weixin.qq.com/wwlogin/sso/login）
   * - `web`：在企业微信内打开的网页授权（open.weixin.qq.com/connect/oauth2/authorize）
   */
  mode?: 'qr' | 'web'
  /** 用 user_ticket 读取敏感信息（头像、邮箱、手机号；需 `snsapi_privateinfo` 且仅 web 模式） */
  detail?: boolean
  /** 调用 user/get 读取姓名等通讯录信息（2022 年后新建的应用通常无权限） */
  profile?: boolean
}

type Json = Record<string, any>

/** 企业 access_token 缓存（按 corpid + secret），提前 5 分钟刷新 */
const corpTokens = new Map<string, { token: string, expires: number }>()

/**
 * 企业微信登录：
 * - 不是标准的“授权码换用户令牌”：用应用的企业 access_token（gettoken）调用 `auth/getuserinfo` 换取成员 userid；
 * - 非企业成员返回 openid（user.id 为 openid）；
 * - 返回的 token.accessToken 为 user_ticket（web 模式且 scope 为 snsapi_privateinfo 时才有），否则为空字符串；
 * - 不支持 userFromToken() / refreshToken()。
 */
export class WeComProvider extends OAuthProvider<WeComProviderConfig> {
  protected override defaultScopes = ['snsapi_base']

  protected defaultEndpoints(): Record<string, string> {
    return {
      authorize: this.config.mode === 'web'
        ? 'https://open.weixin.qq.com/connect/oauth2/authorize'
        : 'https://login.work.weixin.qq.com/wwlogin/sso/login',
      token: 'https://qyapi.weixin.qq.com/cgi-bin/gettoken',
      userinfo: 'https://qyapi.weixin.qq.com/cgi-bin/auth/getuserinfo',
      detail: 'https://qyapi.weixin.qq.com/cgi-bin/auth/getuserdetail',
      user: 'https://qyapi.weixin.qq.com/cgi-bin/user/get',
    }
  }

  protected override authorizeParams(context: AuthorizeContext): Record<string, string> {
    const agentid = String(this.config.agentId)
    if (this.config.mode === 'web') {
      return {
        appid: this.config.clientId,
        redirect_uri: context.redirectUri,
        response_type: 'code',
        scope: this.getScopes().join(','),
        state: context.state,
        agentid,
      }
    }
    return {
      login_type: 'CorpApp',
      appid: this.config.clientId,
      agentid,
      redirect_uri: context.redirectUri,
      state: context.state,
    }
  }

  protected override async buildAuthorizationUrl(params: Record<string, string>): Promise<string> {
    const url = await super.buildAuthorizationUrl(params)
    return this.config.mode === 'web'
      ? `${url}#wechat_redirect`
      : url
  }

  /** 企业 access_token（缓存） */
  async corpToken(): Promise<string> {
    const key = `${this.config.clientId}:${this.config.clientSecret}`
    const cached = corpTokens.get(key)
    if (cached && cached.expires > Date.now())
      return cached.token
    const data = await this.http(this.endpoints.token, {
      query: { corpid: this.config.clientId, corpsecret: this.config.clientSecret },
    })
    if (!data.access_token)
      this.fail('gettoken returned no access_token', data)
    corpTokens.set(key, { token: data.access_token, expires: Date.now() + (Number(data.expires_in ?? 7200) - 300) * 1000 })
    return data.access_token
  }

  /** 用授权码换取成员身份（userid / user_ticket，或非成员的 openid） */
  protected override async exchangeCode(code: string): Promise<OAuthToken> {
    const identity = await this.http(this.endpoints.userinfo, {
      query: { access_token: await this.corpToken(), code },
    })
    return {
      accessToken: identity.user_ticket ?? '',
      expiresIn: identity.expires_in === undefined
        ? undefined
        : Number(identity.expires_in),
      raw: identity,
    }
  }

  override async userFromToken(): Promise<OAuthUser> {
    throw new OAuthException(this.name, 'WeCom does not support userFromToken()', { code: 'unsupported' })
  }

  override async refreshToken(): Promise<OAuthToken> {
    throw new OAuthException(this.name, 'WeCom does not support refreshToken()', { code: 'unsupported' })
  }

  protected async fetchUser(token: OAuthToken, _context: UserContext): Promise<Json> {
    // 新接口为 userid，旧接口为 UserId
    const userid = (token.raw.userid ?? token.raw.UserId) as string | undefined
    let user: Json = { ...token.raw, userid }
    if (!userid)
      return user
    if (this.config.detail && token.raw.user_ticket) {
      const detail = await this.http(this.endpoints.detail, {
        method: 'POST',
        query: { access_token: await this.corpToken() },
        json: { user_ticket: token.raw.user_ticket },
      })
      user = {
        ...user,
        ...detail,
      }
    }
    if (this.config.profile) {
      const profile = await this.http(this.endpoints.user, {
        query: { access_token: await this.corpToken(), userid },
      })
      user = {
        ...user,
        ...profile,
      }
    }
    return user
  }

  protected mapUser(raw: Json): MappedUser {
    return {
      id: raw.userid ?? raw.openid,
      name: raw.name,
      nickname: raw.alias || raw.userid,
      email: raw.biz_mail || raw.email,
      avatar: raw.avatar,
    }
  }
}
