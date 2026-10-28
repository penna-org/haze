import type { FetchFunction } from '../http'
import type { AssistantContentPart, FinishReason, LanguageModel, Message, ModelRequest, ModelResponse, ModelStreamPart, Usage, UserContentPart } from '../types'
import { resolveData } from '../data'
import { UnsupportedFeatureError } from '../errors'
import { compact, parseSSE, postJSON, postStream, safeParseJSON, toReadableStream } from '../http'

/**
 * OpenAI Chat Completions 协议的对话模型（OpenAI 与各兼容厂商共用）。
 * 兼容厂商之间的差异通过 ChatCompat 描述。
 */
export interface ChatCompat {
  /** 输出 token 上限的字段：OpenAI 为 max_completion_tokens，多数兼容厂商为 max_tokens */
  maxTokensField?: 'max_completion_tokens' | 'max_tokens'
  /** 推理内容的字段：reasoning_content（DeepSeek、Qwen、GLM 等）或 reasoning（OpenRouter、Groq、Ollama） */
  reasoningField?: 'reasoning_content' | 'reasoning'
  /** 多轮对话时把推理内容回传（DeepSeek 思考模式下的工具调用需要） */
  sendReasoning?: boolean
  /** 结构化输出：native（json_schema）或 json（json_object + 提示） */
  structuredOutput?: 'native' | 'json'
  /** 流式时请求返回用量（stream_options.include_usage），默认 true */
  streamUsage?: boolean
  /** 是否接受 reasoning_effort，默认 true */
  reasoningEffort?: boolean
  /** 系统消息的角色名，默认 system（OpenAI 推理模型也接受） */
  systemRole?: 'system' | 'developer'
}

export interface ChatModelConfig {
  provider: string
  modelId: string
  url: string
  headers: () => Record<string, string | undefined>
  fetch?: FetchFunction
  compat?: ChatCompat
}

function mapFinishReason(reason: string | null | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop'
    case 'length':
      return 'length'
    case 'tool_calls':
    case 'function_call':
      return 'tool-calls'
    case 'content_filter':
      return 'content-filter'
    default:
      return reason ? 'other' : 'stop'
  }
}

export function mapChatUsage(usage: any): Usage {
  const input = usage?.prompt_tokens ?? 0
  const output = usage?.completion_tokens ?? 0
  return compact({
    inputTokens: input,
    outputTokens: output,
    totalTokens: usage?.total_tokens ?? input + output,
    reasoningTokens: usage?.completion_tokens_details?.reasoning_tokens,
    cachedInputTokens: usage?.prompt_tokens_details?.cached_tokens ?? usage?.prompt_cache_hit_tokens,
  })
}

const AUDIO_FORMATS: Record<string, string> = {
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
}

function userPart(part: UserContentPart): unknown {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text }
    case 'image': {
      const data = resolveData(part.image, part.mediaType)
      return {
        type: 'image_url',
        image_url: {
          url: data.url ?? `data:${data.mediaType ?? 'image/png'};base64,${data.base64}`,
          ...(part.providerOptions?.openai?.imageDetail
            ? { detail: part.providerOptions.openai.imageDetail }
            : {}),
        },
      }
    }
    case 'file': {
      const data = resolveData(part.data, part.mediaType)
      if (part.mediaType.startsWith('image/')) {
        return {
          type: 'image_url',
          image_url: { url: data.url ?? `data:${part.mediaType};base64,${data.base64}` },
        }
      }
      if (AUDIO_FORMATS[part.mediaType]) {
        if (data.url)
          throw new UnsupportedFeatureError('Audio input must be inline data, not a URL')
        return {
          type: 'input_audio',
          input_audio: { data: data.base64, format: AUDIO_FORMATS[part.mediaType] },
        }
      }
      if (part.mediaType === 'application/pdf') {
        if (data.url)
          throw new UnsupportedFeatureError('PDF input must be inline data, not a URL')
        return {
          type: 'file',
          file: { filename: part.filename ?? 'document.pdf', file_data: `data:application/pdf;base64,${data.base64}` },
        }
      }
      throw new UnsupportedFeatureError(`File type ${part.mediaType} is not supported by the Chat Completions API`)
    }
  }
}

function toolOutput(output: unknown): string {
  return typeof output === 'string'
    ? output
    : JSON.stringify(output ?? null)
}

export function toChatMessages(messages: Message[], compat: ChatCompat = {}): unknown[] {
  const result: unknown[] = []
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        result.push({ role: compat.systemRole ?? 'system', content: message.content })
        break
      case 'user':
        result.push({
          role: 'user',
          content: typeof message.content === 'string'
            ? message.content
            : message.content.every(part => part.type === 'text')
              ? message.content.map(part => (part as { text: string }).text).join('')
              : message.content.map(userPart),
        })
        break
      case 'assistant': {
        if (typeof message.content === 'string') {
          result.push({ role: 'assistant', content: message.content })
          break
        }
        const text = message.content.filter(part => part.type === 'text').map(part => part.text).join('')
        const reasoning = message.content.filter(part => part.type === 'reasoning').map(part => part.text).join('')
        const toolCalls = message.content.filter(part => part.type === 'tool-call').map(part => ({
          id: part.toolCallId,
          type: 'function',
          function: {
            name: part.toolName,
            arguments: typeof part.input === 'string'
              ? part.input
              : JSON.stringify(part.input ?? {}),
          },
        }))
        result.push(compact({
          role: 'assistant',
          content: text || (toolCalls.length ? null : ''),
          tool_calls: toolCalls.length ? toolCalls : undefined,
          ...(compat.sendReasoning && reasoning && { [compat.reasoningField ?? 'reasoning_content']: reasoning }),
        }))
        break
      }
      case 'tool':
        for (const part of message.content) {
          result.push({
            role: 'tool',
            tool_call_id: part.toolCallId,
            content: toolOutput(part.output),
          })
        }
        break
    }
  }
  return result
}

/** 构造请求体；不支持的参数记为警告 */
export function buildChatBody(config: ChatModelConfig, request: ModelRequest, stream: boolean): { body: Record<string, unknown>, warnings: string[] } {
  const compat = config.compat ?? {}
  const warnings: string[] = []
  if (request.topK !== undefined)
    warnings.push('topK is not supported by the Chat Completions API and was ignored')
  let responseFormat: unknown
  if (request.responseFormat?.type === 'json') {
    responseFormat = request.responseFormat.schema && (compat.structuredOutput ?? 'native') === 'native'
      ? {
          type: 'json_schema',
          json_schema: compact({
            name: request.responseFormat.name ?? 'response',
            description: request.responseFormat.description,
            schema: request.responseFormat.schema,
            strict: request.providerOptions?.[config.provider]?.strictJsonSchema === true
              ? true
              : undefined,
          }),
        }
      : { type: 'json_object' }
  }
  const toolChoice = request.toolChoice === undefined
    ? undefined
    : typeof request.toolChoice === 'string'
      ? request.toolChoice
      : {
          type: 'function',
          function: { name: request.toolChoice.toolName },
        }
  const effort = request.reasoning?.effort
  const body = compact({
    model: config.modelId,
    messages: toChatMessages(request.messages, compat),
    [compat.maxTokensField ?? 'max_completion_tokens']: request.maxOutputTokens,
    temperature: request.temperature,
    top_p: request.topP,
    stop: request.stopSequences?.length ? request.stopSequences : undefined,
    seed: request.seed,
    response_format: responseFormat,
    tools: request.tools?.map(tool => ({
      type: 'function',
      function: compact({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        strict: tool.strict,
      }),
    })),
    tool_choice: request.tools ? toolChoice : undefined,
    reasoning_effort: effort && compat.reasoningEffort !== false
      ? (effort === 'max'
          ? 'xhigh'
          : effort)
      : undefined,
    stream: stream || undefined,
    stream_options: stream && compat.streamUsage !== false
      ? { include_usage: true }
      : undefined,
    // 厂商专属参数直接合并进请求体（如 { openai: { store: true, service_tier: 'flex' } }）
    ...request.providerOptions?.[config.provider],
  })
  delete body.strictJsonSchema
  return { body, warnings }
}

export function createChatModel(config: ChatModelConfig): LanguageModel {
  const compat = config.compat ?? {}
  const reasoningField = compat.reasoningField
  const readReasoning = (value: any): string | undefined => {
    const text = reasoningField
      ? value?.[reasoningField]
      : value?.reasoning_content ?? value?.reasoning
    return typeof text === 'string'
      ? text
      : undefined
  }
  return {
    kind: 'language',
    provider: config.provider,
    modelId: config.modelId,
    structuredOutput: compat.structuredOutput ?? 'native',

    async generate(request): Promise<ModelResponse> {
      const { body, warnings } = buildChatBody(config, request, false)
      const { value, headers } = await postJSON({
        provider: config.provider,
        url: config.url,
        headers: {
          ...config.headers(),
          ...request.headers,
        },
        body,
        signal: request.signal,
        fetch: config.fetch,
      })
      const choice = value.choices?.[0] ?? {}
      const message = choice.message ?? {}
      const content: AssistantContentPart[] = []
      const reasoning = readReasoning(message)
      if (reasoning)
        content.push({ type: 'reasoning', text: reasoning })
      if (typeof message.content === 'string' && message.content)
        content.push({ type: 'text', text: message.content })
      if (message.refusal)
        content.push({ type: 'text', text: message.refusal })
      for (const call of message.tool_calls ?? []) {
        const parsed = safeParseJSON(call.function?.arguments ?? '')
        content.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.function?.name,
          input: parsed.success ? parsed.value : call.function?.arguments,
        })
      }
      return {
        content,
        finishReason: message.refusal
          ? 'content-filter'
          : mapFinishReason(choice.finish_reason),
        usage: mapChatUsage(value.usage),
        warnings,
        response: { id: value.id, modelId: value.model, headers },
      }
    },

    async stream(request) {
      const { body, warnings } = buildChatBody(config, request, true)
      const { body: stream } = await postStream({
        provider: config.provider,
        url: config.url,
        headers: {
          ...config.headers(),
          ...request.headers,
        },
        body,
        signal: request.signal,
        fetch: config.fetch,
      })
      return toReadableStream(chatStreamParts(stream, warnings, readReasoning))
    },
  }
}

async function* chatStreamParts(stream: ReadableStream<Uint8Array>, warnings: string[], readReasoning: (value: any) => string | undefined): AsyncGenerator<ModelStreamPart> {
  for (const message of warnings)
    yield { type: 'warning', message }
  const calls = new Map<number, { id: string, name: string, input: string, started: boolean }>()
  let finishReason: FinishReason = 'stop'
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let metadataSent = false
  let refused = false
  for await (const event of parseSSE(stream)) {
    if (event.data === '[DONE]')
      break
    const chunk = JSON.parse(event.data)
    if (chunk.error) {
      yield {
        type: 'error',
        error: new Error(chunk.error.message ?? JSON.stringify(chunk.error)),
      }
      return
    }
    if (!metadataSent && (chunk.id || chunk.model)) {
      metadataSent = true
      yield { type: 'response-metadata', id: chunk.id, modelId: chunk.model }
    }
    if (chunk.usage)
      usage = mapChatUsage(chunk.usage)
    const choice = chunk.choices?.[0]
    if (!choice)
      continue
    const delta = choice.delta ?? {}
    const reasoning = readReasoning(delta)
    if (reasoning)
      yield { type: 'reasoning-delta', text: reasoning }
    if (typeof delta.content === 'string' && delta.content)
      yield { type: 'text-delta', text: delta.content }
    if (delta.refusal) {
      refused = true
      yield { type: 'text-delta', text: delta.refusal }
    }
    for (const toolDelta of delta.tool_calls ?? []) {
      const index = toolDelta.index ?? 0
      let call = calls.get(index)
      if (!call) {
        call = {
          id: toolDelta.id ?? `call_${index}`,
          name: toolDelta.function?.name ?? '',
          input: '',
          started: false,
        }
        calls.set(index, call)
      }
      if (toolDelta.id)
        call.id = toolDelta.id
      if (toolDelta.function?.name && !call.name)
        call.name = toolDelta.function.name
      if (!call.started && call.name) {
        call.started = true
        yield { type: 'tool-call-start', toolCallId: call.id, toolName: call.name }
      }
      const argumentsDelta = toolDelta.function?.arguments
      if (argumentsDelta) {
        call.input += argumentsDelta
        yield { type: 'tool-call-delta', toolCallId: call.id, inputDelta: argumentsDelta }
      }
    }
    if (choice.finish_reason)
      finishReason = mapFinishReason(choice.finish_reason)
  }
  for (const call of calls.values()) {
    yield {
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.name,
      input: call.input,
    }
  }
  yield {
    type: 'finish',
    finishReason: refused
      ? 'content-filter'
      : calls.size && finishReason === 'stop'
        ? 'tool-calls'
        : finishReason,
    usage,
  }
}
