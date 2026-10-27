import type { HttpContext, NormalizedError } from '@think-h3/core'
import { ResponseFormatter } from '@think-h3/core'

/**
 * 统一响应格式：在这里修改即可全局调整成功 / 失败时出站数据的结构。
 * 默认：成功 { code: 0, message: 'ok', data }，失败 { code, message, data: null, errors? }。
 * 单个路由跳过格式化：.meta({ envelope: false }) 或 return raw(value)。
 */
export default class Formatter extends ResponseFormatter {
  override success(data: unknown, ctx: HttpContext) {
    return super.success(data, ctx)
  }

  override error(error: NormalizedError, ctx: HttpContext) {
    return super.error(error, ctx)
  }
}
