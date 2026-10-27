import type { CacheStore } from '../store'
import { definePersistent } from '../../persistent'

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

export interface RedisStoreConfig {
  driver: 'redis'
  /** redis://[:password@]host:port/db，默认 redis://127.0.0.1:6379 */
  url?: string
  /** 传给 ioredis 的选项（Cluster / Sentinel 等请改用 client） */
  options?: Record<string, unknown>
  /** 直接使用已创建的 ioredis 实例 */
  client?: unknown
}

interface IORedisLike {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string, ...args: (string | number)[]) => Promise<string | null>
  del: (...keys: string[]) => Promise<number>
  eval: (script: string, keys: number, ...args: (string | number)[]) => Promise<unknown>
  scan: (cursor: string, ...args: (string | number)[]) => Promise<[string, string[]]>
  quit: () => Promise<unknown>
}

async function connect(config: RedisStoreConfig): Promise<IORedisLike> {
  if (config.client)
    return config.client as IORedisLike
  type RedisClass = new (url: string, options?: Record<string, unknown>) => IORedisLike
  let module: { default?: RedisClass, Redis?: RedisClass }
  try {
    module = await import('ioredis') as never
  }
  catch (error) {
    throw new Error('Cache driver "redis" requires ioredis. Install it with: pnpm add ioredis', { cause: error })
  }
  const Redis = (module.Redis ?? module.default)!
  return new Redis(config.url ?? 'redis://127.0.0.1:6379', { lazyConnect: false, maxRetriesPerRequest: 2, ...config.options })
}

/** ioredis 驱动：连接跨热更新复用，应用关闭时断开 */
export function redisStore(name: string, config: RedisStoreConfig): CacheStore {
  const connections = definePersistent('cache:redis', () => new Map<string, Promise<IORedisLike>>(), {
    dispose: async (pool) => {
      await Promise.all([
        ...pool.values(),
      ].map(async client => (await client.catch(() => undefined))?.quit().catch(() => undefined)))
      pool.clear()
    },
  })
  const id = `${name}:${config.url ?? ''}`
  const client = (): Promise<IORedisLike> => {
    let connection = connections.get(id)
    if (!connection) {
      connection = connect(config)
      connections.set(id, connection)
      connection.catch(() => connections.delete(id))
    }
    return connection
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
      let cursor = '0'
      do {
        const [next, keys] = await redis.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 500)
        cursor = next
        if (keys.length)
          await redis.del(...keys)
      } while (cursor !== '0')
    },
  }
}
