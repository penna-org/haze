import type { ApplicationOptions } from '../src'
import type { HealthConfig } from '../src/observability'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, defineRoutes } from '../src'
import { cacheCheck, dbCheck, healthMiddleware, queueCheck, redisCheck, runHealthChecks, storageCheck } from '../src/observability'

let app: Awaited<ReturnType<typeof createApplication>> | undefined
afterEach(async () => {
  await app?.dispose()
  app = undefined
})

async function boot(health: HealthConfig | undefined, options: ApplicationOptions = {}) {
  app = await createApplication({
    mode: 'test',
    env: false,
    config: {
      ...(health && { health }),
      // 故障检查会写错误日志，测试中静默
      logger: { level: 'silent', requests: false },
      filesystem: {
        default: 'memory',
        disks: {
          memory: { driver: 'memory' },
        },
      },
      // 鉴权中间件全局拒绝：健康检查安装在全局中间件之前，不受影响
      middleware: {
        global: [
          (_ctx: unknown, _next: unknown) => new Response('blocked', { status: 401 }),
        ],
      },
    },
    ...options,
  })
  return app
}

describe('health checks', () => {
  it('serves liveness and readiness before global middleware, outside the envelope', async () => {
    await boot({
      checks: {
        cache: cacheCheck(),
        storage: storageCheck(),
        queue: queueCheck(),
      },
    })
    const live = await app!.request('/health/live')
    expect(live.status).toBe(200)
    expect(await live.json()).toEqual({ status: 'ok' })
    expect(live.headers.get('cache-control')).toBe('no-store')

    for (const path of ['/health', '/health/ready']) {
      const response = await app!.request(path)
      expect(response.status).toBe(200)
      const body = await response.json() as any
      expect(body.status).toBe('ok')
      expect(Object.keys(body.checks)).toEqual(['cache', 'storage', 'queue'])
      expect(body.checks.cache).toMatchObject({ status: 'ok' })
      expect(typeof body.checks.cache.latencyMs).toBe('number')
      expect(body.checks.queue.message).toContain('waiting 0')
      // 没有统一响应格式的 { code, data } 包装
      expect(body.code).toBeUndefined()
    }

    // 其它路径仍经过全局中间件
    expect((await app!.request('/other')).status).toBe(401)
    // HEAD 不带响应体
    const head = await app!.request('/health', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
  })

  it('reports down (503) for critical failures and degraded (200) for non-critical ones', async () => {
    await boot({
      checks: {
        ok: () => 'fine',
        flaky: {
          check: () => false,
          critical: false,
        },
        warn: () => ({ status: 'degraded', message: 'slow replica' }),
      },
    })
    let response = await app!.request('/health')
    expect(response.status).toBe(200)
    let body = await response.json() as any
    expect(body.status).toBe('degraded')
    expect(body.checks.ok).toMatchObject({ status: 'ok', message: 'fine' })
    expect(body.checks.flaky.status).toBe('down')
    expect(body.checks.warn).toMatchObject({ status: 'degraded', message: 'slow replica' })
    await app!.dispose()

    await boot({
      checks: {
        db: () => {
          throw new Error('connect ECONNREFUSED 10.0.0.5:5432')
        },
      },
    })
    response = await app!.request('/health')
    expect(response.status).toBe(503)
    body = await response.json()
    expect(body.status).toBe('down')
    // test 模式默认 verbose：显示错误原因
    expect(body.checks.db.message).toContain('ECONNREFUSED')
    // 存活检查不受影响
    expect((await app!.request('/health/live')).status).toBe(200)
  })

  it('hides failure details in production unless verbose', async () => {
    await boot({
      checks: {
        db: () => Promise.reject(new Error('password authentication failed for user "app"')),
      },
    }, { mode: 'production' })
    const body = await (await app!.request('/health')).json() as any
    expect(body.checks.db).toMatchObject({ status: 'down', message: 'check failed' })
  })

  it('times out slow checks and aborts their signal', async () => {
    let aborted = false
    await boot({
      timeout: 50,
      checks: {
        slow: ({ signal }) => new Promise((resolve) => {
          signal.addEventListener('abort', () => {
            aborted = true
            resolve()
          })
        }),
        custom: {
          check: () => new Promise(resolve => setTimeout(resolve, 500)),
          timeout: 20,
        },
      },
    })
    const started = performance.now()
    const response = await app!.request('/health')
    expect(performance.now() - started).toBeLessThan(400)
    expect(response.status).toBe(503)
    const body = await response.json() as any
    expect(body.checks.slow).toMatchObject({ status: 'down', message: 'timed out after 50ms' })
    expect(body.checks.custom.message).toBe('timed out after 20ms')
    expect(aborted).toBe(true)
  })

  it('supports a custom path, caching, disabling, and yields to user routes', async () => {
    let runs = 0
    await boot({
      path: '/status/',
      cache: 60_000,
      checks: {
        counter: () => void runs++,
      },
    })
    expect((await app!.request('/status')).status).toBe(200)
    expect((await app!.request('/status/ready')).status).toBe(200)
    expect((await app!.request('/status/live')).status).toBe(200)
    expect(runs).toBe(1)
    expect((await app!.request('/health')).status).toBe(401)
    await app!.dispose()

    await boot({ enabled: false })
    expect((await app!.request('/health/live')).status).toBe(401)
    await app!.dispose()

    // 项目自己定义了 /health 时以项目路由为准
    app = await createApplication({
      mode: 'test',
      env: false,
      routes: [
        defineRoutes(r => r.get('/health', () => ({ mine: true }))),
      ],
    })
    expect(await (await app.request('/health')).json()).toMatchObject({
      data: { mine: true },
    })
    expect((await app.request('/health/live')).status).toBe(200)
  })

  it('built-in checks: db (Db-like), redis (ping client), cache failure', async () => {
    const queries: unknown[] = []
    const db = {
      raw: (sql: string) => ({ sql }),
      execute: async (query: unknown) => void queries.push(query),
      connection: (name: string) => ({
        execute: async (query: unknown) => void queries.push({ name, query }),
      }),
    }
    await boot({
      checks: {
        db: dbCheck(db),
        analytics: dbCheck(db, { connection: 'analytics' }),
        redis: redisCheck({
          ping: async () => 'PONG',
        }),
        badRedis: {
          check: redisCheck({
            ping: async () => 'NOPE',
          }),
          critical: false,
        },
        missingStore: {
          check: cacheCheck('nope'),
          critical: false,
        },
      },
    })
    const report = await runHealthChecks(app!)
    expect(queries).toEqual([
      { sql: 'select 1' },
      {
        name: 'analytics',
        query: { sql: 'select 1' },
      },
    ])
    expect(report.checks.db!.status).toBe('ok')
    expect(report.checks.redis!.status).toBe('ok')
    expect(report.checks.badRedis).toMatchObject({ status: 'down', message: 'unexpected PING reply: NOPE' })
    expect(report.checks.missingStore!.message).toContain('Cache store "nope" is not defined')
    expect(report.status).toBe('degraded')
  })

  it('passes through non-health requests when used standalone', async () => {
    await boot({})
    const middleware = healthMiddleware(app!)
    expect(typeof middleware).toBe('function')
    expect((await app!.request('/health', { method: 'POST' })).status).toBe(401)
  })
})
