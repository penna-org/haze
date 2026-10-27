import type { CacheStore } from '../store'
import { DELETE_IF_SCRIPT, INCREMENT_SCRIPT, remaining } from './redis'

export interface UpstashStoreConfig {
  driver: 'upstash'
  /** UPSTASH_REDIS_REST_URL */
  url: string
  /** UPSTASH_REDIS_REST_TOKEN */
  token: string
}

interface UpstashLike {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string, options?: { ex?: number, nx?: boolean }) => Promise<string | null>
  del: (...keys: string[]) => Promise<number>
  eval: (script: string, keys: string[], args: (string | number)[]) => Promise<unknown>
  scan: (cursor: string | number, options: { match: string, count: number }) => Promise<[string | number, string[]]>
}

/** Upstash（Redis over HTTP）：无长连接，可运行于 Edge / Serverless */
export function upstashStore(config: UpstashStoreConfig): CacheStore {
  let client: Promise<UpstashLike> | undefined
  const redis = (): Promise<UpstashLike> => {
    client ??= import('@upstash/redis').then(
      ({ Redis }) => new Redis({ url: config.url, token: config.token, automaticDeserialization: false }) as unknown as UpstashLike,
      (error) => {
        client = undefined
        throw new Error('Cache driver "upstash" requires @upstash/redis. Install it with: pnpm add @upstash/redis', { cause: error })
      },
    )
    return client
  }

  return {
    driver: 'upstash',
    atomic: true,
    async get(key) {
      return (await (await redis()).get(key)) ?? undefined
    },
    async set(key, value, ttl) {
      await (await redis()).set(key, value, ttl === undefined
        ? undefined
        : {
            ex: Math.max(1, Math.ceil(ttl)),
          })
    },
    async add(key, value, ttl) {
      return (await (await redis()).set(key, value, {
        nx: true,
        ...(ttl !== undefined && {
          ex: Math.max(1, Math.ceil(ttl)),
        }),
      })) === 'OK'
    },
    async delete(key) {
      return (await (await redis()).del(key)) > 0
    },
    async increment(key, by, ttl) {
      const [value, rest] = await (await redis()).eval(INCREMENT_SCRIPT, [key], [
        by,
        ttl === undefined
          ? 0
          : Math.max(1, Math.ceil(ttl)),
      ]) as [number, number]
      return {
        value: Number(value),
        ttl: remaining(Number(rest)),
      }
    },
    async deleteIf(key, expected) {
      return Number(await (await redis()).eval(DELETE_IF_SCRIPT, [key], [expected])) > 0
    },
    async clear(prefix) {
      const client = await redis()
      let cursor: string | number = 0
      do {
        const [next, keys] = await client.scan(cursor, { match: `${prefix}*`, count: 500 })
        cursor = next
        if (keys.length)
          await client.del(...keys)
      } while (String(cursor) !== '0')
    },
  }
}
