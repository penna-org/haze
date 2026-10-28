import type { OAuthProvider } from './provider'

/** 授权后得到的令牌（各家字段名不同，统一为驼峰；原始响应在 raw 中） */
export interface OAuthToken {
  accessToken: string
  refreshToken?: string
  /** 有效期（秒） */
  expiresIn?: number
  /** OpenID Connect 的 id_token（Google / Apple / Microsoft / OIDC） */
  idToken?: string
  tokenType?: string
  /** 实际授予的 scope（原样，可能以空格或逗号分隔） */
  scope?: string
  /** 令牌接口的原始响应 */
  raw: Record<string, unknown>
}

/** 统一的第三方用户 */
export interface OAuthUser<R = Record<string, unknown>> {
  /** 驱动名（config/oauth.ts 中的键） */
  provider: string
  /** 第三方的用户唯一标识（微信 / QQ 默认为 openid，可配置为 unionid） */
  id: string
  name: string | null
  nickname: string | null
  email: string | null
  avatar: string | null
  /** 用户信息接口的原始响应（含 unionid、手机号等各家特有字段） */
  raw: R
  token: OAuthToken
}

/** 映射用户信息时返回的字段（provider / raw / token 由框架补齐） */
export type MappedUser = Pick<OAuthUser, 'id'> & Partial<Pick<OAuthUser, 'name' | 'nickname' | 'email' | 'avatar'>>

/** 所有驱动共有的配置 */
export interface BaseProviderConfig {
  /**
   * 驱动名：内置驱动或 registerOAuthProvider() 注册的名字，也可直接传入 defineOAuthProvider() 的结果；
   * 省略时取 config/oauth.ts 中的键名
   */
  driver?: string | OAuthDriverFactory
  /** client_id / appid / app_id / AppKey / corpid（各家叫法不同，统一写在这里） */
  clientId: string
  /** client_secret / secret / AppSecret / corpsecret */
  clientSecret?: string
  /** 回调地址：绝对 URL，或站内路径（以 APP_URL 或当前请求的 origin 补全） */
  redirect: string
  /** 默认 scope（覆盖驱动的默认值） */
  scopes?: string[]
  /** 是否使用 PKCE（S256），默认按驱动支持情况 */
  pkce?: boolean
  /** 不校验 state（不写 Cookie / 会话），如 App 内嵌页或调用方自行校验 */
  stateless?: boolean
  /** 附加到授权地址的固定参数 */
  parameters?: Record<string, string>
  /** 覆盖接口地址（私有部署、代理、测试） */
  endpoints?: Record<string, string>
}

/** 驱动工厂：registerOAuthProvider() / defineOAuthProvider() 使用 */
export type OAuthDriverFactory = (name: string, config: any, options: DriverOptions) => OAuthProvider

/** 构造驱动时传入的公共选项 */
export interface DriverOptions {
  /** 发起 HTTP 请求的函数，默认全局 fetch（测试时可替换为模拟服务器） */
  fetch: typeof fetch
  /** state 的保存方式 */
  stateStore: 'cookie' | 'session'
  /** state Cookie 名前缀 */
  cookie: string
  /** state 有效期（秒） */
  stateTtl: number
}
