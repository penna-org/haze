import type { RedisConnectionName, RedisConnectionRef } from '../../redis/config'
import type { RedisClient } from '../../redis/load'
import type { RedisManager, RedisTarget } from '../../redis/manager'
import type { CacheStore } from '../store'
import { useRedisManager } from '../../redis/manager'
import { notAnArray } from '../store'

/** INCRBY 与首次设置过期在同一个脚本中完成（原子） */
export const INCREMENT_SCRIPT = `local value = redis.call('INCRBY', KEYS[1], ARGV[1])
if tonumber(ARGV[2]) > 0 and redis.call('TTL', KEYS[1]) == -1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end
return {value, redis.call('TTL', KEYS[1])}`

export const DELETE_IF_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`

/**
 * 向 JSON 数组字符串追加一个元素（原子）：只检查首尾的 `[` `]`，用 SETRANGE 写在末尾，
 * 不解析、不重新编码（cjson 会改变数字精度与空数组），也不需要把整个值读出来；SETRANGE 保留原有效期。
 * ARGV[1] 为已编码的元素，ARGV[2] 为有效期（秒，0 表示不修改；新建时为永久）
 */
export const PUSH_SCRIPT = `local length = redis.call('STRLEN', KEYS[1])
local ttl = tonumber(ARGV[2])
if length == 0 then
  if ttl > 0 then redis.call('SET', KEYS[1], '[' .. ARGV[1] .. ']', 'EX', ttl) else redis.call('SET', KEYS[1], '[' .. ARGV[1] .. ']') end
  return 1
end
if redis.call('GETRANGE', KEYS[1], 0, 0) ~= '[' or redis.call('GETRANGE', KEYS[1], -1, -1) ~= ']' then
  return redis.error_reply('NOTARRAY cache item is not an array')
end
if length == 2 then redis.call('SETRANGE', KEYS[1], 1, ARGV[1] .. ']') else redis.call('SETRANGE', KEYS[1], length - 1, ',' .. ARGV[1] .. ']') end
if ttl > 0 then redis.call('EXPIRE', KEYS[1], ttl) end
return 1`

/** 修改有效期：ARGV[1] 为秒数，-1 表示改为永久；返回键是否存在 */
export const TOUCH_SCRIPT = `local ttl = tonumber(ARGV[1])
if ttl >= 0 then return redis.call('EXPIRE', KEYS[1], ttl) end
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('PERSIST', KEYS[1])
return 1`

/** Redis 的 TTL：-1 永久，-2 不存在 */
export function remaining(ttl: number): number | undefined {
  return ttl < 0
    ? undefined
    : ttl
}

/** TTL 命令的结果转为 ttl()：不存在为 null，永久为 undefined */
export function ttlResult(ttl: number): number | undefined | null {
  return ttl === -2
    ? null
    : remaining(ttl)
}

/** Redis 的过期秒数至少为 1 */
export function expireSeconds(ttl: number): number {
  return Math.max(1, Math.ceil(ttl))
}

/** 脚本的 NOTARRAY 错误转为 push 的类型错误 */
export function pushError(key: string, error: unknown): unknown {
  return String((error as Error)?.message ?? error).includes('NOTARRAY')
    ? notAnArray(key)
    : error
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

const FEATURE = 'Cache driver "redis"'

/**
 * ioredis 驱动：使用 RedisManager 的共享命令连接（跨热更新复用，应用关闭时断开）。
 * 内联 url 的旧写法保持原来的默认选项（maxRetriesPerRequest: 2，Redis 不可用时尽快失败）。
 */
export function redisStore(_name: string, config: RedisStoreConfig, redis: RedisManager = useRedisManager()): CacheStore & { handler: () => Promise<RedisClient> } {
  const target: RedisTarget = config.client
    ? { client: config.client }
    : config.url
      ? {
          url: config.url,
          options: { lazyConnect: false, maxRetriesPerRequest: 2, ...config.options },
        }
      : { connection: config.connection, options: config.options }
  const client = async (): Promise<RedisClient> => redis.client(target, FEATURE)
  /** 逐个删除（Cluster 上多键 DEL 要求同一个槽） */
  const deleteEach = async (client: RedisClient, keys: string[]): Promise<void> => {
    for (let index = 0; index < keys.length; index += 100)
      await Promise.all(keys.slice(index, index + 100).map(key => client.del(key)))
  }

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
        await redis.set(key, value, 'EX', expireSeconds(ttl))
    },
    async add(key, value, ttl) {
      const redis = await client()
      const result = ttl === undefined
        ? await redis.set(key, value, 'NX')
        : await redis.set(key, value, 'EX', expireSeconds(ttl), 'NX')
      return result === 'OK'
    },
    async delete(key) {
      return (await (await client()).del(key)) > 0
    },
    async increment(key, by, ttl) {
      const [value, rest] = await (await client()).eval(INCREMENT_SCRIPT, 1, key, by, ttl === undefined
        ? 0
        : expireSeconds(ttl)) as [number, number]
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
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${keyPrefix}${prefix}*`, 'COUNT', 500) as [string, string[]]
        cursor = next
        if (keys.length) {
          await redis.del(...keys.map(key => key.startsWith(keyPrefix)
            ? key.slice(keyPrefix.length)
            : key))
        }
      } while (cursor !== '0')
    },
    async ttl(key) {
      return ttlResult(Number(await (await client()).ttl(key)))
    },
    async touch(key, ttl) {
      return Number(await (await client()).eval(TOUCH_SCRIPT, 1, key, ttl === undefined
        ? -1
        : expireSeconds(ttl))) > 0
    },
    async push(key, element, ttl) {
      try {
        await (await client()).eval(PUSH_SCRIPT, 1, key, element, ttl === undefined
          ? 0
          : expireSeconds(ttl))
      }
      catch (error) {
        throw pushError(key, error)
      }
    },
    handler: client,
    commands: {
      async call(command, key, ...args) {
        return (await client())[command](key, ...args)
      },
      async batch(commands) {
        const results = await (await client()).multi(commands).exec() as Array<[Error | null, unknown]> | null
        return (results ?? []).map(([error, result]) => {
          if (error)
            throw error
          return result
        })
      },
    },
    tags: {
      // 有序集合：成员为键，分数为过期时间（永久为 +inf），写入时顺带清掉已过期的成员
      async track(indexKeys, key, ttl) {
        const redis = await client()
        const now = Date.now() / 1000
        await Promise.all(indexKeys.map(async (indexKey) => {
          await redis.zadd(indexKey, ttl === undefined
            ? '+inf'
            : now + ttl, key)
          await redis.zremrangebyscore(indexKey, '-inf', `(${now}`)
        }))
      },
      async flush(indexKeys) {
        const redis = await client()
        for (const indexKey of indexKeys) {
          const keys = await redis.zrange(indexKey, 0, -1) as string[]
          await deleteEach(redis, keys)
          await redis.del(indexKey)
        }
      },
    },
  }
}
