import type { FetchFunction } from '../http'
import type { ProviderInstance, ProviderSettings } from '../provider'
import type { AssistantContentPart, FinishReason, JSONSchema, LanguageModel, Message, ModelRequest, ModelResponse, ModelStreamPart, ProviderMetadata, ProviderOptions, ToolChoice, Usage, UserContentPart } from '../types'
import { fromBase64, resolveData } from '../data'
import { AIError, APICallError, UnsupportedFeatureError } from '../errors'
import { compact, parseSSE, postJSON, postStream, safeParseJSON, toReadableStream } from '../http'
import { createProvider, optionalEnv, withoutTrailingSlash } from '../provider'

/** 发送的 API 版本：该版本对所有模型拒绝 temperature / top_p / top_k */
const API_VERSION = '2026-10-21'

/** 未设置 maxOutputTokens 时的默认值（max_tokens 必填）；流式允许更长的输出 */
const DEFAULT_MAX_TOKENS = 16000
const DEFAULT_STREAM_MAX_TOKENS = 64000

/** providerOptions.anthropic 中由适配器消费、不合并进请求体的键 */
const CONSUMED_OPTIONS = new Set(['betas', 'cacheControl'])

export interface AnthropicModelConfig {
  modelId: string
  url: string
  headers: () => Record<string, string | undefined>
  fetch?: FetchFunction
}

/** cacheControl: true | { ttl: '1h' } → cache_control */
function cacheControl(options: ProviderOptions | undefined): Record<string, unknown> | undefined {
  const value = options?.anthropic?.cacheControl
  if (!value)
    return undefined
  return compact({
    type: 'ephemeral',
    ttl: typeof value === 'object'
      ? (value as { ttl?: string }).ttl
      : undefined,
  })
}

/** 给内容块附加 cache_control（设置了 cacheControl 时） */
function withCache(block: Record<string, unknown>, options: ProviderOptions | undefined): Record<string, unknown> {
  const cache = cacheControl(options)
  return cache
    ? { ...block, cache_control: cache }
    : block
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop'
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length'
    case 'tool_use':
      return 'tool-calls'
    case 'refusal':
      return 'content-filter'
    default:
      return reason ? 'other' : 'stop'
  }
}

/** inputTokens 为总输入（未缓存 + 读缓存 + 写缓存），缓存部分另行列出 */
export function mapAnthropicUsage(usage: any): Usage {
  const cacheRead = usage?.cache_read_input_tokens ?? undefined
  const cacheWrite = usage?.cache_creation_input_tokens ?? undefined
  const input = (usage?.input_tokens ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0)
  const output = usage?.output_tokens ?? 0
  return compact({
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cachedInputTokens: cacheRead,
    cacheWriteInputTokens: cacheWrite,
  })
}

function userPart(part: UserContentPart): Record<string, unknown> {
  switch (part.type) {
    case 'text':
      return withCache({ type: 'text', text: part.text }, part.providerOptions)
    case 'image': {
      const data = resolveData(part.image, part.mediaType)
      return withCache({
        type: 'image',
        source: data.url
          ? { type: 'url', url: data.url }
          : { type: 'base64', media_type: data.mediaType ?? 'image/png', data: data.base64 },
      }, part.providerOptions)
    }
    case 'file': {
      const data = resolveData(part.data, part.mediaType)
      if (part.mediaType.startsWith('image/')) {
        return withCache({
          type: 'image',
          source: data.url
            ? { type: 'url', url: data.url }
            : { type: 'base64', media_type: part.mediaType, data: data.base64 },
        }, part.providerOptions)
      }
      if (part.mediaType === 'application/pdf') {
        return withCache(compact({
          type: 'document',
          source: data.url
            ? { type: 'url', url: data.url }
            : { type: 'base64', media_type: 'application/pdf', data: data.base64 },
          title: part.filename,
        }), part.providerOptions)
      }
      if (part.mediaType === 'text/plain') {
        if (data.url)
          throw new UnsupportedFeatureError('Plain text documents must be inline data, not a URL')
        const bytes = data.bytes ?? fromBase64(data.base64!)
        return withCache(compact({
          type: 'document',
          source: {
            type: 'text',
            media_type: 'text/plain',
            data: new TextDecoder().decode(bytes),
          },
          title: part.filename,
        }), part.providerOptions)
      }
      throw new UnsupportedFeatureError(`File type ${part.mediaType} is not supported by the Anthropic Messages API`)
    }
  }
}

/** 推理内容：带签名的 thinking、加密的 redacted_thinking；没有签名（来自其他厂商）的推理无法回传，丢弃 */
function reasoningBlock(text: string, metadata: ProviderMetadata | undefined): Record<string, unknown> | undefined {
  const anthropic = metadata?.anthropic
  if (typeof anthropic?.redactedData === 'string')
    return { type: 'redacted_thinking', data: anthropic.redactedData }
  if (typeof anthropic?.signature === 'string')
    return { type: 'thinking', thinking: text, signature: anthropic.signature }
  return undefined
}

function toolInput(input: unknown): unknown {
  if (typeof input !== 'string')
    return input ?? {}
  const parsed = safeParseJSON(input)
  return parsed.success
    ? parsed.value
    : {}
}

function toolOutput(output: unknown): string {
  return typeof output === 'string'
    ? output
    : JSON.stringify(output ?? null)
}

/** 把整条消息的 cacheControl 加到它的最后一个内容块上 */
function cacheLast(blocks: Record<string, unknown>[], options: ProviderOptions | undefined): Record<string, unknown>[] {
  const cache = cacheControl(options)
  if (!cache || !blocks.length)
    return blocks
  return [
    ...blocks.slice(0, -1),
    {
      ...blocks.at(-1),
      cache_control: cache,
    },
  ]
}

/**
 * 统一消息 → Anthropic Messages：system 消息提到顶层 system；工具结果放进 user 消息的 tool_result 块；
 * 相邻同角色的消息合并（API 要求 user / assistant 交替）。
 */
export function toAnthropicMessages(messages: Message[]): { system?: Record<string, unknown>[], messages: Array<{ role: 'user' | 'assistant', content: Record<string, unknown>[] }> } {
  const system: Record<string, unknown>[] = []
  const result: Array<{ role: 'user' | 'assistant', content: Record<string, unknown>[] }> = []
  const push = (role: 'user' | 'assistant', content: Record<string, unknown>[]): void => {
    if (!content.length)
      return
    const last = result.at(-1)
    if (last?.role === role)
      last.content.push(...content)
    else
      result.push({ role, content })
  }
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        system.push(withCache({ type: 'text', text: message.content }, message.providerOptions))
        break
      case 'user':
        push('user', cacheLast(typeof message.content === 'string'
          ? [
              { type: 'text', text: message.content },
            ]
          : message.content.map(userPart), message.providerOptions))
        break
      case 'assistant': {
        const parts: AssistantContentPart[] = typeof message.content === 'string'
          ? [
              { type: 'text', text: message.content },
            ]
          : message.content
        const blocks: Record<string, unknown>[] = []
        for (const part of parts) {
          if (part.type === 'text') {
            if (part.text)
              blocks.push(withCache({ type: 'text', text: part.text }, part.providerOptions))
          }
          else if (part.type === 'reasoning') {
            const block = reasoningBlock(part.text, part.providerMetadata)
            if (block)
              blocks.push(block)
          }
          else {
            blocks.push({
              type: 'tool_use',
              id: part.toolCallId,
              name: part.toolName,
              input: toolInput(part.input),
            })
          }
        }
        push('assistant', cacheLast(blocks, message.providerOptions))
        break
      }
      case 'tool':
        // 同一条工具消息的所有结果放在一个 user 回合
        push('user', message.content.map(part => compact({
          type: 'tool_result',
          tool_use_id: part.toolCallId,
          content: toolOutput(part.output),
          is_error: part.isError || undefined,
        })))
        break
    }
  }
  return {
    system: system.length
      ? system
      : undefined,
    messages: result,
  }
}

/** 结构化输出与 strict 工具要求每个对象都声明 additionalProperties: false，未声明时补上 */
function closeObjects(schema: unknown): unknown {
  if (Array.isArray(schema))
    return schema.map(closeObjects)
  if (typeof schema !== 'object' || schema === null)
    return schema
  const result: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(schema))
    result[key] = closeObjects(value)
  if (result.type === 'object' && result.properties && !('additionalProperties' in result))
    result.additionalProperties = false
  return result
}

function toolChoice(choice: ToolChoice | undefined): Record<string, unknown> | undefined {
  // 注意：Claude Opus 5.5、Sonnet 5.5、Fable 5.1 等较新的模型拒绝强制工具调用（any / tool 返回 400），
  // 这里仍按调用方的要求原样传递
  if (choice === undefined)
    return undefined
  if (typeof choice === 'object')
    return { type: 'tool', name: choice.toolName }
  return {
    type: choice === 'required'
      ? 'any'
      : choice,
  }
}

/** 构造请求体；不支持的参数记为警告 */
export function buildAnthropicBody(config: AnthropicModelConfig, request: ModelRequest, stream: boolean): { body: Record<string, unknown>, warnings: string[] } {
  const warnings: string[] = []
  // API 版本 2026-10-21 对所有模型拒绝采样参数（即使是默认值），不发送
  if (request.temperature !== undefined)
    warnings.push('temperature is not supported by the Anthropic API (version 2026-10-21) and was ignored')
  if (request.topP !== undefined)
    warnings.push('topP is not supported by the Anthropic API (version 2026-10-21) and was ignored')
  if (request.topK !== undefined)
    warnings.push('topK is not supported by the Anthropic API (version 2026-10-21) and was ignored')
  if (request.seed !== undefined)
    warnings.push('seed is not supported by the Anthropic API and was ignored')

  const options = request.providerOptions?.anthropic ?? {}
  const extra = Object.fromEntries(Object.entries(options).filter(([key]) => !CONSUMED_OPTIONS.has(key)))
  const { system, messages } = toAnthropicMessages(request.messages)

  const effort = request.reasoning?.effort
  const outputConfig = compact({
    effort: effort === 'minimal'
      ? 'low'
      : effort,
    format: request.responseFormat?.type === 'json' && request.responseFormat.schema
      ? {
          type: 'json_schema',
          schema: closeObjects(request.responseFormat.schema),
        }
      : undefined,
    // providerOptions.anthropic.output_config 与上面的字段合并，而不是整体覆盖
    ...(extra.output_config as Record<string, unknown> | undefined),
  })
  delete extra.output_config

  const body = compact({
    model: config.modelId,
    max_tokens: request.maxOutputTokens ?? (stream
      ? DEFAULT_STREAM_MAX_TOKENS
      : DEFAULT_MAX_TOKENS),
    system,
    messages,
    stop_sequences: request.stopSequences?.length ? request.stopSequences : undefined,
    // 自适应思考由 effort 控制深度；summary 时返回推理摘要（默认 display 为 omitted，thinking 文本为空）。不发送 budget_tokens
    thinking: request.reasoning?.summary
      ? { type: 'adaptive', display: 'summarized' }
      : undefined,
    output_config: Object.keys(outputConfig).length
      ? outputConfig
      : undefined,
    tools: request.tools?.map(tool => compact({
      name: tool.name,
      description: tool.description,
      input_schema: (tool.strict
        ? closeObjects(tool.parameters)
        : tool.parameters) as JSONSchema,
      strict: tool.strict,
    })),
    tool_choice: request.tools
      ? toolChoice(request.toolChoice)
      : undefined,
    // 自动缓存：顶层 cache_control，断点落在最后一个可缓存的块上
    cache_control: cacheControl(request.providerOptions),
    stream: stream || undefined,
    // 厂商专属参数直接合并进请求体（如 { anthropic: { metadata: { user_id }, service_tier: 'auto' } }）
    ...extra,
  })
  return { body, warnings }
}

function requestHeaders(config: AnthropicModelConfig, request: ModelRequest): Record<string, string | undefined> {
  const betas = request.providerOptions?.anthropic?.betas
  return {
    ...config.headers(),
    ...(Array.isArray(betas) && betas.length && {
      'anthropic-beta': betas.join(','),
    }),
    ...request.headers,
  }
}

function mapContent(blocks: any[] | undefined): AssistantContentPart[] {
  const content: AssistantContentPart[] = []
  for (const block of blocks ?? []) {
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', text: block.text })
        break
      case 'thinking':
        // thinking 文本可能为空（display 为 omitted），仍需保留以回传签名
        content.push({
          type: 'reasoning',
          text: block.thinking ?? '',
          providerMetadata: {
            anthropic: { signature: block.signature },
          },
        })
        break
      case 'redacted_thinking':
        content.push({
          type: 'reasoning',
          text: '',
          providerMetadata: {
            anthropic: { redactedData: block.data },
          },
        })
        break
      case 'tool_use':
        content.push({
          type: 'tool-call',
          toolCallId: block.id,
          toolName: block.name,
          input: block.input ?? {},
        })
        break
    }
  }
  return content
}

export function createAnthropicModel(config: AnthropicModelConfig): LanguageModel {
  return {
    kind: 'language',
    provider: 'anthropic',
    modelId: config.modelId,
    structuredOutput: 'native',

    async generate(request): Promise<ModelResponse> {
      const { body, warnings } = buildAnthropicBody(config, request, false)
      const { value, headers } = await postJSON({
        provider: 'anthropic',
        url: config.url,
        headers: requestHeaders(config, request),
        body,
        signal: request.signal,
        fetch: config.fetch,
      })
      return {
        content: mapContent(value.content),
        finishReason: mapFinishReason(value.stop_reason),
        usage: mapAnthropicUsage(value.usage),
        warnings,
        response: { id: value.id, modelId: value.model, headers },
        ...(value.stop_sequence && {
          providerMetadata: {
            anthropic: { stopSequence: value.stop_sequence },
          },
        }),
      }
    },

    async stream(request) {
      const { body, warnings } = buildAnthropicBody(config, request, true)
      const { body: stream } = await postStream({
        provider: 'anthropic',
        url: config.url,
        headers: requestHeaders(config, request),
        body,
        signal: request.signal,
        fetch: config.fetch,
      })
      return toReadableStream(anthropicStreamParts(stream, warnings, config.url))
    },
  }
}

interface StreamBlock {
  type: string
  id?: string
  name?: string
  /** tool_use 累积的 JSON 参数 */
  input: string
  signature?: string
}

async function* anthropicStreamParts(stream: ReadableStream<Uint8Array>, warnings: string[], url: string): AsyncGenerator<ModelStreamPart> {
  for (const message of warnings)
    yield { type: 'warning', message }
  const blocks = new Map<number, StreamBlock>()
  let rawUsage: Record<string, unknown> = {}
  let stopReason: string | undefined
  let stopSequence: string | undefined
  for await (const event of parseSSE(stream)) {
    const chunk = JSON.parse(event.data)
    switch (chunk.type ?? event.event) {
      case 'message_start':
        rawUsage = { ...chunk.message?.usage }
        yield { type: 'response-metadata', id: chunk.message?.id, modelId: chunk.message?.model }
        break
      case 'content_block_start': {
        const start = chunk.content_block ?? {}
        const block: StreamBlock = {
          type: start.type,
          id: start.id,
          name: start.name,
          input: '',
          signature: start.signature || undefined,
        }
        blocks.set(chunk.index, block)
        if (start.type === 'text' && start.text) {
          yield { type: 'text-delta', text: start.text }
        }
        else if (start.type === 'thinking' && start.thinking) {
          yield { type: 'reasoning-delta', text: start.thinking }
        }
        else if (start.type === 'redacted_thinking') {
          yield {
            type: 'reasoning-end',
            providerMetadata: {
              anthropic: { redactedData: start.data },
            },
          }
        }
        else if (start.type === 'tool_use') {
          // 起始块的 input 通常为 {}，参数随 input_json_delta 到达
          if (start.input && Object.keys(start.input).length)
            block.input = JSON.stringify(start.input)
          yield { type: 'tool-call-start', toolCallId: start.id, toolName: start.name }
        }
        break
      }
      case 'content_block_delta': {
        const block = blocks.get(chunk.index)
        const delta = chunk.delta ?? {}
        if (delta.type === 'text_delta') {
          if (delta.text)
            yield { type: 'text-delta', text: delta.text }
        }
        else if (delta.type === 'thinking_delta') {
          if (delta.thinking)
            yield { type: 'reasoning-delta', text: delta.thinking }
        }
        else if (delta.type === 'signature_delta') {
          if (block)
            block.signature = (block.signature ?? '') + delta.signature
        }
        else if (delta.type === 'input_json_delta' && block) {
          if (delta.partial_json) {
            block.input += delta.partial_json
            yield { type: 'tool-call-delta', toolCallId: block.id!, inputDelta: delta.partial_json }
          }
        }
        break
      }
      case 'content_block_stop': {
        const block = blocks.get(chunk.index)
        if (block?.type === 'thinking') {
          yield {
            type: 'reasoning-end',
            providerMetadata: {
              anthropic: { signature: block.signature ?? '' },
            },
          }
        }
        else if (block?.type === 'tool_use') {
          yield {
            type: 'tool-call',
            toolCallId: block.id!,
            toolName: block.name!,
            input: block.input || '{}',
          }
        }
        break
      }
      case 'message_delta':
        if (chunk.delta?.stop_reason)
          stopReason = chunk.delta.stop_reason
        if (chunk.delta?.stop_sequence)
          stopSequence = chunk.delta.stop_sequence
        // message_delta 中的用量是累计值，覆盖 message_start 中的同名字段
        rawUsage = {
          ...rawUsage,
          ...Object.fromEntries(Object.entries(chunk.usage ?? {}).filter(([, value]) => value !== null)),
        }
        break
      case 'error': {
        const error = chunk.error ?? {}
        yield {
          type: 'error',
          error: new APICallError({
            message: `anthropic stream error: ${error.message ?? JSON.stringify(error)}`,
            provider: 'anthropic',
            url,
            responseBody: event.data,
            isRetryable: error.type === 'overloaded_error' || error.type === 'api_error',
          }),
        }
        return
      }
      // ping、message_stop 无需处理
    }
  }
  yield {
    type: 'finish',
    finishReason: mapFinishReason(stopReason),
    usage: mapAnthropicUsage(rawUsage),
    ...(stopSequence && {
      providerMetadata: {
        anthropic: { stopSequence },
      },
    }),
  }
}

export interface AnthropicSettings extends ProviderSettings {
  /** 以 authorization: Bearer 鉴权（网关、OAuth 令牌）；省略时读取 ANTHROPIC_AUTH_TOKEN。与 apiKey 同时设置时 apiKey 优先 */
  authToken?: string
}

/**
 * Anthropic Claude：`anthropic('claude-opus-5-5')`。
 *
 * - `providerOptions.anthropic.cacheControl: true | { ttl: '1h' }`：请求级自动缓存；也可设置在单条消息或内容块上
 * - `providerOptions.anthropic.betas: ['...']`：anthropic-beta 请求头
 * - 其余 `providerOptions.anthropic` 字段原样合并进请求体
 */
export function createAnthropic(settings: AnthropicSettings = {}): ProviderInstance {
  const auth = (): Record<string, string> => {
    if (settings.apiKey)
      return { 'x-api-key': settings.apiKey }
    if (settings.authToken)
      return { authorization: `Bearer ${settings.authToken}` }
    const apiKey = optionalEnv('ANTHROPIC_API_KEY')
    if (apiKey)
      return { 'x-api-key': apiKey }
    const authToken = optionalEnv('ANTHROPIC_AUTH_TOKEN')
    if (authToken)
      return { authorization: `Bearer ${authToken}` }
    throw new AIError('Anthropic API key is missing. Pass apiKey or set ANTHROPIC_API_KEY.')
  }
  const url = `${withoutTrailingSlash(settings.baseURL ?? 'https://api.anthropic.com/v1')}/messages`
  return createProvider('anthropic', {
    languageModel: modelId => createAnthropicModel({
      modelId,
      url,
      headers: () => ({
        ...auth(),
        'anthropic-version': API_VERSION,
        ...settings.headers,
      }),
      fetch: settings.fetch,
    }),
  })
}

/** 读取 ANTHROPIC_API_KEY（或 ANTHROPIC_AUTH_TOKEN）的默认实例 */
export const anthropic = createAnthropic()
