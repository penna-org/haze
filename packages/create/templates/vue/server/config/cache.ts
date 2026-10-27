import { defineCacheConfig, env } from '@think-h3/core'

/**
 * 缓存：Cache.remember('key', '10m', () => ...)、Cache.increment()、Cache.lock()。
 * 多实例部署时设置 CACHE_STORE=redis（REDIS_URL），限流（config/throttle.ts）与 Session 也会共享计数 / 数据。
 */
export default defineCacheConfig(() => ({
  default: env('CACHE_STORE', 'memory'),
  // 多个应用共用一个 Redis 时用前缀区分
  prefix: env('CACHE_PREFIX', '{{name}}:'),
  stores: {
    memory: { driver: 'memory' },
    // 需要安装 ioredis
    redis: {
      driver: 'redis',
      url: env('REDIS_URL', 'redis://127.0.0.1:6379'),
    },
    // Edge / Serverless：Upstash（HTTP，需要安装 @upstash/redis）
    // upstash: { driver: 'upstash', url: env('UPSTASH_REDIS_REST_URL', ''), token: env('UPSTASH_REDIS_REST_TOKEN', '') },
    // Cloudflare Workers：KV 绑定（最终一致，适合缓存与 Session，不适合精确限流）
    // kv: { driver: 'kv', binding: 'CACHE' },
  },
}))
