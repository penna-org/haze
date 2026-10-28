import type { CacheStoreConfig, RouteRegistrar } from '../src'
import process from 'node:process'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Cache, CacheManager, createApplication, defineRoutes, disposePersistent, generateKey, LockTimeoutException, setPlatformBindings } from '../src'

/** KV：在 workerd 中运行（Miniflare），Node 侧通过绑定代理访问 */
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

interface Driver {
  name: string
  config: CacheStoreConfig
  atomic: boolean
}

const drivers: Driver[] = [
  {
    name: 'memory',
    config: { driver: 'memory' },
    atomic: true,
  },
  {
    name: 'kv',
    config: { driver: 'kv', binding: 'CACHE' },
    atomic: false,
  },
  // 真实服务：HAZE_TEST_REDIS_URL=redis://127.0.0.1:6379
  ...(process.env.HAZE_TEST_REDIS_URL
    ? [
        {
          name: 'redis',
          config: { driver: 'redis', url: process.env.HAZE_TEST_REDIS_URL } as CacheStoreConfig,
          atomic: true,
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
        },
      ]
    : []),
]

function boot(store: Driver, routes: RouteRegistrar = () => {}, config: Record<string, unknown> = {}) {
  return createApplication({
    mode: 'test',
    env: false,
    config: {
      logger: { level: 'silent' },
      app: {
        key: generateKey(),
      },
      cache: {
        default: store.name,
        // 每个用例独立的前缀，避免共享服务中的数据互相影响
        prefix: `test:${crypto.randomUUID()}:`,
        stores: {
          [store.name]: store.config,
          other: { driver: 'memory' },
        },
      },
      ...config,
    },
    routes: [
      defineRoutes(routes),
    ],
  })
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe.each(drivers)('cache ($name)', (driver) => {
  it('gets, sets with fallback and serializes JSON', async () => {
    await boot(driver)
    expect(await Cache.get('missing')).toBeUndefined()
    expect(await Cache.get('missing', 'fallback')).toBe('fallback')
    expect(await Cache.get('missing', () => 42)).toBe(42)
    await Cache.set('user', {
      id: 1,
      tags: ['a'],
      nested: { ok: true },
    })
    expect(await Cache.get('user')).toEqual({
      id: 1,
      tags: ['a'],
      nested: { ok: true },
    })
    await Cache.set('zero', 0)
    expect(await Cache.get('zero', 5)).toBe(0)
    expect(await Cache.has('user')).toBe(true)
    expect(await Cache.forget('user')).toBe(true)
    expect(await Cache.has('user')).toBe(false)
  })

  it('expires entries after their ttl', async () => {
    await boot(driver)
    await Cache.set('short', 'v', 1)
    expect(await Cache.get('short')).toBe('v')
    await sleep(1100)
    expect(await Cache.get('short')).toBeUndefined()
  })

  it('remembers, pulls, adds and handles many', async () => {
    await boot(driver)
    let calls = 0
    const compute = () => ++calls
    expect(await Cache.remember('computed', '1m', compute)).toBe(1)
    expect(await Cache.remember('computed', '1m', compute)).toBe(1)
    expect(calls).toBe(1)
    expect(await Cache.pull('computed')).toBe(1)
    expect(await Cache.has('computed')).toBe(false)

    expect(await Cache.add('once', 'first', 60)).toBe(true)
    expect(await Cache.add('once', 'second', 60)).toBe(false)
    expect(await Cache.get('once')).toBe('first')

    await Cache.setMany({ a: 1, b: 2 }, '1m')
    expect(await Cache.many(['a', 'b', 'c'])).toEqual({ a: 1, b: 2, c: undefined })
  })

  it('increments and decrements, with a ttl set only on creation', async () => {
    await boot(driver)
    expect(await Cache.increment('views')).toBe(1)
    expect(await Cache.increment('views', 5)).toBe(6)
    expect(await Cache.decrement('views', 2)).toBe(4)
    expect(await Cache.get('views')).toBe(4)

    const store = Cache.store()
    const first = await store.store.increment(store.key('window'), 1, 30)
    expect(first.value).toBe(1)
    expect(first.ttl).toBeGreaterThan(25)
    expect((await store.store.increment(store.key('window'), 1, 999)).ttl).toBeLessThanOrEqual(30)
  })

  it.runIf(driver.atomic)('increments atomically under concurrency', async () => {
    await boot(driver)
    await Promise.all(Array.from({ length: 50 }, () => Cache.increment('concurrent')))
    expect(await Cache.get('concurrent')).toBe(50)
  })

  it('flushes only its own prefix and switches stores', async () => {
    const app = await boot(driver)
    await Cache.set('a', 1)
    await Cache.store('other').set('a', 'other store')
    // 同一服务中其它前缀的数据不受 flush 影响
    const foreign = new CacheManager(app.config)
    Object.defineProperty(foreign, 'config', {
      value: {
        ...app.make(CacheManager).config,
        prefix: 'foreign:',
      },
    })
    await foreign.store().set('kept', true)

    await Cache.flush()
    expect(await Cache.get('a')).toBeUndefined()
    expect(await Cache.store('other').get('a')).toBe('other store')
    expect(await foreign.store().get('kept')).toBe(true)
    await foreign.store().forget('kept')
  })

  it.runIf(driver.atomic)('locks atomically and releases only by the owner', async () => {
    await boot(driver)
    const first = Cache.lock('report', 10)
    const second = Cache.lock('report', 10)
    expect(await first.get()).toBe(true)
    expect(await second.get()).toBe(false)
    expect(await second.release()).toBe(false)
    // 用持有者标识在别处释放
    expect(await Cache.restoreLock('report', first.owner).release()).toBe(true)
    expect(await second.get()).toBe(true)
    await second.release()

    await expect(Cache.lock('busy', 10).run(async () => {
      await expect(Cache.lock('busy', 10).run(() => 'nested')).rejects.toBeInstanceOf(LockTimeoutException)
      return 'done'
    })).resolves.toBe('done')
    // run 结束后自动释放
    expect(await Cache.lock('busy', 10).run(() => 'again')).toBe('again')

    const held = Cache.lock('wait', 1)
    await held.get()
    // block 等待过期后获得
    await Cache.lock('wait', 5).block(3, 100)
  })

  it.runIf(!driver.atomic)('refuses locks on non-atomic stores', async () => {
    await boot(driver)
    expect(() => Cache.lock('x')).toThrow('does not support atomic locks')
  })

  it('backs sessions with driver "cache"', async () => {
    const app = await boot(driver, (r) => {
      r.post('/count', (ctx) => {
        const count = ctx.session.get<number>('count', 0)! + 1
        ctx.session.set('count', count)
        return { count }
      }).middleware('session')
    }, {
      session: { driver: 'cache', store: driver.name },
    })
    const first = await app.request('/count', { method: 'POST' })
    const cookie = first.headers.getSetCookie()[0].split(';')[0]
    const second = await app.request('/count', {
      method: 'POST',
      headers: { cookie },
    })
    expect((await second.json() as any).data).toEqual({ count: 2 })
    // 会话 ID 签名后存在 Cookie，数据在缓存中
    const id = decodeURIComponent(cookie.split('=')[1]).split('.')[0]
    expect(await Cache.get(`session:${id}`)).toEqual({ count: 2 })
  })

  it('counts throttle hits in the named cache store', async () => {
    const app = await boot(driver, r => r.get('/limited', () => 'ok').middleware('throttle:2,60'), {
      throttle: { store: driver.name },
    })
    expect((await app.request('/limited')).headers.get('ratelimit-remaining')).toBe('1')
    expect((await app.request('/limited')).status).toBe(200)
    const blocked = await app.request('/limited')
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('ratelimit-reset'))).toBeGreaterThan(50)
  })

  it('caches GET responses with cacheResponse', async () => {
    let hits = 0
    const app = await boot(driver, (r) => {
      r.get('/stats', () => ({ hits: ++hits })).middleware('cacheResponse:60')
      r.get('/mine', async ctx => ({ user: ctx.header('x-user') ?? null, hits: ++hits })).middleware('cacheResponse:60')
      r.get('/fresh', (ctx) => {
        ctx.setHeader('cache-control', 'no-store')
        return { hits: ++hits }
      }).middleware('cacheResponse:60')
    })
    const miss = await app.request('/stats?page=1')
    expect([
      miss.headers.get('x-cache'),
      (await miss.json() as any).data,
    ]).toEqual([
      'MISS',
      { hits: 1 },
    ])
    const hit = await app.request('/stats?page=1')
    expect([
      hit.headers.get('x-cache'),
      (await hit.json() as any).data,
    ]).toEqual([
      'HIT',
      { hits: 1 },
    ])
    expect(hit.headers.get('content-type')).toContain('json')
    expect(hit.headers.get('age')).not.toBeNull()
    // 查询参数不同视为不同的响应
    expect((await (await app.request('/stats?page=2')).json() as any).data).toEqual({ hits: 2 })
    // 不安全的方法与 no-store 不缓存
    expect((await app.request('/fresh')).headers.get('x-cache')).toBe('MISS')
    expect((await (await app.request('/fresh')).json() as any).data).toEqual({ hits: 4 })
  })
})

describe('cache wiring', () => {
  const memory: Driver = {
    name: 'memory',
    config: { driver: 'memory' },
    atomic: true,
  }

  it('defaults to a memory store without config/cache.ts and is injectable', async () => {
    const app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        logger: { level: 'silent' },
      },
    })
    const manager = app.make(CacheManager)
    expect(manager.defaultStore).toBe('memory')
    await manager.store().set('k', 'v')
    expect(await Cache.get('k')).toBe('v')
    expect(() => manager.store('nope')).toThrow('Cache store "nope" is not defined')
  })

  it('caches per user with cacheResponse:<ttl>,user', async () => {
    let hits = 0
    const app = await boot(memory, r => r.get('/me', () => ({ hits: ++hits })).middleware('cacheResponse:60,user'), {
      auth: {
        default: 'api',
        guards: {
          api: { driver: 'jwt', provider: 'users' },
        },
        providers: {
          users: {
            retrieveById: (id: string) => ({
              id: Number(id),
            }),
            retrieveByCredentials: () => undefined,
            validateCredentials: () => false,
            getId: (user: { id: number }) => user.id,
          },
        },
      },
    })
    const { issueTestCredentials } = await import('../src')
    const ada = await issueTestCredentials(app, { id: 1 })
    const bob = await issueTestCredentials(app, { id: 2 })
    expect((await (await app.request('/me', { headers: ada })).json() as any).data).toEqual({ hits: 1 })
    expect((await (await app.request('/me', { headers: bob })).json() as any).data).toEqual({ hits: 2 })
    expect((await (await app.request('/me', { headers: ada })).json() as any).data).toEqual({ hits: 1 })
  })

  it('uses a Cloudflare Rate Limiting binding when present, the store otherwise', async () => {
    const calls: string[] = []
    bindings.API_LIMITER = {
      limit: async ({ key }: { key: string }) => {
        calls.push(key)
        return { success: calls.length <= 1 }
      },
    }
    const routes: RouteRegistrar = r => r.get('/edge', () => 'ok').middleware('throttle:api')
    const config = {
      throttle: {
        limiters: {
          api: { max: 1, window: 60, binding: 'API_LIMITER' },
        },
      },
    }
    const app = await boot(memory, routes, config)
    expect((await app.request('/edge')).status).toBe(200)
    const blocked = await app.request('/edge')
    expect([
      blocked.status,
      blocked.headers.get('retry-after'),
    ]).toEqual([429, '60'])
    expect(calls[0]).toMatch(/^throttle:api:ip:/)

    // 绑定不存在（本地开发）：回退到 store 计数
    delete bindings.API_LIMITER
    const local = await boot(memory, routes, config)
    expect((await local.request('/edge')).headers.get('ratelimit-remaining')).toBe('0')
    expect((await local.request('/edge')).status).toBe(429)
  })
})
