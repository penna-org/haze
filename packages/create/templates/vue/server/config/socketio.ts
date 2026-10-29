import { env } from '@hazejs/core'
import { defineSocketIOConfig } from '@hazejs/socket.io'

// 多实例部署时设置 SOCKET_ADAPTER=redis：房间与广播经 Redis 同步到所有实例（需要 pnpm add @socket.io/redis-adapter ioredis）
export default defineSocketIOConfig(() => env('SOCKET_ADAPTER', '') === 'redis'
  ? {
      adapter: {
        driver: 'redis',
        // config/redis.ts 中的连接
        connection: 'default',
        key: '{{name}}',
      },
    }
  : {})
