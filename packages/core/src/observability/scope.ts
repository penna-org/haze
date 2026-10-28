import { AsyncLocalStorage } from 'node:async_hooks'

/** 请求之外的关联信息：任务执行时记录任务 ID 与投递它的请求 ID，面板据此归类 */
export interface TelemetryScope {
  requestId?: string
  jobId?: string
}

const storage = new AsyncLocalStorage<TelemetryScope>()

export function runInTelemetryScope<T>(scope: TelemetryScope, fn: () => T): T {
  return storage.run(scope, fn)
}

export function currentTelemetryScope(): TelemetryScope | undefined {
  return storage.getStore()
}
