import type { KvStoreConfig } from './drivers/kv'
import type { RedisStoreConfig } from './drivers/redis'
import type { UpstashStoreConfig } from './drivers/upstash'
import type { CacheSerializerOption } from './serializer'
import type { CacheStore } from './store'

export interface MemoryStoreConfig {
  driver: 'memory'
}

export interface CustomStoreConfig {
  driver: 'custom'
  store: CacheStore
}

/** 每个存储都可以单独设置的选项 */
export interface CacheStoreOptions {
  /** 值的序列化方式，默认为全局的 serializer（`'typed'`） */
  serializer?: CacheSerializerOption
}

export type CacheStoreConfig = (MemoryStoreConfig | RedisStoreConfig | UpstashStoreConfig | KvStoreConfig | CustomStoreConfig) & CacheStoreOptions

export interface CacheConfig<Name extends string = string> {
  /** 默认存储，默认 memory */
  default: string
  /** 键前缀（多个应用共用 Redis 时区分），默认 `haze:` */
  prefix?: string
  stores: Record<Name, CacheStoreConfig>
  /** cacheResponse 中间件使用的存储，默认为 default */
  responseStore?: string
  /**
   * 值的序列化方式（各存储可以覆盖）：
   * - `'typed'`（默认）：JSON，另外还原 Date、BigInt、Map、Set，仍是合法的 JSON；
   * - `'json'`：纯 JSON（Date 读回为字符串，BigInt 写为字符串）；
   * - `{ serialize, deserialize }`：自定义。
   */
  serializer?: CacheSerializerOption
}

export const defaultCacheConfig: CacheConfig = {
  default: 'memory',
  prefix: 'haze:',
  stores: {
    memory: { driver: 'memory' },
  },
}

/**
 * `config/cache.ts` 的默认导出；存储名与驱动会进入生成的类型
 * （`Cache.store('redis')` 为 RedisCacheRepository，拼错存储名时报错）
 */
export function defineCacheConfig<const S extends Record<string, CacheStoreConfig | undefined>>(
  config: CacheConfigInput<S> | (() => CacheConfigInput<S>),
): CacheConfigInput<S> | (() => CacheConfigInput<S>) {
  return config
}

/**
 * defineCacheConfig 的参数：stores 允许按条件展开的存储（`...(redis ? { locks: {...} } : {})`，
 * 未展开时该存储不存在，使用时报“未定义”）
 */
export type CacheConfigInput<S extends Record<string, CacheStoreConfig | undefined>> = Omit<CacheConfig<keyof S & string>, 'stores'> & { stores: S }
