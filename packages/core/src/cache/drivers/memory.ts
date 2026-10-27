import type { CacheStore } from '../store'
import { definePersistent } from '../../persistent'

interface Entry {
  value: string
  expiresAt: number | undefined
}

/** 进程内缓存（跨热更新保留；多实例之间不共享） */
export function memoryStore(name = 'memory'): CacheStore {
  const entries = definePersistent(`cache:memory:${name}`, () => new Map<string, Entry>())
  let writes = 0

  const read = (key: string): Entry | undefined => {
    const entry = entries.get(key)
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      entries.delete(key)
      return undefined
    }
    return entry
  }
  const write = (key: string, value: string, ttl?: number): void => {
    entries.set(key, {
      value,
      expiresAt: ttl === undefined
        ? undefined
        : Date.now() + ttl * 1000,
    })
    // 惰性清理过期项
    if (++writes % 1000 === 0) {
      const now = Date.now()
      for (const [name, entry] of entries) {
        if (entry.expiresAt !== undefined && entry.expiresAt <= now)
          entries.delete(name)
      }
    }
  }

  return {
    driver: 'memory',
    atomic: true,
    async get(key) {
      return read(key)?.value
    },
    async set(key, value, ttl) {
      write(key, value, ttl)
    },
    async add(key, value, ttl) {
      if (read(key))
        return false
      write(key, value, ttl)
      return true
    },
    async delete(key) {
      return entries.delete(key)
    },
    async increment(key, by, ttl) {
      const entry = read(key)
      const value = Number(entry?.value ?? 0) + by
      if (entry)
        entry.value = String(value)
      else
        write(key, String(value), ttl)
      const expiresAt = entries.get(key)!.expiresAt
      return {
        value,
        ttl: expiresAt === undefined
          ? undefined
          : Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000)),
      }
    },
    async deleteIf(key, expected) {
      if (read(key)?.value !== expected)
        return false
      return entries.delete(key)
    },
    async clear(prefix) {
      for (const key of [
        ...entries.keys(),
      ]) {
        if (key.startsWith(prefix))
          entries.delete(key)
      }
    },
  }
}
