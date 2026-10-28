import type { ProviderInstance, ProviderSettings } from '../provider'
import type { AssistantContentPart, EmbeddingModel, FinishReason, ImageModel, LanguageModel, ModelRequest, ModelResponse, ModelStreamPart, Usage } from '../types'
import type { OpenAIEndpoint } from './openai'
import type { ChatCompat } from './openai-chat'
import { detectMediaType, fromBase64, generatedFile } from '../data'
import { AIError } from '../errors'
import { compact, parseSSE, postBinary, safeParseJSON, toReadableStream } from '../http'
import { apiKeyLoader, createProvider, optionalEnv, withoutTrailingSlash } from '../provider'
import { openAIChatModel, openAIEmbeddingModel } from './openai'
import { mapChatUsage, toChatMessages } from './openai-chat'

/**
 * Workers 中的 `env.AI` 绑定（只用到 run）。
 * 参数类型放宽为 any，以便直接传入 @cloudflare/workers-types 的 Ai 对象。
 */
export interface WorkersAIBinding {
  run: (model: any, inputs: any, options?: any) => Promise<any>
}

/** AI Gateway：网关 ID，或绑定模式下 run 的 gateway 选项 */
export type WorkersAIGateway = string | { id: string, skipCache?: boolean, cacheTtl?: number }

export interface WorkersAISettings extends ProviderSettings {
  /** 账户 ID，省略时读取 CLOUDFLARE_ACCOUNT_ID（REST 模式） */
  accountId?: string
  /** API Token，省略时读取 CLOUDFLARE_API_TOKEN（REST 模式） */
  apiKey?: string
  /** Workers 中的 `env.AI`：传入后不走 REST，直接调用绑定 */
  binding?: WorkersAIBinding
  /** 经过 AI Gateway（REST 模式发送 cf-aig-gateway-id 请求头，绑定模式传给 run） */
  gateway?: WorkersAIGateway
  /** OpenAI 兼容接口地址，默认 `https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1` */
  baseURL?: string
}

/** Workers AI 的 OpenAI 兼容接口：max_tokens，JSON 模式（json_object + 提示） */
const COMPAT: ChatCompat = { maxTokensField: 'max_tokens', structuredOutput: 'json', reasoningEffort: false }

function gatewayId(gateway: WorkersAIGateway | undefined): string | undefined {
  return typeof gateway === 'string'
    ? gateway
    : gateway?.id
}

function randomId(): string {
  return `call_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`
}

// ---------------------------------------------------------------------------
// 绑定模式（env.AI.run）
// ---------------------------------------------------------------------------

/** 绑定模式的消息：OpenAI 形式，工具结果为 role tool 并带上工具名 */
function bindingMessages(request: ModelRequest): unknown[] {
  const names = new Map<string, string>()
  for (const message of request.messages) {
    if (message.role === 'tool') {
      for (const part of message.content)
        names.set(part.toolCallId, part.toolName)
    }
  }
  return toChatMessages(request.messages).map((message: any) => message.role === 'tool'
    ? {
        ...message,
        name: names.get(message.tool_call_id),
      }
    : message)
}

function bindingInputs(request: ModelRequest, stream: boolean): { inputs: Record<string, unknown>, warnings: string[] } {
  const warnings: string[] = []
  if (request.stopSequences?.length)
    warnings.push('stopSequences is not supported by Workers AI and was ignored')
  if (request.reasoning?.effort)
    warnings.push('reasoning.effort is not mapped for Workers AI; pass providerOptions.cloudflare')
  const tools = request.tools?.length && request.toolChoice !== 'none'
    ? request.tools
    : undefined
  if (tools && request.toolChoice && request.toolChoice !== 'auto')
    warnings.push('toolChoice is not supported by Workers AI and was ignored')
  let responseFormat: unknown
  if (request.responseFormat?.type === 'json') {
    if (stream) {
      warnings.push('JSON mode is not supported by Workers AI when streaming; responseFormat was ignored')
    }
    else {
      responseFormat = request.responseFormat.schema
        ? { type: 'json_schema', json_schema: request.responseFormat.schema }
        : { type: 'json_object' }
    }
  }
  const inputs = compact({
    messages: bindingMessages(request),
    tools: tools?.map(tool => compact({ name: tool.name, description: tool.description, parameters: tool.parameters })),
    max_tokens: request.maxOutputTokens,
    temperature: request.temperature,
    top_p: request.topP,
    top_k: request.topK,
    seed: request.seed,
    response_format: responseFormat,
    stream: stream || undefined,
    ...request.providerOptions?.cloudflare,
  })
  return { inputs, warnings }
}

function runOptions(gateway: WorkersAIGateway | undefined): Record<string, unknown> | undefined {
  if (!gateway)
    return undefined
  return {
    gateway: typeof gateway === 'string'
      ? { id: gateway }
      : gateway,
  }
}

/** 工具调用：`{ name, arguments }`（arguments 为对象）或 OpenAI 形式 `{ id, function: { name, arguments } }` */
function readToolCall(call: any): { id: string, name: string, input: string } {
  const name = call.function?.name ?? call.name ?? ''
  const args = call.function?.arguments ?? call.arguments ?? {}
  return {
    id: call.id ?? randomId(),
    name,
    input: typeof args === 'string'
      ? args
      : JSON.stringify(args),
  }
}

function textOf(value: unknown): string {
  // JSON 模式下 response 可能直接是对象
  if (value === undefined || value === null)
    return ''
  return typeof value === 'string'
    ? value
    : JSON.stringify(value)
}

function bindingLanguageModel(binding: WorkersAIBinding, modelId: string, gateway: WorkersAIGateway | undefined): LanguageModel {
  return {
    kind: 'language',
    provider: 'cloudflare',
    modelId,
    structuredOutput: 'json',

    async generate(request): Promise<ModelResponse> {
      const { inputs, warnings } = bindingInputs(request, false)
      const value = await binding.run(modelId, inputs, runOptions(gateway))
      // 新模型可能返回 OpenAI 形式的 choices
      const message = value?.choices?.[0]?.message
      const content: AssistantContentPart[] = []
      const reasoning = message?.reasoning_content ?? message?.reasoning ?? value?.reasoning_content
      if (typeof reasoning === 'string' && reasoning)
        content.push({ type: 'reasoning', text: reasoning })
      const text = textOf(message ? message.content : value?.response)
      if (text)
        content.push({ type: 'text', text })
      const calls = (message?.tool_calls ?? value?.tool_calls ?? []).map(readToolCall)
      for (const call of calls) {
        const parsed = safeParseJSON(call.input)
        content.push({
          type: 'tool-call',
          toolCallId: call.id,
          toolName: call.name,
          input: parsed.success ? parsed.value : call.input,
        })
      }
      const finish = value?.choices?.[0]?.finish_reason
      return {
        content,
        finishReason: calls.length
          ? 'tool-calls'
          : finish === 'length'
            ? 'length'
            : 'stop',
        usage: mapChatUsage(value?.usage),
        warnings,
      }
    },

    async stream(request) {
      const { inputs, warnings } = bindingInputs(request, true)
      const value = await binding.run(modelId, inputs, runOptions(gateway))
      if (!(value instanceof ReadableStream))
        throw new AIError('Workers AI binding did not return a stream')
      return toReadableStream(bindingStreamParts(value, warnings))
    },
  }
}

/** 绑定的流：SSE，`data: {"response":"..."}`，最后一块带 usage，以 [DONE] 结束 */
async function* bindingStreamParts(stream: ReadableStream<Uint8Array>, warnings: string[]): AsyncGenerator<ModelStreamPart> {
  for (const message of warnings)
    yield { type: 'warning', message }
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let finishReason: FinishReason = 'stop'
  const calls = new Map<number, { id: string, name: string, input: string }>()
  const complete: Array<{ id: string, name: string, input: string }> = []
  for await (const event of parseSSE(stream)) {
    if (event.data === '[DONE]')
      break
    const chunk = JSON.parse(event.data)
    if (chunk.usage)
      usage = mapChatUsage(chunk.usage)
    const delta = chunk.choices?.[0]?.delta
    if (chunk.choices?.[0]?.finish_reason === 'length')
      finishReason = 'length'
    const reasoning = delta?.reasoning_content ?? delta?.reasoning
    if (typeof reasoning === 'string' && reasoning)
      yield { type: 'reasoning-delta', text: reasoning }
    const text = delta
      ? delta.content
      : chunk.response
    if (typeof text === 'string' && text)
      yield { type: 'text-delta', text }
    // OpenAI 形式：按 index 增量拼接参数
    for (const toolDelta of delta?.tool_calls ?? []) {
      const index = toolDelta.index ?? 0
      let call = calls.get(index)
      if (!call) {
        call = { id: toolDelta.id ?? randomId(), name: toolDelta.function?.name ?? '', input: '' }
        calls.set(index, call)
        yield { type: 'tool-call-start', toolCallId: call.id, toolName: call.name }
      }
      const argumentsDelta = toolDelta.function?.arguments
      if (typeof argumentsDelta === 'string' && argumentsDelta) {
        call.input += argumentsDelta
        yield { type: 'tool-call-delta', toolCallId: call.id, inputDelta: argumentsDelta }
      }
    }
    // 旧模型：一次给出完整的 { name, arguments }
    if (!delta) {
      for (const raw of chunk.tool_calls ?? []) {
        const call = readToolCall(raw)
        complete.push(call)
        yield { type: 'tool-call-start', toolCallId: call.id, toolName: call.name }
      }
    }
  }
  for (const call of [
    ...calls.values(),
    ...complete,
  ]) {
    yield {
      type: 'tool-call',
      toolCallId: call.id,
      toolName: call.name,
      input: call.input,
    }
  }
  yield {
    type: 'finish',
    finishReason: calls.size || complete.length
      ? 'tool-calls'
      : finishReason,
    usage,
  }
}

function bindingEmbeddingModel(binding: WorkersAIBinding, modelId: string, gateway: WorkersAIGateway | undefined): EmbeddingModel {
  return {
    kind: 'embedding',
    provider: 'cloudflare',
    modelId,
    maxBatchSize: 100,
    async embed(request) {
      const value = await binding.run(modelId, { text: request.values, ...request.providerOptions?.cloudflare }, runOptions(gateway))
      return { embeddings: value?.data ?? [] }
    },
  }
}

/** 图像结果：`{ image: base64 }`（FLUX）或 PNG 字节流（Stable Diffusion） */
async function toImage(value: unknown): Promise<Uint8Array> {
  if (value instanceof ReadableStream)
    return new Uint8Array(await new Response(value).arrayBuffer())
  if (value instanceof Uint8Array)
    return value
  if (value instanceof ArrayBuffer)
    return new Uint8Array(value)
  const image = (value as { image?: string, result?: { image?: string } })?.image ?? (value as { result?: { image?: string } })?.result?.image
  if (typeof image !== 'string')
    throw new AIError('Workers AI did not return an image')
  return fromBase64(image)
}

function imageInputs(request: Parameters<ImageModel['generate']>[0]): { inputs: Record<string, unknown>, warnings: string[] } {
  const warnings: string[] = []
  if (request.n && request.n > 1)
    warnings.push('Workers AI image models generate one image per call')
  if (request.aspectRatio)
    warnings.push('aspectRatio is not supported by Workers AI image models; use size')
  const [width, height] = request.size?.split('x').map(Number) ?? []
  return {
    inputs: compact({
      prompt: request.prompt,
      width,
      height,
      seed: request.seed,
      ...request.providerOptions?.cloudflare,
    }),
    warnings,
  }
}

// ---------------------------------------------------------------------------
// REST 模式
// ---------------------------------------------------------------------------

function restImageModel(runURL: (modelId: string) => string, headers: () => Record<string, string | undefined>, modelId: string, fetch: ProviderSettings['fetch']): ImageModel {
  return {
    kind: 'image',
    provider: 'cloudflare',
    modelId,
    maxImagesPerCall: 1,
    async generate(request) {
      const { inputs, warnings } = imageInputs(request)
      const response = await postBinary({
        provider: 'cloudflare',
        url: runURL(modelId),
        headers: {
          ...headers(),
          ...request.headers,
        },
        body: inputs,
        signal: request.signal,
        fetch,
      })
      // JSON 包装 { result: { image } }，或直接返回图片字节
      const bytes = response.contentType?.includes('application/json')
        ? await toImage(JSON.parse(new TextDecoder().decode(response.bytes)))
        : response.bytes
      return {
        images: [
          generatedFile(bytes, detectMediaType(bytes) ?? 'image/png'),
        ],
        warnings,
        response: { headers: response.headers },
      }
    },
  }
}

/**
 * Cloudflare Workers AI：
 *
 * ```ts
 * // 任意环境：REST（CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN）
 * await generateText({ model: workersAI('@cf/meta/llama-3.3-70b-instruct-fp8-fast'), prompt })
 *
 * // Worker 内：直接使用 env.AI 绑定
 * const ai = createWorkersAI({ binding: env.AI })
 * await generateText({ model: ai('@cf/meta/llama-3.1-8b-instruct'), prompt })
 * ```
 */
export function createWorkersAI(settings: WorkersAISettings = {}): ProviderInstance {
  const { binding, gateway } = settings
  if (binding) {
    return createProvider('cloudflare', {
      languageModel: modelId => bindingLanguageModel(binding, modelId, gateway),
      embeddingModel: modelId => bindingEmbeddingModel(binding, modelId, gateway),
      imageModel: (modelId: string): ImageModel => ({
        kind: 'image',
        provider: 'cloudflare',
        modelId,
        maxImagesPerCall: 1,
        async generate(request) {
          const { inputs, warnings } = imageInputs(request)
          const bytes = await toImage(await binding.run(modelId, inputs, runOptions(gateway)))
          return {
            images: [
              generatedFile(bytes, detectMediaType(bytes) ?? 'image/png'),
            ],
            warnings,
          }
        },
      }),
    })
  }
  const apiKey = apiKeyLoader('Cloudflare Workers AI', settings.apiKey, 'CLOUDFLARE_API_TOKEN')
  // 地址在创建模型时确定
  const baseURL = (): string => {
    if (settings.baseURL)
      return withoutTrailingSlash(settings.baseURL)
    const accountId = settings.accountId ?? optionalEnv('CLOUDFLARE_ACCOUNT_ID')
    if (!accountId)
      throw new AIError('Cloudflare account ID is missing. Pass accountId or baseURL, or set CLOUDFLARE_ACCOUNT_ID.')
    return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`
  }
  const headers = (): Record<string, string | undefined> => ({
    'authorization': `Bearer ${apiKey()}`,
    'cf-aig-gateway-id': gatewayId(gateway),
    ...settings.headers,
  })
  const endpoint = (): OpenAIEndpoint => ({
    provider: 'cloudflare',
    baseURL: baseURL(),
    headers,
    fetch: settings.fetch,
  })
  // 原生接口：.../ai/run/{model}（模型名中的 @ 与 / 原样保留）
  const runURL = (modelId: string): string => `${baseURL().replace(/\/v1$/, '')}/run/${encodeURI(modelId)}`
  return createProvider('cloudflare', {
    languageModel: modelId => openAIChatModel(endpoint(), modelId, COMPAT),
    embeddingModel: modelId => openAIEmbeddingModel(endpoint(), modelId, 100),
    imageModel: modelId => restImageModel(runURL, headers, modelId, settings.fetch),
  })
}

/** 读取 CLOUDFLARE_ACCOUNT_ID 与 CLOUDFLARE_API_TOKEN 的默认实例（REST 模式） */
export const workersAI = createWorkersAI()
