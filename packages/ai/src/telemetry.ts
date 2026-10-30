import type { AssistantContentPart, EmbeddingModel, LanguageModel, Message, ModelRequest, ModelStreamPart, Usage } from './types'

/**
 * 模型调用遥测：上报到 @hazejs/core 的遥测总线（`globalThis[Symbol.for('hazejs.telemetry')]`），
 * 供开发面板与 OpenTelemetry（gen_ai.* 语义约定）使用。不依赖 core；没有监听者时不包装模型。
 */

interface TelemetryHub {
  listeners: { size: number }
  record: (kind: string, data: object) => void
  /** 开发面板开启时为 true：额外上报提示词与输出 */
  captureContent?: boolean
}

const kHub = Symbol.for('hazejs.telemetry')

function activeHub(): TelemetryHub | undefined {
  const hub = (globalThis as { [kHub]?: TelemetryHub })[kHub]
  return hub?.listeners.size ? hub : undefined
}

interface CallInfo {
  operation: 'chat' | 'stream' | 'embeddings'
  provider: string
  model: string
  startTime: number
  started: number
  /** 采集内容时的输入部分 */
  content?: { messages: Array<{ role: string, content: string }>, tools?: string[] }
}

interface CallResult {
  usage?: Partial<Usage>
  finishReason?: string
  error?: unknown
  output?: string
  toolCalls?: Array<{ name: string, input: unknown }>
}

/** 每段内容的上限：开发面板只需看清楚，不需要完整的长文本 */
const MAX_CONTENT = 4000

function clip(text: string): string {
  return text.length > MAX_CONTENT
    ? `${text.slice(0, MAX_CONTENT)}…`
    : text
}

function stringify(value: unknown): string {
  if (typeof value === 'string')
    return value
  try {
    return JSON.stringify(value)
  }
  catch {
    return String(value)
  }
}

/** 消息转为文本：图片 / 文件只保留占位，工具调用与结果写成一行 */
function messageText(message: Message): string {
  if (typeof message.content === 'string')
    return clip(message.content)
  return clip(message.content.map((part) => {
    switch (part.type) {
      case 'text':
      case 'reasoning':
        return part.text
      case 'tool-call':
        return `→ ${part.toolName}(${stringify(part.input)})`
      case 'tool-result':
        return `← ${part.toolName}: ${stringify(part.output)}`
      default:
        return `[${part.type}]`
    }
  }).join('\n'))
}

function requestContent(request: ModelRequest): CallInfo['content'] {
  return {
    messages: request.messages.map(message => ({
      role: message.role,
      content: messageText(message),
    })),
    ...(request.tools?.length && {
      tools: request.tools.map(tool => tool.name),
    }),
  }
}

function responseContent(parts: AssistantContentPart[]): Pick<CallResult, 'output' | 'toolCalls'> {
  const output = parts.filter(part => part.type === 'text').map(part => part.text).join('')
  const toolCalls = parts.filter(part => part.type === 'tool-call').map(part => ({ name: part.toolName, input: part.input }))
  return {
    output: clip(output),
    ...(toolCalls.length && { toolCalls }),
  }
}

function report(hub: TelemetryHub, info: CallInfo, result: CallResult): void {
  hub.record('ai', {
    operation: info.operation,
    provider: info.provider,
    model: info.model,
    inputTokens: result.usage?.inputTokens,
    outputTokens: result.usage?.outputTokens,
    totalTokens: result.usage?.totalTokens,
    finishReason: result.finishReason,
    startTime: info.startTime,
    duration: performance.now() - info.started,
    ...(result.error !== undefined && {
      error: result.error instanceof Error
        ? result.error.message
        : String(result.error),
    }),
    ...info.content,
    ...(info.content && {
      output: result.output,
      toolCalls: result.toolCalls,
    }),
  })
}

function begin(operation: CallInfo['operation'], model: { provider: string, modelId: string }, hub: TelemetryHub, request?: ModelRequest): CallInfo {
  return {
    operation,
    provider: model.provider,
    model: model.modelId,
    startTime: Date.now(),
    started: performance.now(),
    ...(hub.captureContent && request && {
      content: requestContent(request),
    }),
  }
}

/** 代理：其余属性与方法绑定到原模型（适配器可能使用私有字段） */
function proxy<T extends object>(model: T, overrides: Partial<T>): T {
  return new Proxy(model, {
    get(target, key) {
      if (key in overrides)
        return overrides[key as keyof T]
      const value = Reflect.get(target, key, target)
      return typeof value === 'function'
        ? value.bind(target)
        : value
    },
  })
}

function instrumentLanguage(model: LanguageModel, hub: TelemetryHub): LanguageModel {
  return proxy(model, {
    async generate(request) {
      const info = begin('chat', model, hub, request)
      try {
        const response = await model.generate(request)
        report(hub, info, {
          usage: response.usage,
          finishReason: response.finishReason,
          ...(info.content && responseContent(response.content)),
        })
        return response
      }
      catch (error) {
        report(hub, info, { error })
        throw error
      }
    },
    async stream(request) {
      const info = begin('stream', model, hub, request)
      let stream: ReadableStream<ModelStreamPart>
      try {
        stream = await model.stream(request)
      }
      catch (error) {
        report(hub, info, { error })
        throw error
      }
      // 流结束（finish / error 事件或流关闭）时上报一次
      let done = false
      const finish = (result: CallResult): void => {
        if (!done) {
          done = true
          report(hub, info, result)
        }
      }
      let usage: Usage | undefined
      let finishReason: string | undefined
      let output = ''
      const toolCalls: Array<{ name: string, input: unknown }> = []
      return stream.pipeThrough(new TransformStream<ModelStreamPart, ModelStreamPart>({
        transform(part, controller) {
          if (part.type === 'finish') {
            usage = part.usage
            finishReason = part.finishReason
          }
          else if (part.type === 'error') {
            finish({ error: part.error })
          }
          else if (info.content && part.type === 'text-delta' && output.length <= MAX_CONTENT) {
            output += part.text
          }
          else if (info.content && part.type === 'tool-call') {
            toolCalls.push({ name: part.toolName, input: part.input })
          }
          controller.enqueue(part)
        },
        flush() {
          finish({
            usage,
            finishReason,
            ...(info.content && {
              output: clip(output),
              ...(toolCalls.length && { toolCalls }),
            }),
          })
        },
      }))
    },
  })
}

function instrumentEmbedding(model: EmbeddingModel, hub: TelemetryHub): EmbeddingModel {
  return proxy(model, {
    async embed(request) {
      const info = begin('embeddings', model, hub)
      try {
        const response = await model.embed(request)
        report(hub, info, { usage: response.usage && { inputTokens: response.usage.tokens, totalTokens: response.usage.tokens } })
        return response
      }
      catch (error) {
        report(hub, info, { error })
        throw error
      }
    },
  })
}

/** 有遥测监听者时包装对话 / Embedding 模型，否则原样返回 */
export function instrumentModel<T>(kind: string, model: T): T {
  const hub = activeHub()
  if (!hub || !model || typeof model !== 'object')
    return model
  const target = model as { generate?: unknown, embed?: unknown }
  if (kind === 'language' && typeof target.generate === 'function')
    return instrumentLanguage(target as LanguageModel, hub) as T
  if (kind === 'embedding' && typeof target.embed === 'function')
    return instrumentEmbedding(target as EmbeddingModel, hub) as T
  return model
}
