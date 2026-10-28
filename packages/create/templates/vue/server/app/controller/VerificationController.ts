import type { HttpContext } from '@hazejs/core'
import { hasVerifiedEmail, sendEmailVerification, verifyEmail } from '@hazejs/core'

/**
 * 邮箱验证：注册后发送签名链接（config/auth.ts 的 verification），
 * 需要已验证邮箱的接口加上 verified 中间件：.middleware(['auth', 'verified'])
 */
export class VerificationController {
  /** 重新发送验证邮件（需登录，限流） */
  async send(ctx: HttpContext) {
    const user = await ctx.auth.user()
    if (hasVerifiedEmail(user))
      return { status: 'verified' }
    await sendEmailVerification(user)
    return { status: 'sent' }
  }

  /** 邮件中的链接：签名无效或过期返回 403 */
  async verify(ctx: HttpContext) {
    const { verified } = await verifyEmail(ctx)
    return {
      status: verified ? 'verified' : 'already-verified',
    }
  }
}
