import type { QueueDriver } from './types'

/** 投递即在当前调用中执行（不重试；失败时调用 failed 并抛出），由 QueueManager 直接处理 */
export function syncQueue(): QueueDriver {
  const unsupported = async (): Promise<never> => {
    throw new Error('The sync queue runs jobs immediately and keeps no failed jobs')
  }
  return {
    driver: 'sync',
    push: unsupported,
    consume: unsupported,
    failed: async () => [],
    retry: async () => 0,
    forget: async () => false,
    flush: async () => 0,
    close: async () => {},
  }
}
