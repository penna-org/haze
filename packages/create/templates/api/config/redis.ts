import { defineRedisConfig, env } from '@hazejs/core'

/**
 * Redis 连接（需要 pnpm add ioredis）：缓存、队列、WebSocket / 广播、Socket.IO 按名字引用（`connection: 'default'`），
 * 只需设置一次 REDIS_URL。功能之间共用命令连接，订阅与阻塞命令各自另建专用连接。
 */
export default defineRedisConfig(() => ({
  default: 'default',
  connections: {
    default: {
      url: env('REDIS_URL', 'redis://127.0.0.1:6379'),
    },
    // 缓存单独使用一个库 / 实例，并加上键前缀（只作用于键，不作用于 pub/sub 频道）
    // cache: { url: env('REDIS_CACHE_URL', 'redis://127.0.0.1:6379/1'), keyPrefix: 'cache:' },
    // Cluster：{ cluster: [{ host: '10.0.0.1', port: 6379 }], options: { redisOptions: { password: env('REDIS_PASSWORD', '') } } }
    // Sentinel：{ sentinels: [{ host: '10.0.0.1', port: 26379 }], name: 'mymaster' }
  },
}))
