import type { FetchFunction, RequestOptions } from '../http'
import type { ProviderInstance, ProviderSettings } from '../provider'
import type { AssistantContentPart, DataContent, EmbeddingModel, FinishReason, ImageModel, JSONSchema, LanguageModel, Message, ModelRequest, ModelResponse, ModelStreamPart, ProviderMetadata, ReasoningEffort, SpeechModel, ToolChoice, Usage, UserContentPart } from '../types'
import { fromBase64, generatedFile, resolveData } from '../data'
import { AIError } from '../errors'
import { compact, parseSSE, postJSON, postStream, safeParseJSON, toReadableStream } from '../http'
import { createProvider, optionalEnv, withoutTrailingSlash } from '../provider'

/**
 * Google Gemini API（Google AI Studio，generativelanguage.googleapis.com）。
 * 语音识别没有专门的接口：把音频作为 file 部分交给对话模型（generateContent）即可转写。
 */

/** Gemini 各类模型共用的连接 */
export interface GoogleEndpoint {
  provider: string
  baseURL: string
  headers: () => Record<string, string | undefined>
  fetch?: FetchFunction
}

/** 适配器生成的工具调用 ID 的前缀（API 未返回 ID 时），这类 ID 不回传给 API */
const GENERATED_ID_PREFIX = 'google-call-'

/** providerOptions.google 中属于 generationConfig 的键（其余合并到请求体顶层） */
const GENERATION_CONFIG_KEYS = new Set([
  'candidateCount',
  'presencePenalty',
  'frequencyPenalty',
  'responseLogprobs',
  'logprobs',
  'responseModalities',
  'responseFormat',
  'speechConfig',
  'imageConfig',
  'mediaResolution',
  'enableEnhancedCivicAnswers',
  'enableAffectiveDialog',
])

/** Gemini 3 及以后的 thinkingLevel（不支持 xhigh / max，就近取 high） */
const THINKING_LEVELS: Record<ReasoningEffort, string> = {
  minimal: 'minimal',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
  max: 'high',
}

function modelPath(modelId: string): string {
  // 已带资源前缀（models/…、tunedModels/…）时原样使用
  return modelId.includes('/')
    ? modelId
    : `models/${modelId}`
}

function endpointUrl(endpoint: GoogleEndpoint, modelId: string, method: string): string {
  return `${endpoint.baseURL}/${modelPath(modelId)}:${method}`
}

function generateId(): string {
  return `${GENERATED_ID_PREFIX}${crypto.randomUUID()}`
}

function signatureOf(metadata: ProviderMetadata | undefined): string | undefined {
  const value = metadata?.google?.thoughtSignature
  return typeof value === 'string'
    ? value
    : undefined
}

function signatureMetadata(signature: unknown): ProviderMetadata | undefined {
  return typeof signature === 'string' && signature
    ? {
        google: { thoughtSignature: signature },
      }
    : undefined
}

/** 思考签名必须放回收到它的那个部分 */
function withSignature(part: Record<string, unknown>, signature: string | undefined): Record<string, unknown> {
  return signature
    ? { ...part, thoughtSignature: signature }
    : part
}

/** 去掉顶层的 $schema（responseJsonSchema / parametersJsonSchema 不在支持的关键字之列） */
function cleanSchema(schema: JSONSchema): JSONSchema {
  const { $schema: _, ...rest } = schema
  return rest
}

const EXTENSION_TYPES: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  pdf: 'application/pdf',
  txt: 'text/plain',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  aac: 'audio/aac',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
}

/** fileData 必须带 mimeType：未给出时按扩展名推断 */
function mediaTypeOfUrl(url: string, fallback: string): string {
  const extension = /\.([a-z0-9]+)(?:[?#]|$)/i.exec(url)?.[1]?.toLowerCase()
  return (extension && EXTENSION_TYPES[extension]) || fallback
}

/** 二进制输入：https / gs URL 用 fileData（由 Google 拉取），其余用 inlineData（base64） */
function dataPart(data: DataContent, mediaType: string | undefined, fallback: string): Record<string, unknown> {
  const href = data instanceof URL
    ? data.href
    : data
  if (typeof href === 'string' && /^gs:\/\//i.test(href)) {
    return {
      fileData: { mimeType: mediaType ?? mediaTypeOfUrl(href, fallback), fileUri: href },
    }
  }
  const resolved = resolveData(data, mediaType)
  if (resolved.url) {
    return {
      fileData: { mimeType: resolved.mediaType ?? mediaTypeOfUrl(resolved.url, fallback), fileUri: resolved.url },
    }
  }
  return {
    inlineData: { mimeType: resolved.mediaType ?? fallback, data: resolved.base64 },
  }
}

function userPart(part: UserContentPart): Record<string, unknown> | undefined {
  switch (part.type) {
    case 'text':
      return part.text
        ? { text: part.text }
        : undefined
    case 'image':
      return dataPart(part.image, part.mediaType, 'image/png')
    case 'file':
      return dataPart(part.data, part.mediaType, part.mediaType)
  }
}

/** functionResponse.response 必须是对象：其他值包装为 { result }（出错时 { error }） */
function toolResponse(output: unknown, isError: boolean | undefined): Record<string, unknown> {
  if (typeof output === 'object' && output !== null && !Array.isArray(output))
    return output as Record<string, unknown>
  return isError
    ? { error: output ?? null }
    : { result: output ?? null }
}

function toolArgs(input: unknown): unknown {
  if (typeof input === 'string') {
    const parsed = safeParseJSON(input)
    return parsed.success && typeof parsed.value === 'object' && parsed.value !== null
      ? parsed.value
      : {}
  }
  return input ?? {}
}

function callId(toolCallId: string): string | undefined {
  return toolCallId.startsWith(GENERATED_ID_PREFIX)
    ? undefined
    : toolCallId
}

interface GoogleContent {
  role: 'user' | 'model'
  parts: Record<string, unknown>[]
}

/** 消息转换为 systemInstruction + contents（相邻的同角色消息合并为一轮） */
export function toGoogleContents(messages: Message[]): { systemInstruction?: { parts: Array<{ text: string }> }, contents: GoogleContent[] } {
  const system: Array<{ text: string }> = []
  const contents: GoogleContent[] = []
  const push = (role: GoogleContent['role'], parts: Array<Record<string, unknown> | undefined>): void => {
    const filtered = parts.filter(Boolean) as Record<string, unknown>[]
    if (!filtered.length)
      return
    const last = contents.at(-1)
    if (last?.role === role)
      last.parts.push(...filtered)
    else
      contents.push({ role, parts: filtered })
  }
  for (const message of messages) {
    switch (message.role) {
      case 'system':
        if (message.content)
          system.push({ text: message.content })
        break
      case 'user':
        push('user', typeof message.content === 'string'
          ? [
              message.content
                ? { text: message.content }
                : undefined,
            ]
          : message.content.map(userPart))
        break
      case 'assistant': {
        if (typeof message.content === 'string') {
          push('model', [
            message.content
              ? { text: message.content }
              : undefined,
          ])
          break
        }
        push('model', message.content.map((part) => {
          switch (part.type) {
            case 'text': {
              // TextPart 类型上没有 providerMetadata，generate() 仍会把签名放在这里
              const signature = signatureOf((part as { providerMetadata?: ProviderMetadata }).providerMetadata)
              return part.text || signature
                ? withSignature({ text: part.text }, signature)
                : undefined
            }
            case 'reasoning': {
              const signature = signatureOf(part.providerMetadata)
              if (part.text)
                return withSignature({ text: part.text, thought: true }, signature)
              // 只有签名的空部分（流式时文本部分上的签名，见 streamParts）
              return signature
                ? { text: '', thoughtSignature: signature }
                : undefined
            }
            case 'tool-call':
              return withSignature({
                functionCall: compact({
                  id: callId(part.toolCallId),
                  name: part.toolName,
                  args: toolArgs(part.input),
                }),
              }, signatureOf(part.providerMetadata))
            default:
              return undefined
          }
        }))
        break
      }
      case 'tool':
        // 工具结果放在 user 轮次里，顺序与调用一致（FC1, FC2 → FR1, FR2）
        push('user', message.content.map(part => ({
          functionResponse: compact({
            id: callId(part.toolCallId),
            name: part.toolName,
            response: toolResponse(part.output, part.isError),
          }),
        })))
        break
    }
  }
  return {
    systemInstruction: system.length
      ? { parts: system }
      : undefined,
    contents,
  }
}

function toolConfig(choice: ToolChoice | undefined): Record<string, unknown> | undefined {
  if (choice === undefined)
    return undefined
  if (typeof choice === 'object') {
    return {
      functionCallingConfig: {
        mode: 'ANY',
        allowedFunctionNames: [choice.toolName],
      },
    }
  }
  return {
    functionCallingConfig: {
      mode: choice === 'required'
        ? 'ANY'
        : choice === 'none'
          ? 'NONE'
          : 'AUTO',
    },
  }
}

/** Gemini 1.x / 2.x 用 thinkingBudget，Gemini 3 及以后用 thinkingLevel（两者不能同时设置） */
function usesThinkingBudget(modelId: string): boolean {
  return /gemini-[12]\./.test(modelId)
}

/** 2.5 系列的思考预算：Pro 不能关闭（128 ~ 32768），Flash / Flash-Lite 上限 24576 */
function thinkingBudget(modelId: string, effort: ReasoningEffort): number {
  const pro = /pro/.test(modelId)
  switch (effort) {
    case 'minimal':
      return pro ? 128 : 0
    case 'low':
      return 1024
    case 'medium':
      return 8192
    case 'high':
      return 16384
    default:
      return pro ? 32768 : 24576
  }
}

function thinkingConfig(modelId: string, reasoning: ModelRequest['reasoning']): Record<string, unknown> | undefined {
  const effort = reasoning?.effort
  if (!effort && !reasoning?.summary)
    return undefined
  const budget = usesThinkingBudget(modelId)
  return compact({
    includeThoughts: reasoning?.summary
      ? true
      : undefined,
    thinkingLevel: effort && !budget
      ? THINKING_LEVELS[effort]
      : undefined,
    thinkingBudget: effort && budget
      ? thinkingBudget(modelId, effort)
      : undefined,
  })
}

/**
 * 合并 providerOptions.google：generationConfig 的字段（含 thinkingConfig）合并进 generationConfig，
 * tools 追加在函数声明之后（如 { googleSearch: {} }），其余（safetySettings、cachedContent 等）合并到顶层。
 */
function mergeOptions(body: Record<string, unknown>, options: Record<string, unknown> | undefined): Record<string, unknown> {
  const result = { ...body }
  const generationConfig: Record<string, unknown> = { ...body.generationConfig as Record<string, unknown> | undefined }
  for (const [key, value] of Object.entries(options ?? {})) {
    if (key === 'generationConfig') {
      Object.assign(generationConfig, value)
    }
    else if (key === 'thinkingConfig') {
      generationConfig.thinkingConfig = {
        ...generationConfig.thinkingConfig as object | undefined,
        ...value as object,
      }
    }
    else if (GENERATION_CONFIG_KEYS.has(key)) {
      generationConfig[key] = value
    }
    else if (key === 'tools' && Array.isArray(value)) {
      result.tools = [
        ...(result.tools as unknown[] | undefined ?? []),
        ...value,
      ]
    }
    else {
      result[key] = value
    }
  }
  result.generationConfig = Object.keys(generationConfig).length
    ? generationConfig
    : undefined
  return compact(result)
}

/** 构造 generateContent 请求体 */
export function buildGoogleBody(modelId: string, request: ModelRequest): { body: Record<string, unknown>, warnings: string[] } {
  const warnings: string[] = []
  const { systemInstruction, contents } = toGoogleContents(request.messages)
  const json = request.responseFormat?.type === 'json'
    ? request.responseFormat
    : undefined
  const tools = request.tools?.length
    ? [
        {
          functionDeclarations: request.tools.map(tool => compact({
            name: tool.name,
            description: tool.description,
            // parametersJsonSchema 接受完整的 JSON Schema（parameters 只接受 OpenAPI 子集）
            parametersJsonSchema: cleanSchema(tool.parameters),
          })),
        },
      ]
    : undefined
  const body = compact({
    systemInstruction,
    contents,
    tools,
    toolConfig: tools
      ? toolConfig(request.toolChoice)
      : undefined,
    generationConfig: compact({
      maxOutputTokens: request.maxOutputTokens,
      temperature: request.temperature,
      topP: request.topP,
      topK: request.topK,
      stopSequences: request.stopSequences?.length
        ? request.stopSequences
        : undefined,
      seed: request.seed,
      responseMimeType: json
        ? 'application/json'
        : undefined,
      responseJsonSchema: json?.schema
        ? cleanSchema(json.schema)
        : undefined,
      thinkingConfig: thinkingConfig(modelId, request.reasoning),
    }),
  })
  return {
    body: mergeOptions(body, request.providerOptions?.google),
    warnings,
  }
}

function mapFinishReason(reason: string | undefined, hasToolCalls: boolean): FinishReason {
  switch (reason) {
    case 'STOP':
    case undefined:
      return hasToolCalls
        ? 'tool-calls'
        : reason
          ? 'stop'
          : 'other'
    case 'MAX_TOKENS':
      return 'length'
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
    case 'IMAGE_PROHIBITED_CONTENT':
    case 'IMAGE_RECITATION':
      return 'content-filter'
    default:
      return 'other'
  }
}

/** thoughtsTokenCount 不在 candidatesTokenCount 中，合计为输出 token */
export function mapGoogleUsage(usage: any): Usage {
  const input = (usage?.promptTokenCount ?? 0) + (usage?.toolUsePromptTokenCount ?? 0)
  const thoughts = usage?.thoughtsTokenCount
  const output = (usage?.candidatesTokenCount ?? 0) + (thoughts ?? 0)
  return compact({
    inputTokens: input,
    outputTokens: output,
    totalTokens: usage?.totalTokenCount ?? input + output,
    reasoningTokens: thoughts,
    cachedInputTokens: usage?.cachedContentTokenCount,
  })
}

/** 安全评级、检索来源等放进 providerMetadata.google */
function responseMetadata(value: any): ProviderMetadata | undefined {
  const candidate = value?.candidates?.[0]
  const google = compact({
    promptFeedback: value?.promptFeedback,
    safetyRatings: candidate?.safetyRatings,
    groundingMetadata: candidate?.groundingMetadata,
    urlContextMetadata: candidate?.urlContextMetadata,
  })
  return Object.keys(google).length
    ? { google }
    : undefined
}

/** 响应的 parts 转换为统一内容；相邻的同类文本合并，带签名的部分单独保留 */
function contentOf(parts: any[]): AssistantContentPart[] {
  const content: AssistantContentPart[] = []
  for (const part of parts) {
    const providerMetadata = signatureMetadata(part.thoughtSignature)
    if (part.functionCall) {
      content.push({
        type: 'tool-call',
        toolCallId: part.functionCall.id ?? generateId(),
        toolName: part.functionCall.name,
        input: part.functionCall.args ?? {},
        ...(providerMetadata && { providerMetadata }),
      })
      continue
    }
    if (typeof part.text !== 'string' || (!part.text && !providerMetadata))
      continue
    const type = part.thought
      ? 'reasoning'
      : 'text'
    const last = content.at(-1) as (AssistantContentPart & { providerMetadata?: ProviderMetadata }) | undefined
    if (last?.type === type && !last.providerMetadata) {
      last.text += part.text
      if (providerMetadata)
        last.providerMetadata = providerMetadata
      continue
    }
    // 文本部分的签名：TextPart 类型上没有 providerMetadata，这里仍然附加，回传时读取
    content.push({
      type,
      text: part.text,
      ...(providerMetadata && { providerMetadata }),
    } as AssistantContentPart)
  }
  return content
}

export function googleLanguageModel(endpoint: GoogleEndpoint, modelId: string): LanguageModel {
  const request = (path: string, body: Record<string, unknown>, options: ModelRequest): RequestOptions & { body: unknown } => ({
    provider: endpoint.provider,
    url: endpointUrl(endpoint, modelId, path),
    headers: {
      ...endpoint.headers(),
      ...options.headers,
    },
    body,
    signal: options.signal,
    fetch: endpoint.fetch,
  })
  return {
    kind: 'language',
    provider: endpoint.provider,
    modelId,
    structuredOutput: 'native',

    async generate(options): Promise<ModelResponse> {
      const { body, warnings } = buildGoogleBody(modelId, options)
      const { value, headers } = await postJSON(request('generateContent', body, options))
      const candidate = value.candidates?.[0]
      const content = contentOf(candidate?.content?.parts ?? [])
      const blocked = !candidate && value.promptFeedback?.blockReason
      return {
        content,
        finishReason: blocked
          ? 'content-filter'
          : mapFinishReason(candidate?.finishReason, content.some(part => part.type === 'tool-call')),
        usage: mapGoogleUsage(value.usageMetadata),
        warnings,
        providerMetadata: responseMetadata(value),
        response: { id: value.responseId, modelId: value.modelVersion, headers },
      }
    },

    async stream(options) {
      const { body, warnings } = buildGoogleBody(modelId, options)
      const { body: stream } = await postStream(request('streamGenerateContent?alt=sse', body, options))
      return toReadableStream(streamParts(stream, warnings))
    },
  }
}

/**
 * 每个 SSE 事件都是完整的 GenerateContentResponse，parts 为增量；函数调用总是整个到达。
 * 文本部分上的签名（常见于最后一个空文本部分）没有对应的流事件，借 reasoning-end 记录为只含签名的空推理部分，
 * 回传时还原为 { text: '', thoughtSignature }。
 */
async function* streamParts(stream: ReadableStream<Uint8Array>, warnings: string[]): AsyncGenerator<ModelStreamPart> {
  for (const message of warnings)
    yield { type: 'warning', message }
  let finishReason: string | undefined
  let usage: Usage = { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  let metadataSent = false
  let hasToolCalls = false
  let blocked = false
  let reasoningOpen = false
  let last: any
  for await (const event of parseSSE(stream)) {
    const chunk = JSON.parse(event.data)
    if (chunk.error) {
      yield {
        type: 'error',
        error: new Error(chunk.error.message ?? JSON.stringify(chunk.error)),
      }
      return
    }
    last = chunk
    if (!metadataSent && (chunk.responseId || chunk.modelVersion)) {
      metadataSent = true
      yield { type: 'response-metadata', id: chunk.responseId, modelId: chunk.modelVersion }
    }
    if (chunk.usageMetadata)
      usage = mapGoogleUsage(chunk.usageMetadata)
    if (chunk.promptFeedback?.blockReason)
      blocked = true
    const candidate = chunk.candidates?.[0]
    for (const part of candidate?.content?.parts ?? []) {
      const providerMetadata = signatureMetadata(part.thoughtSignature)
      if (part.functionCall) {
        if (reasoningOpen) {
          reasoningOpen = false
          yield { type: 'reasoning-end' }
        }
        hasToolCalls = true
        const toolCallId = part.functionCall.id ?? generateId()
        yield { type: 'tool-call-start', toolCallId, toolName: part.functionCall.name }
        yield {
          type: 'tool-call',
          toolCallId,
          toolName: part.functionCall.name,
          input: JSON.stringify(part.functionCall.args ?? {}),
          ...(providerMetadata && { providerMetadata }),
        }
        continue
      }
      if (typeof part.text !== 'string')
        continue
      if (part.thought) {
        if (part.text) {
          reasoningOpen = true
          yield { type: 'reasoning-delta', text: part.text }
        }
        if (providerMetadata) {
          reasoningOpen = false
          yield { type: 'reasoning-end', providerMetadata }
        }
        continue
      }
      if (reasoningOpen) {
        reasoningOpen = false
        yield { type: 'reasoning-end' }
      }
      if (part.text)
        yield { type: 'text-delta', text: part.text }
      if (providerMetadata)
        yield { type: 'reasoning-end', providerMetadata }
    }
    if (candidate?.finishReason)
      finishReason = candidate.finishReason
  }
  if (reasoningOpen)
    yield { type: 'reasoning-end' }
  const metadata = responseMetadata(last)
  yield {
    type: 'finish',
    finishReason: blocked && !finishReason
      ? 'content-filter'
      : mapFinishReason(finishReason, hasToolCalls),
    usage,
    ...(metadata && { providerMetadata: metadata }),
  }
}

export function googleEmbeddingModel(endpoint: GoogleEndpoint, modelId: string): EmbeddingModel {
  return {
    kind: 'embedding',
    provider: endpoint.provider,
    modelId,
    maxBatchSize: 100,
    async embed(request) {
      const { value, headers } = await postJSON({
        provider: endpoint.provider,
        url: endpointUrl(endpoint, modelId, 'batchEmbedContents'),
        headers: {
          ...endpoint.headers(),
          ...request.headers,
        },
        body: {
          // providerOptions.google（taskType、title 等）作用于每一条
          requests: request.values.map(text => compact({
            model: modelPath(modelId),
            content: {
              parts: [
                { text },
              ],
            },
            outputDimensionality: request.dimensions,
            ...request.providerOptions?.google,
          })),
        },
        signal: request.signal,
        fetch: endpoint.fetch,
      })
      const tokens = value.usageMetadata?.promptTokenCount
      return {
        embeddings: (value.embeddings ?? []).map((item: any) => item.values ?? []),
        usage: tokens === undefined
          ? undefined
          : { tokens },
        response: { headers },
      }
    },
  }
}

/** imageConfig.imageSize 接受的取值 */
const IMAGE_SIZES = new Set(['512', '1K', '2K', '4K'])

/**
 * 文生图：imagen-* 走 :predict（旧接口，Gemini API 已停用 Imagen，保留给仍提供该接口的服务），
 * 其余（gemini-*-image 等）走 generateContent 并取回 inlineData 图片。
 */
export function googleImageModel(endpoint: GoogleEndpoint, modelId: string): ImageModel {
  const imagen = /^(?:models\/)?imagen/.test(modelId)
  return {
    kind: 'image',
    provider: endpoint.provider,
    modelId,
    maxImagesPerCall: imagen
      ? 4
      : 1,
    async generate(request) {
      const warnings: string[] = []
      const headers = {
        ...endpoint.headers(),
        ...request.headers,
      }
      if (imagen) {
        if (request.size)
          warnings.push('size is not supported by Imagen; use aspectRatio')
        if (request.seed !== undefined)
          warnings.push('seed is not supported by Imagen on the Gemini API')
        const { value, headers: responseHeaders } = await postJSON({
          provider: endpoint.provider,
          url: endpointUrl(endpoint, modelId, 'predict'),
          headers,
          body: {
            instances: [
              { prompt: request.prompt },
            ],
            parameters: compact({
              sampleCount: request.n ?? 1,
              aspectRatio: request.aspectRatio,
              ...request.providerOptions?.google,
            }),
          },
          signal: request.signal,
          fetch: endpoint.fetch,
        })
        const predictions = (value.predictions ?? []).filter((item: any) => item.bytesBase64Encoded)
        return {
          images: predictions.map((item: any) => generatedFile(item.bytesBase64Encoded, item.mimeType ?? 'image/png')),
          warnings,
          response: { headers: responseHeaders },
        }
      }
      let imageSize: string | undefined
      if (request.size) {
        const size = request.size.toUpperCase()
        if (IMAGE_SIZES.has(size))
          imageSize = size
        else
          warnings.push(`size "${request.size}" is not supported by Gemini image models; use aspectRatio and 1K / 2K / 4K`)
      }
      const body = mergeOptions({
        contents: [
          {
            role: 'user',
            parts: [
              { text: request.prompt },
            ],
          },
        ],
        generationConfig: compact({
          responseModalities: ['TEXT', 'IMAGE'],
          seed: request.seed,
          imageConfig: request.aspectRatio || imageSize
            ? compact({ aspectRatio: request.aspectRatio, imageSize })
            : undefined,
        }),
      }, request.providerOptions?.google)
      const { value, headers: responseHeaders } = await postJSON({
        provider: endpoint.provider,
        url: endpointUrl(endpoint, modelId, 'generateContent'),
        headers,
        body,
        signal: request.signal,
        fetch: endpoint.fetch,
      })
      const candidate = value.candidates?.[0]
      // 跳过思考过程中的草图（thought: true）
      const images = (candidate?.content?.parts ?? [])
        .filter((part: any) => !part.thought && part.inlineData?.data && String(part.inlineData.mimeType ?? 'image/').startsWith('image/'))
        .map((part: any) => generatedFile(part.inlineData.data, part.inlineData.mimeType ?? 'image/png'))
      if (!images.length) {
        const reason = candidate?.finishReason ?? value.promptFeedback?.blockReason ?? 'unknown'
        throw new AIError(`${endpoint.provider}: the model returned no image (finish reason: ${reason})`)
      }
      return {
        images,
        warnings,
        response: { modelId: value.modelVersion, headers: responseHeaders },
      }
    },
  }
}

/** 给 16 位小端 PCM 加上 44 字节的 WAV 头 */
export function pcmToWav(pcm: Uint8Array, sampleRate = 24000, channels = 1, bitsPerSample = 16): Uint8Array {
  const wav = new Uint8Array(44 + pcm.length)
  const view = new DataView(wav.buffer)
  const write = (offset: number, text: string): void => {
    for (let index = 0; index < text.length; index++)
      view.setUint8(offset + index, text.charCodeAt(index))
  }
  const blockAlign = channels * bitsPerSample / 8
  write(0, 'RIFF')
  view.setUint32(4, 36 + pcm.length, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  write(36, 'data')
  view.setUint32(40, pcm.length, true)
  wav.set(pcm, 44)
  return wav
}

function isWav(bytes: Uint8Array): boolean {
  return bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...bytes.subarray(8, 12)) === 'WAVE'
}

/** 取出 WAV 的 data 块（format: 'pcm' 时） */
function wavData(bytes: Uint8Array): Uint8Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const size = view.getUint32(offset + 4, true)
    if (String.fromCharCode(...bytes.subarray(offset, offset + 4)) === 'data')
      return bytes.subarray(offset + 8, offset + 8 + size)
    offset += 8 + size + (size % 2)
  }
  return bytes.subarray(44)
}

/**
 * 语音合成（gemini-*-tts）：generateContent + responseModalities: ['AUDIO']。
 * 较早的模型返回无头的 PCM（audio/L16;codec=pcm;rate=24000，16 位小端单声道），这里包装为 WAV；
 * 新模型默认已返回 WAV，原样使用。format: 'pcm' 时返回裸 PCM，其余格式均返回 WAV。
 */
export function googleSpeechModel(endpoint: GoogleEndpoint, modelId: string): SpeechModel {
  return {
    kind: 'speech',
    provider: endpoint.provider,
    modelId,
    async generate(request) {
      const body = mergeOptions({
        contents: [
          {
            role: 'user',
            parts: [
              compact({
                text: request.text,
                // 语气、风格等指令
                speechMetadata: request.instructions
                  ? { style: request.instructions }
                  : undefined,
              }),
            ],
          },
        ],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: { voiceName: request.voice ?? 'Kore' },
            },
          },
        },
      }, request.providerOptions?.google)
      const { value, headers } = await postJSON({
        provider: endpoint.provider,
        url: endpointUrl(endpoint, modelId, 'generateContent'),
        headers: {
          ...endpoint.headers(),
          ...request.headers,
        },
        body,
        signal: request.signal,
        fetch: endpoint.fetch,
      })
      const parts: any[] = value.candidates?.[0]?.content?.parts ?? []
      const audioParts = parts.filter(part => part.inlineData?.data)
      if (!audioParts.length)
        throw new AIError(`${endpoint.provider}: the model returned no audio (finish reason: ${value.candidates?.[0]?.finishReason ?? 'unknown'})`)
      const mimeType: string = audioParts[0].inlineData.mimeType ?? 'audio/L16;codec=pcm;rate=24000'
      const chunks = audioParts.map(part => fromBase64(part.inlineData.data))
      const bytes = chunks.length === 1
        ? chunks[0]
        : concat(chunks)
      let audio: Uint8Array
      let mediaType: string
      if (isWav(bytes)) {
        audio = bytes
        mediaType = 'audio/wav'
      }
      else if (/l16|pcm/i.test(mimeType)) {
        const rate = Number(/rate=(\d+)/i.exec(mimeType)?.[1] ?? 24000)
        audio = request.format === 'pcm'
          ? bytes
          : pcmToWav(bytes, rate)
        mediaType = request.format === 'pcm'
          ? 'audio/pcm'
          : 'audio/wav'
      }
      else {
        // μ-law / A-law 等：原样返回
        audio = bytes
        mediaType = mimeType.split(';')[0]
      }
      if (request.format === 'pcm' && mediaType === 'audio/wav') {
        audio = wavData(audio)
        mediaType = 'audio/pcm'
      }
      return {
        audio: generatedFile(audio, mediaType),
        response: { modelId: value.modelVersion, headers },
      }
    },
  }
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

export type GoogleSettings = ProviderSettings

/**
 * Google Gemini：`google('gemini-3-flash')`、`google.embeddingModel('gemini-embedding-001')`、
 * `google.imageModel('gemini-2.5-flash-image')`、`google.speechModel('gemini-2.5-flash-preview-tts')`。
 * API Key 读取 GEMINI_API_KEY，其次 GOOGLE_GENERATIVE_AI_API_KEY。
 */
export function createGoogle(settings: GoogleSettings = {}): ProviderInstance {
  const apiKey = (): string => {
    const key = settings.apiKey ?? optionalEnv('GEMINI_API_KEY') ?? optionalEnv('GOOGLE_GENERATIVE_AI_API_KEY')
    if (!key)
      throw new AIError('Google API key is missing. Pass apiKey or set GEMINI_API_KEY (or GOOGLE_GENERATIVE_AI_API_KEY).')
    return key
  }
  const endpoint: GoogleEndpoint = {
    provider: 'google',
    baseURL: withoutTrailingSlash(settings.baseURL ?? 'https://generativelanguage.googleapis.com/v1beta'),
    headers: () => ({
      'x-goog-api-key': apiKey(),
      ...settings.headers,
    }),
    fetch: settings.fetch,
  }
  return createProvider('google', {
    languageModel: modelId => googleLanguageModel(endpoint, modelId),
    embeddingModel: modelId => googleEmbeddingModel(endpoint, modelId),
    imageModel: modelId => googleImageModel(endpoint, modelId),
    speechModel: modelId => googleSpeechModel(endpoint, modelId),
  })
}

/** 读取 GEMINI_API_KEY 的默认实例 */
export const google = createGoogle()
