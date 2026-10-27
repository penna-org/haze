import type { MiddlewareHandler } from '../middleware/types'
import { ForbiddenException, UnauthorizedException } from '../exception/exceptions'
import { Gate } from './gate'

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

/**
 * `can:<ability>`：与模型无关的能力；`can:<ability>,<Model>`：类级能力（如 create）；
 * `can:<ability>,<Model>,<param>`：按路由参数用 Model.findOrFail() 加载实例并检查（不存在时 404），
 * 实例存入 `ctx.get('<model>')`（类名首字母小写）供控制器复用。
 */
export const can: MiddlewareHandler = async (ctx, next, ability, modelName, param) => {
  if (!ability)
    throw new Error('can middleware requires an ability, e.g. can:update,Post,id')
  if (!modelName) {
    await ctx.authorize(ability as never)
    return next()
  }
  const model = ctx.make(Gate).modelNamed(modelName)
  if (!model)
    throw new Error(`can:${ability},${modelName}: no policy is registered for model "${modelName}" (app/policy)`)
  if (!param) {
    await ctx.authorize(ability as never, model as never)
    return next()
  }
  const finder = (model as unknown as { findOrFail?: (id: unknown) => Promise<object> }).findOrFail
  if (typeof finder !== 'function')
    throw new TypeError(`can:${ability},${modelName},${param}: ${modelName} has no static findOrFail()`)
  const instance = await finder.call(model, ctx.param(param))
  ctx.set(modelName[0].toLowerCase() + modelName.slice(1), instance)
  await ctx.authorize(ability as never, instance as never)
  return next()
}
