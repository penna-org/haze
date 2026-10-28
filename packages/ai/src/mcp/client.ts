import type { FetchFunction } from '../http'
import type { ToolSet } from '../tool'
import type { JSONSchema } from '../types'
import type { JSONRPCResponse, MCPCallToolResult, MCPContent, MCPImplementation, MCPToolDefinition, ParamHeader } from './protocol'
import type { MCPStdioTransportConfig } from './stdio'
import type { MCPHttpTransportConfig, MCPTransport } from './transport'
import { APICallError } from '../errors'
import { jsonSchema } from '../schema'
import { defineTool } from '../tool'
import { encodeHeaderValue, ErrorCode, isObject, LEGACY_PROTOCOL_VERSIONS, MCPError, META_CLIENT_CAPABILITIES, META_CLIENT_INFO, META_PROTOCOL_VERSION, META_SERVER_INFO, MODERN_ERROR_CODES, MODERN_PROTOCOL_VERSIONS, paramHeadersOf, paramHeaderValue } from './protocol'
import { createStdioTransport } from './stdio'
import { createHttpTransport, MCPSessionExpiredError } from './transport'

export type MCPTransportConfig = MCPHttpTransportConfig | MCPStdioTransportConfig

export interface MCPClientOptions {
  /** `{ type: 'http', url }`、`{ type: 'stdio', command, args }`，或自行实现的 MCPTransport */
  transport: MCPTransportConfig | MCPTransport
  /** 客户端名称（clientInfo），默认 `@hazejs/ai` */
  name?: string
  version?: string
  /** HTTP 传输使用的 fetch */
  fetch?: FetchFunction
  /**
   * 固定协议版本，跳过探测：modern 版本（2026-07-28 起）直接按每请求 `_meta` 通信，
   * legacy 版本（2025-11-25 及更早）直接 initialize。默认自动探测。
   */
  protocolVersion?: string
  /**
   * 非 HTTP 传输上探测 `server/discover` 的超时（毫秒），超时视为 legacy 服务端，默认 10000。
   * （HTTP 依据状态码与响应体判断，不受此影响）
   */
  discoverTimeout?: number
  /** 剔除不合法的工具定义等警告，默认 console.warn */
  onWarning?: (message: string) => void
}

export interface MCPServerInfo {
  /** 实际使用的协议版本 */
  protocolVersion: string
  /** modern：每请求携带元数据（2026-07-28 起）；legacy：initialize 握手 */
  era: 'modern' | 'legacy'
  capabilities: Record<string, unknown>
  serverInfo?: MCPImplementation
  instructions?: string
}

export interface MCPCallOptions {
  signal?: AbortSignal
}

export interface MCPClient {
  /** 确定协议版本并取得服务端信息；其余方法会自动调用，结果缓存 */
  initialize: (options?: MCPCallOptions) => Promise<MCPServerInfo>
  /** 列出全部工具（自动翻页） */
  listTools: (options?: MCPCallOptions) => Promise<MCPToolDefinition[]>
  callTool: (name: string, args?: Record<string, unknown>, options?: MCPCallOptions) => Promise<MCPCallToolResult>
  /** 把服务端的工具转换为 ToolSet，直接交给 generateText / streamText */
  tools: (options?: { include?: string[] } & MCPCallOptions) => Promise<ToolSet>
  /** 发送任意请求（resources/list、prompts/get 等），返回 result */
  request: <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, options?: MCPCallOptions) => Promise<T>
  close: () => Promise<void>
}

function isTransport(value: MCPClientOptions['transport']): value is MCPTransport {
  return typeof (value as MCPTransport).request === 'function'
}

function textOf(content: MCPContent[]): string {
  return content.filter(part => part.type === 'text').map(part => part.text).join('\n')
}

/** MCP 工具结果 → hazejs 工具输出：structuredContent 优先，其次文本，含非文本内容时返回原始数组 */
function toolOutput(name: string, result: MCPCallToolResult): unknown {
  if (result.isError) {
    const text = textOf(result.content)
    throw new MCPError(text || `MCP tool "${name}" failed`, { data: result })
  }
  if (result.structuredContent !== undefined)
    return result.structuredContent
  return result.content.every(part => part.type === 'text')
    ? textOf(result.content)
    : result.content
}

/** 去掉 $schema（部分厂商不接受），补全空的 properties */
function normalizeInputSchema(schema: JSONSchema | undefined): JSONSchema {
  const { $schema: _, ...rest } = isObject(schema)
    ? schema
    : { type: 'object' }
  return rest.type === 'object' && !isObject(rest.properties)
    ? { ...rest, properties: {} }
    : rest
}

/**
 * 创建 MCP 客户端：
 *
 * ```ts
 * const mcp = createMCPClient({ transport: { type: 'http', url: 'https://example.com/mcp' } })
 * const { text } = await generateText({ model, prompt, tools: await mcp.tools() })
 * await mcp.close()
 * ```
 *
 * 同时支持 2026-07-28 的无状态协议与 2025-11-25 及更早基于 initialize 的协议：
 * 先发送 `server/discover` 探测，服务端不认识时回退到 initialize 握手。
 */
export function createMCPClient(options: MCPClientOptions): MCPClient {
  const transport: MCPTransport = isTransport(options.transport)
    ? options.transport
    : options.transport.type === 'http'
      ? createHttpTransport(options.transport, options.fetch)
      : createStdioTransport(options.transport)
  const clientInfo: MCPImplementation = { name: options.name ?? '@hazejs/ai', version: options.version ?? '0.0.0' }

  const warn = options.onWarning ?? ((message: string) => console.warn(message))
  let nextId = 0
  let initializing: Promise<MCPServerInfo> | undefined
  let closed = false
  /** 工具名 → x-mcp-header 镜像的参数（来自最近一次 tools/list） */
  const paramHeaders = new Map<string, ParamHeader[]>()

  const withMeta = (params: Record<string, unknown> | undefined, version: string): Record<string, unknown> => ({
    ...params,
    _meta: {
      ...(isObject(params?._meta)
        ? params._meta
        : undefined),
      [META_PROTOCOL_VERSION]: version,
      [META_CLIENT_INFO]: clientInfo,
      [META_CLIENT_CAPABILITIES]: {},
    },
  })

  const send = (method: string, params: Record<string, unknown> | undefined, callOptions: { signal?: AbortSignal, headers?: Record<string, string> } = {}): Promise<JSONRPCResponse> => {
    return transport.request({
      jsonrpc: '2.0',
      id: ++nextId,
      method,
      ...(params && { params }),
    }, callOptions)
  }

  const toError = (method: string, response: Extract<JSONRPCResponse, { error: unknown }>): MCPError => {
    const { code, message, data } = response.error
    return new MCPError(`MCP error ${code} from "${method}": ${message}`, { code, data })
  }

  const discoverInfo = (result: Record<string, unknown>, version: string): MCPServerInfo => ({
    protocolVersion: version,
    era: 'modern',
    capabilities: isObject(result.capabilities)
      ? result.capabilities
      : {},
    serverInfo: isObject(result._meta)
      ? result._meta[META_SERVER_INFO] as MCPImplementation | undefined
      : undefined,
    instructions: typeof result.instructions === 'string'
      ? result.instructions
      : undefined,
  })

  const pickModern = (supported: unknown): string | undefined => Array.isArray(supported)
    ? MODERN_PROTOCOL_VERSIONS.find(version => supported.includes(version))
    : undefined

  /** modern 探测：返回服务端信息；判定为 legacy 服务端时返回 undefined */
  const discover = async (version: string, signal: AbortSignal | undefined, fallback: boolean): Promise<MCPServerInfo | undefined> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const timeout = fallback && transport.type !== 'http'
        ? AbortSignal.timeout(options.discoverTimeout ?? 10_000)
        : undefined
      let response: JSONRPCResponse
      try {
        response = await send('server/discover', withMeta(undefined, version), {
          signal: signal && timeout
            ? AbortSignal.any([signal, timeout])
            : signal ?? timeout,
        })
      }
      catch (error) {
        if (signal?.aborted || !fallback)
          throw error
        // 超时，或 HTTP 4xx 且响应体不是 JSON-RPC 错误：legacy 服务端
        if (timeout?.aborted || (error instanceof APICallError && error.status !== undefined && error.status >= 400 && error.status < 500))
          return undefined
        throw error
      }
      if ('result' in response) {
        const supported = response.result.supportedVersions
        const chosen = Array.isArray(supported) && !supported.includes(version)
          ? pickModern(supported)
          : version
        if (!chosen)
          throw new MCPError(`MCP server supports protocol versions ${JSON.stringify(supported)}, none of which this client implements`)
        return discoverInfo(response.result, chosen)
      }
      const { code, data } = response.error
      if (code === ErrorCode.UnsupportedProtocolVersion) {
        const supported = isObject(data)
          ? data.supported
          : undefined
        const modern = pickModern(supported)
        if (modern && modern !== version) {
          version = modern
          continue
        }
        // 只支持 legacy 版本的 dual-era 服务端
        if (fallback && Array.isArray(supported) && supported.some(item => LEGACY_PROTOCOL_VERSIONS.includes(item)))
          return undefined
        throw toError('server/discover', response)
      }
      if (!fallback || MODERN_ERROR_CODES.includes(code))
        throw toError('server/discover', response)
      // 其他错误（method not found、未初始化等）：legacy 服务端
      return undefined
    }
    throw new MCPError('MCP protocol version negotiation failed')
  }

  /** legacy：initialize → notifications/initialized */
  const legacyInitialize = async (version: string, signal: AbortSignal | undefined): Promise<MCPServerInfo> => {
    transport.setProtocolVersion?.(undefined)
    const response = await send('initialize', { protocolVersion: version, capabilities: {}, clientInfo }, { signal })
    if ('error' in response)
      throw toError('initialize', response)
    const result = response.result
    const negotiated = result.protocolVersion
    if (typeof negotiated !== 'string' || !LEGACY_PROTOCOL_VERSIONS.includes(negotiated))
      throw new MCPError(`MCP server responded with unsupported protocol version ${JSON.stringify(negotiated)}`)
    transport.setProtocolVersion?.(negotiated)
    await transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' }, { signal })
    return {
      protocolVersion: negotiated,
      era: 'legacy',
      capabilities: isObject(result.capabilities)
        ? result.capabilities
        : {},
      serverInfo: result.serverInfo as MCPImplementation | undefined,
      instructions: typeof result.instructions === 'string'
        ? result.instructions
        : undefined,
    }
  }

  const initialize = (callOptions: MCPCallOptions = {}): Promise<MCPServerInfo> => {
    if (closed)
      return Promise.reject(new MCPError('MCP client is closed'))
    initializing ??= (async () => {
      const forced = options.protocolVersion
      if (forced && LEGACY_PROTOCOL_VERSIONS.includes(forced))
        return legacyInitialize(forced, callOptions.signal)
      const modern = await discover(forced ?? MODERN_PROTOCOL_VERSIONS[0], callOptions.signal, !forced)
      return modern ?? legacyInitialize(LEGACY_PROTOCOL_VERSIONS[0], callOptions.signal)
    })()
    // 失败（含取消）后允许重试
    initializing.catch(() => {
      initializing = undefined
    })
    return initializing
  }

  const request = async <T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, callOptions: MCPCallOptions & { headers?: Record<string, string> } = {}, retry = true): Promise<T> => {
    const info = await initialize(callOptions)
    let response: JSONRPCResponse
    try {
      response = await send(method, info.era === 'modern'
        ? withMeta(params, info.protocolVersion)
        : params && Object.keys(params).length
          ? params
          : undefined, callOptions)
    }
    catch (error) {
      // legacy 会话失效：重新握手后重试一次
      if (error instanceof MCPSessionExpiredError && retry) {
        initializing = undefined
        transport.setProtocolVersion?.(undefined)
        return request<T>(method, params, callOptions, false)
      }
      throw error
    }
    if ('error' in response)
      throw toError(method, response)
    const resultType = response.result.resultType ?? 'complete'
    if (resultType === 'input_required')
      throw new MCPError(`MCP server requires additional client input for "${method}" (multi round-trip requests), which this client does not support`, { data: response.result })
    if (resultType !== 'complete')
      throw new MCPError(`MCP server returned an unknown resultType ${JSON.stringify(resultType)} for "${method}"`)
    return response.result as T
  }

  const listTools = async (callOptions: MCPCallOptions = {}): Promise<MCPToolDefinition[]> => {
    const tools: MCPToolDefinition[] = []
    const cursors = new Set<string>()
    let cursor: string | undefined
    do {
      const result = await request('tools/list', cursor === undefined
        ? {}
        : { cursor }, callOptions)
      if (Array.isArray(result.tools))
        tools.push(...result.tools as MCPToolDefinition[])
      cursor = typeof result.nextCursor === 'string' && result.nextCursor
        ? result.nextCursor
        : undefined
      if (cursor !== undefined) {
        if (cursors.has(cursor))
          throw new MCPError(`MCP server returned a repeated tools/list cursor ${JSON.stringify(cursor)}`)
        cursors.add(cursor)
      }
    } while (cursor !== undefined)

    paramHeaders.clear()
    return tools.filter((tool) => {
      const parsed = paramHeadersOf(isObject(tool.inputSchema)
        ? tool.inputSchema
        : {})
      if ('error' in parsed) {
        // Streamable HTTP 要求剔除 x-mcp-header 不合法的工具；其他传输忽略该标注
        if (transport.type === 'http') {
          warn(`MCP tool "${tool.name}" was skipped: ${parsed.error}`)
          return false
        }
        return true
      }
      if (parsed.headers.length)
        paramHeaders.set(tool.name, parsed.headers)
      return true
    })
  }

  const callTool = async (name: string, args: Record<string, unknown> = {}, callOptions: MCPCallOptions = {}, retry = true): Promise<MCPCallToolResult> => {
    const headers: Record<string, string> = {}
    for (const header of paramHeaders.get(name) ?? []) {
      const value = paramHeaderValue(args, header.path)
      if (value !== undefined)
        headers[`mcp-param-${header.name.toLowerCase()}`] = encodeHeaderValue(value)
    }
    let result: Record<string, unknown>
    try {
      result = await request('tools/call', { name, arguments: args }, { ...callOptions, headers })
    }
    catch (error) {
      // 工具的 x-mcp-header 可能已变化：重新列出工具后重试一次
      if (retry && error instanceof MCPError && error.code === ErrorCode.HeaderMismatch) {
        await listTools(callOptions)
        return callTool(name, args, callOptions, false)
      }
      throw error
    }
    return {
      ...result,
      content: Array.isArray(result.content)
        ? result.content as MCPContent[]
        : [],
      structuredContent: result.structuredContent,
      isError: result.isError === true,
    } as MCPCallToolResult
  }

  return {
    initialize,
    listTools,
    callTool: (name, args, callOptions) => callTool(name, args, callOptions),
    async tools({ include, signal } = {}) {
      const allowed = include && new Set(include)
      const set: ToolSet = {}
      for (const tool of await listTools({ signal })) {
        if (allowed && !allowed.has(tool.name))
          continue
        set[tool.name] = defineTool({
          description: tool.description ?? tool.title,
          parameters: jsonSchema<Record<string, unknown>>(normalizeInputSchema(tool.inputSchema)),
          execute: async (input, context) => toolOutput(tool.name, await callTool(tool.name, input ?? {}, { signal: context.signal })),
        })
      }
      return set
    },
    request: (method, params, callOptions) => request(method, params, callOptions),
    async close() {
      if (closed)
        return
      closed = true
      initializing = undefined
      await transport.close()
    },
  }
}
