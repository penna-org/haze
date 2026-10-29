import type { TelemetryEvents } from '../observability/telemetry'
import type { CacheSerializer } from './serializer'
import type { CacheStore } from './store'
import { recordTelemetry, telemetryActive } from '../observability/telemetry'
import { toBase64Url } from '../security/key'
import { tenantCachePrefix } from '../tenancy/context'
import { parseDuration } from '../utils'
import { Lock } from './lock'
import { typedSerializer } from './serializer'
import { notAnArray } from './store'

/** 有效期：秒数或 `'10m'` / `'2h'`；undefined 表示永久 */
export type CacheTtl = string | number | undefined

export function seconds(ttl: CacheTtl): number | undefined {
  return ttl === undefined
    ? undefined
    : parseDuration(ttl)
}

type Operation = TelemetryEvents['cache']['operation']

/**
 * 某个存储上的缓存操作（Cache.store(name) 返回）。
 * ThinkPHP / PSR-16 的方法名与原来的方法名并存：`delete` = `forget`、`clear` = `flush`、
 * `inc` / `dec` = `increment` / `decrement`、`getMultiple` / `setMultiple` = `many` / `setMany`。
 * Handler 为 handler() 返回的底层客户端类型。
 */
export class CacheRepository<Handler = unknown> {
  readonly serializer: CacheSerializer

  constructor(readonly name: string, readonly store: CacheStore, readonly basePrefix: string, serializer: CacheSerializer = typedSerializer) {
    this.serializer = serializer
  }

  /** 键前缀：配置的前缀 + 当前租户的前缀（多租户隔离，没有租户时为空） */
  get prefix(): string {
    return this.basePrefix + tenantCachePrefix(this.name)
  }

  key(key: string): string {
    return this.prefix + key
  }

  /** 存储中的实际键（标签缓存在前缀之后加入标签的命名空间） */
  protected async resolve(keys: string[]): Promise<string[]> {
    return keys.map(key => this.key(key))
  }

  /** 写入之后的钩子（标签缓存在这里把键登记到标签下）；keep 表示写入时保留了原有效期 */
  protected async written(_key: string, _ttl: number | undefined, _keep = false): Promise<void> {}

  async #resolveOne(key: string): Promise<string> {
    return (await this.resolve([key]))[0]!
  }

  async #read<T>(key: string, storageKey: string): Promise<T | undefined> {
    const raw = await this.observe('get', key, () => this.store.get(storageKey), raw => raw !== undefined)
    return raw === undefined
      ? undefined
      : this.serializer.deserialize(raw) as T
  }

  async get<T = unknown>(key: string): Promise<T | undefined>
  async get<T>(key: string, fallback: T | (() => T | Promise<T>)): Promise<T>
  async get<T>(key: string, fallback?: T | (() => T | Promise<T>)): Promise<T | undefined> {
    const value = await this.#read<T>(key, await this.#resolveOne(key))
    if (value !== undefined)
      return value
    return typeof fallback === 'function'
      ? (fallback as () => T | Promise<T>)()
      : fallback
  }

  async many<T = unknown>(keys: string[]): Promise<Record<string, T | undefined>> {
    const storageKeys = await this.resolve(keys)
    const values = await Promise.all(keys.map((key, index) => this.#read<T>(key, storageKeys[index]!)))
    return Object.fromEntries(keys.map((key, index) => [key, values[index]]))
  }

  /** PSR-16 的写法，同 many() */
  getMultiple<T = unknown>(keys: string[]): Promise<Record<string, T | undefined>> {
    return this.many<T>(keys)
  }

  async has(key: string): Promise<boolean> {
    return (await this.store.get(await this.#resolveOne(key))) !== undefined
  }

  async set(key: string, value: unknown, ttl?: CacheTtl): Promise<void> {
    const expires = seconds(ttl)
    const storageKey = await this.#resolveOne(key)
    await this.observe('set', key, () => this.store.set(storageKey, this.serializer.serialize(value), expires))
    await this.written(storageKey, expires)
  }

  async setMany(values: Record<string, unknown>, ttl?: CacheTtl): Promise<void> {
    const expires = seconds(ttl)
    const entries = Object.entries(values)
    const storageKeys = await this.resolve(entries.map(([key]) => key))
    await Promise.all(entries.map(async ([key, value], index) => {
      await this.observe('set', key, () => this.store.set(storageKeys[index]!, this.serializer.serialize(value), expires))
      await this.written(storageKeys[index]!, expires)
    }))
  }

  /** PSR-16 的写法，同 setMany() */
  setMultiple(values: Record<string, unknown>, ttl?: CacheTtl): Promise<void> {
    return this.setMany(values, ttl)
  }

  /** 不存在时写入，返回是否写入 */
  async add(key: string, value: unknown, ttl?: CacheTtl): Promise<boolean> {
    const expires = seconds(ttl)
    const storageKey = await this.#resolveOne(key)
    const added = await this.observe('add', key, () => this.store.add(storageKey, this.serializer.serialize(value), expires))
    if (added)
      await this.written(storageKey, expires)
    return added
  }

  async forget(key: string): Promise<boolean> {
    const storageKey = await this.#resolveOne(key)
    return this.observe('forget', key, () => this.store.delete(storageKey))
  }

  /** ThinkPHP / PSR-16 的写法，同 forget() */
  delete(key: string): Promise<boolean> {
    return this.forget(key)
  }

  /** 删除多个键，返回实际删除的个数 */
  async deleteMany(keys: string[]): Promise<number> {
    const storageKeys = await this.resolve(keys)
    const results = await Promise.all(keys.map((key, index) => this.observe('forget', key, () => this.store.delete(storageKeys[index]!))))
    return results.filter(Boolean).length
  }

  /** PSR-16 的写法，同 deleteMany() */
  deleteMultiple(keys: string[]): Promise<number> {
    return this.deleteMany(keys)
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
    const storageKey = await this.#resolveOne(key)
    const result = await this.observe('increment', key, () => this.store.increment(storageKey, by, seconds(ttl)))
    await this.written(storageKey, result.ttl)
    return result.value
  }

  decrement(key: string, by = 1, ttl?: CacheTtl): Promise<number> {
    return this.increment(key, -by, ttl)
  }

  /** ThinkPHP 的写法，同 increment() */
  inc(key: string, by = 1, ttl?: CacheTtl): Promise<number> {
    return this.increment(key, by, ttl)
  }

  /** ThinkPHP 的写法，同 decrement() */
  dec(key: string, by = 1, ttl?: CacheTtl): Promise<number> {
    return this.decrement(key, by, ttl)
  }

  /**
   * 向数组缓存追加一项，不存在时新建；值不是数组时抛 TypeError。
   * 不传 ttl 时保留原有效期（新建时为永久）。memory / redis / upstash 上是原子的
   * （redis / upstash 用 Lua 脚本在原值末尾拼接），KV 与自定义序列化器为读后写。
   */
  async push(key: string, value: unknown, ttl?: CacheTtl): Promise<void> {
    const expires = seconds(ttl)
    const storageKey = await this.#resolveOne(key)
    await this.observe('push', key, async () => {
      const element = this.serializer.element?.(value)
      if (element !== undefined && this.store.push)
        return this.store.push(storageKey, element, expires)
      // 通用实现：读后写（不保证原子性）
      const raw = await this.store.get(storageKey)
      const current = raw === undefined
        ? []
        : this.serializer.deserialize(raw)
      if (!Array.isArray(current))
        throw notAnArray(storageKey)
      const keep = expires ?? (raw === undefined
        ? undefined
        : await this.store.ttl?.(storageKey) ?? undefined)
      await this.store.set(storageKey, this.serializer.serialize([
        ...current,
        value,
      ]), keep)
    })
    await this.written(storageKey, expires, expires === undefined)
  }

  /** 剩余秒数：永久为 undefined，不存在为 null */
  async ttl(key: string): Promise<number | undefined | null> {
    const storageKey = await this.#resolveOne(key)
    if (!this.store.ttl)
      throw new Error(`Cache driver "${this.store.driver}" does not support ttl()`)
    return this.observe('ttl', key, () => this.store.ttl!(storageKey))
  }

  /** 只修改有效期，不改写值（ttl 省略时改为永久），返回键是否存在 */
  async touch(key: string, ttl?: CacheTtl): Promise<boolean> {
    const expires = seconds(ttl)
    const storageKey = await this.#resolveOne(key)
    const exists = await this.observe('touch', key, async () => {
      if (this.store.touch)
        return this.store.touch(storageKey, expires)
      // 驱动不支持时重新写入一次
      const raw = await this.store.get(storageKey)
      if (raw === undefined)
        return false
      await this.store.set(storageKey, raw, expires)
      return true
    })
    if (exists)
      await this.written(storageKey, expires)
    return exists
  }

  /** 同 touch() */
  expire(key: string, ttl?: CacheTtl): Promise<boolean> {
    return this.touch(key, ttl)
  }

  /** 底层客户端：redis 为共享的 ioredis 连接、upstash 为 Upstash 客户端、memory 为内存 Map、kv 为 KV 绑定 */
  async handler(): Promise<Handler> {
    if (!this.store.handler)
      throw new Error(`Cache driver "${this.store.driver}" does not expose a handler`)
    return await this.store.handler() as Handler
  }

  /** 删除本存储前缀下的全部键 */
  flush(): Promise<void> {
    return this.observe('flush', undefined, () => this.store.clear(this.prefix))
  }

  /** ThinkPHP / PSR-16 的写法，同 flush()；标签缓存上为清除标签 */
  clear(): Promise<void> {
    return this.flush()
  }

  /**
   * 标签缓存：`Cache.tag('user').set(...)`、`Cache.tag(['user', 'post']).clear()`。
   * 值放在由各标签版本号决定的命名空间中，clear() 更新版本号使其失效；
   * 只能用写入时的同一组标签读取（与 Laravel 相同）。
   */
  tag(names: string | string[]): TaggedCache {
    return new TaggedCache(this, typeof names === 'string'
      ? [names]
      : names)
  }

  /** 原子锁（memory / redis / upstash；KV 不支持） */
  lock(name: string, ttl: CacheTtl = 60, owner?: string): Lock {
    return new Lock(this.store, this.key(`lock:${name}`), seconds(ttl) ?? 60, owner)
  }

  /** 以已知的持有者标识恢复锁（在别的进程中释放） */
  restoreLock(name: string, owner: string): Lock {
    return this.lock(name, 60, owner)
  }

  /** 有遥测监听者时上报缓存操作（开发面板的命中 / 未命中，可选的 OpenTelemetry span） */
  protected async observe<R>(operation: Operation, key: string | undefined, fn: () => Promise<R>, hit?: (result: R) => boolean, command?: string): Promise<R> {
    if (!telemetryActive())
      return fn()
    const startTime = Date.now()
    const started = performance.now()
    const result = await fn()
    recordTelemetry('cache', {
      store: this.name,
      operation,
      ...(key !== undefined && {
        key,
      }),
      ...(command && {
        command,
      }),
      ...(hit && {
        hit: hit(result),
      }),
      startTime,
      duration: performance.now() - started,
    })
    return result
  }
}

/** 新的标签版本号（随机值：版本键被清除后重新生成，不会与旧版本相同而让旧值复活） */
function newVersion(): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(9)))
}

const encoder = new TextEncoder()
const namespaces = new Map<string, string>()

/** 标签与版本号的 SHA-1（缓存最近的结果，同一组版本号不必重复计算） */
async function digest(input: string): Promise<string> {
  let hash = namespaces.get(input)
  if (!hash) {
    const bytes = new Uint8Array(await crypto.subtle.digest('SHA-1', encoder.encode(input)))
    hash = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
    if (namespaces.size >= 1000)
      namespaces.clear()
    namespaces.set(input, hash)
  }
  return hash
}

/**
 * 带标签的缓存（`Cache.tag(...)` 返回），所有驱动通用：
 * - 每个标签有一个版本键 `<prefix>tag:<name>:version`（随机值，永久保存）；
 * - 值的键为 `<prefix>tagged:<sha1(各标签:版本)>:<key>`，标签按名字排序，顺序无关；
 * - clear() 为每个标签换一个新版本，包含这些标签的所有组合一并失效；
 * - redis 驱动另外把键记在 `<prefix>tag:<name>:keys`（有序集合，分数为过期时间）中，clear() 时直接删除以释放内存。
 * 前缀含租户前缀，不同租户的标签互不影响。
 */
export class TaggedCache extends CacheRepository {
  readonly tags: string[]

  constructor(readonly parent: CacheRepository<any>, tags: string[]) {
    super(parent.name, parent.store, parent.basePrefix, parent.serializer)
    if (!tags.length)
      throw new Error('Cache.tag() needs at least one tag')
    this.tags = [
      ...new Set(tags),
    ].sort()
  }

  #versionKey(tag: string): string {
    return this.key(`tag:${tag}:version`)
  }

  #indexKey(tag: string): string {
    return this.key(`tag:${tag}:keys`)
  }

  /** 各标签当前的版本号；不存在时以 add 写入（并发时以先写入者为准） */
  async #versions(): Promise<string[]> {
    return Promise.all(this.tags.map(async (tag) => {
      const key = this.#versionKey(tag)
      const current = await this.store.get(key)
      if (current !== undefined)
        return current
      const fresh = newVersion()
      if (await this.store.add(key, fresh))
        return fresh
      return (await this.store.get(key)) ?? fresh
    }))
  }

  /** 当前标签组合的命名空间 */
  async namespace(): Promise<string> {
    const versions = await this.#versions()
    return digest(this.tags.map((tag, index) => `${tag}:${versions[index]}`).join('|'))
  }

  protected override async resolve(keys: string[]): Promise<string[]> {
    const namespace = await this.namespace()
    const prefix = `${this.prefix}tagged:${namespace}:`
    return keys.map(key => prefix + key)
  }

  protected override async written(key: string, ttl: number | undefined, keep = false): Promise<void> {
    if (!this.store.tags)
      return
    // push 保留了原有效期时按实际剩余时间登记
    const rest = keep && ttl === undefined
      ? await this.store.ttl?.(key) ?? undefined
      : ttl
    await this.store.tags.track(this.tags.map(tag => this.#indexKey(tag)), key, rest)
  }

  /** 清除这些标签下的全部值（包括写入时带有更多标签的值） */
  override async flush(): Promise<void> {
    await this.observe('flush', `tag:${this.tags.join(',')}`, async () => {
      await Promise.all(this.tags.map(tag => this.store.set(this.#versionKey(tag), newVersion())))
      await this.store.tags?.flush(this.tags.map(tag => this.#indexKey(tag)))
    })
  }

  /** 追加标签：`Cache.tag('a').tag('b')` 等同于 `Cache.tag(['a', 'b'])` */
  override tag(names: string | string[]): TaggedCache {
    return new TaggedCache(this.parent, [
      ...this.tags,
      ...(typeof names === 'string'
        ? [names]
        : names),
    ])
  }
}
