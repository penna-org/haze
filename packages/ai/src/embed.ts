import type { ModelRef } from './registry'
import type { EmbeddingModel, ProviderOptions } from './types'
import { AIError } from './errors'
import { abortSignal, withRetry } from './http'
import { resolveModel } from './registry'

interface EmbedSettings {
  model?: ModelRef<EmbeddingModel>
  dimensions?: number
  providerOptions?: ProviderOptions
  headers?: Record<string, string>
  maxRetries?: number
  timeout?: number
  abortSignal?: AbortSignal
}

/** 单条文本的向量 */
export async function embed(options: EmbedSettings & { value: string }): Promise<{ embedding: number[], usage?: { tokens: number } }> {
  const { embeddings, usage } = await embedMany({
    ...options,
    values: [options.value],
  })
  return { embedding: embeddings[0], usage }
}

/** 多条文本的向量（按模型的单次上限分批，并发请求），顺序与输入一致 */
export async function embedMany(options: EmbedSettings & { values: string[], /** 并发批次数，默认 4 */ maxParallelCalls?: number }): Promise<{ embeddings: number[][], usage?: { tokens: number } }> {
  const model = resolveModel('embedding', options.model)
  const size = model.maxBatchSize ?? options.values.length
  const batches: string[][] = []
  for (let index = 0; index < options.values.length; index += Math.max(1, size))
    batches.push(options.values.slice(index, index + Math.max(1, size)))
  const results: number[][][] = Array.from({ length: batches.length })
  let tokens: number | undefined
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < batches.length) {
      const index = next++
      const response = await withRetry(() => model.embed({
        values: batches[index],
        dimensions: options.dimensions,
        providerOptions: options.providerOptions,
        headers: options.headers,
        signal: abortSignal(options.abortSignal, options.timeout),
      }), { maxRetries: options.maxRetries, signal: options.abortSignal })
      if (response.embeddings.length !== batches[index].length)
        throw new AIError(`${model.provider} returned ${response.embeddings.length} embeddings for ${batches[index].length} values`)
      results[index] = response.embeddings
      if (response.usage)
        tokens = (tokens ?? 0) + response.usage.tokens
    }
  }
  await Promise.all(Array.from({
    length: Math.min(options.maxParallelCalls ?? 4, batches.length),
  }, worker))
  return {
    embeddings: results.flat(),
    ...(tokens !== undefined && {
      usage: { tokens },
    }),
  }
}

/** 余弦相似度（-1 ~ 1） */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length)
    throw new AIError(`Vectors must have the same length (${a.length} vs ${b.length})`)
  let dot = 0
  let normA = 0
  let normB = 0
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index]
    normA += a[index] * a[index]
    normB += b[index] * b[index]
  }
  return normA === 0 || normB === 0
    ? 0
    : dot / (Math.sqrt(normA) * Math.sqrt(normB))
}
