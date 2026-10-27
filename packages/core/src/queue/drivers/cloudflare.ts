import type { QueueDriver } from './types'
import { usePlatformBinding } from '../../platform'

export interface CloudflareQueueConfig {
  driver: 'cloudflare'
  /** Queues 生产者绑定名（wrangler.json 的 queues.producers），默认 QUEUE */
  binding?: string
}

interface QueueBinding {
  send: (body: unknown, options?: { delaySeconds?: number }) => Promise<void>
}

/**
 * Cloudflare Queues：投递到 Queues 绑定，由 Worker 导出的 queue() 消费（构建时生成）。
 * 重试映射为 message.retry({ delaySeconds })；失败任务进入 wrangler 配置的死信队列。
 */
export function cloudflareQueue(name: string, config: CloudflareQueueConfig): QueueDriver {
  const unsupported = async (): Promise<never> => {
    throw new Error(`Queue connection "${name}" (cloudflare) is consumed by the Worker's queue() handler; failed jobs go to the dead letter queue configured in wrangler`)
  }
  return {
    driver: 'cloudflare',
    async push(message, delaySeconds) {
      const binding = usePlatformBinding<QueueBinding>(config.binding ?? 'QUEUE')
      if (!binding)
        throw new Error(`Queue connection "${name}": Queues binding "${config.binding ?? 'QUEUE'}" not found. Cloudflare Queues are only available on Workers`)
      // Queues 的延迟上限为 12 小时
      await binding.send(message, delaySeconds > 0
        ? {
            delaySeconds: Math.min(Math.ceil(delaySeconds), 43200),
          }
        : undefined)
    },
    consume: unsupported,
    failed: unsupported,
    retry: unsupported,
    forget: unsupported,
    flush: unsupported,
    close: async () => {},
  }
}
