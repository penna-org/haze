import type { Application, RedisDriver } from '../src'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BroadcastManager, Cache, CacheManager, createApplication, defineRedisConfig, disposePersistent, generateKey, Redis, redisCheck, RedisManager, resolveRedisConfig, runHealthChecks, useRedis } from '../src'
import { redisBus } from '../src/broadcast/bus'
import { redisQueue } from '../src/queue/drivers/redis'

/** ioredis 形状的假客户端：记录构造参数，实现用到的少量命令（keyPrefix 只作用于键，与 ioredis 一致） */
const fake = vi.hoisted(() => {
  const data = new Map<string, string>()
  const created: FakeRedis[] = []

  class FakeRedis {
    static instances = created
    status = 'ready'
    readonly args: unknown[]
    readonly options: Record<string, any>
    readonly isCluster: boolean = false
    readonly listeners = new Map<string, Array<(...args: any[]) => void>>()
    readonly subscribed: string[] = []

    constructor(...args: unknown[]) {
      this.args = args
      const options = args.find(arg => typeof arg === 'object' && !Array.isArray(arg)) as Record<string, any> | undefined
      this.options = { keyPrefix: '', ...options }
      created.push(this)
    }

    #key(key: string): string {
      return `${this.options.keyPrefix ?? ''}${key}`
    }

    on(event: string, listener: (...args: any[]) => void) {
      this.listeners.set(event, [
        ...this.listeners.get(event) ?? [],
        listener,
      ])
      return this
    }

    once(event: string, listener: (...args: any[]) => void) {
      return this.on(event, listener)
    }

    emit(event: string, ...args: unknown[]) {
      for (const listener of this.listeners.get(event) ?? [])
        listener(...args)
    }

    duplicate(overrides: Record<string, unknown> = {}) {
      return new (this.constructor as typeof FakeRedis)({
        ...this.options,
        ...overrides,
      })
    }

    async quit() {
      this.status = 'end'
      this.emit('end')
      return 'OK'
    }

    disconnect() {
      this.status = 'end'
      this.emit('end')
    }

    async ping() {
      return 'PONG'
    }

    async get(key: string) {
      return data.get(this.#key(key)) ?? null
    }

    async set(key: string, value: string) {
      data.set(this.#key(key), String(value))
      return 'OK'
    }

    async del(...keys: string[]) {
      let count = 0
      for (const key of keys) {
        count += data.delete(this.#key(key))
          ? 1
          : 0
      }
      return count
    }

    /** 与 ioredis 相同：MATCH 不加 keyPrefix，返回完整的键 */
    async scan(_cursor: string, _match: string, pattern: string) {
      const prefix = pattern.replace(/\*$/, '')
      return [
        '0',
        [
          ...data.keys(),
        ].filter(key => key.startsWith(prefix)),
      ]
    }

    async publish() {
      return 0
    }

    async subscribe(...channels: string[]) {
      this.subscribed.push(...channels)
      return channels.length
    }

    async hvals() {
      return []
    }
  }

  class FakeCluster extends FakeRedis {
    override readonly isCluster = true

    constructor(nodes: unknown, options: Record<string, unknown>) {
      super(nodes, options)
    }

    override duplicate(...args: unknown[]) {
      return new FakeCluster(undefined, {
        ...this.options,
        ...args[1] as Record<string, unknown>,
      })
    }
  }

  return {
    data,
    created,
    FakeRedis,
    FakeCluster,
  }
})

/** 记录传给 BullMQ Queue 的选项 */
const bullmq = vi.hoisted(() => ({ queues: [] as Array<[string, Record<string, any>]> }))

vi.mock('bullmq', () => ({
  Queue: class {
    constructor(name: string, options: Record<string, any>) {
      bullmq.queues.push([name, options])
    }

    async getJobCounts() {
      return {}
    }

    async close() {}
  },
}))

vi.mock('ioredis', () => ({
  default: fake.FakeRedis,
  Redis: fake.FakeRedis,
  Cluster: fake.FakeCluster,
}))

const driver = { Redis: fake.FakeRedis, Cluster: fake.FakeCluster } as unknown as RedisDriver
type Fake = InstanceType<typeof fake.FakeRedis>

const apps: Application[] = []

beforeEach(() => {
  bullmq.queues.length = 0
  fake.created.length = 0
  fake.data.clear()
})

afterEach(async () => {
  for (const app of apps.splice(0))
    await app.dispose()
  await disposePersistent()
  delete process.env.REDIS_URL
})

async function boot(config: Record<string, unknown> = {}): Promise<Application> {
  const app = await createApplication({
    mode: 'test',
    env: false,
    config: {
      logger: { level: 'silent' },
      app: {
        key: generateKey(),
      },
      ...config,
    },
  })
  apps.push(app)
  return app
}

const connections = defineRedisConfig({
  default: 'default',
  connections: {
    default: { url: 'redis://main:6379' },
    cache: { url: 'redis://cache:6379/1', keyPrefix: 'cache:' },
    tuned: {
      host: 'tuned',
      port: 6380,
      password: 'secret',
      db: 2,
      tls: true,
      options: { connectTimeout: 1000 },
    },
    cluster: {
      cluster: [
        { host: 'n1', port: 7000 },
      ],
      keyPrefix: 'c:',
      password: 'pw',
      options: { scaleReads: 'slave' },
    },
    sentinel: {
      sentinels: [
        { host: 's1', port: 26379 },
      ],
      name: 'mymaster',
    },
    custom: {
      client: () => new fake.FakeRedis('redis://custom:6379', { keyPrefix: 'x:' }),
    },
  },
})

describe('redis config', () => {
  it('falls back to an implicit default connection reading REDIS_URL', () => {
    expect(resolveRedisConfig(undefined)).toEqual({
      default: 'default',
      connections: {
        default: { url: 'redis://127.0.0.1:6379' },
      },
    })
    process.env.REDIS_URL = 'redis://from-env:6379'
    expect(new RedisManager().settings()).toEqual({ url: 'redis://from-env:6379' })
    expect(new RedisManager().names()).toEqual(['default'])
  })

  it('picks the default connection: explicit, then `default`, then the first one', () => {
    expect(resolveRedisConfig({
      default: 'b',
      connections: { a: {}, b: {} },
    }).default).toBe('b')
    expect(resolveRedisConfig({
      connections: { a: {}, default: {} },
    }).default).toBe('default')
    expect(resolveRedisConfig({
      connections: { a: {}, b: {} },
    }).default).toBe('a')
  })

  it('resolves feature settings: inline url > connection > default, options override', () => {
    const redis = new RedisManager(connections as never, { driver })
    expect(redis.resolve({ url: 'redis://inline:1', connection: 'cache' }).settings).toEqual({ url: 'redis://inline:1', options: undefined })
    expect(redis.resolve({ connection: 'cache' }).settings).toEqual({ url: 'redis://cache:6379/1', keyPrefix: 'cache:' })
    expect(redis.resolve({}).settings).toEqual({ url: 'redis://main:6379' })
    expect(redis.resolve(undefined).settings).toEqual({ url: 'redis://main:6379' })
    expect(redis.resolve({
      connection: 'tuned',
      options: { connectTimeout: 5 },
    }).settings.options).toEqual({ connectTimeout: 5 })
    expect(() => redis.resolve('nope')).toThrow('Redis connection "nope" is not defined in config/redis.ts')
  })

  it('builds ioredis clients for url, host/port/tls, cluster, sentinel and custom factories', async () => {
    const redis = new RedisManager(connections as never, { driver })
    const tuned = await redis.client('tuned') as unknown as Fake
    expect(tuned.args).toEqual([
      {
        host: 'tuned',
        port: 6380,
        password: 'secret',
        db: 2,
        tls: {},
        connectTimeout: 1000,
      },
    ])
    const cluster = await redis.client('cluster') as unknown as Fake
    expect(cluster.isCluster).toBe(true)
    expect(cluster.args).toEqual([
      [
        { host: 'n1', port: 7000 },
      ],
      {
        scaleReads: 'slave',
        keyPrefix: 'c:',
        redisOptions: { password: 'pw' },
      },
    ])
    const sentinel = await redis.client('sentinel') as unknown as Fake
    expect(sentinel.args).toEqual([
      {
        sentinels: [
          { host: 's1', port: 26379 },
        ],
        name: 'mymaster',
      },
    ])
    const custom = await redis.client('custom') as unknown as Fake
    expect(custom.args[0]).toBe('redis://custom:6379')
    const cache = await redis.client('cache') as unknown as Fake
    expect(cache.args).toEqual([
      'redis://cache:6379/1',
      { keyPrefix: 'cache:' },
    ])
  })
})

describe('redis manager', () => {
  it('shares one command client per connection, dedicated clients for subscribers', async () => {
    const redis = new RedisManager(connections as never, { driver })
    const [a, b] = await Promise.all([
      redis.client(),
      redis.client('default'),
    ])
    expect(a).toBe(b)
    expect(await redis.client({ connection: 'default' })).toBe(a)
    expect(await redis.client('cache')).not.toBe(a)
    expect(fake.created).toHaveLength(2)

    const sub = await redis.subscriber()
    const other = await redis.subscriber()
    expect(sub).not.toBe(a)
    expect(other).not.toBe(sub)
    expect((sub as unknown as Fake).args[0]).toBe('redis://main:6379')
    // 专用连接的选项可以覆盖
    const blocking = await redis.create('cache', { maxRetriesPerRequest: null }) as unknown as Fake
    expect(blocking.args).toEqual([
      'redis://cache:6379/1',
      { keyPrefix: 'cache:', maxRetriesPerRequest: null },
    ])
  })

  it('closes shared and dedicated clients on dispose, keeps them across HMR', async () => {
    const app = await boot({ redis: connections })
    const shared = await app.make(RedisManager).client() as unknown as Fake
    const sub = await app.make(RedisManager).subscriber() as unknown as Fake
    await app.dispose({ reason: 'hmr' })
    apps.length = 0
    expect([shared.status, sub.status]).toEqual(['ready', 'ready'])

    // 热更新后的新应用复用同一个连接
    const next = await boot({ redis: connections })
    expect(await next.make(RedisManager).client()).toBe(shared)
    await next.dispose()
    apps.length = 0
    expect([shared.status, sub.status]).toEqual(['end', 'end'])
    // 之后再使用会重新建立
    const again = new RedisManager(connections as never, { driver })
    expect(await again.client()).not.toBe(shared)
  })

  it('gives BullMQ options without keyPrefix and maxRetriesPerRequest: null', async () => {
    const redis = new RedisManager(connections as never, { driver })
    expect((await redis.bullmq({ connection: 'cache' })).connection).toEqual({ url: 'redis://cache:6379/1', maxRetriesPerRequest: null })
    expect((await redis.bullmq({ url: 'redis://inline:6379' })).connection).toEqual({ url: 'redis://inline:6379', maxRetriesPerRequest: null })
    expect((await redis.bullmq('tuned')).connection).toEqual({
      host: 'tuned',
      port: 6380,
      password: 'secret',
      db: 2,
      tls: {},
      connectTimeout: 1000,
      maxRetriesPerRequest: null,
    })
    expect(fake.created).toHaveLength(0)

    // Cluster / 自定义客户端：专用实例，去掉 keyPrefix
    const cluster = await redis.bullmq('cluster')
    const instance = cluster.connection as unknown as Fake
    expect(instance.isCluster).toBe(true)
    expect(instance.options.keyPrefix).toBeUndefined()
    expect(instance.options.redisOptions).toEqual({ password: 'pw', maxRetriesPerRequest: null })
    await cluster.close()
    expect(instance.status).toBe('end')
    const custom = (await redis.bullmq('custom')).connection as unknown as Fake
    expect(custom.options).toMatchObject({ keyPrefix: undefined, maxRetriesPerRequest: null })
  })

  it('passes the resolved connection to the BullMQ queue driver', async () => {
    const redis = new RedisManager(connections as never, { driver })
    const queue = redisQueue({ driver: 'redis', connection: 'cache', prefix: 'jobs' }, redis)
    await queue.counts!()
    expect(bullmq.queues).toEqual([
      [
        'default',
        {
          connection: { url: 'redis://cache:6379/1', maxRetriesPerRequest: null },
          prefix: 'jobs',
        },
      ],
    ])
    await queue.close?.()
    // Cluster：Queue 拿到专用实例，关闭队列时断开
    const clustered = redisQueue({
      driver: 'redis',
      connection: 'cluster',
      queues: ['a'],
    }, redis)
    await clustered.counts!()
    const instance = bullmq.queues[1]![1].connection as Fake
    expect(instance.isCluster).toBe(true)
    await clustered.close?.()
    expect(instance.status).toBe('end')
  })

  it('throws one install hint when ioredis is missing', async () => {
    vi.resetModules()
    vi.doMock('ioredis', () => {
      throw new Error('Cannot find package \'ioredis\'')
    })
    try {
      const { loadRedis } = await import('../src/redis/load')
      await expect(loadRedis('Cache driver "redis"')).rejects.toThrow('Cache driver "redis" requires ioredis. Install it with: pnpm add ioredis')
      const { RedisManager: Manager } = await import('../src/redis/manager')
      await expect(new Manager().client(undefined, 'Broadcast bus "redis"')).rejects.toThrow('Broadcast bus "redis" requires ioredis. Install it with: pnpm add ioredis')
    }
    finally {
      vi.doUnmock('ioredis')
      vi.resetModules()
    }
  })
})

describe('redis in the application', () => {
  it('the Redis facade and useRedis() use the named shared connections', async () => {
    const app = await boot({ redis: connections })
    await Redis.set('visits', '1')
    expect(await Redis.get('visits')).toBe('1')
    await Redis.connection('cache').set('k', 'v')
    expect(fake.data.get('cache:k')).toBe('v')
    expect(await useRedis('cache').get('k')).toBe('v')
    // 客户端上不存在的命令给出明确的错误
    await expect(useRedis().call('ping')).rejects.toThrow('Redis command "call" is not available')
    // 代理不是 thenable
    const connection = await Promise.resolve(Redis.connection())
    expect(await connection.ping()).toBe('PONG')
    expect(await Redis.client()).toBe(await app.make(RedisManager).client())
    expect(() => Redis.connection('nope' as never)).toThrow('not defined')
  })

  it('cache stores reference a connection; keyPrefix goes before the cache prefix and flush strips it', async () => {
    await boot({
      redis: connections,
      cache: {
        default: 'redis',
        prefix: 'app:',
        stores: {
          redis: { driver: 'redis', connection: 'cache' },
          implicit: { driver: 'redis' },
        },
      },
    })
    await Cache.set('a', 1)
    await Cache.set('b', 2)
    expect([
      ...fake.data.keys(),
    ].sort()).toEqual(['cache:app:a', 'cache:app:b'])
    await Cache.flush()
    expect(fake.data.size).toBe(0)
    // 不指定连接时使用默认连接（与 Redis 门面共用同一个客户端）
    await Cache.store('implicit').set('c', 3)
    expect(fake.data.has('app:c')).toBe(true)
    expect(fake.created.map(client => client.args[0])).toEqual(['redis://cache:6379/1', 'redis://main:6379'])
  })

  it('a single REDIS_URL configures cache, websocket broadcast and the broadcasting bus', async () => {
    process.env.REDIS_URL = 'redis://single:6379'
    const app = await boot({
      cache: {
        default: 'redis',
        stores: {
          redis: { driver: 'redis' },
        },
      },
      websocket: {
        broadcast: { driver: 'redis', channel: 'app:ws' },
      },
    })
    await Cache.set('x', 1)
    const bus = app.make(BroadcastManager).bus()
    expect(bus.driver).toBe('redis')
    await bus.publish({
      channels: ['news'],
      event: 'e',
      data: {},
    } as never)
    // 一个共享命令连接（缓存与总线发布共用）+ 一个订阅连接
    const urls = fake.created.map(client => client.args[0])
    expect(urls).toEqual(['redis://single:6379', 'redis://single:6379'])
    expect(fake.created[1]!.subscribed).toEqual(['app:ws:broadcast'])
  })

  it('the broadcasting bus keeps the inline url form', async () => {
    const redis = new RedisManager(connections as never, { driver })
    const bus = redisBus({ url: 'redis://bus:6379', prefix: 'p' }, redis)
    await bus.presence.members('room')
    expect(fake.created.map(client => client.args[0])).toEqual(['redis://bus:6379', 'redis://bus:6379'])
  })

  it('redisCheck pings a connection, falls back to a cache store, and reports unknown names', async () => {
    const app = await boot({
      redis: connections,
      cache: {
        default: 'memory',
        stores: {
          memory: { driver: 'memory' },
        },
      },
      health: {
        checks: {
          default: redisCheck(),
          cache: redisCheck('cache'),
          store: redisCheck('memory'),
          unknown: {
            check: redisCheck('nope'),
            critical: false,
          },
        },
      },
    })
    const report = await runHealthChecks(app)
    expect(Object.fromEntries(Object.entries(report.checks).map(([name, check]) => [name, check.status]))).toEqual({
      default: 'ok',
      cache: 'ok',
      store: 'ok',
      unknown: 'down',
    })
    expect(report.checks.unknown!.message).toContain('neither a Redis connection')
    // cache 是连接名而不是缓存存储：PING 而不是读写
    expect(app.make(CacheManager).config.stores.cache).toBeUndefined()
  })
})
