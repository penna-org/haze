import type { HttpContext } from '../http/context'

export type Next = () => Promise<unknown>

/**
 * 中间件函数。洋葱模型：
 * - `return next()` / 返回 `undefined`：继续后续处理
 * - 返回其它值：短路并作为响应
 * - `const res = await next()` 之后可修改响应
 *
 * 字符串引用的额外参数会依次传入，例如 `'throttle:10,60'` → `(ctx, next, '10', '60')`
 */
export type MiddlewareHandler = (ctx: HttpContext, next: Next, ...args: string[]) => unknown

/** 类中间件，可通过 `inject()` 注入依赖 */
export interface Middleware {
  handle: MiddlewareHandler
}

export interface MiddlewareClass {
  new (): Middleware
}

/** 别名 / 分组名（可带参数 `name:a,b`）、函数或类 */
export type MiddlewareRef = string | MiddlewareHandler | MiddlewareClass

export interface MiddlewareConfig {
  /** 全局中间件，按顺序对所有请求生效 */
  global?: MiddlewareRef[]
  /** 别名，供路由按名引用 */
  alias?: Record<string, MiddlewareHandler | MiddlewareClass>
  /** 中间件组，例如 `api: ['throttle:60,60', ForceJson]` */
  groups?: Record<string, MiddlewareRef[]>
}

export function defineMiddleware(handler: MiddlewareHandler): MiddlewareHandler {
  return handler
}

export function defineMiddlewareConfig(config: MiddlewareConfig): MiddlewareConfig {
  return config
}
