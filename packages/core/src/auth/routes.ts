import type { ValidationIssue } from '../exception/exceptions'
import type { HttpContext } from '../http/context'
import type { MiddlewareRef } from '../middleware/types'
import type { RouteBuilder } from '../routing/builder'
import { NotFoundException, ValidationException } from '../exception/exceptions'
import { PasswordReset } from './passwords'
import { hasVerifiedEmail, sendEmailVerification, verifyEmail } from './verification'

export interface AuthRoutesOptions {
  /**
   * 邮箱验证：
   * - `POST /email/verification-notification`（需登录）重新发送验证邮件；
   * - `GET /email/verify/:id/:hash`（签名链接）完成验证，路由名 `verification.verify`。
   * 链接由路由名生成：请把 config/auth.ts 的 `verification.route` 设为该路由的完整名称（含分组的 as 前缀）。
   */
  verification?: boolean
  /** 找回密码：`POST /forgot-password`、`POST /reset-password` */
  passwordReset?: boolean
  /** 个人访问令牌：`GET /tokens`、`POST /tokens`、`DELETE /tokens/:id`（需登录） */
  tokens?: boolean | { abilities?: string[] }
  /** 需要登录的路由使用的中间件，默认 `['auth']` */
  auth?: MiddlewareRef[]
  /** 未登录路由（发送邮件、重置密码）的限流，默认 `throttle:6,60`，false 关闭 */
  throttle?: string | false
  /** 新密码的最短长度，默认 8 */
  minPasswordLength?: number
}

const EMAIL_RE = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/

async function input(ctx: HttpContext, fields: Record<string, (value: unknown) => string | undefined>): Promise<Record<string, string>> {
  const body = (await ctx.body() ?? {}) as Record<string, unknown>
  const issues: ValidationIssue[] = []
  const values: Record<string, string> = {}
  for (const [field, check] of Object.entries(fields)) {
    const message = check(body[field])
    if (message)
      issues.push({ target: 'body', path: field, message })
    else
      values[field] = String(body[field])
  }
  if (issues.length)
    throw new ValidationException(issues)
  return values
}

function email(value: unknown): string | undefined {
  return typeof value === 'string' && EMAIL_RE.test(value)
    ? undefined
    : '邮箱格式不正确'
}
function required(value: unknown): string | undefined {
  return typeof value === 'string' && value.length
    ? undefined
    : '必填'
}

/**
 * 注册常用的认证接口（快速开始用；需要定制时参考文档自己写控制器）：
 *
 * ```ts
 * r.group({ prefix: '/api/auth', as: 'auth.' }, (r) => {
 *   authRoutes(r, { verification: true, passwordReset: true, tokens: true })
 * })
 * ```
 */
export function authRoutes(r: RouteBuilder, options: AuthRoutesOptions = {}): void {
  const auth = options.auth ?? ['auth']
  const throttle = options.throttle === false
    ? []
    : [options.throttle ?? 'throttle:6,60']
  const minLength = options.minPasswordLength ?? 8

  if (options.verification) {
    r.post('/email/verification-notification', async (ctx) => {
      const user = await ctx.auth.user()
      if (hasVerifiedEmail(user))
        return { status: 'verified' }
      await sendEmailVerification(user)
      return { status: 'sent' }
    }).middleware(...auth, ...throttle).name('verification.send')

    r.get('/email/verify/:id/:hash', async (ctx) => {
      const { verified } = await verifyEmail(ctx)
      return {
        status: verified ? 'verified' : 'already-verified',
      }
    }).middleware(...throttle).name('verification.verify')
  }

  if (options.passwordReset) {
    r.post('/forgot-password', async (ctx) => {
      const values = await input(ctx, { email })
      // 无论邮箱是否注册都返回同样的提示，避免枚举账号
      const status = await PasswordReset.sendLink(values.email)
      return {
        status: status === 'throttled'
          ? 'throttled'
          : 'sent',
      }
    }).middleware(...throttle).name('password.email')

    r.post('/reset-password', async (ctx) => {
      const values = await input(ctx, {
        email,
        token: required,
        password: value => typeof value === 'string' && value.length >= minLength
          ? undefined
          : `密码至少 ${minLength} 位`,
      })
      const status = await PasswordReset.reset({ email: values.email, token: values.token, password: values.password })
      if (status !== 'reset') {
        throw new ValidationException([
          { target: 'body', path: 'token', message: '重置链接无效或已过期' },
        ])
      }
      return { status }
    }).middleware(...throttle).name('password.update')
  }

  if (options.tokens) {
    const allowed = typeof options.tokens === 'object'
      ? options.tokens.abilities
      : undefined
    r.get('/tokens', async ctx => (await ctx.auth.token().tokens().list((await ctx.auth.user())!))
      .map(({ token: _hash, ...token }) => token)).middleware(...auth).name('tokens.index')

    r.post('/tokens', async (ctx) => {
      const values = await input(ctx, { name: required })
      const body = (await ctx.body() ?? {}) as Record<string, unknown>
      const abilities = Array.isArray(body.abilities)
        ? body.abilities.map(String)
        : undefined
      if (abilities && allowed && abilities.some(item => !allowed.includes(item))) {
        throw new ValidationException([
          { target: 'body', path: 'abilities', message: `只能申请这些能力：${allowed.join(', ')}` },
        ])
      }
      const issued = await ctx.auth.token().createToken((await ctx.auth.user())!, values.name, { abilities: abilities ?? allowed })
      const { token: _hash, ...accessToken } = issued.accessToken
      return ctx.created({ token: issued.plainTextToken, accessToken })
    }).middleware(...auth).name('tokens.store')

    r.delete('/tokens/:id', async (ctx) => {
      if (!(await ctx.auth.token().tokens().revoke(ctx.param('id')!, (await ctx.auth.user())!)))
        throw new NotFoundException('令牌不存在')
      return ctx.noContent()
    }).middleware(...auth).name('tokens.destroy')
  }
}
