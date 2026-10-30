import { AsyncLocalStorage } from 'node:async_hooks'
import { globalStore } from '../utils'

/** 请求之外的关联信息：任务执行时记录任务 ID 与投递它的请求 ID，面板据此归类 */
export interface TelemetryScope {
  requestId?: string
  jobId?: string
}

// 与请求上下文相同：所有 core 副本共用一个（见 request.ts）
const storage = globalStore('telemetry:scope', () => new AsyncLocalStorage<TelemetryScope>())

export function runInTelemetryScope<T>(scope: TelemetryScope, fn: () => T): T {
  return storage.run(scope, fn)
}

export function currentTelemetryScope(): TelemetryScope | undefined {
  return storage.getStore()
}
