import type { FetchFunction } from '../http'
import type { ProviderInstance, ProviderSettings } from '../provider'
import type { AssistantContentPart, EmbeddingModel, FinishReason, ImageModel, LanguageModel, Message, ModelRequest, ModelResponse, ModelStreamPart, ProviderMetadata, ProviderOptions, ReasoningEffort, Usage, UserContentPart } from '../types'
import { generatedFile, loadData } from '../data'
import { AIError, APICallError, UnsupportedFeatureError } from '../errors'
import { compact, postJSON, postStream, safeParseJSON, toReadableStream } from '../http'
import { createProvider, optionalEnv, withoutTrailingSlash } from '../provider'

// ---------------------------------------------------------------------------
// SigV4 签名（Web Crypto，Workers / Deno / Bun / Node 通用）
// ---------------------------------------------------------------------------

export interface AwsCredentials {
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
}

export interface SignRequestOptions {
  method: string
  url: string
  /** 需要一并签名的请求头（content-type 等）；host 与 x-amz-* 自动加入 */
  headers?: Record<string, string>
  body?: string
  credentials: AwsCredentials
  region: string
  service: string
  /** 签名时间，默认当前时间 */
  date?: Date
  /** 加上 x-amz-content-sha256 请求头并签名 */
  signContentSha256?: boolean
}

const encoder = new TextEncoder()

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), byte => byte.toString(16).padStart(2, '0')).join('')
}

async function sha256(data: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', encoder.encode(data)))
}

async function hmac(key: Uint8Array<ArrayBuffer> | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(data))
}

/** AWS 的 UriEncode：除 A-Z a-z 0-9 - _ . ~ 外全部按字节编码（大写十六进制） */
function uriEncode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
}

/** 20150830T123600Z */
function amzDate(date: Date): string {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '')
}

/** 规范请求（canonical request）：非 S3 服务的路径段需要再编码一次 */
export function canonicalRequest(method: string, url: URL, headers: Record<string, string>, payloadHash: string): { request: string, signedHeaders: string } {
  const path = url.pathname
    ? url.pathname.split('/').map(uriEncode).join('/')
    : '/'
  const query = [...url.searchParams]
    .map(([key, value]) => [
      uriEncode(key),
      uriEncode(value),
    ])
    .sort(([a, x], [b, y]) => a < b
      ? -1
      : a > b
        ? 1
        : x < y
          ? -1
          : x > y
            ? 1
            : 0)
    .map(([key, value]) => `${key}=${value}`)
    .join('&')
  const names = Object.keys(headers).sort()
  const canonicalHeaders = names.map(name => `${name}:${headers[name].trim().replace(/\s+/g, ' ')}\n`).join('')
  const signedHeaders = names.join(';')
  return {
    request: [
      method.toUpperCase(),
      path || '/',
      query,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n'),
    signedHeaders,
  }
}

/**
 * 计算 SigV4 签名，返回需要附加到请求上的头（authorization、x-amz-date 等）。
 * host 取自 URL（包含非默认端口），由 fetch 自动发送。
 */
export async function signAwsRequest(options: SignRequestOptions): Promise<Record<string, string>> {
  const url = new URL(options.url)
  const date = amzDate(options.date ?? new Date())
  const day = date.slice(0, 8)
  const payloadHash = await sha256(options.body ?? '')
  const added: Record<string, string> = { 'x-amz-date': date }
  if (options.signContentSha256)
    added['x-amz-content-sha256'] = payloadHash
  if (options.credentials.sessionToken)
    added['x-amz-security-token'] = options.credentials.sessionToken
  const signed: Record<string, string> = { host: url.host }
  for (const [key, value] of Object.entries({
    ...options.headers,
    ...added,
  }))
    signed[key.toLowerCase()] = value
  const { request, signedHeaders } = canonicalRequest(options.method, url, signed, payloadHash)
  const scope = `${day}/${options.region}/${options.service}/aws4_request`
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    date,
    scope,
    await sha256(request),
  ].join('\n')
  let key = await hmac(encoder.encode(`AWS4${options.credentials.secretAccessKey}`), day)
  for (const part of [options.region, options.service, 'aws4_request'])
    key = await hmac(key, part)
  const signature = hex(await hmac(key, stringToSign))
  return {
    ...added,
    authorization: `AWS4-HMAC-SHA256 Credential=${options.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

// ---------------------------------------------------------------------------
// application/vnd.amazon.eventstream 二进制帧解码
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index++) {
    let value = index
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1
        ? 0xEDB88320 ^ (value >>> 1)
        : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** CRC32（IEEE，与 zlib 相同） */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xFFFFFFFF
  for (const byte of bytes)
    crc = CRC_TABLE[(crc ^ byte) & 0xFF] ^ (crc >>> 8)
  return (crc ^ 0xFFFFFFFF) >>> 0
}

export type EventStreamHeaderValue = string | number | boolean | Uint8Array

export interface EventStreamMessage {
  headers: Record<string, EventStreamHeaderValue>
  payload: Uint8Array
}

const decoder = new TextDecoder()

function decodeHeaders(bytes: Uint8Array): Record<string, EventStreamHeaderValue> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headers: Record<string, EventStreamHeaderValue> = {}
  let offset = 0
  while (offset < bytes.length) {
    const nameLength = view.getUint8(offset)
    offset += 1
    const name = decoder.decode(bytes.subarray(offset, offset + nameLength))
    offset += nameLength
    const type = view.getUint8(offset)
    offset += 1
    switch (type) {
      case 0:
        headers[name] = true
        break
      case 1:
        headers[name] = false
        break
      case 2:
        headers[name] = view.getInt8(offset)
        offset += 1
        break
      case 3:
        headers[name] = view.getInt16(offset)
        offset += 2
        break
      case 4:
        headers[name] = view.getInt32(offset)
        offset += 4
        break
      // 5 int64、8 timestamp（毫秒）
      case 5:
      case 8:
        headers[name] = Number(view.getBigInt64(offset))
        offset += 8
        break
      // 6 字节、7 字符串：2 字节长度 + 内容
      case 6:
      case 7: {
        const length = view.getUint16(offset)
        offset += 2
        const value = bytes.subarray(offset, offset + length)
        headers[name] = type === 7
          ? decoder.decode(value)
          : value
        offset += length
        break
      }
      // 9 uuid：16 字节
      case 9:
        headers[name] = hex(bytes.slice(offset, offset + 16).buffer)
        offset += 16
        break
      default:
        throw new AIError(`Invalid event stream header type ${type}`)
    }
  }
  return headers
}

/** 解码一帧：前导（总长、头长、前导 CRC）+ 头 + 负载 + 消息 CRC */
function decodeMessage(bytes: Uint8Array): EventStreamMessage {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const totalLength = view.getUint32(0)
  const headersLength = view.getUint32(4)
  if (totalLength < 16 || headersLength > totalLength - 16)
    throw new AIError('Invalid event stream frame length')
  if (crc32(bytes.subarray(0, 8)) !== view.getUint32(8))
    throw new AIError('Event stream prelude checksum mismatch')
  if (crc32(bytes.subarray(0, totalLength - 4)) !== view.getUint32(totalLength - 4))
    throw new AIError('Event stream message checksum mismatch')
  return {
    headers: decodeHeaders(bytes.subarray(12, 12 + headersLength)),
    payload: bytes.subarray(12 + headersLength, totalLength - 4),
  }
}

/** 逐帧解析 AWS event stream（帧可能跨多个网络块） */
export async function* parseEventStream(stream: ReadableStream<Uint8Array>): AsyncGenerator<EventStreamMessage> {
  const reader = stream.getReader()
  let buffer = new Uint8Array(0)
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done)
        break
      const next = new Uint8Array(buffer.length + value.length)
      next.set(buffer)
      next.set(value, buffer.length)
      buffer = next
      while (buffer.length >= 12) {
        const totalLength = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength).getUint32(0)
        if (totalLength < 16)
          throw new AIError('Invalid event stream frame length')
        if (buffer.length < totalLength)
          break
        // 复制出独立的帧，避免后续缓冲区复用影响负载
        yield decodeMessage(buffer.slice(0, totalLength))
        buffer = buffer.slice(totalLength)
      }
    }
    if (buffer.length)
      throw new AIError('Event stream ended in the middle of a frame')
  }
  finally {
    reader.releaseLock()
  }
}

// ---------------------------------------------------------------------------
// Converse 协议
// ---------------------------------------------------------------------------

export interface BedrockSettings extends ProviderSettings {
  /** 区域，省略时读取 AWS_REGION / AWS_DEFAULT_REGION，默认 us-east-1 */
  region?: string
  /** 省略时读取 AWS_ACCESS_KEY_ID */
  accessKeyId?: string
  /** 省略时读取 AWS_SECRET_ACCESS_KEY */
  secretAccessKey?: string
  /** 临时凭证的会话令牌，省略时读取 AWS_SESSION_TOKEN */
  sessionToken?: string
  /** Bedrock API Key（Bearer 鉴权，优先于 SigV4），省略时读取 AWS_BEARER_TOKEN_BEDROCK */
  apiKey?: string
  /** 默认 `https://bedrock-runtime.{region}.amazonaws.com` */
  baseURL?: string
}

interface BedrockConnection {
  baseURL: () => string
  region: () => string
  /** 计算鉴权头（SigV4 需要请求体参与签名） */
  auth: (url: string, body: string) => Promise<Record<string, string>>
  headers?: Record<string, string>
  fetch?: FetchFunction
}

/** 发送 JSON 请求：鉴权头基于与 postJSON 相同的 JSON.stringify 结果签名 */
async function bedrockHeaders(connection: BedrockConnection, url: string, body: unknown, extra?: Record<string, string>): Promise<Record<string, string>> {
  return {
    ...connection.headers,
    ...extra,
    ...await connection.auth(url, JSON.stringify(body)),
  }
}

/** Converse 请求体顶层支持的字段，providerOptions.bedrock 中的其余字段放进 additionalModelRequestFields */
const CONVERSE_FIELDS = new Set([
  'additionalModelResponseFieldPaths',
  'guardrailConfig',
  'performanceConfig',
  'promptVariables',
  'requestMetadata',
  'serviceTier',
])

const IMAGE_FORMATS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/jpg': 'jpeg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

const DOCUMENT_FORMATS: Record<string, string> = {
  'application/pdf': 'pdf',
  'text/csv': 'csv',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'text/html': 'html',
  'text/plain': 'txt',
  'text/markdown': 'md',
}

/** 推理强度映射到旧版 Claude（4.5 及以前）的 thinking.budget_tokens */
/**
 * 旧版 Claude（3.x、4、4.1、4.5）只支持 budget_tokens；4.6 起使用自适应思考 + output_config.effort，
 * 当前模型（Opus 5.5、Sonnet 5.5 等）对 budget_tokens 返回 400
 */
const LEGACY_CLAUDE = /claude-3|claude-(?:opus|sonnet|haiku)-4-(?:\d{8}|[0-5](?:\D|$))/

const THINKING_BUDGET: Record<ReasoningEffort, number> = {
  minimal: 1024,
  low: 2048,
  medium: 8192,
  high: 16384,
  xhigh: 24576,
  max: 32000,
}

/** 文档名只允许字母数字、单个空白、连字符、圆括号与方括号 */
function documentName(filename: string | undefined, index: number): string {
  const name = (filename ?? '')
    .replace(/\.[^.]+$/, '')
    .replace(/[^\w\s\-()[\]]|_/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return name || `document-${index}`
}

function cachePoint(options?: ProviderOptions): unknown[] {
  return options?.bedrock?.cachePoint
    ? [
        {
          cachePoint: { type: 'default' },
        },
      ]
    : []
}

async function userBlock(part: UserContentPart, index: number, signal?: AbortSignal): Promise<unknown> {
  if (part.type === 'text')
    return { text: part.text }
  const source = part.type === 'image'
    ? part.image
    : part.data
  const data = await loadData(source, part.mediaType, signal)
  const mediaType = data.mediaType ?? (part.type === 'image'
    ? 'image/png'
    : 'application/octet-stream')
  if (IMAGE_FORMATS[mediaType]) {
    return {
      image: {
        format: IMAGE_FORMATS[mediaType],
        source: { bytes: data.base64 },
      },
    }
  }
  if (part.type === 'file' && DOCUMENT_FORMATS[mediaType]) {
    return {
      document: {
        format: DOCUMENT_FORMATS[mediaType],
        name: documentName(part.filename, index),
        source: { bytes: data.base64 },
      },
    }
  }
  throw new UnsupportedFeatureError(`File type ${mediaType} is not supported by the Bedrock Converse API`)
}

function toolResultContent(output: unknown): unknown[] {
  if (typeof output === 'string') {
    return [
      { text: output },
    ]
  }
  // json 块只接受对象，数组与原始值转成文本
  if (output !== null && typeof output === 'object' && !Array.isArray(output)) {
    return [
      { json: output },
    ]
  }
  return [
    {
      text: JSON.stringify(output ?? null),
    },
  ]
}

function assistantBlock(part: AssistantContentPart): unknown | undefined {
  switch (part.type) {
    case 'text':
      // Bedrock 拒绝空白文本块
      return part.text.trim()
        ? { text: part.text }
        : undefined
    case 'reasoning': {
      const metadata = part.providerMetadata?.bedrock
      if (typeof metadata?.redactedData === 'string') {
        return {
          reasoningContent: { redactedContent: metadata.redactedData },
        }
      }
      // 没有签名的推理（来自其他厂商）无法回传
      if (typeof metadata?.signature !== 'string')
        return undefined
      return {
        reasoningContent: {
          reasoningText: { text: part.text, signature: metadata.signature },
        },
      }
    }
    case 'tool-call': {
      const parsed = typeof part.input === 'string'
        ? safeParseJSON(part.input)
        : { success: true as const, value: part.input }
      return {
        toolUse: {
          toolUseId: part.toolCallId,
          name: part.toolName,
          input: (parsed.success ? parsed.value : undefined) ?? {},
        },
      }
    }
  }
}

/** 统一消息转为 Converse 的 system 与 messages（同角色的相邻消息合并，工具结果作为 user 消息） */
export async function toConverseMessages(messages: Message[], signal?: AbortSignal): Promise<{ system: unknown[], messages: Array<{ role: 'user' | 'assistant', content: unknown[] }> }> {
  const system: unknown[] = []
  const result: Array<{ role: 'user' | 'assistant', content: unknown[] }> = []
  let documents = 0
  const push = (role: 'user' | 'assistant', content: unknown[]): void => {
    const last = result.at(-1)
    if (last?.role === role)
      last.content.push(...content)
    else
      result.push({ role, content })
  }
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        system.push({ text: message.content }, ...cachePoint(message.providerOptions))
        break
      case 'user': {
        const parts: UserContentPart[] = typeof message.content === 'string'
          ? [
              { type: 'text', text: message.content },
            ]
          : message.content
        const blocks: unknown[] = []
        for (const part of parts)
          blocks.push(await userBlock(part, ++documents, signal))
        push('user', [
          ...blocks,
          ...cachePoint(message.providerOptions),
        ])
        break
      }
      case 'assistant': {
        const parts: AssistantContentPart[] = typeof message.content === 'string'
          ? [
              { type: 'text', text: message.content },
            ]
          : message.content
        const blocks = parts.map(assistantBlock).filter(block => block !== undefined)
        if (blocks.length) {
          push('assistant', [
            ...blocks,
            ...cachePoint(message.providerOptions),
          ])
        }
        break
      }
      case 'tool':
        push('user', message.content.map(part => ({
          toolResult: compact({
            toolUseId: part.toolCallId,
            content: toolResultContent(part.output),
            status: part.isError ? 'error' : undefined,
          }),
        })))
        break
    }
  }
  return { system, messages: result }
}

function hasToolBlocks(messages: Message[]): boolean {
  return messages.some(message => message.role === 'tool' || (message.role === 'assistant' && typeof message.content !== 'string' && message.content.some(part => part.type === 'tool-call')))
}

/** 构造 Converse 请求体；不支持的参数记为警告 */
export async function buildConverseBody(modelId: string, request: ModelRequest): Promise<{ body: Record<string, unknown>, warnings: string[] }> {
  const warnings: string[] = []
  const { system, messages } = await toConverseMessages(request.messages, request.signal)
  const options = { ...request.providerOptions?.bedrock }
  const topLevel: Record<string, unknown> = {}
  const additional: Record<string, unknown> = { ...options.additionalModelRequestFields as Record<string, unknown> | undefined }
  delete options.additionalModelRequestFields
  delete options.cachePoint
  for (const [key, value] of Object.entries(options)) {
    if (CONVERSE_FIELDS.has(key))
      topLevel[key] = value
    else
      additional[key] = value
  }
  if (request.seed !== undefined)
    warnings.push('seed is not supported by the Bedrock Converse API and was ignored')
  if (request.topK !== undefined)
    additional.top_k ??= request.topK

  let maxTokens = request.maxOutputTokens
  const effort = request.reasoning?.effort
  if (effort && !('thinking' in additional) && !('reasoningConfig' in additional) && !('reasoning_config' in additional)) {
    if (/anthropic\.claude/.test(modelId) && LEGACY_CLAUDE.test(modelId)) {
      // 旧版 Claude：thinking.budget_tokens 计入 maxTokens，需要相应增加
      const budget = THINKING_BUDGET[effort]
      additional.thinking = { type: 'enabled', budget_tokens: budget }
      maxTokens = (maxTokens ?? 4096) + budget
    }
    else if (/anthropic\.claude/.test(modelId)) {
      // Claude 4.6 及以后：自适应思考，用 effort 控制深度
      additional.thinking = {
        type: 'adaptive',
        ...(request.reasoning?.summary && { display: 'summarized' }),
      }
      additional.output_config = {
        effort: effort === 'minimal'
          ? 'low'
          : effort,
      }
    }
    else if (/amazon\.nova/.test(modelId)) {
      additional.reasoningConfig = {
        type: 'enabled',
        maxReasoningEffort: effort === 'minimal'
          ? 'low'
          : effort === 'xhigh' || effort === 'max'
            ? 'high'
            : effort,
      }
    }
    else {
      warnings.push('reasoning.effort is not mapped for this Bedrock model; pass providerOptions.bedrock.additionalModelRequestFields')
    }
  }

  let toolConfig: unknown
  const tools = request.tools?.length && request.toolChoice !== 'none'
    ? request.tools
    : undefined
  if (tools) {
    toolConfig = compact({
      tools: tools.map(tool => ({
        toolSpec: compact({
          name: tool.name,
          description: tool.description,
          inputSchema: { json: tool.parameters },
          strict: tool.strict,
        }),
      })),
      toolChoice: request.toolChoice === undefined || request.toolChoice === 'auto'
        ? (request.toolChoice
            ? { auto: {} }
            : undefined)
        : request.toolChoice === 'required'
          ? { any: {} }
          : {
              tool: { name: (request.toolChoice as { toolName: string }).toolName },
            },
    })
  }
  else if (request.tools?.length && hasToolBlocks(request.messages)) {
    // 历史中有 toolUse / toolResult 时 Converse 要求 toolConfig；Converse 没有 none 选项
    toolConfig = {
      tools: request.tools.map(tool => ({
        toolSpec: compact({
          name: tool.name,
          description: tool.description,
          inputSchema: { json: tool.parameters },
        }),
      })),
    }
    warnings.push('toolChoice "none" is not supported by the Bedrock Converse API; tools are still declared because the conversation contains tool calls')
  }

  let outputConfig: unknown
  if (request.responseFormat?.type === 'json' && request.responseFormat.schema) {
    // 原生结构化输出：schema 以字符串传递
    outputConfig = {
      textFormat: {
        type: 'json_schema',
        structure: {
          jsonSchema: compact({
            schema: JSON.stringify(request.responseFormat.schema),
            name: request.responseFormat.name,
            description: request.responseFormat.description,
          }),
        },
      },
    }
  }

  const inferenceConfig = compact({
    maxTokens,
    temperature: request.temperature,
    topP: request.topP,
    stopSequences: request.stopSequences?.length ? request.stopSequences : undefined,
  })
  const body = compact({
    messages,
    system: system.length ? system : undefined,
    inferenceConfig: Object.keys(inferenceConfig).length
      ? inferenceConfig
      : undefined,
    toolConfig,
    outputConfig,
    additionalModelRequestFields: Object.keys(additional).length
      ? additional
      : undefined,
    ...topLevel,
  })
  return { body, warnings }
}

function mapStopReason(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length'
    case 'tool_use':
      return 'tool-calls'
    case 'guardrail_intervened':
    case 'content_filtered':
      return 'content-filter'
    case 'malformed_model_output':
    case 'malformed_tool_use':
      return 'error'
    default:
      return reason ? 'other' : 'stop'
  }
}

/** Converse 的 inputTokens 不含缓存读写，这里按统一约定计入输入 */
export function mapConverseUsage(usage: any): Usage {
  const cacheRead = usage?.cacheReadInputTokens ?? 0
  const cacheWrite = usage?.cacheWriteInputTokens ?? 0
  const input = (usage?.inputTokens ?? 0) + cacheRead + cacheWrite
  const output = usage?.outputTokens ?? 0
  return compact({
    inputTokens: input,
    outputTokens: output,
    totalTokens: usage?.totalTokens ?? input + output,
    cachedInputTokens: usage?.cacheReadInputTokens,
    cacheWriteInputTokens: usage?.cacheWriteInputTokens,
  })
}

function responseMetadata(value: any): ProviderMetadata | undefined {
  return value?.additionalModelResponseFields
    ? {
        bedrock: { additionalModelResponseFields: value.additionalModelResponseFields },
      }
    : undefined
}

function modelPath(modelId: string, action: string): string {
  return `/model/${encodeURIComponent(modelId)}/${action}`
}

function bedrockLanguageModel(connection: BedrockConnection, modelId: string): LanguageModel {
  return {
    kind: 'language',
    provider: 'bedrock',
    modelId,
    // Converse 原生结构化输出只有部分模型支持，默认借工具调用
    structuredOutput: 'tool',

    async generate(request): Promise<ModelResponse> {
      const { body, warnings } = await buildConverseBody(modelId, request)
      const url = `${connection.baseURL()}${modelPath(modelId, 'converse')}`
      const { value, headers } = await postJSON({
        provider: 'bedrock',
        url,
        headers: await bedrockHeaders(connection, url, body, request.headers),
        body,
        signal: request.signal,
        fetch: connection.fetch,
      })
      const content: AssistantContentPart[] = []
      for (const block of value.output?.message?.content ?? []) {
        if (typeof block.text === 'string') {
          if (block.text)
            content.push({ type: 'text', text: block.text })
        }
        else if (block.reasoningContent) {
          const reasoning = block.reasoningContent
          if (reasoning.reasoningText) {
            content.push({
              type: 'reasoning',
              text: reasoning.reasoningText.text ?? '',
              ...(reasoning.reasoningText.signature && {
                providerMetadata: {
                  bedrock: { signature: reasoning.reasoningText.signature },
                },
              }),
            })
          }
          else if (reasoning.redactedContent) {
            content.push({
              type: 'reasoning',
              text: '',
              providerMetadata: {
                bedrock: { redactedData: reasoning.redactedContent },
              },
            })
          }
        }
        else if (block.toolUse) {
          content.push({
            type: 'tool-call',
            toolCallId: block.toolUse.toolUseId,
            toolName: block.toolUse.name,
            input: block.toolUse.input ?? {},
          })
        }
      }
      return {
        content,
        finishReason: mapStopReason(value.stopReason),
        usage: mapConverseUsage(value.usage),
        warnings,
        response: { headers },
        providerMetadata: responseMetadata(value),
      }
    },

    async stream(request) {
      const { body, warnings } = await buildConverseBody(modelId, request)
      const url = `${connection.baseURL()}${modelPath(modelId, 'converse-stream')}`
      const { body: stream } = await postStream({
        provider: 'bedrock',
        url,
        headers: await bedrockHeaders(connection, url, body, request.headers),
        body,
        signal: request.signal,
        fetch: connection.fetch,
      })
      return toReadableStream(converseStreamParts(stream, warnings, url))
    },
  }
}

const RETRYABLE_EXCEPTIONS = new Set([
  'throttlingException',
  'serviceUnavailableException',
  'internalServerException',
  'modelStreamErrorException',
  'modelNotReadyException',
])

/** 把 event stream 中的异常帧转为错误 */
function streamError(message: EventStreamMessage, url: string): APICallError {
  const type = String(message.headers[':exception-type'] ?? message.headers[':error-code'] ?? 'unknown')
  const body = decoder.decode(message.payload)
  const parsed = safeParseJSON(body)
  const payload = (parsed.success ? parsed.value : undefined) as { message?: string, Message?: string } | undefined
  const text = (message.headers[':error-message'] as string | undefined) ?? payload?.message ?? payload?.Message
  return new APICallError({
    message: `bedrock stream error ${type}: ${text ?? 'unknown error'}`,
    provider: 'bedrock',
    url,
    responseBody: body,
    isRetryable: RETRYABLE_EXCEPTIONS.has(type),
  })
}

interface StreamBlock {
  kind: 'text' | 'tool' | 'reasoning'
  id?: string
  name?: string
  input: string
  signature?: string
  redacted?: string
}

async function* converseStreamParts(stream: ReadableStream<Uint8Array>, warnings: string[], url: string): AsyncGenerator<ModelStreamPart> {
  for (const message of warnings)
    yield { type: 'warning', message }
  const blocks = new Map<number, StreamBlock>()
  let finishReason: FinishReason = 'stop'
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let providerMetadata: ProviderMetadata | undefined
  let hasToolCalls = false
  const closeBlock = function* (index: number): Generator<ModelStreamPart> {
    const block = blocks.get(index)
    if (!block)
      return
    blocks.delete(index)
    if (block.kind === 'tool') {
      hasToolCalls = true
      yield {
        type: 'tool-call',
        toolCallId: block.id!,
        toolName: block.name!,
        input: block.input || '{}',
      }
    }
    else if (block.kind === 'reasoning') {
      yield {
        type: 'reasoning-end',
        providerMetadata: block.signature
          ? {
              bedrock: { signature: block.signature },
            }
          : block.redacted
            ? {
                bedrock: { redactedData: block.redacted },
              }
            : undefined,
      }
    }
  }
  for await (const message of parseEventStream(stream)) {
    const messageType = message.headers[':message-type']
    if (messageType === 'exception' || messageType === 'error') {
      yield {
        type: 'error',
        error: streamError(message, url),
      }
      return
    }
    const eventType = message.headers[':event-type']
    const event = message.payload.length
      ? JSON.parse(decoder.decode(message.payload))
      : {}
    switch (eventType) {
      case 'contentBlockStart': {
        const toolUse = event.start?.toolUse
        if (toolUse) {
          blocks.set(event.contentBlockIndex ?? 0, {
            kind: 'tool',
            id: toolUse.toolUseId,
            name: toolUse.name,
            input: '',
          })
          yield { type: 'tool-call-start', toolCallId: toolUse.toolUseId, toolName: toolUse.name }
        }
        break
      }
      case 'contentBlockDelta': {
        const index = event.contentBlockIndex ?? 0
        const delta = event.delta ?? {}
        if (typeof delta.text === 'string') {
          if (!blocks.has(index))
            blocks.set(index, { kind: 'text', input: '' })
          if (delta.text)
            yield { type: 'text-delta', text: delta.text }
        }
        else if (delta.toolUse) {
          const block = blocks.get(index)
          const input = delta.toolUse.input ?? ''
          if (block?.kind === 'tool' && input) {
            block.input += input
            yield { type: 'tool-call-delta', toolCallId: block.id!, inputDelta: input }
          }
        }
        else if (delta.reasoningContent) {
          let block = blocks.get(index)
          if (!block) {
            block = { kind: 'reasoning', input: '' }
            blocks.set(index, block)
          }
          const reasoning = delta.reasoningContent
          if (typeof reasoning.text === 'string' && reasoning.text)
            yield { type: 'reasoning-delta', text: reasoning.text }
          if (typeof reasoning.signature === 'string')
            block.signature = (block.signature ?? '') + reasoning.signature
          if (typeof reasoning.redactedContent === 'string')
            block.redacted = (block.redacted ?? '') + reasoning.redactedContent
        }
        break
      }
      case 'contentBlockStop':
        yield* closeBlock(event.contentBlockIndex ?? 0)
        break
      case 'messageStop':
        finishReason = mapStopReason(event.stopReason)
        providerMetadata = responseMetadata(event)
        break
      case 'metadata':
        if (event.usage)
          usage = mapConverseUsage(event.usage)
        break
    }
  }
  // 没有收到 contentBlockStop 的块（异常截断）也要结束
  for (const index of [
    ...blocks.keys(),
  ])
    yield* closeBlock(index)
  yield {
    type: 'finish',
    finishReason: hasToolCalls && finishReason === 'stop'
      ? 'tool-calls'
      : finishReason,
    usage,
    ...(providerMetadata && { providerMetadata }),
  }
}

// ---------------------------------------------------------------------------
// Embedding 与图像（InvokeModel）
// ---------------------------------------------------------------------------

function bedrockEmbeddingModel(connection: BedrockConnection, modelId: string): EmbeddingModel {
  const cohere = /cohere\.embed/.test(modelId)
  return {
    kind: 'embedding',
    provider: 'bedrock',
    modelId,
    // Titan 每次只接受一条文本；Cohere 单次最多 96 条
    maxBatchSize: cohere ? 96 : 1,
    async embed(request) {
      const url = `${connection.baseURL()}${modelPath(modelId, 'invoke')}`
      const options = request.providerOptions?.bedrock
      if (cohere) {
        const body = compact({
          texts: request.values,
          input_type: 'search_document',
          output_dimension: request.dimensions,
          ...options,
        })
        const { value, headers } = await postJSON({
          provider: 'bedrock',
          url,
          headers: await bedrockHeaders(connection, url, body, request.headers),
          body,
          signal: request.signal,
          fetch: connection.fetch,
        })
        // embedding_types 设置后返回 { float: [...] }
        const embeddings = Array.isArray(value.embeddings)
          ? value.embeddings
          : value.embeddings?.float ?? []
        return {
          embeddings,
          response: { headers },
        }
      }
      if (request.values.length > 1)
        throw new AIError(`${modelId} embeds one value per call; use embedMany to batch`)
      const body = compact({
        inputText: request.values[0],
        dimensions: request.dimensions,
        // normalize 只有 Titan v2 接受
        normalize: /titan-embed-text-v2/.test(modelId)
          ? true
          : undefined,
        ...options,
      })
      const { value, headers } = await postJSON({
        provider: 'bedrock',
        url,
        headers: await bedrockHeaders(connection, url, body, request.headers),
        body,
        signal: request.signal,
        fetch: connection.fetch,
      })
      return {
        embeddings: [value.embedding ?? []],
        usage: value.inputTextTokenCount !== undefined
          ? { tokens: value.inputTextTokenCount }
          : undefined,
        response: { headers },
      }
    },
  }
}

/** Amazon Nova Canvas / Titan Image Generator */
function bedrockImageModel(connection: BedrockConnection, modelId: string): ImageModel {
  return {
    kind: 'image',
    provider: 'bedrock',
    modelId,
    maxImagesPerCall: 5,
    async generate(request) {
      const warnings: string[] = []
      if (request.aspectRatio)
        warnings.push('aspectRatio is not supported by Bedrock image models; use size')
      const [width, height] = request.size?.split('x').map(Number) ?? []
      const options = { ...request.providerOptions?.bedrock }
      const { imageGenerationConfig, textToImageParams, ...rest } = options as Record<string, Record<string, unknown> | undefined>
      const body = {
        taskType: 'TEXT_IMAGE',
        textToImageParams: { text: request.prompt, ...textToImageParams },
        imageGenerationConfig: compact({
          numberOfImages: request.n ?? 1,
          width,
          height,
          seed: request.seed,
          ...imageGenerationConfig,
        }),
        ...rest,
      }
      const url = `${connection.baseURL()}${modelPath(modelId, 'invoke')}`
      const { value, headers } = await postJSON({
        provider: 'bedrock',
        url,
        headers: await bedrockHeaders(connection, url, body, request.headers),
        body,
        signal: request.signal,
        fetch: connection.fetch,
      })
      if (value.error)
        throw new AIError(`bedrock image generation failed: ${value.error}`)
      return {
        images: (value.images ?? []).map((image: string) => generatedFile(image, 'image/png')),
        warnings,
        response: { headers },
      }
    },
  }
}

/**
 * Amazon Bedrock（Converse API，零依赖 SigV4 签名）：
 *
 * ```ts
 * const bedrock = createBedrock({ region: 'us-west-2' })
 * await generateText({ model: bedrock('us.anthropic.claude-sonnet-4-5-20250929-v1:0'), prompt })
 * await embedMany({ model: bedrock.embeddingModel('amazon.titan-embed-text-v2:0'), values })
 * ```
 *
 * 鉴权：设置了 Bedrock API Key（apiKey / AWS_BEARER_TOKEN_BEDROCK）时用 Bearer，否则用访问密钥做 SigV4 签名。
 * providerOptions.bedrock 中的 guardrailConfig、performanceConfig 等放在请求体顶层，其余字段
 * （如 `thinking`、`reasoningConfig`、`top_k`）放进 additionalModelRequestFields。
 */
export function createBedrock(settings: BedrockSettings = {}): ProviderInstance {
  const region = (): string => settings.region ?? optionalEnv('AWS_REGION') ?? optionalEnv('AWS_DEFAULT_REGION') ?? 'us-east-1'
  const connection: BedrockConnection = {
    region,
    baseURL: () => withoutTrailingSlash(settings.baseURL ?? `https://bedrock-runtime.${region()}.amazonaws.com`),
    headers: settings.headers,
    fetch: settings.fetch,
    async auth(url, body) {
      const apiKey = settings.apiKey ?? optionalEnv('AWS_BEARER_TOKEN_BEDROCK')
      if (apiKey)
        return { authorization: `Bearer ${apiKey}` }
      const accessKeyId = settings.accessKeyId ?? optionalEnv('AWS_ACCESS_KEY_ID')
      const secretAccessKey = settings.secretAccessKey ?? optionalEnv('AWS_SECRET_ACCESS_KEY')
      if (!accessKeyId || !secretAccessKey)
        throw new AIError('Bedrock credentials are missing. Pass apiKey or accessKeyId / secretAccessKey, or set AWS_BEARER_TOKEN_BEDROCK or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY.')
      return signAwsRequest({
        method: 'POST',
        url,
        headers: { 'content-type': 'application/json' },
        body,
        credentials: {
          accessKeyId,
          secretAccessKey,
          // 显式传入访问密钥时不混用环境变量里的会话令牌
          sessionToken: settings.accessKeyId
            ? settings.sessionToken
            : settings.sessionToken ?? optionalEnv('AWS_SESSION_TOKEN'),
        },
        region: region(),
        service: 'bedrock',
        signContentSha256: true,
      })
    },
  }
  return createProvider('bedrock', {
    languageModel: modelId => bedrockLanguageModel(connection, modelId),
    embeddingModel: modelId => bedrockEmbeddingModel(connection, modelId),
    imageModel: modelId => bedrockImageModel(connection, modelId),
  })
}

/** 读取 AWS_REGION、AWS_ACCESS_KEY_ID 等环境变量的默认实例 */
export const bedrock = createBedrock()
