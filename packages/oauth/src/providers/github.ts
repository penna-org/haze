import type { BaseProviderConfig, MappedUser, OAuthToken } from '../types'
import { OAuthProvider } from '../provider'

export interface GitHubProviderConfig extends BaseProviderConfig {
  /** GitHub Enterprise Server：如 `https://github.example.com`（API 为 `<baseUrl>/api/v3`） */
  baseUrl?: string
}

type Json = Record<string, any>

/** GitHub OAuth App / GitHub App 的用户授权（支持 PKCE） */
export class GitHubProvider extends OAuthProvider<GitHubProviderConfig> {
  protected override defaultScopes = ['read:user', 'user:email']
  protected override supportsPkce = true

  protected defaultEndpoints(): Record<string, string> {
    const base = this.config.baseUrl?.replace(/\/+$/, '') ?? 'https://github.com'
    const api = this.config.baseUrl
      ? `${base}/api/v3`
      : 'https://api.github.com'
    return {
      authorize: `${base}/login/oauth/authorize`,
      token: `${base}/login/oauth/access_token`,
      user: `${api}/user`,
      emails: `${api}/user/emails`,
    }
  }

  protected async fetchUser(token: OAuthToken): Promise<Json> {
    const headers = { 'x-github-api-version': '2022-11-28' }
    const user = await this.http(this.endpoints.user, { bearer: token.accessToken, headers })
    // 公开资料中没有邮箱时，用 user:email 权限读取已验证的主邮箱
    if (!user.email) {
      try {
        const emails = await this.http<Json[]>(this.endpoints.emails, { bearer: token.accessToken, headers })
        const primary = Array.isArray(emails)
          ? emails.find(item => item.primary && item.verified) ?? emails.find(item => item.verified)
          : undefined
        if (primary)
          user.email = primary.email
      }
      catch {
        // 没有 user:email 权限时忽略
      }
    }
    return user
  }

  protected mapUser(raw: Json): MappedUser {
    return {
      id: raw.id,
      name: raw.name,
      nickname: raw.login,
      email: raw.email,
      avatar: raw.avatar_url,
    }
  }
}
