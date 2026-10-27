import type { HttpContext } from '@think-h3/core'
import { ExceptionHandler } from '@think-h3/core'

/**
 * 全局异常处理：report() 负责记录 / 上报，render() 负责生成响应。
 * 开发环境中浏览器访问出错的地址会看到带源码定位的错误页。
 */
export default class Handler extends ExceptionHandler {
  override report(error: unknown, ctx: HttpContext) {
    // ctx.logger 已携带 requestId；可在此接入 Sentry 等上报服务
    return super.report(error, ctx)
  }
}
