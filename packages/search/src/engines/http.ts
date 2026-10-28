import { SearchEngineError } from '../engine'

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface HttpOptions {
  /** 服务地址，如 `http://127.0.0.1:7700` */
  url: string
  headers: Record<string, string>
  /** 自定义 fetch（测试或代理） */
  fetch?: Fetch
  /** 单次请求超时（毫秒），默认 30 秒 */
  timeout?: number
}

export interface RequestOptions {
  method?: string
  body?: unknown
  /** 原样发送的请求体（NDJSON / JSONL） */
  raw?: string
  contentType?: string
  query?: Record<string, string | number | boolean | undefined>
  /** 这些状态码不视为错误，返回 undefined */
  allow?: number[]
}

/** 极简 HTTP 客户端：JSON 请求 / 响应，非 2xx 抛出 SearchEngineError */
export function httpClient(name: string, options: HttpOptions) {
  const base = options.url.replace(/\/+$/, '')
  const fetcher: Fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init))
  return async <T = any>(path: string, request: RequestOptions = {}): Promise<T | undefined> => {
    const query = Object.entries(request.query ?? {}).filter(([, value]) => value !== undefined)
    const url = `${base}${path}${query.length
      ? `?${new URLSearchParams(query.map(([key, value]): [string, string] => [
        key,
        String(value),
      ]))}`
      : ''}`
    const headers: Record<string, string> = { ...options.headers }
    let body: string | undefined
    if (request.raw !== undefined) {
      body = request.raw
      headers['content-type'] = request.contentType ?? 'text/plain'
    }
    else if (request.body !== undefined) {
      body = JSON.stringify(request.body)
      headers['content-type'] = 'application/json'
    }
    const method = request.method ?? (body === undefined
      ? 'GET'
      : 'POST')
    const response = await fetcher(url, {
      method,
      headers,
      body,
      signal: AbortSignal.timeout(options.timeout ?? 30_000),
    })
    if (request.allow?.includes(response.status)) {
      await response.body?.cancel()
      return undefined
    }
    const text = await response.text()
    let data: unknown = text
    if (text && (response.headers.get('content-type') ?? '').includes('json')) {
      try {
        data = JSON.parse(text)
      }
      catch {}
    }
    if (!response.ok) {
      const detail = typeof data === 'object' && data !== null
        ? (data as { message?: string, error?: { reason?: string } | string }).message ?? errorReason(data)
        : text
      throw new SearchEngineError(`${name} ${method} ${path} failed with ${response.status}${detail
        ? `: ${detail}`
        : ''}`, response.status, data)
    }
    return data as T
  }
}

function errorReason(data: object): string | undefined {
  const error = (data as { error?: unknown }).error
  if (typeof error === 'string')
    return error
  if (error && typeof error === 'object')
    return (error as { reason?: string }).reason ?? JSON.stringify(error)
  return undefined
}

export type HttpClient = ReturnType<typeof httpClient>
