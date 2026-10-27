import type { MaybePromise } from './utils'
import { globalStore } from './utils'

interface Entry {
  value: unknown
  dispose?: (value: any) => MaybePromise<void>
}

const store = globalStore('persistent', () => new Map<string, Entry>())

export interface PersistentOptions<T> {
  dispose?: (value: T) => MaybePromise<void>
}

/**
 * 跨 HMR 重载保留的资源（数据库连接池、Redis 客户端等）。
 * 同一 key 在进程内只创建一次，热更新时不会重建。
 *
 * ```ts
 * export const pool = definePersistent('db-pool', () => createPool(url), { dispose: p => p.end() })
 * ```
 */
export function definePersistent<T>(key: string, factory: () => T, options: PersistentOptions<T> = {}): T {
  if (!store.has(key)) {
    store.set(key, {
      value: factory(),
      dispose: options.dispose,
    })
  }
  return store.get(key)!.value as T
}

/** 释放持久资源（进程退出时调用）；不传 key 则全部释放 */
export async function disposePersistent(key?: string): Promise<void> {
  const keys = key === undefined
    ? [
        ...store.keys(),
      ].reverse()
    : [key]
  for (const k of keys) {
    const entry = store.get(k)
    store.delete(k)
    await entry?.dispose?.(entry.value)
  }
}
