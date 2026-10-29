import type { CacheHash, CacheList, CacheRepository, CacheRepositoryFor, CacheSet, CacheSortedSet, KvNamespaceLike, MemoryCacheRepository, RedisCacheRepository, RedisClient, ScoredMember, TaggedCache, UpstashClientLike } from '../src'
import { describe, expectTypeOf, it } from 'vitest'
import { Cache, cache, defineCacheConfig, isRedisCache } from '../src'

/** 与 haze typegen 为 config/cache.ts 生成的类型相同的形状（ConfigValue<typeof config>['stores']） */
const _config = defineCacheConfig(() => ({
  default: 'redis',
  stores: {
    memory: { driver: 'memory' },
    redis: { driver: 'redis', connection: 'default' },
    sessions: { driver: 'redis', url: 'redis://127.0.0.1:6379/2', serializer: 'json' },
    edge: { driver: 'upstash', url: '', token: '' },
    kv: { driver: 'kv' },
  },
}))
type Stores = ReturnType<Extract<typeof _config, () => unknown>>['stores']

// 只做类型检查（pnpm typecheck），运行时不执行任何缓存操作
describe('cache types', () => {
  it('maps store names to repository types by driver', () => {
    expectTypeOf<CacheRepositoryFor<'redis', Stores>>().toEqualTypeOf<RedisCacheRepository>()
    expectTypeOf<CacheRepositoryFor<'sessions', Stores>>().toEqualTypeOf<RedisCacheRepository>()
    expectTypeOf<CacheRepositoryFor<'memory', Stores>>().toEqualTypeOf<MemoryCacheRepository>()
    expectTypeOf<CacheRepositoryFor<'edge', Stores>>().toEqualTypeOf<CacheRepository<UpstashClientLike>>()
    expectTypeOf<CacheRepositoryFor<'kv', Stores>>().toEqualTypeOf<CacheRepository<KvNamespaceLike>>()
    expectTypeOf<CacheRepositoryFor<'unknown', Stores>>().toEqualTypeOf<CacheRepository>()
    // 未生成配置类型时都是 CacheRepository
    expectTypeOf<CacheRepositoryFor<'redis'>>().toEqualTypeOf<CacheRepository>()
    expectTypeOf<Awaited<ReturnType<RedisCacheRepository['handler']>>>().toEqualTypeOf<RedisClient>()
  })

  it('types the facade, structures and guards', () => {
    if (Math.random() < 2)
      return
    expectTypeOf(Cache.store()).toEqualTypeOf<CacheRepository>()
    expectTypeOf(Cache.store('redis')).toEqualTypeOf<CacheRepository>()
    expectTypeOf(Cache.redis()).toEqualTypeOf<RedisCacheRepository>()
    expectTypeOf(Cache.tag('user')).toEqualTypeOf<TaggedCache>()
    expectTypeOf(Cache.handler()).toEqualTypeOf<Promise<unknown>>()

    const redis = Cache.redis()
    expectTypeOf(redis.hash<number>('h')).toEqualTypeOf<CacheHash<number>>()
    expectTypeOf(redis.list('l')).toEqualTypeOf<CacheList<unknown>>()
    expectTypeOf(redis.set<string>('s')).toEqualTypeOf<CacheSet<string>>()
    expectTypeOf(redis.set('k', 1)).toEqualTypeOf<Promise<void>>()
    expectTypeOf(redis.zset('z')).toEqualTypeOf<CacheSortedSet<string>>()
    expectTypeOf(redis.zset('z').top(3)).toEqualTypeOf<Promise<ScoredMember<string>[]>>()
    expectTypeOf(redis.zset('z').range(0, -1)).toEqualTypeOf<Promise<string[]>>()
    expectTypeOf(redis.zset('z').range(0, -1, { withScores: true })).toEqualTypeOf<Promise<ScoredMember<string>[]>>()
    expectTypeOf(redis.hash<{ a: number }>('h').get('f')).toEqualTypeOf<Promise<{ a: number } | undefined>>()

    const repository: CacheRepository = Cache.store()
    if (isRedisCache(repository))
      expectTypeOf(repository.hash('h')).toEqualTypeOf<CacheHash<unknown>>()
  })

  it('overloads the cache() helper', () => {
    if (Math.random() < 2)
      return
    expectTypeOf(cache()).toEqualTypeOf<CacheRepository>()
    expectTypeOf(cache('k')).toEqualTypeOf<Promise<unknown>>()
    expectTypeOf(cache<number>('k')).toEqualTypeOf<Promise<number | undefined>>()
    expectTypeOf(cache('k', null)).toEqualTypeOf<Promise<boolean>>()
    expectTypeOf(cache('k', { a: 1 })).toEqualTypeOf<Promise<void>>()
    expectTypeOf(cache('k', 1, '10m')).toEqualTypeOf<Promise<void>>()
    // @ts-expect-error ttl 只能是秒数或时长字符串
    cache('k', 1, true)
  })
})
