import type { KvStoreConfig } from './drivers/kv'
import type { RedisStoreConfig } from './drivers/redis'
import type { UpstashStoreConfig } from './drivers/upstash'
import type { CacheStore } from './store'

export interface MemoryStoreConfig {
  driver: 'memory'
}

export interface CustomStoreConfig {
  driver: 'custom'
  store: CacheStore
}

export type CacheStoreConfig = MemoryStoreConfig | RedisStoreConfig | UpstashStoreConfig | KvStoreConfig | CustomStoreConfig

export interface CacheConfig {
  /** 默认存储，默认 memory */
  default: string
  /** 键前缀（多个应用共用 Redis 时区分），默认 `haze:` */
  prefix?: string
  stores: Record<string, CacheStoreConfig>
  /** cacheResponse 中间件使用的存储，默认为 default */
  responseStore?: string
}

export const defaultCacheConfig: CacheConfig = {
  default: 'memory',
  prefix: 'haze:',
  stores: {
    memory: { driver: 'memory' },
  },
}

/** `config/cache.ts` 的默认导出 */
export function defineCacheConfig(config: CacheConfig | (() => CacheConfig)): CacheConfig | (() => CacheConfig) {
  return config
}
