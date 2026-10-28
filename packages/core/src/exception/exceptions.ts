import { HTTPError } from 'h3'

export interface HttpExceptionOptions {
  status?: number
  /** 业务错误码，默认等于 HTTP 状态码 */
  code?: number | string
  data?: unknown
  headers?: ConstructorParameters<typeof Headers>[0]
  cause?: unknown
}

/**
 * 框架异常基类。继承 h3 的 HTTPError，因此即使逃逸出框架边界，h3 也能正确渲染。
 * 注意：不要覆盖 `name`，h3 依赖 `name === 'HTTPError'` 识别。
 */
export class HttpException extends HTTPError {
  readonly code: number | string

  constructor(message?: string, options: HttpExceptionOptions = {}) {
    const status = options.status ?? 500
    super(message || 'Internal Server Error', {
      status,
      data: options.data,
      headers: options.headers,
    })
    this.code = options.code ?? status
    if (options.cause !== undefined)
      Object.defineProperty(this, 'cause', { value: options.cause, configurable: true, writable: true })
  }
}

type ExceptionOptions = Omit<HttpExceptionOptions, 'status'>

type ExceptionClass = new (message?: string, options?: ExceptionOptions) => HttpException

function createHttpException(status: number, defaultMessage: string): ExceptionClass {
  return class extends HttpException {
    constructor(message?: string, options: ExceptionOptions = {}) {
      super(message || defaultMessage, { ...options, status })
    }
  }
}

export class BadRequestException extends createHttpException(400, 'Bad Request') {}
export class UnauthorizedException extends createHttpException(401, 'Unauthorized') {}
export class ForbiddenException extends createHttpException(403, 'Forbidden') {}
export class NotFoundException extends createHttpException(404, 'Not Found') {}
export class MethodNotAllowedException extends createHttpException(405, 'Method Not Allowed') {}
export class ConflictException extends createHttpException(409, 'Conflict') {}
export class TooManyRequestsException extends createHttpException(429, 'Too Many Requests') {}
/** CSRF token 缺失或不匹配（与 Laravel 一致使用 419，前端可据此刷新 token 后重试） */
export class CsrfTokenMismatchException extends createHttpException(419, 'Page Expired') {}
export class InternalServerErrorException extends createHttpException(500, 'Internal Server Error') {}
/** 签名链接无效、被篡改或已过期（`signed` 中间件） */
export class InvalidSignatureException extends createHttpException(403, 'Invalid signature.') {}

export interface ValidationIssue {
  /** 校验目标：body / query / params / headers */
  target?: string
  /** 字段路径，例如 `items.0.name` */
  path: string
  message: string
}

export class ValidationException extends HttpException {
  readonly issues: ValidationIssue[]

  constructor(issues: ValidationIssue[], message = 'Validation Failed') {
    super(message, { status: 422 })
    this.issues = issues
  }
}

/**
 * 业务异常：默认 HTTP 200，通过 `code` 区分业务错误。
 *
 * ```ts
 * throw new BusinessException(10001, '余额不足')
 * ```
 */
export class BusinessException extends HttpException {
  constructor(code: number | string, message: string, options: ExceptionOptions & { status?: number } = {}) {
    super(message, { status: 200, ...options, code })
  }
}
