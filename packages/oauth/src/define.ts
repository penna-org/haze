import type { HttpOptions } from './provider'
import type { BaseProviderConfig, DriverOptions, MappedUser, OAuthDriverFactory, OAuthToken } from './types'
import { OAuthProvider } from './provider'

type Json = Record<string, any>

export interface OAuthProviderDefinition<C extends BaseProviderConfig = BaseProviderConfig> {
  /** 接口地址：authorize / token 必填，user 为用户信息接口（未提供 fetchUser 时以 Bearer 请求） */
  endpoints: { authorize: string, token: string, user?: string, [key: string]: string | undefined } | ((config: C) => { authorize: string, token: string, user?: string, [key: string]: string | undefined })
  scopes?: string[]
  scopeSeparator?: string
  /** 默认是否启用 PKCE，默认 true */
  pkce?: boolean
  /** 自定义读取用户：`http` 为带错误处理的请求函数 */
  fetchUser?: (token: OAuthToken, helpers: { config: C, http: <T = Json>(url: string, options?: HttpOptions) => Promise<T> }) => Promise<Json>
  /** 原始用户信息 → 统一字段 */
  mapUser: (raw: Json, token: OAuthToken) => MappedUser
}

/**
 * 声明一个标准 OAuth 2.0 提供方（授权码 + 表单换取令牌 + Bearer 读取用户）：
 *
 * ```ts
 * const Gitea = defineOAuthProvider({
 *   endpoints: config => ({
 *     authorize: `${config.baseUrl}/login/oauth/authorize`,
 *     token: `${config.baseUrl}/login/oauth/access_token`,
 *     user: `${config.baseUrl}/api/v1/user`,
 *   }),
 *   scopes: ['read:user'],
 *   mapUser: raw => ({ id: raw.id, name: raw.full_name, nickname: raw.login, email: raw.email, avatar: raw.avatar_url }),
 * })
 * // config/oauth.ts：providers: { gitea: { driver: Gitea, clientId, clientSecret, redirect, baseUrl } }
 * // 或 registerOAuthProvider('gitea', Gitea) 后写 driver: 'gitea'
 * ```
 *
 * 流程不标准的提供方请继承 OAuthProvider 覆盖相应方法。
 */
export function defineOAuthProvider<C extends BaseProviderConfig = BaseProviderConfig & Record<string, any>>(definition: OAuthProviderDefinition<C>): OAuthDriverFactory {
  class DefinedProvider extends OAuthProvider<C> {
    protected override defaultScopes = definition.scopes ?? []
    protected override scopeSeparator = definition.scopeSeparator ?? ' '
    protected override supportsPkce = definition.pkce ?? true

    protected defaultEndpoints(): Record<string, string> {
      const endpoints = typeof definition.endpoints === 'function'
        ? definition.endpoints(this.config)
        : definition.endpoints
      return Object.fromEntries(Object.entries(endpoints).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    }

    protected fetchUser(token: OAuthToken): Promise<Json> {
      if (definition.fetchUser) {
        return definition.fetchUser(token, {
          config: this.config,
          http: (url, options) => this.http(url, options),
        })
      }
      const url = this.endpoints.user
      if (!url)
        throw new Error(`OAuth provider "${this.name}": define endpoints.user or fetchUser()`)
      return this.http(url, { bearer: token.accessToken })
    }

    protected mapUser(raw: Json, token: OAuthToken): MappedUser {
      return definition.mapUser(raw, token)
    }
  }
  return (name: string, config: C, options: DriverOptions) => new DefinedProvider(name, config, options)
}
