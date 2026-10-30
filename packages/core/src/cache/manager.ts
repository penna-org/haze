import type { Config, GeneratedConfig } from '../config/config'
import type { CacheConfig, CacheStoreConfig } from './config'
import type { KvNamespaceLike } from './drivers/kv'
import type { MemoryCacheEntry } from './drivers/memory'
import type { UpstashClientLike } from './drivers/upstash'
import type { CacheTtl } from './repository'
import type { CacheStore } from './store'
import { RedisManager } from '../redis/manager'
import { getContextContainer } from '../request'
import { defaultCacheConfig } from './config'
import { kvStore } from './drivers/kv'
import { memoryStore } from './drivers/memory'
import { redisStore } from './drivers/redis'
import { upstashStore } from './drivers/upstash'
import { CacheRepository } from './repository'
import { resolveSerializer } from './serializer'
import { isRedisCache, RedisCacheRepository } from './structures'

function createStore(name: string, config: CacheStoreConfig, redis: () => RedisManager): CacheStore {
  switch (config.driver) {
    case 'memory':
      return memoryStore(name)
    case 'redis':
      return redisStore(name, config, redis())
    case 'upstash':
      return upstashStore(config)
    case 'kv':
      return kvStore(name, config)
    case 'custom':
      return config.store
    default:
      throw new Error(`Cache store "${name}": unknown driver "${(config as { driver: string }).driver}"`)
  }
}

/** memory 驱动的存储：与 redis 相同的数据结构接口（进程内模拟，供测试使用），handler() 为内存 Map */
export type MemoryCacheRepository = RedisCacheRepository<Map<string, MemoryCacheEntry>>

/** 生成过配置类型（config/cache.ts）时的存储声明，否则为 never */
type GeneratedCacheStores = GeneratedConfig extends { cache: { stores: infer S } } ? S : never

/** 已声明的存储名：生成过配置类型时为存储名的联合，否则为 string */
export type CacheStoreName = [GeneratedCacheStores] extends [never] ? string : keyof GeneratedCacheStores & string

/** 按存储的驱动得到仓库类型 */
export type CacheRepositoryForConfig<C> = C extends { driver: 'redis' }
  ? RedisCacheRepository
  : C extends { driver: 'memory' }
    ? MemoryCacheRepository
    : C extends { driver: 'upstash' }
      ? CacheRepository<UpstashClientLike>
      : C extends { driver: 'kv' }
        ? CacheRepository<KvNamespaceLike>
        : CacheRepository

/**
 * `Cache.store(name)` 的返回类型：config/cache.ts 中驱动为 redis 的存储为 RedisCacheRepository，
 * memory 为 MemoryCacheRepository，其它为 CacheRepository（未生成配置类型时都是 CacheRepository）。
 * Stores 默认取生成的配置类型，也可以显式传入。
 */
export type CacheRepositoryFor<Name extends string, Stores = GeneratedCacheStores> = [Stores] extends [never]
  ? CacheRepository
  : Name extends keyof Stores
    ? CacheRepositoryForConfig<NonNullable<Stores[Name]>>
    : CacheRepository

/** 存储访问器的重载：不传名字为默认存储，传入已知的名字得到对应驱动的仓库类型 */
export interface CacheStoreAccessor {
  (): CacheRepository
  <N extends CacheStoreName>(name: N): CacheRepositoryFor<N>
  (name?: CacheStoreName): CacheRepository
}

/** 缓存存储管理（应用内单例，`inject(CacheManager)`；config/cache.ts 缺省时为内存缓存） */
export class CacheManager {
  readonly #repositories = new Map<string, CacheRepository>()

  readonly #redis: RedisManager | undefined

  /** redis 为应用的 Redis 连接管理器（redis 驱动的存储使用其命名连接），缺省时按同一份配置创建 */
  constructor(readonly appConfig: Config, redis?: RedisManager) {
    this.#redis = redis
  }

  get config(): CacheConfig {
    const config = this.appConfig.get<Partial<CacheConfig> | undefined>('cache', undefined)
    return {
      ...defaultCacheConfig,
      ...config,
      stores: {
        ...defaultCacheConfig.stores,
        ...config?.stores,
      },
    }
  }

  get defaultStore(): string {
    return this.config.default
  }

  /**
   * 取存储（默认 default）；有数据结构命令的驱动（redis、memory）返回 RedisCacheRepository。
   * 管理器也接受任意字符串（框架内部按配置值取存储），门面 `Cache.store()` 只接受已声明的存储名
   */
  store(): CacheRepository
  store<N extends CacheStoreName>(name: N): CacheRepositoryFor<N>
  store(name?: string): CacheRepository
  store(name?: string): any {
    const config = this.config
    const storeName = name ?? config.default
    let repository = this.#repositories.get(storeName)
    if (!repository) {
      const storeConfig = config.stores[storeName]
      if (!storeConfig)
        throw new Error(`Cache store "${storeName}" is not defined in config/cache.ts`)
      const store = createStore(storeName, storeConfig, () => this.#redis ?? new RedisManager(this.appConfig))
      const serializer = resolveSerializer(storeConfig.serializer ?? config.serializer)
      repository = store.commands
        ? new RedisCacheRepository(storeName, store, config.prefix ?? '', serializer)
        : new CacheRepository(storeName, store, config.prefix ?? '', serializer)
      this.#repositories.set(storeName, repository)
    }
    return repository
  }

  /** 带 Redis 数据结构的存储（redis；测试中的 memory 存储同样可用），其它驱动抛错 */
  redis(name?: string): RedisCacheRepository {
    const repository = this.store(name)
    if (!isRedisCache(repository))
      throw new Error(`Cache store "${repository.name}" (driver "${repository.store.driver}") is not a Redis store`)
    return repository as RedisCacheRepository
  }
}

let fallback: CacheManager | undefined

/** 设置请求之外使用的缓存管理器（应用启动时设置） */
export function setCacheManager(manager: CacheManager | undefined): void {
  fallback = manager
}

/** 当前应用的缓存管理器：请求内取请求容器（多应用时为应用配置），否则取最近启动的应用 */
export function useCacheManager(): CacheManager {
  const manager = getContextContainer()?.make(CacheManager) ?? fallback
  if (!manager)
    throw new Error('Cache is not available: the application has not booted')
  return manager
}

const methods = [
  'get',
  'many',
  'getMultiple',
  'has',
  'set',
  'setMany',
  'setMultiple',
  'add',
  'forget',
  'delete',
  'deleteMany',
  'deleteMultiple',
  'pull',
  'remember',
  'rememberForever',
  'increment',
  'decrement',
  'inc',
  'dec',
  'push',
  'ttl',
  'touch',
  'expire',
  'handler',
  'flush',
  'clear',
  'tag',
  'lock',
  'restoreLock',
] as const

export type CacheFacade = Pick<CacheRepository, typeof methods[number]> & {
  /** 切换存储：`Cache.store('redis')`（redis 存储的类型为 RedisCacheRepository） */
  store: CacheStoreAccessor
  /** 带 Redis 数据结构的存储（默认为默认存储），不是 redis（或测试用的 memory）时抛错 */
  redis: (name?: CacheStoreName) => RedisCacheRepository
}

/**
 * 缓存门面：默认存储的快捷入口，`Cache.store('redis')` 切换存储。
 *
 * ```ts
 * const stats = await Cache.remember('stats', '10m', () => computeStats())
 * await Cache.tag('user').set('user:1', user)
 * await Cache.redis().zset('scores').add('ada', 42)
 * ```
 */
export const Cache: CacheFacade = {
  store: ((name?: string) => useCacheManager().store(name)) as CacheStoreAccessor,
  redis: (name?: CacheStoreName) => useCacheManager().redis(name),
  ...Object.fromEntries(methods.map(method => [
    method,
    (...args: unknown[]) => (useCacheManager().store() as any)[method](...args),
  ])),
} as CacheFacade

/**
 * ThinkPHP 风格的助手函数（默认存储）：
 * - `cache()`：默认存储的仓库；
 * - `cache(key)`：读取；
 * - `cache(key, value, ttl?)`：写入；
 * - `cache(key, null)`：删除。
 */
export function cache(): CacheRepository
export function cache<T = unknown>(key: string): Promise<T | undefined>
export function cache(key: string, value: null): Promise<boolean>
export function cache(key: string, value: unknown, ttl?: CacheTtl): Promise<void>
export function cache(...args: [key?: string, value?: unknown, ttl?: CacheTtl]): CacheRepository | Promise<unknown> {
  const repository = useCacheManager().store()
  if (!args.length)
    return repository
  const [key, value, ttl] = args as [string, unknown, CacheTtl]
  if (args.length === 1)
    return repository.get(key)
  if (value === null)
    return repository.forget(key)
  return repository.set(key, value, ttl)
}
