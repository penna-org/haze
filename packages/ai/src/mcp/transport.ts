import type { FetchFunction } from '../http'
import type { JSONRPCMessage, JSONRPCNotification, JSONRPCRequest, JSONRPCResponse } from './protocol'
import { APICallError } from '../errors'
import { cleanHeaders, parseSSE } from '../http'
import { encodeHeaderValue, ErrorCode, errorResponse, isObject, isRequest, isResponse, MCPError, mcpNameOf, META_PROTOCOL_VERSION } from './protocol'

export interface MCPRequestOptions {
  signal?: AbortSignal
  /** 额外的 HTTP 头（由 x-mcp-header 生成的 Mcp-Param-*）；非 HTTP 传输忽略 */
  headers?: Record<string, string>
}

/**
 * MCP 传输层：负责把 JSON-RPC 消息送达服务端并取回对应的响应。
 * 内置 Streamable HTTP 与 stdio，也可以自行实现（WebSocket、进程内等）。
 */
export interface MCPTransport {
  /** 传输类型；为 `http` 时客户端按 Streamable HTTP 的规则剔除 x-mcp-header 不合法的工具 */
  readonly type?: string
  /** 发送请求并返回 id 对应的响应；JSON-RPC 错误响应原样返回，由客户端处理 */
  request: (message: JSONRPCRequest, options?: MCPRequestOptions) => Promise<JSONRPCResponse>
  /** 发送通知 */
  notify: (message: JSONRPCNotification, options?: MCPRequestOptions) => Promise<void>
  /**
   * legacy 协议握手完成后告知协商的版本（HTTP 之后的请求据此带 MCP-Protocol-Version 头）；
   * 传 undefined 表示重新开始（清除会话）。
   */
  setProtocolVersion?: (version: string | undefined) => void
  close: () => Promise<void>
}

/** legacy 会话失效（HTTP 404 / stdio 进程重启），客户端需要重新 initialize */
export class MCPSessionExpiredError extends MCPError {
  constructor(message = 'MCP session expired') {
    super(message)
    this.name = 'MCPSessionExpiredError'
  }
}

export type MCPHeaders = Record<string, string | undefined>

export interface MCPHttpTransportConfig {
  type: 'http'
  /** MCP 端点，如 `https://example.com/mcp` */
  url: string | URL
  /** 附加的请求头（如 Authorization）；可以是函数，每次请求时读取（刷新令牌） */
  headers?: MCPHeaders | (() => MCPHeaders | Promise<MCPHeaders>)
}

function headersOf(response: Response): Record<string, string> {
  const result: Record<string, string> = {}
  response.headers.forEach((value, key) => {
    result[key] = value
  })
  return result
}

function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text)
  }
  catch {
    return undefined
  }
}

/** legacy 服务端可能在 SSE 流中向客户端发请求：ping 正常应答，其余（采样、征询等）未声明能力，返回 method not found */
export function answerServerRequest(message: JSONRPCRequest): JSONRPCResponse {
  return message.method === 'ping'
    ? { jsonrpc: '2.0', id: message.id, result: {} }
    : errorResponse(message.id, ErrorCode.MethodNotFound, `Client does not support "${message.method}"`)
}

/**
 * Streamable HTTP 传输：每条消息一次 POST，响应为 JSON 或 SSE。
 * modern 请求的 MCP-Protocol-Version 取自请求体 `_meta`，legacy 会话使用握手协商的版本并携带 Mcp-Session-Id。
 */
export function createHttpTransport(config: MCPHttpTransportConfig, fetch?: FetchFunction): MCPTransport {
  const url = String(config.url)
  const doFetch = fetch ?? globalThis.fetch
  let protocolVersion: string | undefined
  let sessionId: string | undefined

  async function send(method: 'POST' | 'DELETE', message: JSONRPCMessage | undefined, options: MCPRequestOptions = {}): Promise<Response> {
    const extra = typeof config.headers === 'function'
      ? await config.headers()
      : config.headers
    const params = message && 'method' in message && isObject(message.params)
      ? message.params
      : undefined
    const meta = isObject(params?._meta)
      ? params._meta
      : undefined
    const name = message && 'method' in message
      ? mcpNameOf(message.method, params)
      : undefined
    const headers = cleanHeaders(
      method === 'POST'
        ? { 'accept': 'application/json, text/event-stream', 'content-type': 'application/json' }
        : undefined,
      extra,
      {
        'mcp-protocol-version': typeof meta?.[META_PROTOCOL_VERSION] === 'string'
          ? meta[META_PROTOCOL_VERSION]
          : protocolVersion,
        'mcp-method': message && 'method' in message
          ? message.method
          : undefined,
        'mcp-name': name === undefined
          ? undefined
          : encodeHeaderValue(name),
        'mcp-session-id': sessionId,
      },
      options.headers,
    )
    let response: Response
    try {
      response = await doFetch(url, {
        method,
        headers,
        body: message
          ? JSON.stringify(message)
          : undefined,
        signal: options.signal,
      })
    }
    catch (error) {
      if (options.signal?.aborted)
        throw error
      throw new APICallError({
        message: `MCP: network error calling ${url}: ${(error as Error).message}`,
        provider: 'mcp',
        url,
        cause: error,
      })
    }
    const session = response.headers.get('mcp-session-id')
    if (session)
      sessionId = session
    return response
  }

  /** 非 2xx：响应体是 JSON-RPC 错误时交给客户端，否则抛出 APICallError */
  async function failure(response: Response, hadSession: boolean): Promise<JSONRPCResponse> {
    const body = await response.text().catch(() => '')
    // legacy：带会话的请求收到 404 表示会话已失效
    if (response.status === 404 && hadSession) {
      sessionId = undefined
      throw new MCPSessionExpiredError()
    }
    const parsed = parseJSON(body)
    if (isResponse(parsed) && 'error' in parsed)
      return parsed
    throw new APICallError({
      message: `MCP server error ${response.status}: ${body.slice(0, 500) || response.statusText}`,
      provider: 'mcp',
      url,
      status: response.status,
      responseBody: body,
      responseHeaders: headersOf(response),
    })
  }

  async function readStream(body: ReadableStream<Uint8Array>, request: JSONRPCRequest): Promise<JSONRPCResponse> {
    for await (const event of parseSSE(body)) {
      // 2025-11-25 的服务端会先发一条只有 id、data 为空的事件
      if (!event.data.trim())
        continue
      const message = parseJSON(event.data)
      if (isResponse(message) && message.id === request.id)
        return message
      if (isRequest(message))
        void send('POST', answerServerRequest(message)).then(response => response.body?.cancel(), () => {})
      // 进度、日志等通知忽略
    }
    throw new MCPError(`MCP server closed the stream before responding to "${request.method}"`)
  }

  return {
    type: 'http',
    async request(message, options = {}) {
      const controller = new AbortController()
      const signal = options.signal
        ? AbortSignal.any([options.signal, controller.signal])
        : controller.signal
      const hadSession = sessionId !== undefined
      const response = await send('POST', message, { ...options, signal })
      try {
        if (!response.ok)
          return await failure(response, hadSession)
        const contentType = response.headers.get('content-type') ?? ''
        if (contentType.includes('text/event-stream') && response.body)
          return await readStream(response.body, message)
        const json = parseJSON(await response.text())
        // legacy 服务端可能以数组返回
        const found = Array.isArray(json)
          ? json.find(item => isResponse(item) && item.id === message.id)
          : json
        if (!isResponse(found))
          throw new MCPError(`Invalid response from MCP server for "${message.method}" (HTTP ${response.status}, ${contentType || 'no content type'})`)
        return found
      }
      finally {
        // 拿到响应后关闭连接（对 SSE 流即结束该请求）
        controller.abort()
      }
    },
    async notify(message, options = {}) {
      const hadSession = sessionId !== undefined
      const response = await send('POST', message, options)
      if (!response.ok) {
        const error = await failure(response, hadSession)
        if ('error' in error)
          throw new MCPError(`MCP server rejected "${message.method}": ${error.error.message}`, { code: error.error.code, data: error.error.data })
      }
      await response.body?.cancel()
    },
    setProtocolVersion(version) {
      protocolVersion = version
      if (version === undefined)
        sessionId = undefined
    },
    async close() {
      // legacy：显式结束会话；服务端可以返回 405 表示不支持
      if (sessionId) {
        await send('DELETE', undefined).then(response => response.body?.cancel(), () => {})
        sessionId = undefined
      }
    },
  }
}
