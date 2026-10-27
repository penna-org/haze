import type { HttpContext } from '@think-h3/core'
import { ExceptionHandler } from '@think-h3/core'

export default class Handler extends ExceptionHandler {
  override render(error: unknown, ctx: HttpContext) {
    ctx.setHeader('x-handler', 'custom')
    return super.render(error, ctx)
  }
}
