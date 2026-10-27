import type { HttpContext } from '@think-h3/core'
import { ExceptionHandler, ValidationException } from '@think-h3/core'

export default class Handler extends ExceptionHandler {
  protected override dontReport = [ValidationException]

  override report(error: unknown, ctx: HttpContext) {
    if (!this.shouldReport(error))
      return
    // 可在此接入 Sentry 等上报服务
    this.logger.error(`[${ctx.get('requestId')}] ${ctx.method} ${ctx.path}`, error)
  }

  override render(error: unknown, ctx: HttpContext) {
    // 所有错误响应都带上请求 ID，便于排查
    ctx.setHeader('x-request-id', ctx.get('requestId') ?? '')
    return super.render(error, ctx)
  }
}
