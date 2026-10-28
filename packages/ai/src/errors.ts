/** 所有 AI 错误的基类 */
export class AIError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'AIError'
  }
}

/** 厂商接口返回错误（HTTP 状态码非 2xx 或网络错误） */
export class APICallError extends AIError {
  readonly provider: string
  readonly url: string
  readonly status?: number
  readonly responseBody?: string
  readonly responseHeaders?: Record<string, string>
  /** 429、408、409、5xx 与网络错误可以重试 */
  readonly isRetryable: boolean

  constructor(options: {
    message: string
    provider: string
    url: string
    status?: number
    responseBody?: string
    responseHeaders?: Record<string, string>
    isRetryable?: boolean
    cause?: unknown
  }) {
    super(options.message, { cause: options.cause })
    this.name = 'APICallError'
    this.provider = options.provider
    this.url = options.url
    this.status = options.status
    this.responseBody = options.responseBody
    this.responseHeaders = options.responseHeaders
    this.isRetryable = options.isRetryable ?? (options.status === undefined || options.status === 408 || options.status === 409 || options.status === 429 || options.status >= 500)
  }
}

/** 模型名无法解析（未配置的厂商 / 别名） */
export class NoSuchModelError extends AIError {
  constructor(message: string) {
    super(message)
    this.name = 'NoSuchModelError'
  }
}

/** 模型没有生成符合 schema 的对象 */
export class NoObjectGeneratedError extends AIError {
  readonly text?: string
  readonly issues?: unknown

  constructor(message: string, options: { text?: string, issues?: unknown, cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'NoObjectGeneratedError'
    this.text = options.text
    this.issues = options.issues
  }
}

/** 模型调用了未声明的工具，或参数不符合工具的 schema */
export class InvalidToolCallError extends AIError {
  readonly toolName: string
  readonly input: unknown

  constructor(message: string, options: { toolName: string, input: unknown, cause?: unknown }) {
    super(message, { cause: options.cause })
    this.name = 'InvalidToolCallError'
    this.toolName = options.toolName
    this.input = options.input
  }
}

/** 能力不受当前模型 / 厂商支持 */
export class UnsupportedFeatureError extends AIError {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedFeatureError'
  }
}
