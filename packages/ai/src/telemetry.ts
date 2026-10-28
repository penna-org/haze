import type { EmbeddingModel, LanguageModel, ModelStreamPart, Usage } from './types'

/**
 * 模型调用遥测：上报到 @hazejs/core 的遥测总线（`globalThis[Symbol.for('hazejs.telemetry')]`），
 * 供开发面板与 OpenTelemetry（gen_ai.* 语义约定）使用。不依赖 core；没有监听者时不包装模型。
 */

interface TelemetryHub {
  listeners: { size: number }
  record: (kind: string, data: object) => void
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
}

function report(hub: TelemetryHub, info: CallInfo, result: { usage?: Partial<Usage>, finishReason?: string, error?: unknown }): void {
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
  })
}

function begin(operation: CallInfo['operation'], model: { provider: string, modelId: string }): CallInfo {
  return {
    operation,
    provider: model.provider,
    model: model.modelId,
    startTime: Date.now(),
    started: performance.now(),
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
      const info = begin('chat', model)
      try {
        const response = await model.generate(request)
        report(hub, info, { usage: response.usage, finishReason: response.finishReason })
        return response
      }
      catch (error) {
        report(hub, info, { error })
        throw error
      }
    },
    async stream(request) {
      const info = begin('stream', model)
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
      const finish = (result: Parameters<typeof report>[2]): void => {
        if (!done) {
          done = true
          report(hub, info, result)
        }
      }
      let usage: Usage | undefined
      let finishReason: string | undefined
      return stream.pipeThrough(new TransformStream<ModelStreamPart, ModelStreamPart>({
        transform(part, controller) {
          if (part.type === 'finish') {
            usage = part.usage
            finishReason = part.finishReason
          }
          else if (part.type === 'error') {
            finish({ error: part.error })
          }
          controller.enqueue(part)
        },
        flush() {
          finish({ usage, finishReason })
        },
      }))
    },
  })
}

function instrumentEmbedding(model: EmbeddingModel, hub: TelemetryHub): EmbeddingModel {
  return proxy(model, {
    async embed(request) {
      const info = begin('embeddings', model)
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
