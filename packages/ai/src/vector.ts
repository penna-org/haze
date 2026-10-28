import type { ModelRef } from './registry'
import type { Tool } from './tool'
import type { EmbeddingModel } from './types'
import { cosineSimilarity, embed, embedMany } from './embed'
import { AIError } from './errors'
import { jsonSchema } from './schema'
import { defineTool } from './tool'

export type Metadata = Record<string, unknown>

export interface VectorRecord<M extends Metadata = Metadata> {
  id: string
  content: string
  embedding: number[]
  metadata?: M
}

export interface VectorMatch<M extends Metadata = Metadata> {
  record: VectorRecord<M>
  /** 余弦相似度（-1 ~ 1） */
  score: number
}

export interface VectorQuery<M extends Metadata = Metadata> {
  /** 返回的条数，默认 5 */
  topK?: number
  /** 低于该相似度的结果丢弃 */
  minScore?: number
  /** 元数据过滤：键值相等，或自定义函数 */
  filter?: Partial<M> | ((metadata: M) => boolean)
}

/** 向量存储：内置内存实现；数据库（pgvector、Qdrant 等）实现此接口即可接入 */
export interface VectorStore<M extends Metadata = Metadata> {
  upsert: (records: VectorRecord<M>[]) => Promise<void>
  query: (embedding: number[], options?: VectorQuery<M>) => Promise<VectorMatch<M>[]>
  delete: (ids: string[]) => Promise<void>
  /** 记录条数 */
  count: () => Promise<number>
}

function matches<M extends Metadata>(metadata: M, filter: VectorQuery<M>['filter']): boolean {
  if (!filter)
    return true
  if (typeof filter === 'function')
    return filter(metadata)
  return Object.entries(filter).every(([key, value]) => metadata[key] === value)
}

/** 进程内的向量存储（开发、测试、小规模数据） */
export function createMemoryVectorStore<M extends Metadata = Metadata>(): VectorStore<M> & { readonly records: Map<string, VectorRecord<M>> } {
  const records = new Map<string, VectorRecord<M>>()
  return {
    records,
    async upsert(items) {
      for (const item of items)
        records.set(item.id, item)
    },
    async query(embedding, options = {}) {
      const results: VectorMatch<M>[] = []
      for (const record of records.values()) {
        if (!matches(record.metadata ?? {} as M, options.filter))
          continue
        const score = cosineSimilarity(embedding, record.embedding)
        if (options.minScore === undefined || score >= options.minScore)
          results.push({ record, score })
      }
      return results.sort((a, b) => b.score - a.score).slice(0, options.topK ?? 5)
    },
    async delete(ids) {
      for (const id of ids)
        records.delete(id)
    },
    async count() {
      return records.size
    },
  }
}

export interface SplitOptions {
  /** 每段的最大字符数，默认 1000 */
  chunkSize?: number
  /** 相邻段重叠的字符数，默认 100 */
  overlap?: number
}

/** 按段落 → 句子 → 字符切分文本，尽量在自然边界处断开 */
export function splitText(text: string, options: SplitOptions = {}): string[] {
  const size = options.chunkSize ?? 1000
  const overlap = Math.min(options.overlap ?? 100, Math.floor(size / 2))
  const normalized = text.replace(/\r\n/g, '\n').trim()
  if (!normalized)
    return []
  if (normalized.length <= size)
    return [normalized]
  const chunks: string[] = []
  let start = 0
  while (start < normalized.length) {
    let end = Math.min(start + size, normalized.length)
    if (end < normalized.length) {
      const window = normalized.slice(start, end)
      // 优先在段落、句末（中英文标点）、空白处断开
      const cut = Math.max(window.lastIndexOf('\n\n'), ...['。', '！', '？', '. ', '! ', '? ', '\n'].map(mark => window.lastIndexOf(mark)))
      if (cut > size * 0.5)
        end = start + cut + 1
      else if (window.lastIndexOf(' ') > size * 0.5)
        end = start + window.lastIndexOf(' ')
    }
    chunks.push(normalized.slice(start, end).trim())
    if (end >= normalized.length)
      break
    start = Math.max(end - overlap, start + 1)
  }
  return chunks.filter(Boolean)
}

export interface KnowledgeDocument<M extends Metadata = Metadata> {
  /** 文档 ID；切分后的段为 `${id}#${序号}` */
  id?: string
  content: string
  metadata?: M
}

export interface KnowledgeBaseOptions<M extends Metadata = Metadata> {
  model?: ModelRef<EmbeddingModel>
  /** 默认内存存储 */
  store?: VectorStore<M>
  /** 文档切分方式，false 表示不切分 */
  split?: SplitOptions | false
}

export interface KnowledgeBase<M extends Metadata = Metadata> {
  readonly store: VectorStore<M>
  /** 切分、向量化并写入；返回写入的段 ID */
  add: (documents: Array<KnowledgeDocument<M> | string>) => Promise<string[]>
  search: (query: string, options?: VectorQuery<M>) => Promise<VectorMatch<M>[]>
  remove: (ids: string[]) => Promise<void>
  /** 作为工具交给模型检索（RAG） */
  asTool: (options?: { description?: string, topK?: number }) => Tool<{ query: string }, Array<{ content: string, score: number, metadata?: M }>>
}

let documentCounter = 0

/**
 * 知识库（RAG）：文档切分 → embedding → 向量存储 → 检索。
 *
 * ```ts
 * const docs = createKnowledgeBase({ model: 'openai:text-embedding-3-small' })
 * await docs.add([{ id: 'refund-policy', content: policyText }])
 * await generateText({ model, prompt, tools: { searchDocs: docs.asTool() } })
 * ```
 */
export function createKnowledgeBase<M extends Metadata = Metadata>(options: KnowledgeBaseOptions<M> = {}): KnowledgeBase<M> {
  const store = options.store ?? createMemoryVectorStore<M>()
  const base: KnowledgeBase<M> = {
    store,
    async add(documents) {
      const pieces: Array<{ id: string, content: string, metadata?: M }> = []
      for (const input of documents) {
        const document = typeof input === 'string'
          ? { content: input }
          : input
        const id = document.id ?? `doc-${Date.now().toString(36)}-${++documentCounter}`
        const chunks = options.split === false
          ? [document.content]
          : splitText(document.content, options.split)
        chunks.forEach((content, index) => pieces.push({
          id: chunks.length === 1
            ? id
            : `${id}#${index}`,
          content,
          metadata: document.metadata,
        }))
      }
      if (!pieces.length)
        return []
      const { embeddings } = await embedMany({
        model: options.model,
        values: pieces.map(piece => piece.content),
      })
      await store.upsert(pieces.map((piece, index) => ({ ...piece, embedding: embeddings[index] })))
      return pieces.map(piece => piece.id)
    },
    async search(query, searchOptions) {
      if (!query.trim())
        throw new AIError('Search query must not be empty')
      const { embedding } = await embed({ model: options.model, value: query })
      return store.query(embedding, searchOptions)
    },
    async remove(ids) {
      await store.delete(ids)
    },
    asTool(toolOptions = {}) {
      return defineTool({
        description: toolOptions.description ?? 'Search the knowledge base for passages relevant to a query',
        parameters: jsonSchema<{ query: string }>({
          type: 'object',
          properties: {
            query: { type: 'string', description: 'What to search for' },
          },
          required: ['query'],
          additionalProperties: false,
        }),
        execute: async ({ query }) => (await base.search(query, { topK: toolOptions.topK ?? 5 })).map(match => ({
          content: match.record.content,
          score: Math.round(match.score * 1000) / 1000,
          ...(match.record.metadata && { metadata: match.record.metadata }),
        })),
      })
    },
  }
  return base
}
