import type { MaybePromise } from '../utils'
import type { HttpContext } from './context'

/**
 * 出站拦截器：在统一格式化与异常渲染之后执行，拿到即将发出的 Response。
 * 修改 `response.headers` 或返回新的 Response 均可；返回 undefined 表示不替换。
 */
export type Interceptor = (response: Response, ctx: HttpContext) => MaybePromise<Response | void>

/**
 * 定义出站拦截器（`app/interceptor/*.ts` 的默认导出，按文件名顺序执行）：
 *
 * ```ts
 * export default defineInterceptor((response, ctx) => {
 *   response.headers.set('x-response-time', `${Math.round(performance.now() - ctx.startedAt)}ms`)
 * })
 * ```
 */
export function defineInterceptor(interceptor: Interceptor): Interceptor {
  return interceptor
}
