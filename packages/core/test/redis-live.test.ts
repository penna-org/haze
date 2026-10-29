import type { Application } from '../src'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { Cache, createApplication, generateKey, Redis, redisCheck, RedisManager, runHealthChecks, useRedis } from '../src'

const url = process.env.HAZE_TEST_REDIS_URL

// 真实 Redis：HAZE_TEST_REDIS_URL=redis://127.0.0.1:6379
describe.runIf(url)('redis connections (real server)', () => {
  let app: Application | undefined

  afterEach(async () => {
    await app?.dispose()
    app = undefined
  })

  async function boot(config: Record<string, unknown> = {}): Promise<Application> {
    app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        logger: { level: 'silent' },
        app: {
          key: generateKey(),
        },
        redis: {
          default: 'main',
          connections: {
            main: { url },
            cache: { url, keyPrefix: `test-${crypto.randomUUID()}:` },
          },
        },
        ...config,
      },
    })
    return app
  }

  it('the facade runs commands on named connections; keyPrefix applies to keys', async () => {
    await boot()
    const key = `test:${crypto.randomUUID()}`
    await Redis.set(key, 'main', 'EX', 30)
    expect(await Redis.get(key)).toBe('main')
    await useRedis('cache').set(key, 'cache', 'EX', 30)
    expect(await Redis.connection('cache').get(key)).toBe('cache')
    // 共享连接上的 keyPrefix 由 ioredis 加在键前面
    const prefix = app!.make(RedisManager).settings('cache').keyPrefix!
    expect(await Redis.get(`${prefix}${key}`)).toBe('cache')
    expect(await (await Redis.client('cache')).pipeline().get(key).exec()).toEqual([
      [null, 'cache'],
    ])
    await Redis.del(key, `${prefix}${key}`)
  })

  it('pub/sub on a dedicated subscriber, publishing on the shared client', async () => {
    await boot()
    const channel = `test:${crypto.randomUUID()}`
    const subscriber = await Redis.subscriber()
    const received: string[] = []
    subscriber.on('message', (_channel: string, message: string) => received.push(message))
    await subscriber.subscribe(channel)
    await Redis.publish(channel, 'hello')
    const started = Date.now()
    while (!received.length && Date.now() - started < 2000)
      await new Promise(resolve => setTimeout(resolve, 10))
    expect(received).toEqual(['hello'])
    await subscriber.quit()
  })

  it('cache stores and redisCheck use the same connection names', async () => {
    const instance = await boot({
      cache: {
        default: 'redis',
        prefix: 'app:',
        stores: {
          redis: { driver: 'redis', connection: 'cache' },
        },
      },
      health: {
        checks: {
          main: redisCheck('main'),
          default: redisCheck(),
          store: redisCheck('redis'),
        },
      },
    })
    await Cache.set('k', { a: 1 })
    expect(await Cache.get('k')).toEqual({ a: 1 })
    await Cache.flush()
    expect(await Cache.get('k')).toBeUndefined()
    const report = await runHealthChecks(instance)
    expect(report.status).toBe('ok')
    expect(Object.keys(report.checks)).toEqual(['main', 'default', 'store'])
  })

  it('redisCheck reports an unreachable connection as down', async () => {
    const instance = await boot({
      redis: {
        connections: {
          // 未监听的端口：快速失败
          broken: {
            url: 'redis://127.0.0.1:1',
            options: {
              maxRetriesPerRequest: 0,
              retryStrategy: () => null,
              connectTimeout: 200,
            },
          },
        },
      },
      health: {
        checks: {
          broken: redisCheck('broken'),
        },
      },
    })
    const report = await runHealthChecks(instance)
    expect(report.checks.broken!.status).toBe('down')
  })
})
