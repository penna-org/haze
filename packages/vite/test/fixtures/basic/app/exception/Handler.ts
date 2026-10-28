import type { HttpContext } from '@hazejs/core'
import { ExceptionHandler } from '@hazejs/core'

export default class Handler extends ExceptionHandler {
  override render(error: unknown, ctx: HttpContext) {
    ctx.setHeader('x-handler', 'custom')
    return super.render(error, ctx)
  }
}
