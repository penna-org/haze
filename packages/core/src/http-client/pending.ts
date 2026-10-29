import type { HttpManager } from './manager'
import type { HttpAttachment, HttpBodyFormat, HttpDuration, HttpFetchFunction, HttpHeadersInit, HttpMiddleware, HttpQuery, HttpRequestOptions, HttpRetryOptions, ResolvedOptions, ResolvedRetry } from './options'
import type { HttpRequestBody } from './request'
import { tracedFetch } from '../observability/otel'
import { recordTelemetry, telemetryActive } from '../observability/telemetry'
import { ConnectionException, StrayRequestException, TimeoutException } from './exceptions'
import { HttpFailedConnection } from './fake'
import { useHttpManager } from './manager'
import { base64, bodySize, buildUrl, encodeBody, resolveOptions, toMilliseconds } from './options'
import { redactHeaders, redactUrl } from './redact'
import { HttpClientRequest } from './request'
import { HttpClientResponse } from './response'

/** @internal */
export interface PendingRequestState {
  /** 构造器链上累积的选项层 */
  layers: HttpRequestOptions[]
  /** 命名客户端 */
  client?: string
  /** `Http.create()` 创建：不使用 config/http.ts 的 defaults */
  standalone?: boolean
  /** pool() 中：请求在被调度时才发出 */
  lazy?: boolean
}

export interface HttpPoolOptions {
  /** 同时进行的请求数，默认不限制 */
  concurrency?: number
}

/** 默认重试的状态码 */
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504])

/**
 * 出站请求构造器（不可变）：`Http` 本身就是一个默认的构造器，
 * `Http.baseURL(...).withToken(...)` 每一步都返回新的构造器，可以安全地复用与共享。
 *
 * ```ts
 * const github = Http.baseURL('https://api.github.com').withToken(token).retry(3)
 * const repos = await (await github.get('/user/repos', { query: { per_page: 100 } })).throw().json()
 * ```
 */
export class PendingRequest {
  readonly #state: PendingRequestState

  constructor(state: PendingRequestState = { layers: [] }) {
    this.#state = state
  }

  #with(layer: HttpRequestOptions | undefined, patch: Partial<PendingRequestState> = {}): PendingRequest {
    return new PendingRequest({
      ...this.#state,
      ...patch,
      layers: layer
        ? [...this.#state.layers, layer]
        : this.#state.layers,
    })
  }

  /** 叠加任意选项 */
  withOptions(options: HttpRequestOptions): PendingRequest {
    return this.#with(options)
  }

  /** 使用 config/http.ts 中的命名客户端（之后的设置覆盖它） */
  client(name: string): PendingRequest {
    return this.#with(undefined, { client: name })
  }

  baseURL(url: string): PendingRequest {
    return this.#with({ baseURL: url })
  }

  withHeaders(headers: HttpHeadersInit): PendingRequest {
    return this.#with({ headers })
  }

  withHeader(name: string, value: string): PendingRequest {
    return this.#with({
      headers: { [name]: value },
    })
  }

  accept(contentType: string): PendingRequest {
    return this.withHeader('accept', contentType)
  }

  acceptJson(): PendingRequest {
    return this.accept('application/json')
  }

  contentType(contentType: string): PendingRequest {
    return this.withHeader('content-type', contentType)
  }

  withUserAgent(userAgent: string): PendingRequest {
    return this.withHeader('user-agent', userAgent)
  }

  /** Authorization: `<type> <token>`，默认 Bearer */
  withToken(token: string, type = 'Bearer'): PendingRequest {
    return this.withHeader('authorization', `${type} ${token}`)
  }

  withBasicAuth(username: string, password: string): PendingRequest {
    return this.#with({
      basicAuth: [username, password],
    })
  }

  withQuery(query: HttpQuery): PendingRequest {
    return this.#with({ query })
  }

  /** URL 中 `{name}` 占位符的值：`withUrlParameters({ id: 1 }).get('/users/{id}')` */
  withUrlParameters(parameters: Record<string, string | number>): PendingRequest {
    return this.#with({ urlParameters: parameters })
  }

  /** 每次尝试的超时（数字为毫秒），false 不限制；默认 30s */
  timeout(timeout: HttpDuration | false): PendingRequest {
    return this.#with({ timeout })
  }

  /**
   * 失败时重试：times 为最多尝试的次数（含第一次）。
   * 默认只重试连接失败（含超时）与 408 / 425 / 429 / 5xx（501 除外），429 / 503 的 retry-after 优先。
   */
  retry(times: number, options?: Omit<HttpRetryOptions, 'times'>): PendingRequest
  retry(options: HttpRetryOptions): PendingRequest
  retry(times: number | HttpRetryOptions, options: Omit<HttpRetryOptions, 'times'> = {}): PendingRequest {
    return this.#with({
      retry: typeof times === 'number'
        ? { ...options, times }
        : times,
    })
  }

  /** 对象请求体编码为 JSON（默认） */
  asJson(): PendingRequest {
    return this.#with({ bodyFormat: 'json' })
  }

  /** 对象请求体编码为 application/x-www-form-urlencoded */
  asForm(): PendingRequest {
    return this.#with({ bodyFormat: 'form' })
  }

  /** 对象请求体编码为 multipart/form-data */
  asMultipart(): PendingRequest {
    return this.#with({ bodyFormat: 'multipart' })
  }

  bodyFormat(format: HttpBodyFormat): PendingRequest {
    return this.#with({ bodyFormat: format })
  }

  /** 附加文件（请求体随之改为 multipart，data 中的字段一并发送） */
  attach(name: string, contents: HttpAttachment['contents'], filename?: string, type?: string): PendingRequest {
    return this.#with({
      attachments: [
        { name, contents, filename, type },
      ],
    })
  }

  /** 原样发送的请求体 */
  withBody(body: HttpRequestBody, contentType?: string): PendingRequest {
    return this.#with({
      body,
      ...(contentType && {
        headers: { 'content-type': contentType },
      }),
    })
  }

  /** 请求中间件：`(request, next) => next(request)`，先注册的在外层 */
  withMiddleware(middleware: HttpMiddleware): PendingRequest {
    return this.#with({
      middleware: [middleware],
    })
  }

  /** 改用自定义的 fetch（Workers 的 service binding、代理等） */
  withFetch(fetch: HttpFetchFunction): PendingRequest {
    return this.#with({ fetch })
  }

  withSignal(signal: AbortSignal): PendingRequest {
    return this.#with({ signal })
  }

  /** 不跟随重定向（3xx 原样返回） */
  withoutRedirecting(): PendingRequest {
    return this.#with({ redirect: 'manual' })
  }

  /** 4xx / 5xx 时自动抛出 HttpRequestException */
  throw(enabled = true): PendingRequest {
    return this.#with({ throw: enabled })
  }

  get(url: string, options?: HttpRequestOptions): Promise<HttpClientResponse> {
    return this.send('GET', url, options)
  }

  head(url: string, options?: HttpRequestOptions): Promise<HttpClientResponse> {
    return this.send('HEAD', url, options)
  }

  /** DELETE；需要请求体时用 `options.body` */
  delete(url: string, options?: HttpRequestOptions): Promise<HttpClientResponse> {
    return this.send('DELETE', url, options)
  }

  post(url: string, data?: unknown, options?: HttpRequestOptions): Promise<HttpClientResponse> {
    return this.send('POST', url, data === undefined
      ? options
      : { ...options, body: data })
  }

  put(url: string, data?: unknown, options?: HttpRequestOptions): Promise<HttpClientResponse> {
    return this.send('PUT', url, data === undefined
      ? options
      : { ...options, body: data })
  }

  patch(url: string, data?: unknown, options?: HttpRequestOptions): Promise<HttpClientResponse> {
    return this.send('PATCH', url, data === undefined
      ? options
      : { ...options, body: data })
  }

  /** 任意方法的请求（请求体放在 `options.body`） */
  send(method: string, url: string, options?: HttpRequestOptions): Promise<HttpClientResponse> {
    const run = (): Promise<HttpClientResponse> => this.#execute(method.toUpperCase(), url, options)
    return this.#state.lazy
      ? lazyPromise(run)
      : run()
  }

  /**
   * 转为与 fetch 签名相同的函数：交给接受自定义 fetch 的第三方 SDK，
   * 其请求同样经过本客户端的设置、中间件、重试、遥测与 `Http.fake()`。
   * 请求体会先读入内存（不支持流式上传）。
   *
   * ```ts
   * const openai = new OpenAI({ fetch: Http.timeout('60s').toFetch() })
   * ```
   */
  toFetch(): HttpFetchFunction {
    return async (input, init) => {
      const request = input instanceof Request && !init
        ? input
        : new Request(input, init)
      const body = request.body
        ? new Uint8Array(await request.arrayBuffer())
        : undefined
      const response = await this.withHeaders(request.headers).send(request.method, request.url, {
        ...(body && { body }),
        signal: request.signal,
        redirect: request.redirect,
      })
      return response.toResponse()
    }
  }

  /**
   * 并发发送一组请求，按顺序（或按键）返回响应；`concurrency` 限制同时进行的请求数。
   * 回调中的 `pool` 继承当前构造器的设置，其请求在被调度时才发出。
   *
   * ```ts
   * const [a, b] = await Http.pool(p => [p.get(u1), p.get(u2)], { concurrency: 5 })
   * const { user } = await Http.pool(p => ({ user: p.get(u3) }))
   * ```
   */
  async pool<const T extends readonly unknown[] | Record<string, unknown>>(build: (pool: PendingRequest) => T, options: HttpPoolOptions = {}): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
    const built = build(this.#with(undefined, { lazy: true }))
    const list = Array.isArray(built)
    const entries: Array<[string | number, unknown]> = list
      ? (built as readonly unknown[]).map((item, index) => [index, item])
      : Object.entries(built)
    const concurrency = options.concurrency ?? Number.POSITIVE_INFINITY
    if (!(concurrency >= 1))
      throw new RangeError('pool(): concurrency must be at least 1')
    const results: Record<string | number, unknown> = list
      ? [] as unknown as Record<number, unknown>
      : {}
    let next = 0
    let failed = false
    const worker = async (): Promise<void> => {
      while (next < entries.length && !failed) {
        const [key, item] = entries[next++]!
        try {
          results[key] = await item
        }
        catch (error) {
          // 出错后不再调度新的请求
          failed = true
          throw error
        }
      }
    }
    await Promise.all(Array.from({
      length: Math.min(concurrency, entries.length),
    }, worker))
    return results as { -readonly [K in keyof T]: Awaited<T[K]> }
  }

  async #execute(method: string, url: string, call: HttpRequestOptions | undefined): Promise<HttpClientResponse> {
    const manager = useHttpManager()
    const options = resolveOptions([
      ...(this.#state.standalone
        ? []
        : [manager.config.defaults]),
      ...(this.#state.client
        ? [
            manager.clientOptions(this.#state.client),
          ]
        : []),
      ...this.#state.layers,
      call,
    ])
    let target = buildUrl(url, options)
    // 非法地址直接抛出 TypeError，不当作连接失败
    const parsed = new URL(target)
    // fetch 不接受带用户信息的 URL：转为 Basic 认证（已设置 authorization 时以它为准）
    if (parsed.username || parsed.password) {
      if (!options.headers.has('authorization'))
        options.headers.set('authorization', `Basic ${base64(`${decodeURIComponent(parsed.username)}:${decodeURIComponent(parsed.password)}`)}`)
      parsed.username = ''
      parsed.password = ''
      target = parsed.href
    }
    if ((method === 'GET' || method === 'HEAD') && options.hasBody)
      throw new TypeError(`${method} requests cannot have a body; use options.query instead`)
    const { body, contentType } = encodeBody(options.hasBody
      ? options.body
      : undefined, options)
    if (contentType && !options.headers.has('content-type'))
      options.headers.set('content-type', contentType)
    // multipart 的边界由 fetch 生成：去掉手动设置的不带 boundary 的 content-type
    if (body instanceof FormData && !/boundary=/i.test(options.headers.get('content-type') ?? 'boundary='))
      options.headers.delete('content-type')

    const chain = compose(options.middleware, request => this.#transport(manager, request, options))
    const retry = options.retry
    // 流式请求体只能读一次，不重试
    const retryable = !(body instanceof ReadableStream)
    for (let attempt = 1; ; attempt++) {
      const request = new HttpClientRequest({
        method,
        url: target,
        headers: new Headers(options.headers),
        body,
        data: options.body,
        attempt,
        client: this.#state.client,
      })
      let response: HttpClientResponse | undefined
      let error: ConnectionException | undefined
      try {
        response = await chain(request)
      }
      catch (caught) {
        if (!(caught instanceof ConnectionException))
          throw caught
        error = caught
      }
      if (retryable && attempt < retry.times && (error || response!.failed()) && await shouldRetry(retry, response, error, request)) {
        let wait = backoffDelay(retry, attempt)
        const after = response && retry.retryAfter && (response.status === 429 || response.status === 503)
          ? retryAfterMs(response.headers)
          : undefined
        if (after !== undefined && after > retry.maxRetryAfter)
          return finish(response!, options)
        if (after !== undefined)
          wait = after
        if (retry.maxDelay !== undefined)
          wait = Math.min(wait, retry.maxDelay)
        await response?.discard()
        await sleep(wait, options.signal)
        continue
      }
      if (error)
        throw error
      return finish(response!, options)
    }
  }

  /** 最内层：假响应或真实请求，记录到 Http.fake() 并上报遥测 */
  async #transport(manager: HttpManager, request: HttpClientRequest, options: ResolvedOptions): Promise<HttpClientResponse> {
    const startTime = Date.now()
    const started = performance.now()
    let response: HttpClientResponse | undefined
    let error: unknown
    try {
      response = await this.#dispatch(manager, request, options)
      return response
    }
    catch (caught) {
      error = caught
      throw caught
    }
    finally {
      if (telemetryActive())
        report(manager, request, response, error, startTime, performance.now() - started)
    }
  }

  async #dispatch(manager: HttpManager, request: HttpClientRequest, options: ResolvedOptions): Promise<HttpClientResponse> {
    const fake = manager.faking
    if (fake) {
      const stub = await fake.resolve(request)
      if (stub instanceof HttpFailedConnection) {
        fake.record(request, undefined)
        throw new ConnectionException(request, stub.message)
      }
      if (stub !== undefined) {
        const response = new HttpClientResponse(stub instanceof Response
          ? stub.clone()
          : stub.toResponse(), request, { faked: true })
        if (response.failed())
          await response.buffer()
        fake.record(request, response)
        return response
      }
      if (fake.isStray(request))
        throw new StrayRequestException(request)
    }
    try {
      const response = await sendRequest(request, options)
      fake?.record(request, response)
      return response
    }
    catch (error) {
      if (error instanceof ConnectionException)
        fake?.record(request, undefined)
      throw error
    }
  }
}

/** 真实发送：超时与调用方的 signal 合并为一个 AbortController（不依赖 AbortSignal.any / timeout） */
async function sendRequest(request: HttpClientRequest, options: ResolvedOptions): Promise<HttpClientResponse> {
  const { signal, timeout } = options
  if (signal?.aborted)
    throw signal.reason
  const controller = new AbortController()
  let timedOut = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const onAbort = (): void => controller.abort(signal!.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  if (timeout !== undefined) {
    timer = setTimeout(() => {
      timedOut = true
      controller.abort(new TimeoutException(request, timeout))
    }, timeout)
    // Node：未读取的响应不让进程等到超时才退出
    ;(timer as { unref?: () => void }).unref?.()
  }
  const release = (): void => clearTimeout(timer)
  const mapError = (error: unknown): unknown => {
    if (timedOut)
      return new TimeoutException(request, timeout!, { cause: error })
    if (signal?.aborted)
      return signal.reason ?? error
    return error instanceof ConnectionException
      ? error
      : new ConnectionException(request, undefined, { cause: error })
  }
  let raw: Response
  try {
    raw = await tracedFetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body as RequestInit['body'],
      signal: controller.signal,
      ...(options.redirect && {
        redirect: options.redirect,
      }),
      ...(request.body instanceof ReadableStream && {
        duplex: 'half',
      }),
    } as RequestInit, options.fetch ?? globalThis.fetch)
  }
  catch (error) {
    release()
    throw mapError(error)
  }
  const response = new HttpClientResponse(raw, request, { release, mapError })
  if (!raw.body)
    release()
  // 失败的响应预先读取，throw() 的信息与 when() 中都能拿到响应体
  else if (response.failed())
    await response.buffer()
  return response
}

function compose(middleware: HttpMiddleware[], transport: (request: HttpClientRequest) => Promise<HttpClientResponse>): (request: HttpClientRequest) => Promise<HttpClientResponse> {
  return middleware.reduceRight<(request: HttpClientRequest) => Promise<HttpClientResponse>>(
    (next, current) => request => current(request, next),
    transport,
  )
}

function finish(response: HttpClientResponse, options: ResolvedOptions): HttpClientResponse {
  return options.throw
    ? response.throw()
    : response
}

async function shouldRetry(retry: ResolvedRetry, response: HttpClientResponse | undefined, error: ConnectionException | undefined, request: HttpClientRequest): Promise<boolean> {
  if (retry.when)
    return retry.when(response, error, request)
  return error !== undefined || RETRYABLE_STATUS.has(response!.status)
}

/** 第 attempt 次尝试失败后的等待时间 */
function backoffDelay(retry: ResolvedRetry, attempt: number): number {
  const { backoff, delay } = retry
  if (typeof backoff === 'function')
    return backoff(attempt)
  if (Array.isArray(backoff)) {
    return backoff.length
      ? toMilliseconds(backoff[Math.min(attempt, backoff.length) - 1]!)
      : delay
  }
  switch (backoff) {
    case 'linear':
      return delay * attempt
    case 'exponential':
      return delay * 2 ** (attempt - 1)
    default:
      return delay
  }
}

/** retry-after-ms / retry-after（秒数或 HTTP 日期）→ 毫秒 */
function retryAfterMs(headers: Headers): number | undefined {
  const ms = Number(headers.get('retry-after-ms'))
  if (headers.has('retry-after-ms') && Number.isFinite(ms) && ms >= 0)
    return ms
  const value = headers.get('retry-after')
  if (!value)
    return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds))
    return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date)
    ? Math.max(0, date - Date.now())
    : undefined
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  if (ms <= 0 && !signal)
    return Promise.resolve()
  return new Promise((resolve, reject) => {
    if (signal?.aborted)
      return reject(signal.reason)
    let timer: ReturnType<typeof setTimeout> | undefined
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal!.reason)
    }
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** 只在被 await（调用 then）时才开始执行的 Promise（pool 的调度依赖它） */
function lazyPromise<T>(run: () => Promise<T>): Promise<T> {
  let promise: Promise<T> | undefined
  const start = (): Promise<T> => promise ??= run()
  return {
    then: (resolve, reject) => start().then(resolve, reject),
    catch: reject => start().catch(reject),
    finally: callback => start().finally(callback),
    [Symbol.toStringTag]: 'Promise',
  } as Promise<T>
}

function report(manager: HttpManager, request: HttpClientRequest, response: HttpClientResponse | undefined, error: unknown, startTime: number, duration: number): void {
  const redact = manager.redactHeaders
  const length = response?.headers.get('content-length')
  recordTelemetry('http', {
    method: request.method,
    url: redactUrl(request.url),
    ...(response && {
      status: response.status,
      responseHeaders: redactHeaders(response.headers, redact),
      responseSize: length !== null && length !== undefined
        ? Number(length)
        : response.bufferedSize,
    }),
    ...(request.client && {
      client: request.client,
    }),
    attempt: request.attempt,
    requestHeaders: redactHeaders(request.headers, redact),
    requestSize: bodySize(request.body),
    ...(response?.faked && {
      faked: true,
    }),
    startTime,
    duration,
    ...(error !== undefined && {
      error: error instanceof Error
        ? error.message
        : String(error),
    }),
  })
}
