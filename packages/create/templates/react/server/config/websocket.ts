import { defineWebSocketConfig, env } from '@think-h3/core'

// 多实例部署时设置 WS_BROADCAST=redis：Socket.publish / peer.publish 经 Redis 转发到所有实例（需要 ioredis）
export default defineWebSocketConfig(() => env('WS_BROADCAST', '') === 'redis'
  ? {
      broadcast: {
        driver: 'redis',
        url: env('REDIS_URL', 'redis://127.0.0.1:6379'),
        channel: '{{name}}:ws',
      },
    }
  : {})
