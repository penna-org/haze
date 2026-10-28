import { env } from '@hazejs/core'
import { defineSocketIOConfig } from '@hazejs/socket.io'

// 多实例部署时设置 SOCKET_ADAPTER=redis：房间与广播经 Redis 同步到所有实例（需要 pnpm add @socket.io/redis-adapter ioredis）
export default defineSocketIOConfig(() => env('SOCKET_ADAPTER', '') === 'redis'
  ? {
      adapter: {
        driver: 'redis',
        url: env('REDIS_URL', 'redis://127.0.0.1:6379'),
        key: '{{name}}',
      },
    }
  : {})
