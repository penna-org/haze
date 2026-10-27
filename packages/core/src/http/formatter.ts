import type { NormalizedError } from '../exception/handler'
import type { HttpContext } from './context'
import { Config } from '../config/config'
import { inject } from '../container/container'
import { isFormattable } from './response'

/**
 * 统一响应格式（出站数据的最终形态）。默认输出：
 *
 * - 成功：`{ code: 0, message: 'ok', data }`
 * - 失败：`{ code, message, data: null, errors? }`
 *
 * 在 `app/response/Formatter.ts` 中继承并覆盖即可全局替换格式：
 *
 * ```ts
 * export default class Formatter extends ResponseFormatter {
 *   override success(data: unknown) {
 *     return { success: true, result: data }
 *   }
 *   override error(error: NormalizedError) {
 *     return { success: false, errorCode: error.code, errorMessage: error.message }
 *   }
 * }
 * ```
 *
 * 单个路由可用 `.meta({ envelope: false })` 或在处理器中 `return raw(value)` 跳过格式化。
 */
export class ResponseFormatter {
  /** 全局配置；格式化时请优先读取 ctx.config（多应用时为应用级配置） */
  protected readonly config = inject(Config)

  /** 是否需要格式化该返回值（默认只处理普通对象、数组、数字、布尔、null） */
  shouldFormat(value: unknown, _ctx: HttpContext): boolean {
    return isFormattable(value)
  }

  success(data: unknown, ctx: HttpContext): unknown {
    const { envelope, successCode, successMessage } = ctx.config.get('app.response')
    if (!envelope)
      return data
    return { code: successCode, message: successMessage, data: data ?? null }
  }

  error(error: NormalizedError, ctx: HttpContext): unknown {
    const envelope = ctx.config.get('app.response.envelope')
    return {
      ...(envelope
        ? { code: error.code, message: error.message, data: error.data ?? null }
        : { status: error.status, message: error.message, data: error.data }),
      ...(error.errors && { errors: error.errors }),
      ...(error.stack && { stack: error.stack }),
    }
  }
}
