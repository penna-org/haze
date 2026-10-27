import type { QueueManager } from './manager'
import { getRequestStore } from '../request'

let fallback: QueueManager | undefined
let token: unknown

/** @internal */
export function setQueueManager(manager: QueueManager | undefined, key: unknown): void {
  fallback = manager
  token = key
}

/** 当前应用的队列管理器：请求内取请求容器，否则取最近启动的应用 */
export function useQueueManager(): QueueManager {
  const manager = (token && getRequestStore()?.container.make(token as never)) as QueueManager | undefined ?? fallback
  if (!manager)
    throw new Error('Queue is not available: the application has not booted')
  return manager
}
