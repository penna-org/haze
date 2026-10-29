import type { CacheRepository } from '../cache/repository'
import type { MaybePromise } from '../utils'
import type { JobContext, JobMiddleware } from './job'
import { parseDuration } from '../utils'
import { QueueManager } from './manager'
import { runStates } from './state'

/** 中间件的状态存储：config/queue.ts 的 store（默认为默认缓存存储） */
function cacheOf(job: JobContext): CacheRepository {
  return job.app.make(QueueManager).cache()
}

export interface RateLimitedOptions<P> {
  /** 每个时间窗口内最多执行的次数 */
  max: number
  /** 时间窗口：秒数 / '1m' */
  per: string | number
  /** 细分限流键（例如按租户、按账号），默认整个限流器共用一个计数 */
  key?: (payload: P) => string
}

/**
 * 限流：同名限流器在每个时间窗口（固定窗口，对齐到 per 的整数倍）内最多执行 max 次，
 * 超出的任务被放回队列，到下一个窗口开始时再执行（不消耗执行次数）。
 *
 * ```ts
 * defineJob({ middleware: [rateLimited('github', { max: 10, per: '1m' })], ... })
 * ```
 */
export function rateLimited<P = any>(name: string, options: RateLimitedOptions<P>): JobMiddleware<P> {
  const per = parseDuration(options.per)
  if (!(per > 0))
    throw new Error('rateLimited(): per must be greater than 0')
  return async (payload, job, next) => {
    const now = Date.now() / 1000
    const window = Math.floor(now / per)
    const key = `queue:rate:${name}${options.key
      ? `:${options.key(payload)}`
      : ''}:${window}`
    const count = await cacheOf(job).increment(key, 1, Math.ceil(per) + 1)
    if (count > options.max) {
      job.release(Math.max(0.05, (window + 1) * per - now))
      return undefined
    }
    return next()
  }
}

export interface WithoutOverlappingOptions {
  /** 拿不到锁时放回队列的延迟（秒数 / '10s'），默认 1 秒；false 为直接丢弃本次执行 */
  releaseAfter?: string | number | false
  /** 锁的有效期（防止进程崩溃后锁不释放），默认 '1h' */
  expireAfter?: string | number
}

/**
 * 防止重叠：同一个键同一时间只执行一个（缓存锁），其余的放回队列稍后再试。
 * key 省略时为任务名（同一任务不并发执行）。
 *
 * ```ts
 * withoutOverlapping(p => `user:${p.userId}`, { releaseAfter: '10s', expireAfter: '5m' })
 * ```
 */
export function withoutOverlapping<P = any>(key?: string | ((payload: P) => string), options: WithoutOverlappingOptions = {}): JobMiddleware<P> {
  const expire = parseDuration(options.expireAfter ?? '1h')
  return async (payload, job, next) => {
    const name = typeof key === 'function'
      ? key(payload)
      : key ?? job.name
    const lock = cacheOf(job).lock(`queue:overlap:${name}`, expire)
    if (!(await lock.get())) {
      if (options.releaseAfter !== false)
        job.release(options.releaseAfter ?? 1)
      return undefined
    }
    try {
      return await next()
    }
    finally {
      await lock.release()
    }
  }
}

export interface ThrottlesExceptionsOptions {
  /** 时间窗口内允许的异常次数，默认 10 */
  max?: number
  /** 时间窗口（秒数 / '10m'），默认 '10m' */
  per?: string | number
  /** 每次异常后的重试等待（覆盖任务的 backoff），默认使用任务的 backoff */
  backoff?: string | number
  /** 计数键，默认任务名 */
  key?: string
  /** 只统计满足条件的异常，默认全部 */
  when?: (error: unknown) => boolean
}

/**
 * 异常节流（熔断）：任务在 per 内抛出 max 次异常后，之后的执行直接放回队列，
 * 直到窗口结束（不消耗执行次数）；异常本身仍按 tries / backoff 计为失败。成功执行一次即清零。
 * 适合调用不稳定的第三方服务。
 */
export function throttlesExceptions(options: ThrottlesExceptionsOptions = {}): JobMiddleware {
  const max = options.max ?? 10
  const per = parseDuration(options.per ?? '10m')
  const backoff = options.backoff === undefined
    ? undefined
    : parseDuration(options.backoff)
  return async (_payload, job, next) => {
    const cache = cacheOf(job)
    const key = `queue:throttle:${options.key ?? job.name}`
    const failures = Number(await cache.get(key) ?? 0)
    if (failures >= max) {
      const rest = cache.store.ttl
        ? await cache.ttl(key)
        : undefined
      job.release(typeof rest === 'number' && rest > 0
        ? rest
        : per)
      return undefined
    }
    try {
      const result = await next()
      if (failures > 0)
        await cache.forget(key)
      return result
    }
    catch (error) {
      if (!options.when || options.when(error)) {
        await cache.increment(key, 1, per)
        const state = runStates.get(job)
        if (state && backoff !== undefined)
          state.retryDelay = backoff
      }
      throw error
    }
  }
}

/** 条件满足时跳过本次执行（任务视为成功完成，不调用 handle） */
export function skipIf<P = any>(predicate: (payload: P, job: JobContext) => MaybePromise<boolean>): JobMiddleware<P> {
  return async (payload, job, next) => {
    if (await predicate(payload, job))
      return undefined
    return next()
  }
}
