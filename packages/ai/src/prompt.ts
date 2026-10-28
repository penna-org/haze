import type { ToolSet } from './tool'
import type { AssistantContentPart, Message, ModelRequest, ProviderOptions, ReasoningEffort, ToolChoice, ToolSpec, Usage, UserContentPart } from './types'
import { AIError } from './errors'
import { toSchema } from './schema'

/** 提示输入：system + prompt 或 messages */
export interface PromptInput {
  system?: string
  /** 单轮输入，追加为最后一条用户消息 */
  prompt?: string | UserContentPart[]
  messages?: Message[]
}

/** 各调用通用的生成参数 */
export interface CallSettings {
  maxOutputTokens?: number
  temperature?: number
  topP?: number
  topK?: number
  stopSequences?: string[]
  seed?: number
  /** 推理强度与摘要（厂商支持时） */
  reasoning?: { effort?: ReasoningEffort, summary?: boolean }
  providerOptions?: ProviderOptions
  headers?: Record<string, string>
  /** 429 / 5xx / 网络错误的重试次数，默认 2 */
  maxRetries?: number
  /** 单次模型调用的超时（毫秒） */
  timeout?: number
  abortSignal?: AbortSignal
}

export function buildMessages(input: PromptInput): Message[] {
  const messages: Message[] = []
  if (input.system)
    messages.push({ role: 'system', content: input.system })
  if (input.messages)
    messages.push(...input.messages)
  if (input.prompt !== undefined)
    messages.push({ role: 'user', content: input.prompt })
  if (!messages.some(message => message.role !== 'system'))
    throw new AIError('A prompt or messages is required')
  return messages
}

export async function buildToolSpecs(tools: ToolSet | undefined): Promise<ToolSpec[] | undefined> {
  if (!tools || !Object.keys(tools).length)
    return undefined
  return Promise.all(Object.entries(tools).map(async ([name, tool]) => ({
    name,
    description: tool.description,
    parameters: (await toSchema(tool.parameters)).jsonSchema,
    ...(tool.strict && { strict: true }),
  })))
}

export function buildRequest(settings: CallSettings, messages: Message[], extra: Partial<ModelRequest> & { signal?: AbortSignal }): ModelRequest {
  return {
    messages,
    maxOutputTokens: settings.maxOutputTokens,
    temperature: settings.temperature,
    topP: settings.topP,
    topK: settings.topK,
    stopSequences: settings.stopSequences,
    seed: settings.seed,
    reasoning: settings.reasoning,
    providerOptions: settings.providerOptions,
    headers: settings.headers,
    ...extra,
  }
}

export function emptyUsage(): Usage {
  return { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
}

export function addUsage(a: Usage, b: Usage): Usage {
  const sum = (x?: number, y?: number): number | undefined => x === undefined && y === undefined
    ? undefined
    : (x ?? 0) + (y ?? 0)
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    totalTokens: a.totalTokens + b.totalTokens,
    ...(sum(a.reasoningTokens, b.reasoningTokens) !== undefined && {
      reasoningTokens: sum(a.reasoningTokens, b.reasoningTokens),
    }),
    ...(sum(a.cachedInputTokens, b.cachedInputTokens) !== undefined && {
      cachedInputTokens: sum(a.cachedInputTokens, b.cachedInputTokens),
    }),
    ...(sum(a.cacheWriteInputTokens, b.cacheWriteInputTokens) !== undefined && {
      cacheWriteInputTokens: sum(a.cacheWriteInputTokens, b.cacheWriteInputTokens),
    }),
  }
}

export function textOf(content: AssistantContentPart[]): string {
  return content.filter(part => part.type === 'text').map(part => part.text).join('')
}

export function reasoningOf(content: AssistantContentPart[]): string | undefined {
  const parts = content.filter(part => part.type === 'reasoning')
  return parts.length
    ? parts.map(part => part.text).join('')
    : undefined
}

export function resolveToolChoice(choice: ToolChoice | undefined, tools: ToolSpec[] | undefined): ToolChoice | undefined {
  if (!tools)
    return undefined
  if (typeof choice === 'object' && !tools.some(tool => tool.name === choice.toolName))
    throw new AIError(`toolChoice names an unknown tool "${choice.toolName}"`)
  return choice
}
