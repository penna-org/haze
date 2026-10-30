import type { CacheRepository } from '../../cache/repository'
import type { HttpContext } from '../../http/context'
import type { MaybePromise } from '../../utils'
import type { MiddlewareHandler } from '../types'
import { CacheManager } from '../../cache/manager'
import { TooManyRequestsException } from '../../exception/exceptions'
import { definePersistent } from '../../persistent'
import { usePlatformBinding } from '../../platform'
import { parseDuration } from '../../utils'

/** 限流计数存储：固定窗口内的请求次数 */
export interface RateLimitStore {
  /** 计数 +1，返回窗口内的次数与窗口结束时间（毫秒时间戳） */
  hit: (key: string, windowSeconds: number) => Promise<{ count: number, resetAt: number }>
  reset: (key: string) => Promise<void>
}

export interface ThrottleLimiter {
  /** 窗口内最多请求次数（使用 binding 时只用于响应头与本地回退） */
  max: number
  /** 窗口长度：`60` / `1m` / `1h` */
  window: string | number
  /**
   * Cloudflare Workers Rate Limiting 绑定名（限额与周期在 wrangler.json 的 ratelimits 中配置）：
   * 原子、全局生效，是 Workers 上限流的推荐方式。绑定不存在时（本地开发）回退到 store 计数。
   */
  binding?: string
  /** 计数维度，默认已登录用户 ID，否则客户端 IP */
  key?: (ctx: HttpContext) => MaybePromise<string>
}

export interface ThrottleConfig {
  /**
   * 计数存储：默认进程内存（单实例）。多实例部署使用共享存储：
   * 字符串为 config/cache.ts 中的存储名（如 `'redis'`），也可传入自定义 RateLimitStore
   */
  store?: RateLimitStore | string
  /** 命名规则：`throttle:api` */
  limiters?: Record<string, ThrottleLimiter>
}

export function defineThrottleConfig(config: ThrottleConfig | (() => ThrottleConfig)): ThrottleConfig | (() => ThrottleConfig) {
  return config
}

/** 进程内存的固定窗口计数（跨热更新保留） */
export function memoryRateLimitStore(): RateLimitStore {
  const hits = definePersistent('throttle:memory', () => new Map<string, { count: number, resetAt: number }>())
  return {
    async hit(key, windowSeconds) {
      const now = Date.now()
      let entry = hits.get(key)
      if (!entry || entry.resetAt <= now) {
        entry = { count: 0, resetAt: now + windowSeconds * 1000 }
        hits.set(key, entry)
        if (hits.size % 1000 === 0) {
          for (const [name, item] of hits) {
            if (item.resetAt <= now)
              hits.delete(name)
          }
        }
      }
      entry.count++
      return { ...entry }
    },
    async reset(key) {
      hits.delete(key)
    },
  }
}

let defaultStore: RateLimitStore | undefined
const cacheStores = new WeakMap<CacheRepository, RateLimitStore>()

/** 基于缓存存储的限流计数（原子自增 + 首次设置过期）：`throttle: { store: 'redis' }` */
export function cacheRateLimitStore(cache: CacheRepository): RateLimitStore {
  return {
    async hit(key, windowSeconds) {
      const { value, ttl } = await cache.store.increment(cache.key(key), 1, windowSeconds)
      return { count: value, resetAt: Date.now() + (ttl ?? windowSeconds) * 1000 }
    },
    async reset(key) {
      await cache.forget(key)
    },
  }
}

let warnedNonAtomic = false
let warnedUnknownIp = false

function resolveStore(ctx: HttpContext, store: ThrottleConfig['store']): RateLimitStore {
  if (store === undefined)
    return defaultStore ??= memoryRateLimitStore()
  if (typeof store !== 'string')
    return store
  const cache = ctx.make(CacheManager).store(store)
  if (!cache.store.atomic && !warnedNonAtomic) {
    warnedNonAtomic = true
    ctx.logger.warn(`throttle: cache store "${store}" (${cache.store.driver}) is not atomic, counts are approximate. On Cloudflare Workers use a Rate Limiting binding (limiter.binding)`)
  }
  let limiter = cacheStores.get(cache)
  if (!limiter) {
    limiter = cacheRateLimitStore(cache)
    cacheStores.set(cache, limiter)
  }
  return limiter
}

interface RateLimitBinding {
  limit: (options: { key: string }) => Promise<{ success: boolean }>
}

/** 默认计数维度：已登录用户，否则客户端 IP */
async function defaultKey(ctx: HttpContext): Promise<string> {
  if (ctx.config.get('auth', undefined)) {
    const id = await ctx.auth.id().catch(() => undefined)
    if (id !== undefined)
      return `user:${id}`
  }
  const ip = ctx.ip
  if (ip === undefined && !warnedUnknownIp && !ctx.config.get('app.debug', false)) {
    warnedUnknownIp = true
    ctx.logger.warn('throttle: the client IP is unknown, so all anonymous requests share one rate limit. Behind a proxy set app.trustProxy; in a custom entry pass the platform address with setClientAddress()')
  }
  return `ip:${ip ?? 'unknown'}`
}

/** `throttle:60,60`（60 秒内最多 60 次）或 `throttle:api`（config/throttle.ts 中的命名规则） */
export const throttle: MiddlewareHandler = async (ctx, next, ...args) => {
  const config = ctx.config.get<ThrottleConfig>('throttle', {})
  let limiter: ThrottleLimiter
  const spec = args.join(',')
  if (args.length === 1 && Number.isNaN(Number(args[0]))) {
    const named = config.limiters?.[args[0]]
    if (!named)
      throw new Error(`Throttle limiter "${args[0]}" is not defined in config/throttle.ts`)
    limiter = named
  }
  else {
    limiter = {
      max: Number(args[0] ?? 60),
      window: args[1] ?? 60,
    }
  }
  const window = parseDuration(limiter.window)
  const key = `throttle:${spec}:${await (limiter.key ?? defaultKey)(ctx)}`

  // Cloudflare Rate Limiting 绑定：只返回是否放行
  const binding = limiter.binding && usePlatformBinding<RateLimitBinding>(limiter.binding)
  if (binding) {
    ctx.setHeader('ratelimit-limit', String(limiter.max))
    if (!(await binding.limit({ key })).success) {
      ctx.setHeader('retry-after', String(window))
      throw new TooManyRequestsException('请求过于频繁，请稍后再试')
    }
    return next()
  }

  const { count, resetAt } = await resolveStore(ctx, config.store).hit(key, window)
  const reset = Math.max(0, Math.ceil((resetAt - Date.now()) / 1000))
  ctx.setHeader('ratelimit-limit', String(limiter.max))
  ctx.setHeader('ratelimit-remaining', String(Math.max(0, limiter.max - count)))
  ctx.setHeader('ratelimit-reset', String(reset))
  if (count > limiter.max) {
    ctx.setHeader('retry-after', String(reset))
    throw new TooManyRequestsException('请求过于频繁，请稍后再试')
  }
  return next()
}
