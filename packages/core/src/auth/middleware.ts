import type { MiddlewareHandler } from '../middleware/types'
import { ForbiddenException, UnauthorizedException } from '../exception/exceptions'

/** `auth` / `auth:api` / `auth:web,api`：任一 Guard 通过即放行，并作为本次请求的默认 Guard */
export const authenticate: MiddlewareHandler = async (ctx, next, ...guards) => {
  const names = guards.length
    ? guards
    : [ctx.auth.defaultGuard]
  for (const name of names) {
    if (await ctx.auth.guard(name).check()) {
      ctx.auth.shouldUse(name)
      return next()
    }
  }
  throw new UnauthorizedException('未登录或登录已过期')
}

/** `guest` / `guest:web`：已登录时拒绝（如注册、登录接口） */
export const guest: MiddlewareHandler = async (ctx, next, ...guards) => {
  const names = guards.length
    ? guards
    : [ctx.auth.defaultGuard]
  for (const name of names) {
    if (await ctx.auth.guard(name).check())
      throw new ForbiddenException('已登录')
  }
  return next()
}
