/** 请求体（已编码，可直接交给 fetch） */
export type HttpRequestBody = string | URLSearchParams | FormData | Blob | ArrayBuffer | ArrayBufferView | ReadableStream<Uint8Array>

export interface HttpClientRequestInit {
  method: string
  url: string
  headers: Headers
  body?: HttpRequestBody
  data?: unknown
  attempt?: number
  client?: string
}

/**
 * 出站请求：中间件、`Http.fake()` 的回调与断言拿到的对象。
 * 中间件可以直接修改 `url`、`method`、`headers` 与 `body`（每次尝试都是新的对象）。
 */
export class HttpClientRequest {
  method: string
  url: string
  headers: Headers
  /** 编码后的请求体：JSON 为字符串，表单为 URLSearchParams，multipart 为 FormData */
  body: HttpRequestBody | undefined
  /** 编码前传入的数据（`post(url, data)` 的 data） */
  readonly data: unknown
  /** 第几次尝试（从 1 开始） */
  readonly attempt: number
  /** 命名客户端（`Http.client(name)`） */
  readonly client: string | undefined

  constructor(init: HttpClientRequestInit) {
    this.method = init.method
    this.url = init.url
    this.headers = init.headers
    this.body = init.body
    this.data = init.data
    this.attempt = init.attempt ?? 1
    this.client = init.client
  }

  header(name: string): string | null {
    return this.headers.get(name)
  }

  /** 是否有该请求头；传入 value 时同时比较值 */
  hasHeader(name: string, value?: string | RegExp): boolean {
    const actual = this.headers.get(name)
    if (actual === null)
      return false
    if (value === undefined)
      return true
    return typeof value === 'string'
      ? actual === value
      : value.test(actual)
  }

  /** 查询参数（同名参数取最后一个） */
  get query(): Record<string, string> {
    return Object.fromEntries(new URL(this.url).searchParams)
  }

  /** 字符串形式的请求体（JSON、表单）；二进制与 multipart 为空字符串 */
  text(): string {
    if (typeof this.body === 'string')
      return this.body
    if (this.body instanceof URLSearchParams)
      return this.body.toString()
    return ''
  }

  /** 按 JSON 解析请求体，不是 JSON 时返回 undefined */
  json<T = any>(): T {
    const text = this.text()
    try {
      return (text
        ? JSON.parse(text)
        : undefined) as T
    }
    catch {
      return undefined as T
    }
  }

  /** 表单字段（urlencoded 或 multipart；同名字段为数组，文件为 File） */
  form(): Record<string, any> {
    const body = this.body
    const entries: Array<[string, unknown]> = body instanceof URLSearchParams
      ? [...body]
      : body instanceof FormData
        ? [...body]
        : typeof body === 'string' && this.isForm()
          ? [
              ...new URLSearchParams(body),
            ]
          : []
    const result: Record<string, any> = {}
    for (const [key, value] of entries) {
      if (!(key in result))
        result[key] = value
      else if (Array.isArray(result[key]))
        result[key].push(value)
      else
        result[key] = [result[key], value]
    }
    return result
  }

  isJson(): boolean {
    return /\bjson\b/i.test(this.headers.get('content-type') ?? '')
  }

  isForm(): boolean {
    return this.body instanceof URLSearchParams || /application\/x-www-form-urlencoded/i.test(this.headers.get('content-type') ?? '')
  }

  isMultipart(): boolean {
    return this.body instanceof FormData
  }

  /** 转为标准的 Request */
  toRequest(): Request {
    return new Request(this.url, {
      method: this.method,
      headers: this.headers,
      body: this.body as RequestInit['body'],
      ...(this.body instanceof ReadableStream && { duplex: 'half' }),
    } as RequestInit)
  }
}
