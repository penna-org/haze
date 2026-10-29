import type { HttpClientRequest } from './request'
import type { HttpClientResponse } from './response'
import { redactUrl } from './redact'

/** 错误信息中响应体预览的最大长度 */
const PREVIEW_LENGTH = 500

function preview(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > PREVIEW_LENGTH
    ? `${trimmed.slice(0, PREVIEW_LENGTH)}… (truncated)`
    : trimmed
}

/** 响应状态为 4xx / 5xx 时由 `response.throw()`（或客户端的 `.throw()`）抛出 */
export class HttpRequestException extends Error {
  override name = 'HttpRequestException'
  readonly status: number
  /** 响应体预览（最多 500 个字符） */
  readonly body: string

  constructor(readonly response: HttpClientResponse) {
    const body = preview(response.bufferedText() ?? '')
    super(`HTTP request returned status code ${response.status}: ${response.request.method} ${redactUrl(response.request.url)}${body
      ? `\n${body}`
      : ''}`)
    this.status = response.status
    this.body = body
  }

  get request(): HttpClientRequest {
    return this.response.request
  }
}

/** 没有拿到响应：网络、DNS、连接被拒绝、TLS 等错误（原始错误在 `cause` 中） */
export class ConnectionException extends Error {
  override name = 'ConnectionException'

  constructor(readonly request: HttpClientRequest, message?: string, options?: { cause?: unknown }) {
    const reason = message ?? describe(options?.cause)
    super(`Connection failed for ${request.method} ${redactUrl(request.url)}${reason
      ? `: ${reason}`
      : ''}`, options)
  }
}

/** 超过 `timeout()` 设置的时间仍未完成（每次尝试单独计时） */
export class TimeoutException extends ConnectionException {
  override name = 'TimeoutException'

  constructor(request: HttpClientRequest, readonly timeout: number, options?: { cause?: unknown }) {
    super(request, `timed out after ${timeout}ms`, options)
  }
}

/** `Http.preventStrayRequests()` 之后发出了没有匹配假响应的请求 */
export class StrayRequestException extends Error {
  override name = 'StrayRequestException'

  constructor(readonly request: HttpClientRequest) {
    super(`Attempted request to [${request.method} ${redactUrl(request.url)}] without a matching fake. Fake it with Http.fake({ 'pattern': ... }) or allow it with Http.allowStrayRequests([...]).`)
  }
}

/** 取底层错误的可读信息（Node 的 fetch 把真正的原因放在 cause 中） */
function describe(error: unknown): string | undefined {
  if (!(error instanceof Error)) {
    return error === undefined
      ? undefined
      : String(error)
  }
  const cause = error.cause instanceof Error
    ? ` (${(error.cause as Error & { code?: string }).code ?? error.cause.message})`
    : ''
  return `${error.message}${cause}`
}
