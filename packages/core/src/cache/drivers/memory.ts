import type { CacheStore } from '../store'
import { definePersistent } from '../../persistent'
import { appendElement } from '../store'
import { memoryCommands, wrongType } from './memory-commands'

/** 内存中的数据结构（模拟 Redis 的 hash / list / set / sorted set） */
export type MemoryStructure = { type: 'hash', data: Map<string, string> }
  | { type: 'list', data: string[] }
  | { type: 'set', data: Set<string> }
  | { type: 'zset', data: Map<string, number> }

/** 内存驱动的一项：普通值为序列化后的字符串，数据结构为 MemoryStructure；expiresAt 为毫秒时间戳 */
export interface MemoryCacheEntry {
  value: string | MemoryStructure
  expiresAt: number | undefined
}

/** 进程内缓存（跨热更新保留；多实例之间不共享）。另外模拟 Redis 的数据结构命令，测试中可以替代 redis 存储 */
export function memoryStore(name = 'memory'): CacheStore & { handler: () => Map<string, MemoryCacheEntry> } {
  const entries = definePersistent(`cache:memory:${name}`, () => new Map<string, MemoryCacheEntry>())
  let writes = 0

  const read = (key: string): MemoryCacheEntry | undefined => {
    const entry = entries.get(key)
    if (entry?.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      entries.delete(key)
      return undefined
    }
    return entry
  }
  /** 读取普通值；键上是数据结构时与 Redis 一样报 WRONGTYPE */
  const readString = (key: string): (MemoryCacheEntry & { value: string }) | undefined => {
    const entry = read(key)
    if (entry && typeof entry.value !== 'string')
      throw wrongType()
    return entry as (MemoryCacheEntry & { value: string }) | undefined
  }
  const write = (key: string, value: MemoryCacheEntry['value'], ttl?: number): void => {
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
  const remainingSeconds = (entry: MemoryCacheEntry): number | undefined => entry.expiresAt === undefined
    ? undefined
    : Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000))

  return {
    driver: 'memory',
    atomic: true,
    async get(key) {
      return readString(key)?.value
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
      return read(key) !== undefined && entries.delete(key)
    },
    async increment(key, by, ttl) {
      const entry = readString(key)
      const value = Number(entry?.value ?? 0) + by
      if (entry)
        entry.value = String(value)
      else
        write(key, String(value), ttl)
      return {
        value,
        ttl: remainingSeconds(entries.get(key)!),
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
    async ttl(key) {
      const entry = read(key)
      return entry
        ? remainingSeconds(entry)
        : null
    },
    async touch(key, ttl) {
      const entry = read(key)
      if (!entry)
        return false
      entry.expiresAt = ttl === undefined
        ? undefined
        : Date.now() + ttl * 1000
      return true
    },
    // 同步完成读与写，并发的 push 不会互相覆盖
    async push(key, element, ttl) {
      const entry = readString(key)
      const value = appendElement(key, entry?.value, element)
      if (entry && ttl === undefined)
        entry.value = value
      else
        write(key, value, ttl)
    },
    handler: () => entries,
    commands: memoryCommands(read, write, key => entries.delete(key)),
  }
}
