import type { HttpContext } from '@think-h3/core'
import { ExceptionHandler, ValidationException } from '@think-h3/core'

export default class Handler extends ExceptionHandler {
  protected override dontReport = [ValidationException]

  override report(error: unknown, ctx: HttpContext) {
    if (!this.shouldReport(error))
      return
    // ctx.logger 已带 requestId；可在此接入 Sentry 等上报服务
    ctx.logger.error(`${ctx.method} ${ctx.path}`, error)
  }
}
