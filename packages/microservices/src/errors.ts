import type { ValidationIssue } from '@hazejs/core'
import { HTTPError, HttpException, ValidationException } from '@hazejs/core'

/** 在线路上传递的错误 */
export interface SerializedError {
  name: string
  message: string
  /** HTTP 状态码（远端抛出的是 HttpException 时） */
  status?: number
  /** 业务码（HttpException.code） */
  code?: number | string
  data?: unknown
  issues?: ValidationIssue[]
}

export function serializeError(error: unknown): SerializedError {
  if (HTTPError.isError(error)) {
    const unhandled = (error as HTTPError).unhandled
    return {
      name: error instanceof ValidationException
        ? 'ValidationException'
        : error.name,
      message: error.message,
      status: error.status,
      code: error instanceof HttpException
        ? error.code
        : error.status,
      ...(!unhandled && error.data !== undefined && { data: error.data }),
      ...(error instanceof ValidationException && { issues: error.issues }),
    }
  }
  if (error instanceof Error)
    return { name: error.name, message: error.message }
  return {
    name: 'Error',
    message: String(error),
  }
}

/**
 * 远端处理器抛出的错误（在调用方重新抛出）。
 * - 远端是 HttpException 且状态码 < 500（如 404、422、业务异常）：保留状态码，在 HTTP 接口中照常渲染；
 * - 其它错误：502 Bad Gateway，生产环境不向客户端暴露远端消息（与未处理异常一致）。
 */
export class RemoteError extends HttpException {
  readonly pattern: string
  readonly remote: SerializedError
  readonly issues: ValidationIssue[] | undefined

  constructor(pattern: string, remote: SerializedError) {
    const propagated = remote.status !== undefined && remote.status < 500
    super(remote.message, {
      status: propagated ? remote.status : 502,
      code: propagated ? remote.code : 502,
      data: remote.issues
        ? { issues: remote.issues, ...(remote.data as object) }
        : remote.data,
    })
    this.pattern = pattern
    this.remote = remote
    this.issues = remote.issues
    if (!propagated)
      Object.defineProperty(this, 'unhandled', { value: true, configurable: true })
  }
}

/** 在 timeout 内没有收到回复 */
export class MicroserviceTimeoutError extends HttpException {
  readonly pattern: string

  constructor(pattern: string, timeout: number) {
    super(`No reply for "${pattern}" within ${timeout}ms`, { status: 504, code: 'MICROSERVICE_TIMEOUT' })
    this.pattern = pattern
  }
}

/** 没有服务在监听该消息（NATS no responders、内存传输无处理器、gRPC 连接失败） */
export class MicroserviceUnavailableError extends HttpException {
  readonly pattern: string

  constructor(pattern: string, message = `No microservice is listening for "${pattern}"`) {
    super(message, { status: 503, code: 'MICROSERVICE_UNAVAILABLE' })
    this.pattern = pattern
  }
}

/** 服务端：收到的消息没有对应的处理器 */
export class NoHandlerError extends HttpException {
  constructor(pattern: string) {
    super(`No message handler for "${pattern}"`, { status: 404, code: 'NO_MESSAGE_HANDLER' })
  }
}
