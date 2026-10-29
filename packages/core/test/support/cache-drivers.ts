import type { CacheStoreConfig, RouteRegistrar } from '../../src'
import process from 'node:process'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll } from 'vitest'
import { createApplication, defineRoutes, disposePersistent, generateKey, setPlatformBindings } from '../../src'

/** 缓存测试共用的驱动列表：memory、KV（Miniflare），以及按环境变量启用的真实 Redis / Upstash */
export interface CacheDriver {
  name: string
  config: CacheStoreConfig
  atomic: boolean
  /** 有 Redis 数据结构（redis；memory 模拟） */
  structures: boolean
}

export const memoryDriver: CacheDriver = {
  name: 'memory',
  config: { driver: 'memory' },
  atomic: true,
  structures: true,
}

export const redisUrl = process.env.HAZE_TEST_REDIS_URL

export const cacheDrivers: CacheDriver[] = [
  memoryDriver,
  {
    name: 'kv',
    config: { driver: 'kv', binding: 'CACHE' },
    atomic: false,
    structures: false,
  },
  // 真实服务：HAZE_TEST_REDIS_URL=redis://127.0.0.1:6379
  ...(redisUrl
    ? [
        {
          name: 'redis',
          config: { driver: 'redis', url: redisUrl } as CacheStoreConfig,
          atomic: true,
          structures: true,
        },
        // config/redis.ts 的命名连接，带 keyPrefix
        {
          name: 'redis-connection',
          config: { driver: 'redis', connection: 'cache' } as CacheStoreConfig,
          atomic: true,
          structures: true,
        },
      ]
    : []),
  // Upstash REST（本地可用 serverless-redis-http）：HAZE_TEST_UPSTASH_URL / HAZE_TEST_UPSTASH_TOKEN
  ...(process.env.HAZE_TEST_UPSTASH_URL
    ? [
        {
          name: 'upstash',
          config: { driver: 'upstash', url: process.env.HAZE_TEST_UPSTASH_URL, token: process.env.HAZE_TEST_UPSTASH_TOKEN ?? '' } as CacheStoreConfig,
          atomic: true,
          structures: false,
        },
      ]
    : []),
]

/** 有数据结构的驱动：memory 与真实 Redis */
export const structureDrivers = cacheDrivers.filter(driver => driver.structures)

/** KV 在 workerd 中运行（Miniflare），Node 侧通过绑定代理访问；在测试文件顶层调用一次 */
export function useKvBinding(): Record<string, unknown> {
  let miniflare: Miniflare | undefined
  const bindings: Record<string, unknown> = {}
  beforeAll(async () => {
    miniflare = new Miniflare({
      modules: true,
      script: 'export default { fetch: () => new Response() }',
      kvNamespaces: ['CACHE'],
    })
    bindings.CACHE = await miniflare.getKVNamespace('CACHE')
    setPlatformBindings(bindings)
  })
  afterAll(async () => {
    await disposePersistent()
    await miniflare?.dispose()
  })
  return bindings
}

/** 启动一个以该驱动为默认存储的应用；每次使用独立的前缀，避免共享服务中的数据互相影响 */
export function bootCache(driver: CacheDriver, config: Record<string, unknown> = {}, routes: RouteRegistrar = () => {}) {
  const { cache, ...rest } = config as { cache?: Record<string, unknown> }
  return createApplication({
    mode: 'test',
    env: false,
    config: {
      logger: { level: 'silent' },
      app: {
        key: generateKey(),
      },
      redis: {
        connections: {
          default: { url: redisUrl ?? 'redis://127.0.0.1:6379' },
          cache: { url: redisUrl ?? 'redis://127.0.0.1:6379', keyPrefix: 'haze-test-kp:' },
        },
      },
      cache: {
        default: driver.name,
        prefix: `test:${crypto.randomUUID()}:`,
        ...cache,
        stores: {
          [driver.name]: driver.config,
          other: { driver: 'memory' },
          ...(cache?.stores as Record<string, unknown> | undefined),
        },
      },
      ...rest,
    },
    routes: [
      defineRoutes(routes),
    ],
  })
}

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
