import type { HttpContext } from '../http/context'
import type { AbstractConstructor, MaybePromise } from '../utils'
import type { ValidationIssue } from './exceptions'
import { HTTPError } from 'h3'
import { Config } from '../config/config'
import { inject } from '../container/container'
import { ResponseFormatter } from '../http/formatter'
import { Logger } from '../logger'
import { Router } from '../routing/router'
import { renderErrorPage } from './error-page'
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
 *
 * 调试模式下浏览器访问（Accept: text/html）会得到带源码与请求信息的错误页，API 请求仍返回 JSON。
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
    ctx.logger.error(`[${ctx.method}] ${ctx.path}`, error)
  }

  render(error: unknown, ctx: HttpContext): MaybePromise<unknown> {
    const normalized = this.normalize(error, ctx)
    ctx.status(normalized.status)
    normalized.headers?.forEach((value, key) => ctx.setHeader(key, value))
    if (this.isDebug(ctx) && this.wantsHtml(ctx))
      return this.renderDebugPage(error, normalized, ctx)
    return this.format(normalized, ctx)
  }

  protected wantsHtml(ctx: HttpContext): boolean {
    return ctx.header('accept')?.includes('text/html') ?? false
  }

  protected renderDebugPage(error: unknown, normalized: NormalizedError, ctx: HttpContext): Response {
    const html = renderErrorPage({
      error,
      status: normalized.status,
      message: normalized.message,
      code: normalized.code,
      request: ctx.req,
      requestId: ctx.requestId,
      params: ctx.params(),
      issues: normalized.errors,
      routes: normalized.status === 404
        ? ctx.make(Router).list()
        : undefined,
    })
    return new Response(html, {
      status: normalized.status,
      headers: { 'content-type': 'text/html; charset=utf-8' },
    })
  }

  /** 读取当前请求生效的配置（多应用时为应用级配置） */
  protected isDebug(ctx: HttpContext): boolean {
    return ctx.config.get('app.debug')
  }

  protected normalize(error: unknown, ctx: HttpContext): NormalizedError {
    const debug = this.isDebug(ctx)
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

  /** 错误响应体，默认交给 ResponseFormatter.error()，与成功响应保持同一套格式 */
  protected format(error: NormalizedError, ctx: HttpContext): unknown {
    return ctx.make(ResponseFormatter).error(error, ctx)
  }
}
