import type { HttpContext } from '@hazejs/core'
import type { GraphQLFormattedError } from 'graphql'
import { ExceptionHandler, HTTPError, HttpException, ValidationException } from '@hazejs/core'
import { GraphQLError } from 'graphql'

/** 常用的 extensions.code（与 Apollo 等生态一致） */
export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  BAD_USER_INPUT: 'BAD_USER_INPUT',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  TOO_MANY_REQUESTS: 'TOO_MANY_REQUESTS',
  INTERNAL_SERVER_ERROR: 'INTERNAL_SERVER_ERROR',
  BUSINESS_ERROR: 'BUSINESS_ERROR',
  GRAPHQL_PARSE_FAILED: 'GRAPHQL_PARSE_FAILED',
  GRAPHQL_VALIDATION_FAILED: 'GRAPHQL_VALIDATION_FAILED',
  OPERATION_RESOLUTION_FAILURE: 'OPERATION_RESOLUTION_FAILURE',
  DEPTH_LIMIT_EXCEEDED: 'DEPTH_LIMIT_EXCEEDED',
  COMPLEXITY_LIMIT_EXCEEDED: 'COMPLEXITY_LIMIT_EXCEEDED',
} as const

const statusCodes: Record<number, string> = {
  400: ErrorCode.BAD_REQUEST,
  401: ErrorCode.UNAUTHENTICATED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  419: 'CSRF_TOKEN_MISMATCH',
  422: ErrorCode.BAD_USER_INPUT,
  429: ErrorCode.TOO_MANY_REQUESTS,
}

/** HTTP 状态码 → extensions.code */
export function codeForStatus(status: number): string {
  return statusCodes[status] ?? (status >= 500
    ? ErrorCode.INTERNAL_SERVER_ERROR
    : status < 400
      // BusinessException（默认 HTTP 200），业务码见 extensions.errorCode
      ? ErrorCode.BUSINESS_ERROR
      : ErrorCode.BAD_REQUEST)
}

export type FormatError = (formatted: GraphQLFormattedError, error: GraphQLError) => GraphQLFormattedError

export interface FormatOptions {
  /** 显示未知错误的原始消息（默认取 app.debug） */
  debug: boolean
  formatError?: FormatError
}

/**
 * GraphQLError → 响应中的错误：
 * - HttpException / h3 HTTPError：extensions.code 取自状态码（字符串业务码优先），附 status；
 *   数字业务码（与状态码不同时）放在 extensions.errorCode，data 放在 extensions.data；
 * - ValidationException：BAD_USER_INPUT，extensions.issues 为字段错误；
 * - 其它异常：INTERNAL_SERVER_ERROR，非调试模式下隐藏原始消息；
 * - 直接抛出的 GraphQLError 保留自己的 extensions。
 */
export function formatGraphQLError(error: GraphQLError, options: FormatOptions): GraphQLFormattedError {
  const original = error.originalError
  const formatted = error.toJSON() as { -readonly [K in keyof GraphQLFormattedError]: GraphQLFormattedError[K] }
  if (original && !(original instanceof GraphQLError)) {
    if (HTTPError.isError(original)) {
      const status = original.status
      const code = original instanceof HttpException
        ? original.code
        : status
      const hidden = (original as HTTPError).unhandled && !options.debug
      formatted.message = hidden ? 'Internal Server Error' : original.message
      formatted.extensions = {
        ...formatted.extensions,
        code: typeof code === 'string'
          ? code
          : codeForStatus(status),
        status,
        ...(typeof code === 'number' && code !== status && { errorCode: code }),
        ...(original instanceof ValidationException && { issues: original.issues }),
        ...(!hidden && original.data !== undefined && { data: original.data }),
      }
    }
    else {
      if (!options.debug)
        formatted.message = 'Internal Server Error'
      formatted.extensions = { ...formatted.extensions, code: ErrorCode.INTERNAL_SERVER_ERROR }
    }
  }
  else if (!formatted.extensions?.code && !error.path) {
    // 解析 / 校验阶段的错误（没有 path）
    formatted.extensions = {
      ...formatted.extensions,
      code: error.message.startsWith('Syntax Error')
        ? ErrorCode.GRAPHQL_PARSE_FAILED
        : ErrorCode.GRAPHQL_VALIDATION_FAILED,
    }
  }
  return options.formatError
    ? options.formatError(formatted, error)
    : formatted
}

/** 未知错误与 5xx 交给 ExceptionHandler.report()（记录日志 / 上报） */
export async function reportErrors(errors: readonly GraphQLError[] | undefined, ctx: HttpContext): Promise<void> {
  for (const error of errors ?? []) {
    const original = error.originalError
    if (!original || original instanceof GraphQLError)
      continue
    if (HTTPError.isError(original) && original.status < 500)
      continue
    try {
      await ctx.make(ExceptionHandler).report(original, ctx)
    }
    catch {}
  }
}

/** 构造带 code 的 GraphQLError（解析器中可直接抛出） */
export function graphqlError(message: string, code: string, extensions: Record<string, unknown> = {}): GraphQLError {
  return new GraphQLError(message, {
    extensions: { code, ...extensions },
  })
}
