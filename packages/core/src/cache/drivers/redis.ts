import type { RedisConnectionName, RedisConnectionRef } from '../../redis/config'
import type { RedisManager, RedisTarget } from '../../redis/manager'
import type { CacheStore } from '../store'
import { useRedisManager } from '../../redis/manager'

/** INCRBY 与首次设置过期在同一个脚本中完成（原子） */
export const INCREMENT_SCRIPT = `local value = redis.call('INCRBY', KEYS[1], ARGV[1])
if tonumber(ARGV[2]) > 0 and redis.call('TTL', KEYS[1]) == -1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return {value, redis.call('TTL', KEYS[1])}`

export const DELETE_IF_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`

/** Redis 的 TTL：-1 永久，-2 不存在 */
export function remaining(ttl: number): number | undefined {
  return ttl < 0
    ? undefined
    : ttl
}

export interface RedisStoreConfig extends RedisConnectionRef {
  driver: 'redis'
  /**
   * config/redis.ts 中的连接名，默认为其 default 连接（REDIS_URL）。
   * 连接的 keyPrefix 加在缓存前缀（config/cache.ts 的 prefix）之前
   */
  connection?: RedisConnectionName
  /** 内联地址（旧写法）：redis://[:password@]host:port/db，设置后不使用命名连接 */
  url?: string
  /** 传给 ioredis 的选项：与 url 一起时为内联连接的选项，与 connection 一起时覆盖命名连接的选项 */
  options?: Record<string, unknown>
  /** 直接使用已创建的 ioredis 实例 */
  client?: unknown
}

interface IORedisLike {
  readonly options?: { keyPrefix?: string }
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string, ...args: (string | number)[]) => Promise<string | null>
  del: (...keys: string[]) => Promise<number>
  eval: (script: string, keys: number, ...args: (string | number)[]) => Promise<unknown>
  scan: (cursor: string, ...args: (string | number)[]) => Promise<[string, string[]]>
}

const FEATURE = 'Cache driver "redis"'

/**
 * ioredis 驱动：使用 RedisManager 的共享命令连接（跨热更新复用，应用关闭时断开）。
 * 内联 url 的旧写法保持原来的默认选项（maxRetriesPerRequest: 2，Redis 不可用时尽快失败）。
 */
export function redisStore(_name: string, config: RedisStoreConfig, redis: RedisManager = useRedisManager()): CacheStore {
  const target: RedisTarget = config.client
    ? { client: config.client }
    : config.url
      ? {
          url: config.url,
          options: { lazyConnect: false, maxRetriesPerRequest: 2, ...config.options },
        }
      : { connection: config.connection, options: config.options }
  const client = async (): Promise<IORedisLike> => await redis.client(target, FEATURE) as unknown as IORedisLike

  return {
    driver: 'redis',
    atomic: true,
    async get(key) {
      return (await (await client()).get(key)) ?? undefined
    },
    async set(key, value, ttl) {
      const redis = await client()
      if (ttl === undefined)
        await redis.set(key, value)
      else
        await redis.set(key, value, 'EX', Math.max(1, Math.ceil(ttl)))
    },
    async add(key, value, ttl) {
      const redis = await client()
      const result = ttl === undefined
        ? await redis.set(key, value, 'NX')
        : await redis.set(key, value, 'EX', Math.max(1, Math.ceil(ttl)), 'NX')
      return result === 'OK'
    },
    async delete(key) {
      return (await (await client()).del(key)) > 0
    },
    async increment(key, by, ttl) {
      const [value, rest] = await (await client()).eval(INCREMENT_SCRIPT, 1, key, by, ttl === undefined
        ? 0
        : Math.max(1, Math.ceil(ttl))) as [number, number]
      return {
        value: Number(value),
        ttl: remaining(Number(rest)),
      }
    },
    async deleteIf(key, expected) {
      return Number(await (await client()).eval(DELETE_IF_SCRIPT, 1, key, expected)) > 0
    },
    async clear(prefix) {
      const redis = await client()
      // ioredis 的 keyPrefix 不作用于 SCAN 的模式，返回的键也带着它；DEL 时会再加一次，先去掉
      const keyPrefix = redis.options?.keyPrefix ?? ''
      let cursor = '0'
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${keyPrefix}${prefix}*`, 'COUNT', 500)
        cursor = next
        if (keys.length) {
          await redis.del(...keys.map(key => key.startsWith(keyPrefix)
            ? key.slice(keyPrefix.length)
            : key))
        }
      } while (cursor !== '0')
    },
  }
}
