import type { MiddlewareHandler } from '../middleware/types'
import { ForbiddenException, UnauthorizedException } from '../exception/exceptions'
import { Gate } from './gate'

/**
 * `auth` / `auth:api` / `auth:web,api`：任一 Guard 通过即放行，并作为本次请求的默认 Guard。
 * 未通过时 401：没有凭据为 `code: 'unauthenticated'`，凭据无效（过期、签名不符等）为 `code: 'token_invalid'`，
 * 客户端可据此决定是去登录还是刷新令牌。
 *
 * 加上 `optional`（`auth:optional`、`auth:api,optional`）时不拒绝：登录了就识别用户，未登录或凭据无效按访客处理
 * （公开接口中也想知道是谁在访问）
 */
export const authenticate: MiddlewareHandler = async (ctx, next, ...args) => {
  const optional = args.includes('optional')
  const guards = args.filter(arg => arg !== 'optional')
  const names = guards.length
    ? guards
    : [ctx.auth.defaultGuard]
  let invalid = false
  for (const name of names) {
    const guard = ctx.auth.guard(name)
    let passed: boolean
    try {
      passed = await guard.check()
    }
    catch (error) {
      if (optional)
        continue
      throw error
    }
    if (passed) {
      ctx.auth.shouldUse(name)
      return next()
    }
    invalid ||= guard.failure === 'invalid'
  }
  if (optional) {
    // 按访客处理：清除本次请求中解析失败的用户，之后 ctx.auth.user() 为 undefined
    for (const name of names)
      ctx.auth.guard(name).setUser(undefined)
    return next()
  }
  throw new UnauthorizedException('未登录或登录已过期', {
    code: invalid ? 'token_invalid' : 'unauthenticated',
  })
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
 * `can:<ability>`：与模型无关的能力，`can:a|b` 拥有其中任一即可；`can:<ability>,<Model>`：类级能力（如 create）；
 * `can:<ability>,<Model>,<param>`：按路由参数用 Model.findOrFail() 加载实例并检查（不存在时 404），
 * 实例存入 `ctx.get('<model>')`（类名首字母小写）供控制器复用。
 */
export const can: MiddlewareHandler = async (ctx, next, ability, modelName, param) => {
  if (!ability)
    throw new Error('can middleware requires an ability, e.g. can:update,Post,id')
  if (!modelName) {
    if (ability.includes('|'))
      await ctx.authorizeAny(ability.split('|') as never)
    else
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

async function requireUser(ctx: Parameters<MiddlewareHandler>[0]): Promise<void> {
  if (!(await ctx.auth.check()))
    throw new UnauthorizedException('未登录或登录已过期')
}

/** `abilities:posts:read,posts:write`：当前令牌须具备全部能力（放在 auth 之后） */
export const abilities: MiddlewareHandler = async (ctx, next, ...required) => {
  if (!required.length)
    throw new Error('abilities middleware requires at least one ability, e.g. abilities:posts:write')
  await requireUser(ctx)
  for (const ability of required) {
    if (!(await ctx.auth.tokenCan(ability)))
      throw new ForbiddenException(`令牌缺少能力：${ability}`)
  }
  return next()
}

/** `ability:posts:read,posts:write`：当前令牌具备其中任一能力即可 */
export const ability: MiddlewareHandler = async (ctx, next, ...candidates) => {
  if (!candidates.length)
    throw new Error('ability middleware requires at least one ability, e.g. ability:posts:read')
  await requireUser(ctx)
  for (const item of candidates) {
    if (await ctx.auth.tokenCan(item))
      return next()
  }
  throw new ForbiddenException(`令牌缺少能力：${candidates.join(' / ')}`)
}
