import type { HttpContext } from '@hazejs/core'
import { PasswordReset, validate, ValidationException } from '@hazejs/core'
import { ForgotPasswordSchema, ResetPasswordSchema } from '~/app/validate/auth'

/** 找回密码：发送重置链接 → 前端页面提交新密码（config/auth.ts 的 passwords） */
export class PasswordResetController {
  async forgot(ctx: HttpContext) {
    const { email } = await validate(ForgotPasswordSchema, await ctx.body())
    const status = await PasswordReset.sendLink(email)
    // 无论邮箱是否注册都返回同样的结果，避免被用来探测账号
    return {
      status: status === 'throttled'
        ? 'throttled'
        : 'sent',
    }
  }

  async reset(ctx: HttpContext) {
    const input = await validate(ResetPasswordSchema, await ctx.body())
    const status = await PasswordReset.reset(input)
    if (status !== 'reset') {
      throw new ValidationException([
        { target: 'body', path: 'token', message: '重置链接无效或已过期' },
      ])
    }
    return { status }
  }
}
