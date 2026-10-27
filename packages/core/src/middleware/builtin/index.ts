import type { MiddlewareHandler } from '../types'
import { authenticate, guest } from '../../auth/middleware'
import { parseSize } from '../../utils'
import { compress } from './compress'
import { cors } from './cors'
import { secureHeaders } from './secure-headers'
import { throttle } from './throttle'

/** `bodyLimit:10mb`：调整本路由的请求体上限（默认 config/app.ts 的 bodyLimit，1mb） */
export const bodyLimit: MiddlewareHandler = (ctx, next, limit) => {
  if (!limit)
    throw new Error('bodyLimit requires a size, e.g. bodyLimit:10mb')
  ctx.bodyLimit = parseSize(limit)
  return next()
}

/** `session`：启动会话（ctx.session 可同步读写），响应前写回 */
export const session: MiddlewareHandler = async (ctx, next) => {
  await ctx.startSession()
  return next()
}

/** 内置中间件别名，可在 config/middleware.ts 的 alias 中用同名覆盖 */
export const builtinMiddleware: Record<string, MiddlewareHandler> = {
  cors,
  throttle,
  secureHeaders,
  compress,
  bodyLimit,
  session,
  auth: authenticate,
  guest,
}
