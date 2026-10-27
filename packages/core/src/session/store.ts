import type { CacheRepository } from '../cache/repository'
import { definePersistent } from '../persistent'

export type SessionData = Record<string, unknown>

/** Session 服务端存储（memory / 自定义的 Redis、KV、数据库等） */
export interface SessionStore {
  get: (id: string) => Promise<SessionData | undefined>
  /** ttl：秒 */
  set: (id: string, data: SessionData, ttl: number) => Promise<void>
  destroy: (id: string) => Promise<void>
}

/** 进程内存储：单实例部署 / 开发测试使用（跨热更新保留，多实例之间不共享） */
export function memorySessionStore(): SessionStore {
  const entries = definePersistent('session:memory', () => new Map<string, { data: SessionData, expiresAt: number }>())
  return {
    async get(id) {
      const entry = entries.get(id)
      if (!entry)
        return undefined
      if (entry.expiresAt <= Date.now()) {
        entries.delete(id)
        return undefined
      }
      return structuredClone(entry.data)
    },
    async set(id, data, ttl) {
      entries.set(id, {
        data: structuredClone(data),
        expiresAt: Date.now() + ttl * 1000,
      })
      // 惰性清理过期会话
      if (entries.size % 1000 === 0) {
        const now = Date.now()
        for (const [key, entry] of entries) {
          if (entry.expiresAt <= now)
            entries.delete(key)
        }
      }
    },
    async destroy(id) {
      entries.delete(id)
    },
  }
}

/** 基于缓存存储的会话（Redis / Upstash / KV 等，多实例共享）：`{ driver: 'cache', store: 'redis' }` */
export function cacheSessionStore(cache: CacheRepository): SessionStore {
  return {
    get: id => cache.get<SessionData>(`session:${id}`),
    set: (id, data, ttl) => cache.set(`session:${id}`, data, ttl),
    destroy: async (id) => {
      await cache.forget(`session:${id}`)
    },
  }
}
