import type { HttpContext, Middleware, Next } from '@hazejs/core'
import { HttpException } from '@hazejs/core'

/** 只接受 JSON 请求体；模块以别名 '{{moduleName}}.json' 注册，宿主项目的路由也可以使用 */
export class EnsureJson implements Middleware {
  handle(ctx: HttpContext, next: Next) {
    if (!ctx.header('content-type')?.includes('application/json'))
      throw new HttpException('Expected a JSON body', { status: 415 })
    return next()
  }
}
