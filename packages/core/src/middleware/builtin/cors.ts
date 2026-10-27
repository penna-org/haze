import type { CorsOptions } from 'h3'
import type { MiddlewareHandler } from '../types'
import { handleCors } from 'h3'

export type { CorsOptions }

/**
 * `cors`：跨域（配置在 config/cors.ts，默认允许任意来源）。
 * 预检请求（OPTIONS）匹配不到路由，因此需放在全局中间件中。
 */
export const cors: MiddlewareHandler = (ctx, next) => {
  const preflight = handleCors(ctx.event, ctx.config.get<CorsOptions>('cors', {}))
  return preflight === false
    ? next()
    : preflight
}

export function defineCorsConfig(config: CorsOptions | (() => CorsOptions)): CorsOptions | (() => CorsOptions) {
  return config
}
