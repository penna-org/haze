import { AIError, APICallError } from './errors'

/** 自定义 fetch（代理、测试、Workers 的 service binding 等） */
export type FetchFunction = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface RequestOptions {
  provider: string
  url: string
  headers?: Record<string, string | undefined>
  signal?: AbortSignal
  fetch?: FetchFunction
}

export function cleanHeaders(...headers: Array<Record<string, string | undefined> | undefined>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const group of headers) {
    for (const [key, value] of Object.entries(group ?? {})) {
      if (value !== undefined)
        result[key.toLowerCase()] = value
    }
  }
  return result
}

/** 去掉值为 undefined 的键（请求体中不传未设置的参数） */
export function compact<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)) as T
}

function headersOf(response: Response): Record<string, string> {
  const result: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    result[key] = value
  })
  return result
}

/** 从各厂商的错误响应中取出可读的信息 */
function errorMessage(body: string): string | undefined {
  try {
    const json = JSON.parse(body) as any
    const error = Array.isArray(json)
      ? json[0]?.error
      : json?.error ?? json
    if (typeof error === 'string')
      return error
    return error?.message ?? json?.message ?? json?.errors?.[0]?.message ?? json?.Message
  }
  catch {
    return body.slice(0, 500) || undefined
  }
}

async function send(options: RequestOptions & { method: string, body?: string | FormData, contentType?: string }): Promise<Response> {
  const doFetch = options.fetch ?? globalThis.fetch
  let response: Response
  try {
    response = await doFetch(options.url, {
      method: options.method,
      headers: cleanHeaders(options.contentType
        ? { 'content-type': options.contentType }
        : undefined, options.headers),
      body: options.body,
      signal: options.signal,
    })
  }
  catch (error) {
    if (options.signal?.aborted)
      throw error
    throw new APICallError({
      message: `${options.provider}: network error calling ${options.url}: ${(error as Error).message}`,
      provider: options.provider,
      url: options.url,
      cause: error,
    })
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new APICallError({
      message: `${options.provider} API error ${response.status}: ${errorMessage(body) ?? response.statusText}`,
      provider: options.provider,
      url: options.url,
      status: response.status,
      responseBody: body,
      responseHeaders: headersOf(response),
    })
  }
  return response
}

export interface JSONResult<T> {
  value: T
  headers: Record<string, string>
}

export async function postJSON<T = any>(options: RequestOptions & { body: unknown }): Promise<JSONResult<T>> {
  const response = await send({
    ...options,
    method: 'POST',
    body: JSON.stringify(options.body),
    contentType: 'application/json',
  })
  return {
    value: await response.json() as T,
    headers: headersOf(response),
  }
}

export async function getJSON<T = any>(options: RequestOptions): Promise<JSONResult<T>> {
  const response = await send({ ...options, method: 'GET' })
  return {
    value: await response.json() as T,
    headers: headersOf(response),
  }
}

/** multipart 表单（语音识别上传音频） */
export async function postForm<T = any>(options: RequestOptions & { body: FormData }): Promise<JSONResult<T>> {
  const response = await send({ ...options, method: 'POST', body: options.body })
  return {
    value: await response.json() as T,
    headers: headersOf(response),
  }
}

/** 返回二进制响应（语音合成） */
export async function postBinary(options: RequestOptions & { body: unknown }): Promise<{ bytes: Uint8Array, contentType?: string, headers: Record<string, string> }> {
  const response = await send({
    ...options,
    method: 'POST',
    body: JSON.stringify(options.body),
    contentType: 'application/json',
  })
  return {
    bytes: new Uint8Array(await response.arrayBuffer()),
    contentType: response.headers.get('content-type') ?? undefined,
    headers: headersOf(response),
  }
}

/** 流式请求：返回响应体（SSE / NDJSON / AWS event stream 由调用方解析） */
export async function postStream(options: RequestOptions & { body: unknown }): Promise<{ body: ReadableStream<Uint8Array>, headers: Record<string, string> }> {
  const response = await send({
    ...options,
    method: 'POST',
    body: JSON.stringify(options.body),
    contentType: 'application/json',
  })
  if (!response.body) {
    throw new APICallError({
      message: `${options.provider}: empty stream response`,
      provider: options.provider,
      url: options.url,
      status: response.status,
    })
  }
  return {
    body: response.body,
    headers: headersOf(response),
  }
}

export interface SSEEvent {
  event?: string
  data: string
  id?: string
}

/** 解析 text/event-stream（按规范处理多行 data、注释与 CRLF） */
export async function* parseSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  let event: string | undefined
  let id: string | undefined
  let data: string[] = []
  /** 处理一行；空行表示一条消息结束，返回该消息 */
  const processLine = (line: string): SSEEvent | undefined => {
    if (line === '') {
      const message = data.length
        ? {
            event,
            data: data.join('\n'),
            id,
          }
        : undefined
      event = undefined
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
    return undefined
  }
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done)
        break
      buffer += value
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
    // 流结束时没有以空行结尾的最后一条消息
    if (buffer)
      processLine(buffer)
    const last = processLine('')
    if (last)
      yield last
  }
  finally {
    reader.releaseLock()
  }
}

/** 逐行解析 NDJSON（Ollama 原生接口、Gemini 等） */
export async function* parseNDJSON<T = unknown>(stream: ReadableStream<Uint8Array>): AsyncGenerator<T> {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ''
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done)
        break
      buffer += value
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (line.trim())
          yield JSON.parse(line) as T
      }
    }
    if (buffer.trim())
      yield JSON.parse(buffer) as T
  }
  finally {
    reader.releaseLock()
  }
}

/** 把异步迭代转换为 ReadableStream（适配器的 stream() 返回值） */
export function toReadableStream<T>(iterable: AsyncIterable<T>): ReadableStream<T> {
  const iterator = iterable[Symbol.asyncIterator]()
  return new ReadableStream<T>({
    async pull(controller) {
      try {
        const { value, done } = await iterator.next()
        if (done)
          controller.close()
        else
          controller.enqueue(value)
      }
      catch (error) {
        controller.error(error)
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason)
    },
  })
}

export interface RetryOptions {
  /** 最多重试次数，默认 2 */
  maxRetries?: number
  /** 首次重试前等待的毫秒数，默认 1000，之后翻倍 */
  initialDelay?: number
  signal?: AbortSignal
}

function retryAfter(error: APICallError): number | undefined {
  const headers = error.responseHeaders ?? {}
  const ms = Number(headers['retry-after-ms'])
  if (Number.isFinite(ms) && ms > 0)
    return ms
  const seconds = Number(headers['retry-after'])
  if (Number.isFinite(seconds) && seconds > 0)
    return seconds * 1000
  const date = headers['retry-after']
    ? Date.parse(headers['retry-after'])
    : Number.NaN
  return Number.isFinite(date)
    ? Math.max(0, date - Date.now())
    : undefined
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      reject(signal.reason)
    }, { once: true })
  })
}

/** 对可重试的错误（429、5xx、网络）按指数退避重试，遵循 retry-after */
export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const maxRetries = options.maxRetries ?? 2
  let delay = options.initialDelay ?? 1000
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    }
    catch (error) {
      if (!(error instanceof APICallError) || !error.isRetryable || attempt >= maxRetries || options.signal?.aborted)
        throw error
      // retry-after 超过 60 秒时不再等待
      const wait = retryAfter(error)
      if (wait !== undefined && wait > 60_000)
        throw error
      await sleep(wait ?? delay, options.signal)
      delay *= 2
    }
  }
}

/** 合并调用方的 signal 与超时 */
export function abortSignal(signal?: AbortSignal, timeout?: number): AbortSignal | undefined {
  const signals = [
    signal,
    timeout
      ? AbortSignal.timeout(timeout)
      : undefined,
  ].filter(Boolean) as AbortSignal[]
  if (signals.length <= 1)
    return signals[0]
  return AbortSignal.any(signals)
}

/** 解析 JSON，失败时返回 undefined（工具参数可能是不完整的 JSON） */
export function safeParseJSON(text: string): { success: true, value: unknown } | { success: false, error: unknown } {
  try {
    return {
      success: true,
      value: text.trim() === ''
        ? {}
        : JSON.parse(text),
    }
  }
  catch (error) {
    return { success: false, error }
  }
}

export function assertNever(value: never, message = 'Unexpected value'): never {
  throw new AIError(`${message}: ${JSON.stringify(value)}`)
}
