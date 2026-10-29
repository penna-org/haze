import type { CacheStore } from '../store'
import { usePlatformBinding } from '../../platform'
import { appendElement } from '../store'

export interface KvStoreConfig {
  driver: 'kv'
  /** Workers 绑定名（默认 CACHE），或直接传入 KVNamespace */
  binding?: string | object
}

/** Cloudflare KVNamespace 中用到的部分（需要完整类型时断言为 `KVNamespace`） */
export interface KvNamespaceLike {
  get: (key: string) => Promise<string | null>
  getWithMetadata: <M>(key: string) => Promise<{ value: string | null, metadata: M | null }>
  put: (key: string, value: string, options?: { expirationTtl?: number, metadata?: unknown }) => Promise<void>
  delete: (key: string) => Promise<void>
  list: (options: { prefix: string, cursor?: string }) => Promise<{ keys: { name: string }[], list_complete: boolean, cursor?: string }>
}

/** KV 的过期时间最短 60 秒 */
const MIN_TTL = 60

/**
 * Cloudflare KV：最终一致（跨区域约 60 秒），同一键每秒最多写一次。
 * add / increment / deleteIf / push / touch 为“读后写”，不保证原子性；适合缓存与 Session，不适合精确限流与锁。
 * 有效期同时记在元数据的 expiresAt 中（KV 没有读取 TTL 的接口），ttl() 由它计算；
 * KV 也不能只改有效期，touch() 会连同值重新写入一次。
 */
export function kvStore(name: string, config: KvStoreConfig): CacheStore & { handler: () => KvNamespaceLike } {
  const kv = (): KvNamespaceLike => {
    const binding = typeof config.binding === 'object'
      ? config.binding
      : usePlatformBinding<object>(config.binding ?? 'CACHE')
    if (!binding)
      throw new Error(`Cache store "${name}": KV binding "${config.binding ?? 'CACHE'}" not found. KV is only available on Cloudflare Workers`)
    return binding as KvNamespaceLike
  }
  const options = (ttl: number | undefined, expiresAt?: number): { expirationTtl?: number, metadata?: unknown } => ttl === undefined
    ? {}
    : {
        expirationTtl: Math.max(MIN_TTL, Math.ceil(ttl)),
        metadata: { expiresAt: expiresAt ?? Date.now() + ttl * 1000 },
      }

  /** 读取值与过期时间（小于 60 秒的有效期由元数据判断） */
  const read = async (key: string): Promise<{ value: string, expiresAt: number | undefined } | undefined> => {
    const { value, metadata } = await kv().getWithMetadata<{ expiresAt?: number }>(key)
    if (value === null || (metadata?.expiresAt && metadata.expiresAt <= Date.now()))
      return undefined
    return { value, expiresAt: metadata?.expiresAt || undefined }
  }
  const rest = (expiresAt: number | undefined): number | undefined => expiresAt === undefined
    ? undefined
    : Math.max(0, (expiresAt - Date.now()) / 1000)

  return {
    driver: 'kv',
    atomic: false,
    async get(key) {
      return (await read(key))?.value
    },
    async set(key, value, ttl) {
      await kv().put(key, value, options(ttl))
    },
    async add(key, value, ttl) {
      if (await this.get(key) !== undefined)
        return false
      await this.set(key, value, ttl)
      return true
    },
    async delete(key) {
      const exists = await this.get(key) !== undefined
      await kv().delete(key)
      return exists
    },
    async increment(key, by, ttl) {
      const { value, metadata } = await kv().getWithMetadata<{ expiresAt?: number }>(key)
      const alive = value !== null && !(metadata?.expiresAt && metadata.expiresAt <= Date.now())
      const next = (alive
        ? Number(value)
        : 0) + by
      const expiresAt = alive
        ? metadata?.expiresAt
        : ttl === undefined
          ? undefined
          : Date.now() + ttl * 1000
      const rest = expiresAt === undefined
        ? undefined
        : Math.max(0, (expiresAt - Date.now()) / 1000)
      await kv().put(key, String(next), options(rest, expiresAt))
      return {
        value: next,
        ttl: rest === undefined
          ? undefined
          : Math.ceil(rest),
      }
    },
    async deleteIf(key, expected) {
      if (await this.get(key) !== expected)
        return false
      await kv().delete(key)
      return true
    },
    async clear(prefix) {
      let cursor: string | undefined
      do {
        const page = await kv().list({ prefix, cursor })
        await Promise.all(page.keys.map(item => kv().delete(item.name)))
        cursor = page.list_complete ? undefined : page.cursor
      } while (cursor)
    },
    async ttl(key) {
      const entry = await read(key)
      if (!entry)
        return null
      const seconds = rest(entry.expiresAt)
      return seconds === undefined
        ? undefined
        : Math.ceil(seconds)
    },
    async touch(key, ttl) {
      const entry = await read(key)
      if (!entry)
        return false
      await kv().put(key, entry.value, options(ttl))
      return true
    },
    async push(key, element, ttl) {
      const entry = await read(key)
      const value = appendElement(key, entry?.value, element)
      // 未指定 ttl 时保留原来的过期时间
      const expiresAt = ttl === undefined
        ? entry?.expiresAt
        : Date.now() + ttl * 1000
      await kv().put(key, value, options(rest(expiresAt), expiresAt))
    },
    handler: kv,
  }
}
