import type { AssistantContentPart, FinishReason, LanguageModel, ModelRequest, ModelResponse, ModelStreamPart, Usage } from './types'
import { toReadableStream } from './http'

/** mockModel 的一次回复：文本，或完整的回复内容 */
export type MockReply = string | {
  text?: string
  reasoning?: string
  toolCalls?: Array<{ toolName: string, input: unknown, toolCallId?: string }>
  finishReason?: FinishReason
  usage?: Partial<Usage>
} | ((request: ModelRequest) => MockReply)

export interface MockModel extends LanguageModel {
  /** 收到的请求（按顺序） */
  readonly requests: ModelRequest[]
}

let callCounter = 0

function toResponse(reply: MockReply, request: ModelRequest): ModelResponse {
  if (typeof reply === 'function')
    return toResponse(reply(request), request)
  const value = typeof reply === 'string'
    ? { text: reply }
    : reply
  const content: AssistantContentPart[] = []
  if (value.reasoning)
    content.push({ type: 'reasoning', text: value.reasoning })
  if (value.text)
    content.push({ type: 'text', text: value.text })
  for (const call of value.toolCalls ?? []) {
    content.push({
      type: 'tool-call',
      toolCallId: call.toolCallId ?? `call_${++callCounter}`,
      toolName: call.toolName,
      input: call.input,
    })
  }
  const usage = { inputTokens: 10, outputTokens: 5, ...value.usage }
  return {
    content,
    finishReason: value.finishReason ?? (value.toolCalls?.length ? 'tool-calls' : 'stop'),
    usage: { ...usage, totalTokens: usage.totalTokens ?? usage.inputTokens + usage.outputTokens },
    response: { id: `mock-${callCounter}`, modelId: 'mock' },
  }
}

async function* streamParts(response: ModelResponse): AsyncGenerator<ModelStreamPart> {
  yield { type: 'response-metadata', id: response.response?.id, modelId: response.response?.modelId }
  for (const part of response.content) {
    if (part.type === 'text') {
      // 按词切分，模拟逐步输出
      for (const piece of part.text.match(/\S+\s*|\s+/g) ?? [])
        yield { type: 'text-delta', text: piece }
    }
    else if (part.type === 'reasoning') {
      yield { type: 'reasoning-delta', text: part.text }
      yield { type: 'reasoning-end' }
    }
    else {
      const input = JSON.stringify(part.input)
      yield { type: 'tool-call-start', toolCallId: part.toolCallId, toolName: part.toolName }
      yield { type: 'tool-call-delta', toolCallId: part.toolCallId, inputDelta: input }
      yield {
        type: 'tool-call',
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input,
      }
    }
  }
  yield { type: 'finish', finishReason: response.finishReason, usage: response.usage }
}

/**
 * 测试用模型：按顺序返回预设的回复（用完后重复最后一条），并记录收到的请求。
 *
 * ```ts
 * const model = mockModel(['Hello!', { toolCalls: [{ toolName: 'weather', input: { city: 'Paris' } }] }])
 * ```
 */
export function mockModel(replies: MockReply[] | MockReply = 'Hello from the mock model', options: { provider?: string, modelId?: string, structuredOutput?: LanguageModel['structuredOutput'] } = {}): MockModel {
  const queue = Array.isArray(replies)
    ? replies
    : [replies]
  const requests: ModelRequest[] = []
  const next = (request: ModelRequest): ModelResponse => {
    requests.push(request)
    const reply = queue.length > 1
      ? queue.shift()!
      : queue[0]
    return toResponse(reply, request)
  }
  return {
    kind: 'language',
    provider: options.provider ?? 'mock',
    modelId: options.modelId ?? 'mock',
    structuredOutput: options.structuredOutput ?? 'native',
    requests,
    async generate(request) {
      return next(request)
    },
    async stream(request) {
      return toReadableStream(streamParts(next(request)))
    },
  }
}
