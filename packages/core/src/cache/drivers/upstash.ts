import type { CacheStore } from '../store'
import { DELETE_IF_SCRIPT, expireSeconds, INCREMENT_SCRIPT, PUSH_SCRIPT, pushError, remaining, TOUCH_SCRIPT, ttlResult } from './redis'

export interface UpstashStoreConfig {
  driver: 'upstash'
  /** UPSTASH_REDIS_REST_URL */
  url: string
  /** UPSTASH_REDIS_REST_TOKEN */
  token: string
}

/** @upstash/redis 客户端的结构（core 不依赖它的类型；需要完整类型时断言为 `import('@upstash/redis').Redis`） */
export interface UpstashClientLike {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string, options?: { ex?: number, nx?: boolean }) => Promise<string | null>
  del: (...keys: string[]) => Promise<number>
  eval: (script: string, keys: string[], args: (string | number)[]) => Promise<unknown>
  scan: (cursor: string | number, options: { match: string, count: number }) => Promise<[string | number, string[]]>
  ttl: (key: string) => Promise<number>
  [command: string]: any
}

/** Upstash（Redis over HTTP）：无长连接，可运行于 Edge / Serverless */
export function upstashStore(config: UpstashStoreConfig): CacheStore & { handler: () => Promise<UpstashClientLike> } {
  let client: Promise<UpstashClientLike> | undefined
  const redis = (): Promise<UpstashClientLike> => {
    client ??= import('@upstash/redis').then(
      ({ Redis }) => new Redis({ url: config.url, token: config.token, automaticDeserialization: false }) as unknown as UpstashClientLike,
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
            ex: expireSeconds(ttl),
          })
    },
    async add(key, value, ttl) {
      return (await (await redis()).set(key, value, {
        nx: true,
        ...(ttl !== undefined && {
          ex: expireSeconds(ttl),
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
          : expireSeconds(ttl),
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
    async ttl(key) {
      return ttlResult(Number(await (await redis()).ttl(key)))
    },
    async touch(key, ttl) {
      return Number(await (await redis()).eval(TOUCH_SCRIPT, [key], [
        ttl === undefined
          ? -1
          : expireSeconds(ttl),
      ])) > 0
    },
    async push(key, element, ttl) {
      try {
        await (await redis()).eval(PUSH_SCRIPT, [key], [
          element,
          ttl === undefined
            ? 0
            : expireSeconds(ttl),
        ])
      }
      catch (error) {
        throw pushError(key, error)
      }
    },
    handler: redis,
  }
}
