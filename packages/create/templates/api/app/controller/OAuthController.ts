import type { HttpContext } from '@hazejs/core'
import { BadRequestException } from '@hazejs/core'
import { OAuth } from '@hazejs/oauth'
import { User } from '~/app/model/User'

/**
 * GitHub 登录示例（config/oauth.ts）：未设置 GITHUB_CLIENT_ID 时两个接口都返回 404。
 * 浏览器访问 /api/auth/github → GitHub 授权 → 回调 /api/auth/github/callback，返回 JWT。
 */
export class OAuthController {
  redirect(ctx: HttpContext) {
    return OAuth.driver('github').redirect(ctx)
  }

  async callback(ctx: HttpContext) {
    const profile = await OAuth.driver('github').user(ctx)
    if (!profile.email)
      throw new BadRequestException('GitHub 账号没有可用的邮箱')
    // 示例按邮箱关联账号；正式项目建议另建 social_accounts 表记录 provider + profile.id
    const user = await User.where('email', profile.email).find()
      ?? await User.create({ name: profile.name ?? profile.nickname ?? profile.email, email: profile.email })
    // GitHub 返回的主邮箱已验证
    if (!user.emailVerifiedAt) {
      user.emailVerifiedAt = new Date()
      await user.save()
    }
    return ctx.auth.jwt().login(user)
  }
}
