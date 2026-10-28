import type { JSONSchema } from '../types'
import { fromBase64, toBase64 } from '../data'
import { AIError } from '../errors'

/**
 * MCP（Model Context Protocol）协议的公共定义。
 *
 * 规范：https://modelcontextprotocol.io/specification/2026-07-28
 * - 2026-07-28 起协议无状态（modern）：没有 initialize 握手，每个请求在 `_meta` 中携带协议版本与客户端能力；
 * - 2025-11-25 及更早（legacy）：先 initialize 再 notifications/initialized，HTTP 上用 Mcp-Session-Id 维持会话。
 * 客户端与服务端都同时支持两代协议（dual-era）。
 */

export const LATEST_PROTOCOL_VERSION = '2026-07-28'
/** 按每请求 `_meta` 协商版本的协议版本（新的在前） */
export const MODERN_PROTOCOL_VERSIONS: readonly string[] = ['2026-07-28']
/** 需要 initialize 握手的协议版本（新的在前） */
export const LEGACY_PROTOCOL_VERSIONS: readonly string[] = [
  '2025-11-25',
  '2025-06-18',
  '2025-03-26',
  '2024-11-05',
]

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion'
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo'
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities'
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo'

/** JSON-RPC 与 MCP 定义的错误码 */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** HTTP 头与请求体不一致，或缺少必需的头（2026-07-28） */
  HeaderMismatch: -32020,
  /** 处理请求需要客户端未声明的能力（2026-07-28） */
  MissingRequiredClientCapability: -32021,
  /** 服务端不支持请求的协议版本，data.supported 列出支持的版本（2026-07-28） */
  UnsupportedProtocolVersion: -32022,
} as const

/** 只有 modern 服务端才会返回的错误码：据此区分 modern 与 legacy 服务端 */
export const MODERN_ERROR_CODES: readonly number[] = [ErrorCode.HeaderMismatch, ErrorCode.MissingRequiredClientCapability, ErrorCode.UnsupportedProtocolVersion]

export type JSONRPCId = string | number

export interface JSONRPCRequest {
  jsonrpc: '2.0'
  id: JSONRPCId
  method: string
  params?: Record<string, unknown>
}

export interface JSONRPCNotification {
  jsonrpc: '2.0'
  method: string
  params?: Record<string, unknown>
}

export interface JSONRPCErrorObject {
  code: number
  message: string
  data?: unknown
}

export type JSONRPCResponse
  = | { jsonrpc: '2.0', id: JSONRPCId, result: Record<string, unknown> }
    | { jsonrpc: '2.0', id?: JSONRPCId | null, error: JSONRPCErrorObject }

export type JSONRPCMessage = JSONRPCRequest | JSONRPCNotification | JSONRPCResponse

/** 名称与版本（clientInfo / serverInfo） */
export interface MCPImplementation {
  name: string
  version: string
  title?: string
}

/** MCP 服务端返回的错误（JSON-RPC 错误响应，或无法继续的协议状态） */
export class MCPError extends AIError {
  /** JSON-RPC 错误码；本地错误（超时、进程退出等）没有错误码 */
  readonly code?: number
  readonly data?: unknown

  constructor(message: string, options: { code?: number, data?: unknown, cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.name = 'MCPError'
    this.code = options.code
    this.data = options.data
  }
}

// ---------- 工具相关的数据类型 ----------

export interface MCPToolDefinition {
  name: string
  title?: string
  description?: string
  inputSchema: JSONSchema
  outputSchema?: JSONSchema
  annotations?: Record<string, unknown>
  icons?: unknown[]
  _meta?: Record<string, unknown>
}

export interface MCPAnnotations {
  audience?: Array<'user' | 'assistant'>
  priority?: number
  lastModified?: string
}

export type MCPContent
  = | { type: 'text', text: string, annotations?: MCPAnnotations, _meta?: Record<string, unknown> }
    | { type: 'image', data: string, mimeType: string, annotations?: MCPAnnotations, _meta?: Record<string, unknown> }
    | { type: 'audio', data: string, mimeType: string, annotations?: MCPAnnotations, _meta?: Record<string, unknown> }
    | { type: 'resource_link', uri: string, name: string, title?: string, description?: string, mimeType?: string, size?: number, annotations?: MCPAnnotations, _meta?: Record<string, unknown> }
    | { type: 'resource', resource: { uri: string, mimeType?: string, text?: string, blob?: string, annotations?: MCPAnnotations, _meta?: Record<string, unknown> }, annotations?: MCPAnnotations, _meta?: Record<string, unknown> }

export interface MCPCallToolResult {
  content: MCPContent[]
  /** 任意 JSON 值（2025-11-25 及更早只允许对象） */
  structuredContent?: unknown
  isError?: boolean
  _meta?: Record<string, unknown>
}

// ---------- 消息判别 ----------

export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function isResponse(message: unknown): message is JSONRPCResponse {
  return isObject(message) && !('method' in message) && ('result' in message || 'error' in message)
}

export function isRequest(message: unknown): message is JSONRPCRequest {
  return isObject(message) && typeof message.method === 'string' && (typeof message.id === 'string' || typeof message.id === 'number')
}

export function isNotification(message: unknown): message is JSONRPCNotification {
  return isObject(message) && typeof message.method === 'string' && !('id' in message)
}

/** 错误响应；无法读出请求 id 时（解析错误等）不带 id */
export function errorResponse(id: JSONRPCId | null | undefined, code: number, message: string, data?: unknown): JSONRPCResponse {
  return {
    jsonrpc: '2.0',
    ...(id !== undefined && id !== null && { id }),
    error: data === undefined
      ? { code, message }
      : { code, message, data },
  }
}

// ---------- Streamable HTTP 的请求元数据头 ----------

const SENTINEL = /^=\?base64\?(.*)\?=$/s

/** 头的值只能是可见 ASCII 与空格（首尾不能是空白）；否则用 `=?base64?…?=` 编码 */
export function encodeHeaderValue(value: string): string {
  const safe = /^[\x21-\x7E](?:[\x20-\x7E]*[\x21-\x7E])?$/.test(value) && !SENTINEL.test(value)
  return safe
    ? value
    : `=?base64?${toBase64(new TextEncoder().encode(value))}?=`
}

/** 解码 encodeHeaderValue 的结果；值含非法字符时返回 undefined */
export function decodeHeaderValue(value: string): string | undefined {
  const match = SENTINEL.exec(value)
  if (match) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(fromBase64(match[1]))
    }
    catch {
      return undefined
    }
  }
  return /^[\x20-\x7E\t]*$/.test(value)
    ? value
    : undefined
}

/** Mcp-Name 头的来源：tools/call、prompts/get 的 name，resources/read 的 uri */
export function mcpNameOf(method: string, params: Record<string, unknown> | undefined): string | undefined {
  const value = method === 'tools/call' || method === 'prompts/get'
    ? params?.name
    : method === 'resources/read'
      ? params?.uri
      : undefined
  return typeof value === 'string'
    ? value
    : undefined
}

/** inputSchema 中用 `x-mcp-header` 标注、需要镜像为 `Mcp-Param-{name}` 头的参数 */
export interface ParamHeader {
  name: string
  /** 从参数根开始的属性路径（只经过 properties） */
  path: string[]
}

const TOKEN = /^[!#$%&'*+\-.^`|~\w]+$/
const PRIMITIVE_TYPES = new Set(['string', 'integer', 'boolean'])
/** 这些关键字的值是数据而不是子 schema */
const DATA_KEYWORDS = new Set(['enum', 'const', 'default', 'examples'])

/** 统计 schema 中所有 x-mcp-header 标注（包括不合法位置上的） */
function countAnnotations(node: unknown, isPropertyMap = false): number {
  if (Array.isArray(node))
    return node.reduce((sum: number, item) => sum + countAnnotations(item), 0)
  if (!isObject(node))
    return 0
  let count = 0
  for (const [key, value] of Object.entries(node)) {
    if (isPropertyMap) {
      count += countAnnotations(value)
      continue
    }
    if (key === 'x-mcp-header')
      count++
    else if (!DATA_KEYWORDS.has(key))
      count += countAnnotations(value, key === 'properties')
  }
  return count
}

/**
 * 提取 inputSchema 中的 x-mcp-header 标注并校验约束（非空、token 字符、大小写不敏感唯一、
 * 只用于 string / integer / boolean，且只能经由 properties 到达）。不合法时返回错误说明。
 */
export function paramHeadersOf(schema: JSONSchema): { headers: ParamHeader[] } | { error: string } {
  const headers: ParamHeader[] = []
  const seen = new Set<string>()
  const walk = (node: Record<string, unknown>, path: string[]): string | undefined => {
    if (!isObject(node.properties))
      return undefined
    for (const [key, property] of Object.entries(node.properties)) {
      if (!isObject(property))
        continue
      if ('x-mcp-header' in property) {
        const name = property['x-mcp-header']
        if (typeof name !== 'string' || !TOKEN.test(name))
          return `invalid x-mcp-header value ${JSON.stringify(name)} on "${[...path, key].join('.')}"`
        if (seen.has(name.toLowerCase()))
          return `duplicate x-mcp-header "${name}"`
        if (typeof property.type !== 'string' || !PRIMITIVE_TYPES.has(property.type))
          return `x-mcp-header "${name}" must annotate a string, integer or boolean parameter`
        seen.add(name.toLowerCase())
        headers.push({
          name,
          path: [...path, key],
        })
      }
      const error = walk(property, [...path, key])
      if (error)
        return error
    }
    return undefined
  }
  const error = walk(schema, [])
  if (error)
    return { error }
  if (countAnnotations(schema) !== headers.length)
    return { error: 'x-mcp-header is only allowed on properties reachable through "properties" keywords' }
  return { headers }
}

/** 按路径取出参数值并转为头的值；没有值（或类型不符）时返回 undefined */
export function paramHeaderValue(args: unknown, path: string[]): string | undefined {
  let value: unknown = args
  for (const key of path) {
    value = isObject(value)
      ? value[key]
      : undefined
  }
  if (typeof value === 'string')
    return value
  if (typeof value === 'boolean')
    return String(value)
  if (typeof value === 'number' && Number.isSafeInteger(value))
    return String(value)
  return undefined
}
