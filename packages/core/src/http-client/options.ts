import type { ConnectionException } from './exceptions'
import type { HttpClientRequest, HttpRequestBody } from './request'
import type { HttpClientResponse } from './response'
import { jsonReplacer } from '../utils'

/** 请求头（Headers、对象或键值对数组） */
export type HttpHeadersInit = ConstructorParameters<typeof Headers>[0]

/** fetch 的 redirect 选项 */
export type HttpRedirect = 'follow' | 'manual' | 'error'

/** 时长：数字为毫秒，字符串可带单位 ms / s / m / h（`'200ms'`、`'5s'`），不带单位为毫秒 */
export type HttpDuration = number | string

export type HttpQueryValue = string | number | boolean | bigint | Date | null | undefined

/** 查询参数：对象（数组为同名参数重复，null / undefined 跳过）、URLSearchParams 或查询字符串 */
export type HttpQuery = Record<string, HttpQueryValue | HttpQueryValue[]> | URLSearchParams | string

/** 重试间隔的增长方式；数组按次取值（不够时取最后一个）；函数按第几次重试（从 1 开始）返回毫秒数 */
export type HttpBackoff = 'constant' | 'linear' | 'exponential' | HttpDuration[] | ((retry: number) => number)

export interface HttpRetryOptions {
  /** 最多尝试的次数（含第一次），与 Laravel 的 `retry(3)` 相同；1 为不重试 */
  times?: number
  /** 首次重试前等待的时间，默认 100ms */
  delay?: HttpDuration
  /** 默认 constant */
  backoff?: HttpBackoff
  /** 单次等待的上限 */
  maxDelay?: HttpDuration
  /**
   * 是否重试：连接失败（含超时）或响应为 4xx / 5xx 时调用。
   * 默认只重试连接失败与 408 / 425 / 429 / 500 / 502 / 503 / 504。
   */
  when?: (response: HttpClientResponse | undefined, error: ConnectionException | undefined, request: HttpClientRequest) => boolean | Promise<boolean>
  /** 429 / 503 响应带 retry-after 时按它等待，默认 true */
  retryAfter?: boolean
  /** retry-after 超过该值时不再重试（直接返回该响应），默认 60s */
  maxRetryAfter?: HttpDuration
}

/** 请求中间件：可修改请求，或在 next() 之后处理响应；先注册的在外层 */
export type HttpMiddleware = (request: HttpClientRequest, next: (request: HttpClientRequest) => Promise<HttpClientResponse>) => Promise<HttpClientResponse>

/** 自定义 fetch（Workers 的 service binding、代理等） */
export type HttpFetchFunction = (input: Request | string | URL, init?: RequestInit) => Promise<Response>

export type HttpBodyFormat = 'json' | 'form' | 'multipart'

export interface HttpAttachment {
  name: string
  contents: Blob | string | ArrayBuffer | ArrayBufferView
  filename?: string
  /** 文件的 content-type（contents 不是 Blob 时使用） */
  type?: string
}

/** 客户端选项：`Http.create(options)`、config/http.ts 的 defaults 与 clients */
export interface HttpClientOptions {
  /** 相对地址的前缀（直接拼接：`/api/v1` + `/users` → `/api/v1/users`） */
  baseURL?: string
  headers?: HttpHeadersInit
  query?: HttpQuery
  /** URL 中 `{name}` 占位符的值（自动编码） */
  urlParameters?: Record<string, string | number>
  /** Bearer 令牌 */
  token?: string
  /** Basic 认证：[用户名, 密码] */
  basicAuth?: [username: string, password: string]
  /** 每次尝试的超时，默认 30s；false 不限制 */
  timeout?: HttpDuration | false
  /** 数字为最多尝试的次数（含第一次） */
  retry?: number | HttpRetryOptions
  /** 对象请求体的编码，默认 json */
  bodyFormat?: HttpBodyFormat
  attachments?: HttpAttachment[]
  middleware?: HttpMiddleware[]
  fetch?: HttpFetchFunction
  redirect?: HttpRedirect
  /** 4xx / 5xx 时自动抛出 HttpRequestException */
  throw?: boolean
  signal?: AbortSignal
}

/** 单次请求的选项（`get(url, options)` / `post(url, data, options)`） */
export interface HttpRequestOptions extends HttpClientOptions {
  /** 请求体（`delete` 等没有 data 参数的方法使用） */
  body?: unknown
}

export interface ResolvedRetry {
  times: number
  delay: number
  backoff: HttpBackoff
  maxDelay: number | undefined
  when: HttpRetryOptions['when']
  retryAfter: boolean
  maxRetryAfter: number
}

export interface ResolvedOptions {
  baseURL: string | undefined
  headers: Headers
  query: URLSearchParams
  urlParameters: Record<string, string | number>
  timeout: number | undefined
  retry: ResolvedRetry
  bodyFormat: HttpBodyFormat
  attachments: HttpAttachment[]
  middleware: HttpMiddleware[]
  fetch: HttpFetchFunction | undefined
  redirect: HttpRedirect | undefined
  throw: boolean
  signal: AbortSignal | undefined
  hasBody: boolean
  body: unknown
}

export const DEFAULT_TIMEOUT = 30_000

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
}

export function toMilliseconds(value: HttpDuration): number {
  if (typeof value === 'number')
    return value
  const match = /^\s*(\d+(?:\.\d+)?)\s*(?:(ms|[smh])\s*)?$/i.exec(value)
  if (!match)
    throw new Error(`Invalid duration "${value}" (expected e.g. 200ms, 5s, 1m)`)
  return Number(match[1]) * UNITS[(match[2] ?? 'ms').toLowerCase()]!
}

/** UTF-8 安全的 base64（btoa 只接受 Latin-1） */
export function base64(value: string): string {
  let binary = ''
  for (const byte of new TextEncoder().encode(value))
    binary += String.fromCharCode(byte)
  return btoa(binary)
}

function appendQuery(target: URLSearchParams, query: HttpQuery | undefined): void {
  if (query === undefined)
    return
  if (typeof query === 'string' || query instanceof URLSearchParams) {
    for (const [key, value] of new URLSearchParams(query))
      target.append(key, value)
    return
  }
  for (const [key, value] of Object.entries(query)) {
    // 后面的层覆盖前面的同名参数
    target.delete(key)
    for (const item of Array.isArray(value)
      ? value
      : [value]) {
      if (item === null || item === undefined)
        continue
      target.append(key, item instanceof Date
        ? item.toISOString()
        : String(item))
    }
  }
}

/** 合并各层选项：配置的 defaults → 命名客户端 → 构造器链 → 单次请求 */
export function resolveOptions(layers: Array<HttpRequestOptions | undefined>): ResolvedOptions {
  const resolved: ResolvedOptions = {
    baseURL: undefined,
    headers: new Headers(),
    query: new URLSearchParams(),
    urlParameters: {},
    timeout: DEFAULT_TIMEOUT,
    retry: {
      times: 1,
      delay: 100,
      backoff: 'constant',
      maxDelay: undefined,
      when: undefined,
      retryAfter: true,
      maxRetryAfter: 60_000,
    },
    bodyFormat: 'json',
    attachments: [],
    middleware: [],
    fetch: undefined,
    redirect: undefined,
    throw: false,
    signal: undefined,
    hasBody: false,
    body: undefined,
  }
  for (const layer of layers) {
    if (!layer)
      continue
    if (layer.baseURL !== undefined)
      resolved.baseURL = layer.baseURL
    if (layer.token !== undefined)
      resolved.headers.set('authorization', `Bearer ${layer.token}`)
    if (layer.basicAuth)
      resolved.headers.set('authorization', `Basic ${base64(`${layer.basicAuth[0]}:${layer.basicAuth[1]}`)}`)
    if (layer.headers) {
      new Headers(layer.headers).forEach((value, key) => {
        resolved.headers.set(key, value)
      })
    }
    appendQuery(resolved.query, layer.query)
    if (layer.urlParameters)
      Object.assign(resolved.urlParameters, layer.urlParameters)
    if (layer.timeout !== undefined) {
      resolved.timeout = layer.timeout === false || layer.timeout === 0
        ? undefined
        : toMilliseconds(layer.timeout)
    }
    if (layer.retry !== undefined) {
      const retry = typeof layer.retry === 'number'
        ? { times: layer.retry }
        : layer.retry
      resolved.retry = {
        times: retry.times ?? resolved.retry.times,
        delay: retry.delay === undefined
          ? resolved.retry.delay
          : toMilliseconds(retry.delay),
        backoff: retry.backoff ?? resolved.retry.backoff,
        maxDelay: retry.maxDelay === undefined
          ? resolved.retry.maxDelay
          : toMilliseconds(retry.maxDelay),
        when: retry.when ?? resolved.retry.when,
        retryAfter: retry.retryAfter ?? resolved.retry.retryAfter,
        maxRetryAfter: retry.maxRetryAfter === undefined
          ? resolved.retry.maxRetryAfter
          : toMilliseconds(retry.maxRetryAfter),
      }
    }
    if (layer.bodyFormat)
      resolved.bodyFormat = layer.bodyFormat
    if (layer.attachments)
      resolved.attachments.push(...layer.attachments)
    if (layer.middleware)
      resolved.middleware.push(...layer.middleware)
    if (layer.fetch)
      resolved.fetch = layer.fetch
    if (layer.redirect)
      resolved.redirect = layer.redirect
    if (layer.throw !== undefined)
      resolved.throw = layer.throw
    if (layer.signal)
      resolved.signal = layer.signal
    if ('body' in layer && layer.body !== undefined) {
      resolved.hasBody = true
      resolved.body = layer.body
    }
  }
  return resolved
}

const ABSOLUTE_URL_RE = /^[a-z][\w+.-]*:\/\//i

/** 拼接 baseURL、替换 `{name}` 占位符、合并查询参数 */
export function buildUrl(path: string, options: Pick<ResolvedOptions, 'baseURL' | 'query' | 'urlParameters'>): string {
  let url = path.replace(/\{(\w+)\}/g, (match, name: string) => name in options.urlParameters
    ? encodeURIComponent(String(options.urlParameters[name]))
    : match)
  if (!ABSOLUTE_URL_RE.test(url)) {
    if (!options.baseURL)
      throw new TypeError(`Invalid URL "${path}": pass an absolute URL or set baseURL`)
    url = url
      ? `${options.baseURL.replace(/\/+$/, '')}/${url.replace(/^\/+/, '')}`
      : options.baseURL
  }
  const query = options.query.toString()
  if (!query)
    return url
  const hash = url.indexOf('#')
  const [base, fragment] = hash === -1
    ? [url, '']
    : [
        url.slice(0, hash),
        url.slice(hash),
      ]
  return `${base}${base.includes('?')
    ? '&'
    : '?'}${query}${fragment}`
}

export function isRawBody(value: unknown): value is HttpRequestBody {
  return typeof value === 'string'
    || value instanceof URLSearchParams
    || value instanceof FormData
    || value instanceof Blob
    || value instanceof ArrayBuffer
    || ArrayBuffer.isView(value)
    || value instanceof ReadableStream
}

/** 把嵌套对象展开为表单字段：`{ a: { b: 1 }, c: [1, 2] }` → `a[b]=1&c=1&c=2` */
function flatten(value: unknown, prefix: string, visit: (key: string, value: unknown) => void): void {
  if (value === null || value === undefined)
    return
  if (Array.isArray(value)) {
    for (const item of value)
      flatten(item, prefix, visit)
    return
  }
  if (typeof value === 'object' && !(value instanceof Date) && !(value instanceof Blob)) {
    for (const [key, item] of Object.entries(value)) {
      flatten(item, prefix
        ? `${prefix}[${key}]`
        : key, visit)
    }
    return
  }
  visit(prefix, value)
}

function scalar(value: unknown): string {
  return value instanceof Date
    ? value.toISOString()
    : String(value)
}

function attachmentBlob(attachment: HttpAttachment): Blob {
  return attachment.contents instanceof Blob
    ? attachment.contents
    : new Blob([attachment.contents as NonNullable<ConstructorParameters<typeof Blob>[0]>[number]], attachment.type
        ? { type: attachment.type }
        : {})
}

/** 按 bodyFormat 编码请求体，返回请求体与需要设置的 content-type */
export function encodeBody(data: unknown, options: Pick<ResolvedOptions, 'bodyFormat' | 'attachments'>): { body?: HttpRequestBody, contentType?: string } {
  if (options.attachments.length || (options.bodyFormat === 'multipart' && data !== undefined && !isRawBody(data))) {
    const form = new FormData()
    if (data instanceof FormData) {
      for (const [key, value] of data)
        form.append(key, value)
    }
    else {
      flatten(data, '', (key, value) => {
        if (value instanceof Blob)
          form.append(key, value)
        else
          form.append(key, scalar(value))
      })
    }
    for (const attachment of options.attachments) {
      const blob = attachmentBlob(attachment)
      form.append(attachment.name, blob, attachment.filename ?? (blob as File).name ?? 'blob')
    }
    // multipart 的边界由 fetch 生成，不设置 content-type
    return { body: form }
  }
  if (data === undefined)
    return {}
  if (isRawBody(data))
    return { body: data }
  if (options.bodyFormat === 'form') {
    const params = new URLSearchParams()
    flatten(data, '', (key, value) => params.append(key, scalar(value)))
    return { body: params }
  }
  return {
    body: JSON.stringify(data, jsonReplacer),
    contentType: 'application/json',
  }
}

/** 请求体的字节数（遥测用；multipart 与流无法预先得知） */
export function bodySize(body: HttpRequestBody | undefined): number | undefined {
  if (body === undefined)
    return 0
  if (typeof body === 'string')
    return new TextEncoder().encode(body).byteLength
  if (body instanceof URLSearchParams)
    return body.toString().length
  if (body instanceof Blob)
    return body.size
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body))
    return body.byteLength
  return undefined
}
