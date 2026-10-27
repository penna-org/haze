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
