import type { EmbeddingModel, LanguageModel, ModelStreamPart } from '../src'
import { afterEach, describe, expect, it } from 'vitest'
import { embedMany, generateText, streamText } from '../src'

/** 模拟 @hazejs/core 的遥测总线（只依赖 globalThis 上的约定结构） */
const kHub = Symbol.for('hazejs.telemetry')
const records: Array<{ kind: string, data: Record<string, unknown> }> = []
function installHub() {
  const listeners = new Set([
    () => {},
  ])
  ;(globalThis as Record<symbol, unknown>)[kHub] = {
    listeners,
    record: (kind: string, data: Record<string, unknown>) => void records.push({ kind, data }),
  }
}

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[kHub]
  records.length = 0
})

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 }

class PrivateModel implements LanguageModel {
  readonly kind = 'language'
  readonly provider = 'mock'
  readonly modelId = 'mock-1'
  // 适配器可能使用私有字段：包装后仍须以原对象调用
  #reply = 'hello'

  async generate() {
    return {
      content: [
        { type: 'text' as const, text: this.#reply },
      ],
      finishReason: 'stop' as const,
      usage,
    }
  }

  async stream() {
    return new ReadableStream<ModelStreamPart>({
      start: (controller) => {
        controller.enqueue({ type: 'text-delta', text: this.#reply })
        controller.enqueue({ type: 'finish', finishReason: 'stop', usage })
        controller.close()
      },
    })
  }
}

const failing: LanguageModel = {
  kind: 'language',
  provider: 'mock',
  modelId: 'broken',
  generate: async () => {
    throw new Error('rate limited')
  },
  stream: async () => {
    throw new Error('rate limited')
  },
}

const embedder: EmbeddingModel = {
  kind: 'embedding',
  provider: 'mock',
  modelId: 'embed-1',
  embed: async request => ({
    embeddings: request.values.map(() => [1, 0]),
    usage: { tokens: 7 },
  }),
}

describe('ai telemetry', () => {
  it('reports chat, stream and embedding calls with usage and latency', async () => {
    installHub()
    const model = new PrivateModel()
    expect((await generateText({ model, prompt: 'hi' })).text).toBe('hello')
    const stream = streamText({ model, prompt: 'hi' })
    expect(await stream.text).toBe('hello')
    await embedMany({
      model: embedder,
      values: ['a', 'b'],
    })

    expect(records.map(record => record.kind)).toEqual(['ai', 'ai', 'ai'])
    expect(records[0]!.data).toMatchObject({
      operation: 'chat',
      provider: 'mock',
      model: 'mock-1',
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      finishReason: 'stop',
    })
    expect(records[1]!.data).toMatchObject({
      operation: 'stream',
      model: 'mock-1',
      outputTokens: 5,
      finishReason: 'stop',
    })
    expect(records[2]!.data).toMatchObject({ operation: 'embeddings', model: 'embed-1', inputTokens: 7 })
    for (const { data } of records) {
      expect(typeof data.duration).toBe('number')
      expect(typeof data.startTime).toBe('number')
    }
  })

  it('reports errors and leaves models untouched without listeners', async () => {
    installHub()
    await expect(generateText({ model: failing, prompt: 'hi', maxRetries: 0 })).rejects.toThrow('rate limited')
    expect(records[0]!.data).toMatchObject({ operation: 'chat', model: 'broken', error: 'rate limited' })

    delete (globalThis as Record<symbol, unknown>)[kHub]
    records.length = 0
    await generateText({
      model: new PrivateModel(),
      prompt: 'hi',
    })
    expect(records).toHaveLength(0)
  })
})
