import type { AuthorizeContext, UserContext } from '../provider'
import type { BaseProviderConfig, MappedUser, OAuthToken } from '../types'
import { OAuthException } from '../errors'
import { OAuthProvider } from '../provider'
import { rsaSign, rsaVerify } from '../rsa'

export interface AlipayProviderConfig extends BaseProviderConfig {
  /** clientId 为支付宝开放平台的 APPID */
  clientId: string
  /** 应用私钥（RSA2，PKCS#8 / PKCS#1 PEM 或纯 base64） */
  privateKey: string
  /** 支付宝公钥：配置后校验响应签名（推荐） */
  alipayPublicKey?: string
  /** 使用沙箱环境 */
  sandbox?: boolean
}

type Json = Record<string, any>

/** 待签名字符串：去掉 sign 与空值，按键名 ASCII 排序后以 `k=v&k=v` 拼接（值不做 URL 编码） */
export function alipaySignContent(params: Record<string, string | undefined>): string {
  return Object.keys(params)
    .filter(key => key !== 'sign' && params[key] !== undefined && params[key] !== '')
    .sort()
    .map(key => `${key}=${params[key]}`)
    .join('&')
}

/** 对请求参数签名（RSA2） */
export function alipaySign(params: Record<string, string | undefined>, privateKey: string): Promise<string> {
  return rsaSign(alipaySignContent(params), privateKey)
}

/** 北京时间 `yyyy-MM-dd HH:mm:ss`（网关要求） */
function timestamp(): string {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 19).replace('T', ' ')
}

/**
 * 从响应原文中取出某个节点的 JSON 原文（验签针对原文，不能重新序列化）。
 * 从 `"<node>":` 之后按括号配对扫描，跳过字符串中的括号。
 */
export function extractResponseNode(text: string, node: string): string | undefined {
  const start = text.indexOf(`"${node}"`)
  if (start < 0)
    return undefined
  let index = text.indexOf('{', start + node.length + 2)
  if (index < 0)
    return undefined
  const begin = index
  let depth = 0
  let inString = false
  for (; index < text.length; index++) {
    const char = text[index]
    if (inString) {
      if (char === '\\')
        index++
      else if (char === '"')
        inString = false
    }
    else if (char === '"') {
      inString = true
    }
    else if (char === '{') {
      depth++
    }
    else if (char === '}' && --depth === 0) {
      return text.slice(begin, index + 1)
    }
  }
  return undefined
}

/**
 * 支付宝网页 / 移动应用授权登录（`auth_user`）：
 * - 授权页参数为 app_id / scope / redirect_uri / state，回调参数为 `auth_code`；
 * - 换取令牌（alipay.system.oauth.token）与读取用户（alipay.user.info.share）都是 RSA2 签名的网关请求；
 * - 配置 alipayPublicKey 时校验响应签名；user.id 为 open_id（老应用为 user_id）。
 */
export class AlipayProvider extends OAuthProvider<AlipayProviderConfig> {
  protected override defaultScopes = ['auth_user']
  protected override scopeSeparator = ','
  protected override codeParam = 'auth_code'

  protected defaultEndpoints(): Record<string, string> {
    return this.config.sandbox
      ? {
          authorize: 'https://openauth-sandbox.dl.alipaydev.com/oauth2/publicAppAuthorize.htm',
          gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
        }
      : {
          authorize: 'https://openauth.alipay.com/oauth2/publicAppAuthorize.htm',
          gateway: 'https://openapi.alipay.com/gateway.do',
        }
  }

  protected override authorizeParams(context: AuthorizeContext): Record<string, string> {
    return {
      app_id: this.config.clientId,
      scope: this.getScopes().join(this.scopeSeparator),
      redirect_uri: context.redirectUri,
      state: context.state,
    }
  }

  /**
   * 调用网关接口：公共参数 + 接口参数一并签名，表单 POST。
   * 返回 `<method 以 _ 连接>_response` 节点；`code` 不为 10000 或返回 error_response 时抛错。
   */
  async gateway(method: string, params: Record<string, string | undefined> = {}): Promise<Json> {
    if (!this.config.privateKey)
      throw new Error(`OAuth provider "${this.name}": privateKey is required`)
    const request: Record<string, string | undefined> = {
      app_id: this.config.clientId,
      method,
      format: 'JSON',
      charset: 'utf-8',
      sign_type: 'RSA2',
      timestamp: timestamp(),
      version: '1.0',
      ...params,
    }
    request.sign = await alipaySign(request, this.config.privateKey)
    let response: Response
    try {
      response = await this.options.fetch(`${this.endpoints.gateway}?charset=utf-8`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded;charset=utf-8', 'accept': 'application/json' },
        body: new URLSearchParams(Object.entries(request).filter((entry): entry is [string, string] => entry[1] !== undefined)).toString(),
      })
    }
    catch (error) {
      throw new OAuthException(this.name, `Request to the Alipay gateway failed`, { status: 502, code: 'provider_unreachable', cause: error })
    }
    const text = await response.text()
    let data: Json
    try {
      data = JSON.parse(text)
    }
    catch {
      this.fail(`${method} returned invalid JSON`, undefined, 502)
    }
    if (data.error_response)
      this.fail(`${method} failed`, { ...data.error_response, msg: data.error_response.sub_msg ?? data.error_response.msg })
    const node = `${method.replace(/\./g, '_')}_response`
    const result = data[node] as Json | undefined
    if (!result)
      this.fail(`${method} returned no ${node}`, data, 502)
    if (this.config.alipayPublicKey) {
      const content = extractResponseNode(text, node)
      if (!data.sign || !content || !await rsaVerify(content, data.sign, this.config.alipayPublicKey))
        this.fail(`${method} response signature is invalid`, undefined, 502)
    }
    if (result.code !== undefined && result.code !== '10000')
      this.fail(`${method} failed`, { ...result, msg: result.sub_msg ?? result.msg })
    return result
  }

  protected override async exchangeCode(code: string): Promise<OAuthToken> {
    return this.#token(await this.gateway('alipay.system.oauth.token', { grant_type: 'authorization_code', code }))
  }

  override async refreshToken(refreshToken: string): Promise<OAuthToken> {
    return this.#token(await this.gateway('alipay.system.oauth.token', { grant_type: 'refresh_token', refresh_token: refreshToken }))
  }

  #token(data: Json): OAuthToken {
    if (!data.access_token)
      this.fail('alipay.system.oauth.token returned no access_token', data)
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresIn: data.expires_in === undefined
        ? undefined
        : Number(data.expires_in),
      raw: data,
    }
  }

  protected async fetchUser(token: OAuthToken, _context: UserContext): Promise<Json> {
    const user = await this.gateway('alipay.user.info.share', { auth_token: token.accessToken })
    return {
      ...user,
      open_id: user.open_id ?? token.raw.open_id,
      user_id: user.user_id ?? token.raw.user_id,
    }
  }

  protected mapUser(raw: Json): MappedUser {
    return {
      id: raw.open_id ?? raw.user_id,
      name: raw.nick_name,
      nickname: raw.nick_name,
      avatar: raw.avatar,
    }
  }
}
