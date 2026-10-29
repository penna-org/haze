import type { HttpClientRequest } from './request'
import { HttpRequestException } from './exceptions'

export interface HttpResponseOptions {
  /** 读完响应体或开始流式读取时调用（清除本次尝试的超时定时器） */
  release?: () => void
  /** 读取响应体出错时转换错误（超时 → TimeoutException） */
  mapError?: (error: unknown) => unknown
  /** 由 Http.fake() 返回 */
  faked?: boolean
}

/** text/event-stream 中的一条消息 */
export interface ServerSentEvent {
  event?: string
  data: string
  id?: string
  retry?: number
}

/**
 * 出站请求的响应：包装标准 Response。`text()` / `json()` / `blob()` / `bytes()`
 * 共用同一份缓冲，可以重复调用；`stream()` / `sse()` 直接读取底层流（只能读一次）。
 */
export class HttpClientResponse {
  readonly #raw: Response
  readonly #options: HttpResponseOptions
  #bytes: Promise<Uint8Array> | undefined
  #buffered: Uint8Array | undefined
  #streamed = false

  constructor(raw: Response, readonly request: HttpClientRequest, options: HttpResponseOptions = {}) {
    this.#raw = raw
    this.#options = options
  }

  /** 底层的标准 Response（读取它的 body 会绕过缓冲） */
  get raw(): Response {
    return this.#raw
  }

  get status(): number {
    return this.#raw.status
  }

  get statusText(): string {
    return this.#raw.statusText
  }

  get headers(): Headers {
    return this.#raw.headers
  }

  /** 最终地址（跟随重定向之后）；假响应为请求地址 */
  get url(): string {
    return this.#raw.url || this.request.url
  }

  get redirected(): boolean {
    return this.#raw.redirected
  }

  /** 状态码为 2xx */
  get ok(): boolean {
    return this.successful()
  }

  /** 是否为 Http.fake() 返回的响应 */
  get faked(): boolean {
    return this.#options.faked === true
  }

  header(name: string): string | null {
    return this.#raw.headers.get(name)
  }

  successful(): boolean {
    return this.status >= 200 && this.status < 300
  }

  /** 3xx（关闭跟随重定向时才会出现） */
  redirect(): boolean {
    return this.status >= 300 && this.status < 400
  }

  /** 4xx 或 5xx */
  failed(): boolean {
    return this.status >= 400
  }

  clientError(): boolean {
    return this.status >= 400 && this.status < 500
  }

  serverError(): boolean {
    return this.status >= 500
  }

  /** 4xx / 5xx 时抛出 HttpRequestException，否则返回自身（可链式调用） */
  throw(): this {
    if (this.failed())
      throw new HttpRequestException(this)
    return this
  }

  /** 条件为真且状态为 4xx / 5xx 时抛出 */
  throwIf(condition: boolean | ((response: this) => boolean)): this {
    const value = typeof condition === 'function'
      ? condition(this)
      : condition
    return value
      ? this.throw()
      : this
  }

  async bytes(): Promise<Uint8Array> {
    if (this.#streamed)
      throw new TypeError('The response body has already been read with stream() / sse()')
    this.#bytes ??= this.#raw.arrayBuffer().then(
      (buffer) => {
        this.#buffered = new Uint8Array(buffer)
        return this.#buffered
      },
      (error: unknown) => {
        throw this.#options.mapError?.(error) ?? error
      },
    ).finally(() => this.#options.release?.())
    return this.#bytes
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    const bytes = await this.bytes()
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(await this.bytes())
  }

  /** 按 JSON 解析；响应体为空时返回 null */
  async json<T = any>(): Promise<T> {
    const text = await this.text()
    return (text.trim()
      ? JSON.parse(text)
      : null) as T
  }

  async blob(): Promise<Blob> {
    return new Blob([await this.bytes() as Uint8Array<ArrayBuffer>], {
      type: this.header('content-type') ?? '',
    })
  }

  /** 已读取（缓冲）的响应体文本，未读取时为 undefined */
  bufferedText(): string | undefined {
    return this.#buffered && new TextDecoder().decode(this.#buffered)
  }

  /** 已缓冲的字节数，未读取时为 undefined */
  get bufferedSize(): number | undefined {
    return this.#buffered?.byteLength
  }

  /** @internal */
  async buffer(): Promise<this> {
    await this.bytes()
    return this
  }

  /** @internal */
  async discard(): Promise<void> {
    if (!this.#bytes && !this.#streamed)
      await this.#raw.body?.cancel().catch(() => {})
    this.#options.release?.()
  }

  /**
   * 逐块读取响应体：`for await (const chunk of response.stream())`。
   * 开始流式读取后不再受 timeout 限制（需要时传入 signal）。
   */
  async* stream(): AsyncGenerator<Uint8Array> {
    if (this.#bytes) {
      yield await this.#bytes
      return
    }
    if (this.#streamed)
      throw new TypeError('The response body can only be streamed once')
    this.#streamed = true
    this.#options.release?.()
    const body = this.#raw.body
    if (!body)
      return
    const reader = body.getReader()
    try {
      while (true) {
        let result: Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>
        try {
          result = await reader.read()
        }
        catch (error) {
          throw this.#options.mapError?.(error) ?? error
        }
        if (result.done)
          return
        yield result.value
      }
    }
    finally {
      // 提前结束迭代时取消底层流，释放连接
      reader.cancel().catch(() => {})
      reader.releaseLock()
    }
  }

  /** 按 text/event-stream 逐条解析响应体 */
  sse(): AsyncGenerator<ServerSentEvent> {
    return parseServerSentEvents(this.stream())
  }

  /** 转为标准 Response（已缓冲时使用缓冲的内容），可直接作为路由的返回值转发 */
  toResponse(): Response {
    const init = { status: this.status, statusText: this.statusText, headers: this.headers }
    if (this.#buffered)
      return new Response(this.#buffered as Uint8Array<ArrayBuffer>, init)
    return this.#raw
  }
}

/** 解析 text/event-stream（与 @hazejs/ai 的实现相同：多行 data、注释、CRLF 与跨块的 \r\n） */
export async function* parseServerSentEvents(chunks: AsyncIterable<Uint8Array>): AsyncGenerator<ServerSentEvent> {
  const decoder = new TextDecoder()
  let buffer = ''
  let event: string | undefined
  let id: string | undefined
  let retry: number | undefined
  let data: string[] = []
  /** 处理一行；空行表示一条消息结束，返回该消息 */
  const processLine = (line: string): ServerSentEvent | undefined => {
    if (line === '') {
      const message: ServerSentEvent | undefined = data.length
        ? {
            data: data.join('\n'),
            ...(event !== undefined && { event }),
            ...(id !== undefined && { id }),
            ...(retry !== undefined && { retry }),
          }
        : undefined
      event = undefined
      retry = undefined
      data = []
      return message
    }
    if (line.startsWith(':'))
      return undefined
    const colon = line.indexOf(':')
    const field = colon === -1
      ? line
      : line.slice(0, colon)
    const value = colon === -1
      ? ''
      : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'data')
      data.push(value)
    else if (field === 'event')
      event = value
    else if (field === 'id')
      id = value
    else if (field === 'retry' && /^\d+$/.test(value))
      retry = Number(value)
    return undefined
  }
  const drain = function* (): Generator<ServerSentEvent> {
    let match = /\r\n|\r|\n/.exec(buffer)
    // 块末尾的 \r 可能是被拆开的 \r\n，等下一块再处理
    while (match && !(match[0] === '\r' && match.index === buffer.length - 1)) {
      const message = processLine(buffer.slice(0, match.index))
      buffer = buffer.slice(match.index + match[0].length)
      if (message)
        yield message
      match = /\r\n|\r|\n/.exec(buffer)
    }
  }
  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true })
    yield* drain()
  }
  buffer += decoder.decode()
  yield* drain()
  // 流结束时没有以空行结尾的最后一条消息
  if (buffer)
    processLine(buffer.replace(/\r$/, ''))
  const last = processLine('')
  if (last)
    yield last
}
