import type { DataContent, Message } from './types'
import { toBase64 } from './data'

/** 对话记忆：按会话 ID 保存消息历史 */
export interface ConversationMemory {
  load: (conversationId: string) => Promise<Message[]>
  append: (conversationId: string, messages: Message[]) => Promise<void>
  clear: (conversationId: string) => Promise<void>
}

export interface MemoryOptions {
  /** 最多保留的消息条数（从一条用户消息处截断，不会拆开工具调用与结果），默认不限制 */
  maxMessages?: number
}

/** 截断到最近的 maxMessages 条，起点对齐到用户消息 */
export function trimMessages(messages: Message[], maxMessages: number | undefined): Message[] {
  if (!maxMessages || messages.length <= maxMessages)
    return messages
  let start = messages.length - maxMessages
  while (start < messages.length && messages[start].role !== 'user')
    start++
  return messages.slice(start)
}

function serializeData(data: DataContent, mediaType?: string): string {
  if (typeof data === 'string')
    return data
  if (data instanceof URL)
    return data.href
  const bytes = data instanceof Uint8Array
    ? data
    : new Uint8Array(data)
  return `data:${mediaType ?? 'application/octet-stream'};base64,${toBase64(bytes)}`
}

/** 把消息中的二进制数据转为 data: URL，便于 JSON 存储（缓存、数据库） */
export function serializeMessages(messages: Message[]): Message[] {
  return messages.map((message) => {
    if (message.role !== 'user' || typeof message.content === 'string')
      return message
    return {
      ...message,
      content: message.content.map((part) => {
        if (part.type === 'image') {
          return {
            ...part,
            image: serializeData(part.image, part.mediaType),
          }
        }
        if (part.type === 'file') {
          return {
            ...part,
            data: serializeData(part.data, part.mediaType),
          }
        }
        return part
      }),
    }
  })
}

/** 进程内的对话记忆（开发、测试、单实例） */
export function memoryConversationStore(options: MemoryOptions = {}): ConversationMemory {
  const conversations = new Map<string, Message[]>()
  return {
    async load(id) {
      return [
        ...(conversations.get(id) ?? []),
      ]
    },
    async append(id, messages) {
      conversations.set(id, trimMessages([
        ...(conversations.get(id) ?? []),
        ...messages,
      ], options.maxMessages))
    },
    async clear(id) {
      conversations.delete(id)
    },
  }
}

/** 键值缓存的最小接口（与 hazejs 的 Cache / CacheRepository 兼容） */
export interface CacheLike {
  get: <T = unknown>(key: string) => Promise<T | undefined | null>
  set: (key: string, value: unknown, ttl?: number | string) => Promise<unknown>
  forget: (key: string) => Promise<unknown>
}

/**
 * 基于缓存的对话记忆（多实例共享，配合 hazejs 的 redis / upstash / kv 缓存）：
 *
 * ```ts
 * const memory = cacheConversationStore(Cache.store('redis'), { ttl: '7d', maxMessages: 50 })
 * ```
 */
export function cacheConversationStore(cache: CacheLike, options: MemoryOptions & { prefix?: string, ttl?: number | string } = {}): ConversationMemory {
  const key = (id: string): string => `${options.prefix ?? 'ai:conversation:'}${id}`
  return {
    async load(id) {
      return (await cache.get<Message[]>(key(id))) ?? []
    },
    async append(id, messages) {
      const history = (await cache.get<Message[]>(key(id))) ?? []
      await cache.set(key(id), trimMessages([
        ...history,
        ...serializeMessages(messages),
      ], options.maxMessages), options.ttl)
    },
    async clear(id) {
      await cache.forget(key(id))
    },
  }
}
