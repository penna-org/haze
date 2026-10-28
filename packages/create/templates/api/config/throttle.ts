import { defineThrottleConfig, env } from '@hazejs/core'

// 限流计数存在 config/cache.ts 的存储中（CACHE_STORE=redis 时多实例共享）
export default defineThrottleConfig(() => ({
  store: env('CACHE_STORE', 'memory'),
  // 命名规则：.middleware('throttle:api')
  limiters: {
    api: { max: 60, window: '1m' },
    // Cloudflare Workers：使用 Rate Limiting 绑定（wrangler.json 的 ratelimits）
    // api: { max: 60, window: '1m', binding: 'API_RATE_LIMITER' },
  },
}))
