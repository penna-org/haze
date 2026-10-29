import type { Config } from '../config/config'
import type { CacheConfig, CacheStoreConfig } from './config'
import type { CacheStore } from './store'
import { RedisManager } from '../redis/manager'
import { getRequestStore } from '../request'
import { defaultCacheConfig } from './config'
import { kvStore } from './drivers/kv'
import { memoryStore } from './drivers/memory'
import { redisStore } from './drivers/redis'
import { upstashStore } from './drivers/upstash'
import { CacheRepository } from './repository'

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

  /** 取存储（默认 default） */
  store(name: string = this.config.default): CacheRepository {
    let repository = this.#repositories.get(name)
    if (!repository) {
      const config = this.config.stores[name]
      if (!config)
        throw new Error(`Cache store "${name}" is not defined in config/cache.ts`)
      repository = new CacheRepository(name, createStore(name, config, () => this.#redis ?? new RedisManager(this.appConfig)), this.config.prefix ?? '')
      this.#repositories.set(name, repository)
    }
    return repository
  }
}

let fallback: CacheManager | undefined

/** 设置请求之外使用的缓存管理器（应用启动时设置） */
export function setCacheManager(manager: CacheManager | undefined): void {
  fallback = manager
}

/** 当前应用的缓存管理器：请求内取请求容器（多应用时为应用配置），否则取最近启动的应用 */
export function useCacheManager(): CacheManager {
  const manager = getRequestStore()?.container.make(CacheManager) ?? fallback
  if (!manager)
    throw new Error('Cache is not available: the application has not booted')
  return manager
}

type Facade = Pick<CacheRepository, 'get' | 'many' | 'has' | 'set' | 'setMany' | 'add' | 'forget' | 'pull' | 'remember' | 'rememberForever' | 'increment' | 'decrement' | 'flush' | 'lock' | 'restoreLock'> & {
  store: (name?: string) => CacheRepository
}

const methods = [
  'get',
  'many',
  'has',
  'set',
  'setMany',
  'add',
  'forget',
  'pull',
  'remember',
  'rememberForever',
  'increment',
  'decrement',
  'flush',
  'lock',
  'restoreLock',
] as const

/**
 * 缓存门面：默认存储的快捷入口，`Cache.store('redis')` 切换存储。
 *
 * ```ts
 * const stats = await Cache.remember('stats', '10m', () => computeStats())
 * ```
 */
export const Cache: Facade = {
  store: (name?: string) => useCacheManager().store(name),
  ...Object.fromEntries(methods.map(method => [
    method,
    (...args: unknown[]) => (useCacheManager().store() as any)[method](...args),
  ])),
} as Facade
