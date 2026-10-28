import type { CacheStore } from './store'
import { jsonReplacer, parseDuration } from '../utils'
import { Lock } from './lock'

/** 有效期：秒数或 `'10m'` / `'2h'`；undefined 表示永久 */
export type CacheTtl = string | number | undefined

function seconds(ttl: CacheTtl): number | undefined {
  return ttl === undefined
    ? undefined
    : parseDuration(ttl)
}

/** 值以 JSON 序列化（Date 读回为字符串） */
function encode(value: unknown): string {
  return JSON.stringify(value === undefined
    ? null
    : value, jsonReplacer)
}

function decode<T>(raw: string | undefined): T | undefined {
  if (raw === undefined)
    return undefined
  return JSON.parse(raw) as T
}

/** 某个存储上的缓存操作（Cache.store(name) 返回） */
export class CacheRepository {
  constructor(readonly name: string, readonly store: CacheStore, readonly prefix: string) {}

  key(key: string): string {
    return this.prefix + key
  }

  async get<T = unknown>(key: string): Promise<T | undefined>
  async get<T>(key: string, fallback: T | (() => T | Promise<T>)): Promise<T>
  async get<T>(key: string, fallback?: T | (() => T | Promise<T>)): Promise<T | undefined> {
    const value = decode<T>(await this.store.get(this.key(key)))
    if (value !== undefined)
      return value
    return typeof fallback === 'function'
      ? (fallback as () => T | Promise<T>)()
      : fallback
  }

  async many<T = unknown>(keys: string[]): Promise<Record<string, T | undefined>> {
    const values = await Promise.all(keys.map(key => this.get<T>(key)))
    return Object.fromEntries(keys.map((key, index) => [key, values[index]]))
  }

  async has(key: string): Promise<boolean> {
    return (await this.store.get(this.key(key))) !== undefined
  }

  async set(key: string, value: unknown, ttl?: CacheTtl): Promise<void> {
    await this.store.set(this.key(key), encode(value), seconds(ttl))
  }

  async setMany(values: Record<string, unknown>, ttl?: CacheTtl): Promise<void> {
    await Promise.all(Object.entries(values).map(([key, value]) => this.set(key, value, ttl)))
  }

  /** 不存在时写入，返回是否写入 */
  add(key: string, value: unknown, ttl?: CacheTtl): Promise<boolean> {
    return this.store.add(this.key(key), encode(value), seconds(ttl))
  }

  forget(key: string): Promise<boolean> {
    return this.store.delete(this.key(key))
  }

  /** 读取并删除 */
  async pull<T = unknown>(key: string): Promise<T | undefined> {
    const value = await this.get<T>(key)
    await this.forget(key)
    return value
  }

  /** 读取缓存，不存在时执行 fn 并写入（fn 返回 undefined 时不缓存） */
  async remember<T>(key: string, ttl: CacheTtl, fn: () => T | Promise<T>): Promise<T> {
    const cached = await this.get<T>(key)
    if (cached !== undefined)
      return cached
    const value = await fn()
    if (value !== undefined)
      await this.set(key, value, ttl)
    return value
  }

  rememberForever<T>(key: string, fn: () => T | Promise<T>): Promise<T> {
    return this.remember(key, undefined, fn)
  }

  /** 原子自增（不存在时从 0 开始），ttl 只在键新建时设置 */
  async increment(key: string, by = 1, ttl?: CacheTtl): Promise<number> {
    return (await this.store.increment(this.key(key), by, seconds(ttl))).value
  }

  decrement(key: string, by = 1, ttl?: CacheTtl): Promise<number> {
    return this.increment(key, -by, ttl)
  }

  /** 删除本存储前缀下的全部键 */
  flush(): Promise<void> {
    return this.store.clear(this.prefix)
  }

  /** 原子锁（memory / redis / upstash；KV 不支持） */
  lock(name: string, ttl: CacheTtl = 60, owner?: string): Lock {
    return new Lock(this.store, this.key(`lock:${name}`), seconds(ttl) ?? 60, owner)
  }

  /** 以已知的持有者标识恢复锁（在别的进程中释放） */
  restoreLock(name: string, owner: string): Lock {
    return this.lock(name, 60, owner)
  }
}
