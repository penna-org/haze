/**
 * 统一的数据模型：所有厂商适配器把各自的协议转换到这里定义的消息、请求与流事件。
 */

/** 厂商专属数据（如 Anthropic thinking 的 signature、Gemini 的 thoughtSignature），按厂商名分组，需原样回传 */
export type ProviderMetadata = Record<string, Record<string, unknown>>

/** 调用时的厂商专属参数，按厂商名分组：`{ anthropic: { cacheControl: true } }` */
export type ProviderOptions = Record<string, Record<string, unknown>>

/** 二进制数据：字节、base64 字符串或 data: / https: URL */
export type DataContent = Uint8Array | ArrayBuffer | string | URL

export interface TextPart {
  type: 'text'
  text: string
  providerOptions?: ProviderOptions
}

export interface ImagePart {
  type: 'image'
  /** 字节、base64、data: URL 或 https: URL */
  image: DataContent
  /** 省略时从 data: URL 或字节头推断 */
  mediaType?: string
  providerOptions?: ProviderOptions
}

export interface FilePart {
  type: 'file'
  data: DataContent
  mediaType: string
  filename?: string
  providerOptions?: ProviderOptions
}

export interface ReasoningPart {
  type: 'reasoning'
  text: string
  /** 回传给同一厂商所需的数据（签名、加密内容） */
  providerMetadata?: ProviderMetadata
}

export interface ToolCallPart {
  type: 'tool-call'
  toolCallId: string
  toolName: string
  input: unknown
  providerMetadata?: ProviderMetadata
}

export interface ToolResultPart {
  type: 'tool-result'
  toolCallId: string
  toolName: string
  output: unknown
  isError?: boolean
}

export type UserContentPart = TextPart | ImagePart | FilePart
export type AssistantContentPart = TextPart | ReasoningPart | ToolCallPart

export interface SystemMessage {
  role: 'system'
  content: string
  providerOptions?: ProviderOptions
}

export interface UserMessage {
  role: 'user'
  content: string | UserContentPart[]
  providerOptions?: ProviderOptions
}

export interface AssistantMessage {
  role: 'assistant'
  content: string | AssistantContentPart[]
  providerOptions?: ProviderOptions
}

export interface ToolMessage {
  role: 'tool'
  content: ToolResultPart[]
}

export type Message = SystemMessage | UserMessage | AssistantMessage | ToolMessage

export type FinishReason = 'stop' | 'length' | 'tool-calls' | 'content-filter' | 'error' | 'other'

export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** 推理（thinking）消耗的输出 token，包含在 outputTokens 中 */
  reasoningTokens?: number
  /** 命中提示缓存的输入 token，包含在 inputTokens 中 */
  cachedInputTokens?: number
  /** 写入提示缓存的输入 token（Anthropic） */
  cacheWriteInputTokens?: number
}

/** JSON Schema（draft-07 / 2020-12 的子集，交给厂商时原样传递） */
export type JSONSchema = Record<string, unknown>

/** 交给模型的工具声明 */
export interface ToolSpec {
  name: string
  description?: string
  parameters: JSONSchema
  /** 厂商支持时要求严格遵循 schema（OpenAI strict、Anthropic strict） */
  strict?: boolean
}

export type ToolChoice = 'auto' | 'none' | 'required' | { toolName: string }

export type ResponseFormat
  = | { type: 'text' }
    | { type: 'json', schema?: JSONSchema, name?: string, description?: string }

/** 推理强度：不支持的厂商忽略；Anthropic 映射到 output_config.effort，OpenAI 映射到 reasoning_effort */
export type ReasoningEffort = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

/** 适配器收到的请求（已规范化） */
export interface ModelRequest {
  messages: Message[]
  tools?: ToolSpec[]
  toolChoice?: ToolChoice
  responseFormat?: ResponseFormat
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  stopSequences?: string[]
  seed?: number
  reasoning?: { effort?: ReasoningEffort, /** 返回推理摘要（厂商支持时） */ summary?: boolean }
  providerOptions?: ProviderOptions
  headers?: Record<string, string>
  signal?: AbortSignal
}

export interface ResponseInfo {
  id?: string
  modelId?: string
  headers?: Record<string, string>
}

export interface ModelResponse {
  content: AssistantContentPart[]
  finishReason: FinishReason
  usage: Usage
  response?: ResponseInfo
  /** 适配器发现的问题（如忽略了不支持的参数） */
  warnings?: string[]
  providerMetadata?: ProviderMetadata
}

/** 适配器产生的流事件 */
export type ModelStreamPart
  = | { type: 'response-metadata', id?: string, modelId?: string }
    | { type: 'text-delta', text: string }
    | { type: 'reasoning-delta', text: string }
  /** 一段推理结束，携带需要回传的数据（签名等） */
    | { type: 'reasoning-end', providerMetadata?: ProviderMetadata }
    | { type: 'tool-call-start', toolCallId: string, toolName: string }
    | { type: 'tool-call-delta', toolCallId: string, inputDelta: string }
  /** 完整的工具调用，input 为 JSON 字符串 */
    | { type: 'tool-call', toolCallId: string, toolName: string, input: string, providerMetadata?: ProviderMetadata }
    | { type: 'finish', finishReason: FinishReason, usage: Usage, providerMetadata?: ProviderMetadata }
    | { type: 'warning', message: string }
    | { type: 'error', error: unknown }

/** 对话模型：适配器实现 */
export interface LanguageModel {
  readonly kind: 'language'
  /** 厂商名（与 ProviderOptions / ProviderMetadata 的键一致） */
  readonly provider: string
  readonly modelId: string
  /** 结构化输出的实现方式：native（JSON Schema 约束）、json（JSON 模式 + 提示）、tool（借工具调用） */
  readonly structuredOutput?: 'native' | 'json' | 'tool'
  generate: (request: ModelRequest) => Promise<ModelResponse>
  stream: (request: ModelRequest) => Promise<ReadableStream<ModelStreamPart>>
}

export interface EmbeddingRequest {
  values: string[]
  /** 输出维度（厂商支持时） */
  dimensions?: number
  providerOptions?: ProviderOptions
  headers?: Record<string, string>
  signal?: AbortSignal
}

export interface EmbeddingResponse {
  embeddings: number[][]
  usage?: { tokens: number }
  response?: ResponseInfo
}

export interface EmbeddingModel {
  readonly kind: 'embedding'
  readonly provider: string
  readonly modelId: string
  /** 单次请求最多的条数，embedMany 据此分批 */
  readonly maxBatchSize?: number
  embed: (request: EmbeddingRequest) => Promise<EmbeddingResponse>
}

export interface ImageRequest {
  prompt: string
  n?: number
  /** 如 1024x1024 */
  size?: string
  /** 如 16:9（厂商支持时） */
  aspectRatio?: string
  seed?: number
  providerOptions?: ProviderOptions
  headers?: Record<string, string>
  signal?: AbortSignal
}

export interface GeneratedFile {
  data: Uint8Array
  mediaType: string
  /** base64，便于直接写进 JSON 响应 */
  readonly base64: string
}

export interface ImageResponse {
  images: GeneratedFile[]
  /** 厂商返回的改写后的提示词等 */
  revisedPrompts?: (string | undefined)[]
  warnings?: string[]
  response?: ResponseInfo
}

export interface ImageModel {
  readonly kind: 'image'
  readonly provider: string
  readonly modelId: string
  readonly maxImagesPerCall?: number
  generate: (request: ImageRequest) => Promise<ImageResponse>
}

export interface SpeechRequest {
  text: string
  voice?: string
  /** mp3（默认）、wav、opus、aac、flac、pcm */
  format?: string
  speed?: number
  instructions?: string
  providerOptions?: ProviderOptions
  headers?: Record<string, string>
  signal?: AbortSignal
}

export interface SpeechResponse {
  audio: GeneratedFile
  response?: ResponseInfo
}

export interface SpeechModel {
  readonly kind: 'speech'
  readonly provider: string
  readonly modelId: string
  generate: (request: SpeechRequest) => Promise<SpeechResponse>
}

export interface TranscriptionRequest {
  audio: DataContent
  mediaType?: string
  /** ISO-639-1，如 zh、en */
  language?: string
  prompt?: string
  providerOptions?: ProviderOptions
  headers?: Record<string, string>
  signal?: AbortSignal
}

export interface TranscriptionSegment {
  text: string
  start: number
  end: number
}

export interface TranscriptionResponse {
  text: string
  language?: string
  durationInSeconds?: number
  segments?: TranscriptionSegment[]
  response?: ResponseInfo
}

export interface TranscriptionModel {
  readonly kind: 'transcription'
  readonly provider: string
  readonly modelId: string
  transcribe: (request: TranscriptionRequest) => Promise<TranscriptionResponse>
}
