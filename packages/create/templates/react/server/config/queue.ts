import { defineQueueConfig, env } from '@hazejs/core'

/**
 * 队列：app/job 下的任务，await SendWelcomeEmail.dispatch({ userId })。
 * memory 在本进程消费（开发 / 单实例）；生产多实例设置 QUEUE_CONNECTION=redis（需要 pnpm add bullmq ioredis），
 * 并运行 haze queue:work（构建产物：node dist/…/worker.mjs queue）。
 */
export default defineQueueConfig(() => ({
  default: env('QUEUE_CONNECTION', 'memory'),
  connections: {
    memory: { driver: 'memory', concurrency: 2 },
    sync: { driver: 'sync' },
    redis: {
      driver: 'redis',
      // config/redis.ts 中的连接（BullMQ 不使用连接的 keyPrefix，键前缀为 prefix，默认 haze）
      connection: 'default',
      queues: ['default'],
    },
    // Cloudflare Workers：Queues 绑定（wrangler.json 的 queues.producers / consumers）
    // cloudflare: { driver: 'cloudflare', binding: 'QUEUE' },
  },
}))
