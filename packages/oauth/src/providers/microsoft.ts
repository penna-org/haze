import type { BaseProviderConfig, MappedUser, OAuthToken } from '../types'
import { OAuthProvider } from '../provider'

export interface MicrosoftProviderConfig extends BaseProviderConfig {
  /**
   * 租户：`common`（默认，个人与工作 / 学校账号）、`organizations`（仅工作 / 学校账号）、
   * `consumers`（仅个人账号），或租户 ID / 域名（单租户应用）
   */
  tenant?: string
}

type Json = Record<string, any>

/** Microsoft Entra ID（原 Azure AD）v2.0 终结点，用户资料来自 Microsoft Graph `/me` */
export class MicrosoftProvider extends OAuthProvider<MicrosoftProviderConfig> {
  protected override defaultScopes = [
    'openid',
    'profile',
    'email',
    'User.Read',
  ]

  protected override supportsPkce = true

  protected defaultEndpoints(): Record<string, string> {
    const tenant = encodeURIComponent(this.config.tenant ?? 'common')
    return {
      authorize: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`,
      token: `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`,
      user: 'https://graph.microsoft.com/v1.0/me',
    }
  }

  protected fetchUser(token: OAuthToken): Promise<Json> {
    return this.http(this.endpoints.user, { bearer: token.accessToken })
  }

  protected mapUser(raw: Json): MappedUser {
    return {
      id: raw.id,
      name: raw.displayName,
      nickname: raw.userPrincipalName,
      // 个人账号的 mail 可能为空，退回 UPN
      email: raw.mail ?? raw.userPrincipalName,
    }
  }
}
