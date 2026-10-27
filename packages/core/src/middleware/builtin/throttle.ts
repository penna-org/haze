import type { HttpContext } from '../../http/context'
import type { MaybePromise } from '../../utils'
import type { MiddlewareHandler } from '../types'
import { TooManyRequestsException } from '../../exception/exceptions'
import { definePersistent } from '../../persistent'
import { parseDuration } from '../../utils'

/** 限流计数存储：固定窗口内的请求次数 */
export interface RateLimitStore {
  /** 计数 +1，返回窗口内的次数与窗口结束时间（毫秒时间戳） */
  hit: (key: string, windowSeconds: number) => Promise<{ count: number, resetAt: number }>
  reset: (key: string) => Promise<void>
}

export interface ThrottleLimiter {
  /** 窗口内最多请求次数 */
  max: number
  /** 窗口长度：`60` / `1m` / `1h` */
  window: string | number
  /** 计数维度，默认已登录用户 ID，否则客户端 IP */
  key?: (ctx: HttpContext) => MaybePromise<string>
}

export interface ThrottleConfig {
  /** 默认进程内存（单实例）；多实例部署换成 Redis / KV 等共享存储 */
  store?: RateLimitStore
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

/** 默认计数维度：已登录用户，否则客户端 IP */
async function defaultKey(ctx: HttpContext): Promise<string> {
  if (ctx.config.get('auth', undefined)) {
    const id = await ctx.auth.id().catch(() => undefined)
    if (id !== undefined)
      return `user:${id}`
  }
  return `ip:${ctx.ip ?? 'unknown'}`
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
  const store = config.store ?? (defaultStore ??= memoryRateLimitStore())
  const key = `throttle:${spec}:${await (limiter.key ?? defaultKey)(ctx)}`
  const { count, resetAt } = await store.hit(key, window)
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
