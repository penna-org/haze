import type { HttpContext } from '../http/context'
import type { AbstractConstructor, MaybePromise } from '../utils'
import type { ValidationIssue } from './exceptions'
import { HTTPError } from 'h3'
import { Config } from '../config/config'
import { inject } from '../container/container'
import { Logger } from '../logger'
import { HttpException, ValidationException } from './exceptions'

export interface NormalizedError {
  status: number
  code: number | string
  message: string
  data?: unknown
  errors?: ValidationIssue[]
  headers?: Headers
  stack?: string[]
}

/**
 * 全局异常处理器。业务项目在 `app/exception/Handler.ts` 中继承并覆盖：
 * - `report()`：记录 / 上报（日志、Sentry 等）
 * - `render()`：转换为响应体
 */
export class ExceptionHandler {
  protected readonly logger = inject(Logger)
  protected readonly config = inject(Config)

  /** 不需要上报的异常类型 */
  protected dontReport: AbstractConstructor<Error>[] = []

  shouldReport(error: unknown): boolean {
    if (this.dontReport.some(type => error instanceof type))
      return false
    // 4xx 属于客户端错误，不作为服务端错误上报
    if (HTTPError.isError(error) && error.status < 500)
      return false
    return true
  }

  report(error: unknown, ctx: HttpContext): MaybePromise<void> {
    if (!this.shouldReport(error))
      return
    this.logger.error(`[${ctx.method}] ${ctx.path}`, error)
  }

  render(error: unknown, ctx: HttpContext): MaybePromise<unknown> {
    const normalized = this.normalize(error)
    ctx.status(normalized.status)
    normalized.headers?.forEach((value, key) => ctx.setHeader(key, value))
    return this.format(normalized)
  }

  protected get debug(): boolean {
    return this.config.get('app.debug')
  }

  protected normalize(error: unknown): NormalizedError {
    const debug = this.debug
    const stack = debug && error instanceof Error && error.stack
      ? error.stack.split('\n').map(line => line.trim())
      : undefined

    if (HTTPError.isError(error)) {
      // h3 内部把非 HTTPError 包装为 unhandled，生产环境不暴露其消息
      const hidden = error.unhandled && !debug
      return {
        status: error.status,
        code: error instanceof HttpException
          ? error.code
          : error.status,
        message: hidden ? 'Internal Server Error' : error.message,
        data: hidden ? undefined : error.data,
        errors: error instanceof ValidationException
          ? error.issues
          : undefined,
        headers: error.headers,
        stack,
      }
    }

    return {
      status: 500,
      code: 500,
      message: debug && error instanceof Error
        ? error.message
        : 'Internal Server Error',
      stack,
    }
  }

  protected format(error: NormalizedError): unknown {
    const envelope = this.config.get('app.response.envelope')
    return {
      ...(envelope
        ? { code: error.code, message: error.message, data: error.data ?? null }
        : { status: error.status, message: error.message, data: error.data }),
      ...(error.errors && { errors: error.errors }),
      ...(error.stack && { stack: error.stack }),
    }
  }
}
