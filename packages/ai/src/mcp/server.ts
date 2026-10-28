import type { ToolSet } from '../tool'
import type { JSONSchema } from '../types'
import type { JSONRPCId, JSONRPCResponse, MCPCallToolResult, MCPImplementation, MCPToolDefinition } from './protocol'
import { formatIssues, toSchema, validateWithSchema } from '../schema'
import { decodeHeaderValue, ErrorCode, errorResponse, isObject, isResponse, LEGACY_PROTOCOL_VERSIONS, mcpNameOf, META_CLIENT_CAPABILITIES, META_PROTOCOL_VERSION, META_SERVER_INFO, MODERN_PROTOCOL_VERSIONS, paramHeadersOf } from './protocol'

export interface MCPServerOptions {
  name: string
  version: string
  /** 展示用的名称 */
  title?: string
  /** 给模型的使用说明 */
  instructions?: string
  /** 对外提供的工具（defineTool 定义）；没有 execute 的工具不会列出 */
  tools: ToolSet
  /**
   * 允许的 Origin（防 DNS rebinding，规范要求校验）。默认只允许与请求同源或不带 Origin 的请求；
   * `'*'` 允许所有来源。
   */
  allowedOrigins?: string[] | '*' | ((origin: string) => boolean)
  /** tools/list 结果的缓存提示（2026-07-28），默认 `{ ttlMs: 60000, cacheScope: 'private' }` */
  cache?: { ttlMs?: number, cacheScope?: 'public' | 'private' }
}

export interface MCPServer {
  /** 处理一次 Streamable HTTP 请求（POST JSON-RPC），总是以 JSON 应答 */
  handle: (request: Request) => Promise<Response>
}

const SUPPORTED_VERSIONS = [
  ...MODERN_PROTOCOL_VERSIONS,
  ...LEGACY_PROTOCOL_VERSIONS,
]

/** 方法处理结果：result 或 JSON-RPC 错误，以及 HTTP 状态码 */
type Outcome = { result: Record<string, unknown> } | { error: { code: number, message: string, data?: unknown }, status?: number }

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fail(code: number, message: string, status?: number, data?: unknown): Outcome {
  return {
    error: data === undefined
      ? { code, message }
      : { code, message, data },
    status,
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isObject(value))
    return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

function errorResult(text: string): MCPCallToolResult {
  return {
    content: [
      { type: 'text', text },
    ],
    isError: true,
  }
}

/** 工具输出 → MCP 结果：字符串原样作为文本，其余序列化为 JSON；普通对象同时作为 structuredContent */
function toCallResult(output: unknown): MCPCallToolResult {
  const text = typeof output === 'string'
    ? output
    : output === undefined
      ? ''
      : JSON.stringify(output)
  return isPlainObject(output)
    ? {
        content: [
          { type: 'text', text },
        ],
        structuredContent: output,
      }
    : {
        content: [
          { type: 'text', text },
        ],
      }
}

/** 按路径取参数值（Mcp-Param-* 校验） */
function valueAt(args: unknown, path: string[]): unknown {
  let value = args
  for (const key of path) {
    value = isObject(value)
      ? value[key]
      : undefined
  }
  return value
}

/** 校验 x-mcp-header 镜像的 Mcp-Param-* 头与参数一致；返回不一致的说明 */
function checkParamHeaders(request: Request, schema: JSONSchema, args: Record<string, unknown>): string | undefined {
  const parsed = paramHeadersOf(schema)
  if ('error' in parsed)
    return undefined
  for (const { name, path } of parsed.headers) {
    const header = request.headers.get(`mcp-param-${name}`)
    const decoded = header === null
      ? undefined
      : decodeHeaderValue(header)
    if (header !== null && decoded === undefined)
      return `Mcp-Param-${name} header contains invalid characters`
    const value = valueAt(args, path)
    if (value === undefined || value === null)
      continue
    if (decoded === undefined)
      return `Missing Mcp-Param-${name} header`
    const matches = typeof value === 'number'
      ? Number(decoded) === value
      : decoded === String(value)
    if (!matches)
      return `Mcp-Param-${name} header value does not match the "${path.join('.')}" argument`
  }
  return undefined
}

/**
 * 创建无状态的 MCP 服务端（Streamable HTTP，JSON 应答），把 hazejs 工具提供给其他 MCP 客户端：
 *
 * ```ts
 * // route/api.ts
 * import { createMCPServer, defineTool, jsonSchema } from '@hazejs/ai'
 * import { defineRoutes } from '@hazejs/core'
 *
 * const server = createMCPServer({
 *   name: 'my-app',
 *   version: '1.0.0',
 *   tools: { weather },
 * })
 *
 * export default defineRoutes((r) => {
 *   r.post('/mcp', ctx => server.handle(ctx.req))
 * })
 * ```
 *
 * 同时服务 2026-07-28（每请求 `_meta`，含 `server/discover`）与 2025-11-25 及更早（initialize 握手）的客户端，
 * 不创建会话（不返回 Mcp-Session-Id）。
 */
export function createMCPServer(options: MCPServerOptions): MCPServer {
  const serverInfo: MCPImplementation = options.title
    ? { name: options.name, version: options.version, title: options.title }
    : { name: options.name, version: options.version }
  const capabilities = { tools: {} }
  let definitions: Promise<MCPToolDefinition[]> | undefined

  const listTools = (): Promise<MCPToolDefinition[]> => {
    definitions ??= Promise.all(Object.entries(options.tools)
      .filter(([, tool]) => tool.execute)
      .map(async ([name, tool]): Promise<MCPToolDefinition> => {
        const schema = await toSchema(tool.parameters)
        return {
          name,
          ...(tool.description && { description: tool.description }),
          inputSchema: schema.jsonSchema.type === undefined
            ? { type: 'object', ...schema.jsonSchema }
            : schema.jsonSchema,
        }
      }))
    definitions.catch(() => {
      definitions = undefined
    })
    return definitions
  }

  const callTool = async (request: Request, id: JSONRPCId, params: Record<string, unknown>, modern: boolean): Promise<Outcome> => {
    const name = params.name
    if (typeof name !== 'string')
      return fail(ErrorCode.InvalidParams, 'Missing tool name')
    const tool = Object.hasOwn(options.tools, name)
      ? options.tools[name]
      : undefined
    if (!tool?.execute)
      return fail(ErrorCode.InvalidParams, `Unknown tool: ${name}`)
    const args = params.arguments ?? {}
    if (!isObject(args))
      return fail(ErrorCode.InvalidParams, 'Tool arguments must be an object')
    const schema = await toSchema(tool.parameters)
    if (modern) {
      const mismatch = checkParamHeaders(request, schema.jsonSchema, args)
      if (mismatch)
        return fail(ErrorCode.HeaderMismatch, `Header mismatch: ${mismatch}`, 400)
    }
    // 参数错误作为工具执行错误返回，模型可以据此修正
    const validated = await validateWithSchema(schema, args)
    if (!validated.success) {
      return {
        result: {
          ...errorResult(`Invalid arguments for tool "${name}": ${formatIssues(validated.issues)}`),
        },
      }
    }
    try {
      const output = await tool.execute(validated.value, { toolCallId: `mcp-${id}`, messages: [], signal: request.signal })
      return {
        result: {
          ...toCallResult(output),
        },
      }
    }
    catch (error) {
      return {
        result: {
          ...errorResult(error instanceof Error
            ? error.message
            : String(error)),
        },
      }
    }
  }

  /** 2026-07-28：校验头与 `_meta`，每个结果带 resultType 与 serverInfo */
  const modern = async (request: Request, id: JSONRPCId, method: string, params: Record<string, unknown>, meta: Record<string, unknown>): Promise<Outcome> => {
    const version = meta[META_PROTOCOL_VERSION]
    if (typeof version !== 'string')
      return fail(ErrorCode.InvalidParams, `Invalid _meta["${META_PROTOCOL_VERSION}"]`, 400)
    const headerVersion = request.headers.get('mcp-protocol-version')
    if (headerVersion !== version)
      return fail(ErrorCode.HeaderMismatch, `Header mismatch: MCP-Protocol-Version header ${JSON.stringify(headerVersion)} does not match _meta protocol version ${JSON.stringify(version)}`, 400)
    const headerMethod = request.headers.get('mcp-method')
    if (headerMethod !== method)
      return fail(ErrorCode.HeaderMismatch, `Header mismatch: Mcp-Method header ${JSON.stringify(headerMethod)} does not match method ${JSON.stringify(method)}`, 400)
    const name = mcpNameOf(method, params)
    if (name !== undefined) {
      const header = request.headers.get('mcp-name')
      if ((header === null
        ? undefined
        : decodeHeaderValue(header)) !== name) {
        return fail(ErrorCode.HeaderMismatch, `Header mismatch: Mcp-Name header does not match ${JSON.stringify(name)}`, 400)
      }
    }
    if (!MODERN_PROTOCOL_VERSIONS.includes(version))
      return fail(ErrorCode.UnsupportedProtocolVersion, 'Unsupported protocol version', 400, { supported: SUPPORTED_VERSIONS, requested: version })
    if (!isObject(meta[META_CLIENT_CAPABILITIES]))
      return fail(ErrorCode.InvalidParams, `Missing _meta["${META_CLIENT_CAPABILITIES}"]`, 400)

    let outcome: Outcome
    switch (method) {
      case 'server/discover':
        outcome = {
          result: {
            supportedVersions: SUPPORTED_VERSIONS,
            capabilities,
            ...(options.instructions && { instructions: options.instructions }),
          },
        }
        break
      case 'tools/list':
        outcome = {
          result: {
            tools: await listTools(),
            ttlMs: options.cache?.ttlMs ?? 60_000,
            cacheScope: options.cache?.cacheScope ?? 'private',
          },
        }
        break
      case 'tools/call':
        outcome = await callTool(request, id, params, true)
        break
      case 'ping':
        outcome = { result: {} }
        break
      default:
        return fail(ErrorCode.MethodNotFound, `Method not found: ${method}`, 404)
    }
    if ('error' in outcome)
      return outcome
    return {
      result: {
        resultType: 'complete',
        ...outcome.result,
        _meta: {
          ...(isObject(outcome.result._meta)
            ? outcome.result._meta
            : undefined),
          [META_SERVER_INFO]: serverInfo,
        },
      },
    }
  }

  /** 2025-11-25 及更早：initialize 协商版本；无状态，不发会话 id */
  const legacy = async (request: Request, id: JSONRPCId, method: string, params: Record<string, unknown>): Promise<Outcome> => {
    if (method === 'initialize') {
      const requested = params.protocolVersion
      return {
        result: {
          protocolVersion: typeof requested === 'string' && LEGACY_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : LEGACY_PROTOCOL_VERSIONS[0],
          capabilities,
          serverInfo,
          ...(options.instructions && { instructions: options.instructions }),
        },
      }
    }
    // 2025-06-18 起后续请求带 MCP-Protocol-Version 头；不带时按 2025-03-26 处理
    const header = request.headers.get('mcp-protocol-version')
    if (header !== null && !LEGACY_PROTOCOL_VERSIONS.includes(header)) {
      return MODERN_PROTOCOL_VERSIONS.includes(header)
        ? fail(ErrorCode.InvalidParams, `Missing _meta["${META_PROTOCOL_VERSION}"]`, 400)
        : fail(ErrorCode.InvalidRequest, `Unsupported protocol version: ${header} (supported: ${SUPPORTED_VERSIONS.join(', ')})`, 400)
    }
    switch (method) {
      case 'ping':
        return { result: {} }
      case 'tools/list':
        return {
          result: { tools: await listTools() },
        }
      case 'tools/call':
        return callTool(request, id, params, false)
      default:
        return fail(ErrorCode.MethodNotFound, `Method not found: ${method}`)
    }
  }

  const originAllowed = (request: Request): boolean => {
    const origin = request.headers.get('origin')
    if (origin === null || options.allowedOrigins === '*')
      return true
    if (typeof options.allowedOrigins === 'function')
      return options.allowedOrigins(origin)
    if (Array.isArray(options.allowedOrigins))
      return options.allowedOrigins.includes(origin)
    try {
      return new URL(origin).host === (request.headers.get('host') ?? new URL(request.url).host)
    }
    catch {
      return false
    }
  }

  return {
    async handle(request) {
      // 无状态：没有 GET 流，也没有可以 DELETE 的会话
      if (request.method !== 'POST') {
        return new Response(null, {
          status: 405,
          headers: { allow: 'POST' },
        })
      }
      if (!originAllowed(request))
        return json(403, errorResponse(undefined, ErrorCode.InvalidRequest, 'Origin not allowed'))

      let body: unknown
      try {
        body = JSON.parse(await request.text())
      }
      catch {
        return json(400, errorResponse(undefined, ErrorCode.ParseError, 'Parse error'))
      }
      // 2025-06-18 起不再支持 JSON-RPC 批量请求
      if (Array.isArray(body))
        return json(400, errorResponse(undefined, ErrorCode.InvalidRequest, 'JSON-RPC batching is not supported'))
      if (!isObject(body) || body.jsonrpc !== '2.0')
        return json(400, errorResponse(undefined, ErrorCode.InvalidRequest, 'Invalid JSON-RPC message'))
      // 本服务端不向客户端发请求；legacy 客户端发来的响应直接接受
      if (isResponse(body))
        return new Response(null, { status: 202 })
      if (typeof body.method !== 'string')
        return json(400, errorResponse(undefined, ErrorCode.InvalidRequest, 'Invalid JSON-RPC message'))
      // 通知（notifications/initialized 等）
      if (!('id' in body))
        return new Response(null, { status: 202 })
      const id = body.id
      if (typeof id !== 'string' && typeof id !== 'number')
        return json(400, errorResponse(undefined, ErrorCode.InvalidRequest, 'Request id must be a string or number'))
      if (body.params !== undefined && !isObject(body.params))
        return json(400, errorResponse(id, ErrorCode.InvalidParams, 'params must be an object'))

      const params = body.params ?? {}
      const meta = isObject(params._meta) && META_PROTOCOL_VERSION in params._meta
        ? params._meta
        : undefined
      let outcome: Outcome
      try {
        outcome = meta
          ? await modern(request, id, body.method, params, meta)
          : await legacy(request, id, body.method, params)
      }
      catch (error) {
        outcome = fail(ErrorCode.InternalError, error instanceof Error
          ? error.message
          : String(error), 500)
      }
      const response: JSONRPCResponse = 'result' in outcome
        ? { jsonrpc: '2.0', id, result: outcome.result }
        : errorResponse(id, outcome.error.code, outcome.error.message, outcome.error.data)
      return json('error' in outcome
        ? outcome.status ?? 200
        : 200, response)
    },
  }
}
