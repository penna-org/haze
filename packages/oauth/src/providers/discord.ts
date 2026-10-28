import type { MappedUser, OAuthToken } from '../types'
import { OAuthProvider } from '../provider'

type Json = Record<string, any>

/** Discord */
export class DiscordProvider extends OAuthProvider {
  protected override defaultScopes = ['identify', 'email']

  protected defaultEndpoints(): Record<string, string> {
    return {
      authorize: 'https://discord.com/oauth2/authorize',
      token: 'https://discord.com/api/oauth2/token',
      user: 'https://discord.com/api/users/@me',
      cdn: 'https://cdn.discordapp.com',
    }
  }

  protected fetchUser(token: OAuthToken): Promise<Json> {
    return this.http(this.endpoints.user, { bearer: token.accessToken })
  }

  protected mapUser(raw: Json): MappedUser {
    // 头像为哈希，以 a_ 开头的是动图
    const avatar = raw.avatar
      ? `${this.endpoints.cdn}/avatars/${raw.id}/${raw.avatar}.${String(raw.avatar).startsWith('a_')
        ? 'gif'
        : 'png'}`
      : undefined
    return {
      id: raw.id,
      name: raw.global_name ?? raw.username,
      nickname: raw.username,
      // 未验证的邮箱不可信
      email: raw.verified === false
        ? undefined
        : raw.email,
      avatar,
    }
  }
}
