import type { BaseProviderConfig, MappedUser, OAuthToken } from '../types'
import { OAuthProvider } from '../provider'

export interface GitLabProviderConfig extends BaseProviderConfig {
  /** 自建实例的地址，默认 `https://gitlab.com` */
  baseUrl?: string
}

type Json = Record<string, any>

/** GitLab（gitlab.com 或自建实例，支持 PKCE） */
export class GitLabProvider extends OAuthProvider<GitLabProviderConfig> {
  protected override defaultScopes = ['read_user']
  protected override supportsPkce = true

  protected defaultEndpoints(): Record<string, string> {
    const base = this.config.baseUrl?.replace(/\/+$/, '') ?? 'https://gitlab.com'
    return {
      authorize: `${base}/oauth/authorize`,
      token: `${base}/oauth/token`,
      user: `${base}/api/v4/user`,
    }
  }

  protected fetchUser(token: OAuthToken): Promise<Json> {
    return this.http(this.endpoints.user, { bearer: token.accessToken })
  }

  protected mapUser(raw: Json): MappedUser {
    return {
      id: raw.id,
      name: raw.name,
      nickname: raw.username,
      email: raw.email,
      avatar: raw.avatar_url,
    }
  }
}
