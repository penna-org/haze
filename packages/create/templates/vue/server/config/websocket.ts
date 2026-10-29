import { defineWebSocketConfig, env } from '@hazejs/core'

// 多实例部署时设置 WS_BROADCAST=redis：Socket.publish / peer.publish 经 Redis 转发到所有实例（需要 ioredis）
export default defineWebSocketConfig(() => env('WS_BROADCAST', '') === 'redis'
  ? {
      broadcast: {
        driver: 'redis',
        // config/redis.ts 中的连接
        connection: 'default',
        channel: '{{name}}:ws',
      },
    }
  : {})
