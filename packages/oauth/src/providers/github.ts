import type { BaseProviderConfig, MappedUser, OAuthToken } from '../types'
import { OAuthProvider } from '../provider'

export interface GitHubProviderConfig extends BaseProviderConfig {
  /** GitHub Enterprise Server：如 `https://github.example.com`（API 为 `<baseUrl>/api/v3`） */
  baseUrl?: string
}

type Json = Record<string, any>

/** fetchUser 核对出的邮箱验证状态（不写进 raw，保持它是接口的原始响应） */
const emailVerified = new WeakMap<Json, boolean | null>()

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
    // 用 user:email 权限读取邮箱列表：公开资料中没有邮箱时取已验证的主邮箱；
    // 有公开邮箱时在列表中核对它是否已验证（/user 本身不带验证状态）
    let verified: boolean | null = null
    try {
      const emails = await this.http<Json[]>(this.endpoints.emails, { bearer: token.accessToken, headers })
      if (Array.isArray(emails)) {
        if (user.email) {
          const match = emails.find(item => typeof item.email === 'string' && item.email.toLowerCase() === String(user.email).toLowerCase())
          verified = match
            ? match.verified === true
            : null
        }
        else {
          const primary = emails.find(item => item.primary && item.verified) ?? emails.find(item => item.verified)
          if (primary) {
            user.email = primary.email
            verified = true
          }
        }
      }
    }
    catch {
      // 没有 user:email 权限时忽略（邮箱的验证状态未知）
    }
    emailVerified.set(user, verified)
    return user
  }

  protected mapUser(raw: Json): MappedUser {
    return {
      id: raw.id,
      name: raw.name,
      nickname: raw.login,
      email: raw.email,
      emailVerified: emailVerified.get(raw) ?? null,
      avatar: raw.avatar_url,
    }
  }
}
