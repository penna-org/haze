import type { Application, RouteRegistrar } from '../src'
import type { TenancyConfig, Tenant } from '../src/tenancy/config'
import { H3 } from 'h3'
import { afterEach, describe, expect, it } from 'vitest'
import { Cache, CacheManager, Config, Container, createApplication, defineJob, HttpContext, Queue, Storage, StorageManager } from '../src'
import { setHttpContext } from '../src/http/context'
import { currentTenant, useTenant } from '../src/tenancy/context'
import { Tenancy, tenancy } from '../src/tenancy/facade'
import { tenancyMiddleware, tenancyOf, TenantNotFoundException } from '../src/tenancy/manager'

interface TestTenant extends Tenant {
  id: string
  name: string
}

const tenants: Record<string, TestTenant> = {
  acme: { id: 'acme', name: 'Acme Inc.' },
  globex: { id: 'globex', name: 'Globex' },
}
let lookups = 0
function find(key: string): TestTenant | undefined {
  lookups++
  return tenants[key]
}

const seen: Array<string | undefined> = []
const TenantJob = defineJob({
  handle(payload: { label: string }) {
    seen.push(`${payload.label}:${Tenancy.key() ?? 'central'}`)
  },
})

const routes: RouteRegistrar = (r) => {
  r.get('/whoami', ctx => ({ tenant: ctx.tenant ?? null, key: Tenancy.key() ?? null }))
  r.get('/t/:tenant/whoami', ctx => ({
    tenant: useTenant<TestTenant>().name,
    param: ctx.param('tenant'),
  }))
  r.get('/health', () => ({ tenant: currentTenant() ?? null }))
  r.post('/cache', async () => {
    await Cache.set('visits', Tenancy.key())
    return Cache.get('visits')
  })
  r.get('/cache', async () => ({ value: await Cache.get('visits') ?? null }))
  r.post('/files', async () => {
    await Storage.put('report.txt', `report of ${Tenancy.key()}`)
    return { files: await Storage.files('', { recursive: true }) }
  })
  r.get('/files', async () => ({ text: await Storage.text('report.txt') ?? null }))
  r.post('/job', async () => {
    await TenantJob.dispatch({ label: 'http' })
    return 'queued'
  })
  r.group({
    middleware: ['session'],
  }, (r) => {
    r.post('/session', (ctx) => {
      ctx.session.set('owner', Tenancy.key())
      return 'ok'
    })
    r.get('/session', ctx => ({ owner: ctx.session.get('owner') ?? null }))
  })
}

let app: Application | undefined
afterEach(async () => {
  await app?.dispose()
  app = undefined
  seen.length = 0
  lookups = 0
})

async function boot(config: Partial<TenancyConfig> = {}, extra: Record<string, unknown> = {}): Promise<Application> {
  app = await createApplication({
    mode: 'test',
    env: false,
    routes: [routes],
    jobs: {
      '/app/job/TenantJob.ts': { default: TenantJob },
    },
    config: {
      app: {
        key: 'a'.repeat(32),
      },
      logger: { level: 'silent' },
      middleware: {
        global: [tenancy],
      },
      tenancy: { find, ...config },
      filesystem: {
        default: 'local',
        disks: {
          local: { driver: 'memory' },
        },
      },
      ...extra,
    },
  })
  return app
}

async function json(response: Response | Promise<Response>): Promise<any> {
  const res = await response
  return { status: res.status, body: await res.json() }
}

describe('tenant resolution', () => {
  it('resolves by header (default) and answers 404 for unknown or missing tenants', async () => {
    const app = await boot()
    const ok = await json(app.request('/whoami', {
      headers: { 'x-tenant': 'acme' },
    }))
    expect(ok.status).toBe(200)
    expect(ok.body.data).toEqual({ tenant: tenants.acme, key: 'acme' })
    expect((await app.request('/whoami', {
      headers: { 'x-tenant': 'nope' },
    })).status).toBe(404)
    expect((await app.request('/whoami')).status).toBe(404)
  })

  it('uses a custom header name', async () => {
    const app = await boot({ header: 'X-Org' })
    expect((await json(app.request('/whoami', {
      headers: { 'x-org': 'globex' },
    }))).body.data.key).toBe('globex')
  })

  it('resolves by subdomain; the main domain is central', async () => {
    const app = await boot({
      resolvers: ['subdomain'],
      domain: 'example.com',
    })
    expect((await json(app.request('http://acme.example.com/whoami'))).body.data.key).toBe('acme')
    expect((await json(app.request('http://ACME.Example.com/whoami'))).body.data.key).toBe('acme')
    expect((await app.request('http://nope.example.com/whoami')).status).toBe(404)
    // 多级子域名不视为租户
    expect((await app.request('http://a.acme.example.com/whoami')).status).toBe(404)
    const central = await json(app.request('http://example.com/whoami'))
    expect(central.status).toBe(200)
    expect(central.body.data).toEqual({ tenant: null, key: null })
  })

  it('resolves by full domain', async () => {
    tenants['acme.test'] = { id: 'acme-domain', name: 'Acme by domain' }
    try {
      const app = await boot({
        resolvers: ['domain'],
        centralDomains: ['admin.test'],
      })
      expect((await json(app.request('http://acme.test/whoami'))).body.data.tenant.name).toBe('Acme by domain')
      expect((await json(app.request('http://acme.test/whoami'))).body.data.key).toBe('acme-domain')
      expect((await app.request('http://unknown.test/whoami')).status).toBe(404)
      expect((await json(app.request('http://admin.test/whoami'))).body.data.key).toBeNull()
    }
    finally {
      delete tenants['acme.test']
    }
  })

  it('resolves by path prefix (the route keeps the segment)', async () => {
    const app = await boot({
      resolvers: ['path'],
    })
    expect((await json(app.request('/t/globex/whoami'))).body.data).toEqual({ tenant: 'Globex', param: 'globex' })
    expect((await app.request('/t/nope/whoami')).status).toBe(404)
  })

  it('supports custom resolvers, fallbacks, except paths and optional tenancy', async () => {
    let app = await boot({
      resolvers: [
        ctx => ctx.query('org'),
        'header',
      ],
      except: ['/health'],
    })
    expect((await json(app.request('/whoami?org=acme'))).body.data.key).toBe('acme')
    expect((await json(app.request('/whoami', {
      headers: { 'x-tenant': 'globex' },
    }))).body.data.key).toBe('globex')
    expect((await json(app.request('/health'))).body.data).toEqual({ tenant: null })
    await app.dispose()

    app = await boot({ required: false })
    expect((await json(app.request('/whoami'))).body.data).toEqual({ tenant: null, key: null })
    expect((await app.request('/whoami', {
      headers: { 'x-tenant': 'nope' },
    })).status).toBe(404)
  })

  it('remembers lookups when configured', async () => {
    const app = await boot({ remember: '1m' })
    for (let i = 0; i < 3; i++) {
      await app.request('/whoami', {
        headers: { 'x-tenant': 'acme' },
      })
    }
    expect(lookups).toBe(1)
    tenancyOf(app).forget('acme')
    await app.request('/whoami', {
      headers: { 'x-tenant': 'acme' },
    })
    expect(lookups).toBe(2)
  })
})

describe('tenant isolation', () => {
  it('prefixes cache keys per tenant', async () => {
    const app = await boot()
    const acme = { 'x-tenant': 'acme' }
    const globex = { 'x-tenant': 'globex' }
    await app.request('/cache', { method: 'POST', headers: acme })
    expect((await json(app.request('/cache', { headers: acme }))).body.data.value).toBe('acme')
    expect((await json(app.request('/cache', { headers: globex }))).body.data.value).toBeNull()

    const store = app.make(CacheManager).store()
    expect(await store.store.get('haze:tenant:acme:visits')).toBe('"acme"')
    // 中央上下文看不到租户的键；flush 只清理当前租户
    expect(await Cache.get('visits')).toBeUndefined()
    await Tenancy.run(tenants.globex, () => Cache.set('visits', 'g'))
    await Tenancy.run(tenants.acme, () => Cache.flush())
    expect(await store.store.get('haze:tenant:acme:visits')).toBeUndefined()
    expect(await Tenancy.run(tenants.globex, () => Cache.get('visits'))).toBe('g')
  })

  it('can limit cache isolation to some stores, or turn it off', async () => {
    const app = await boot({
      cache: {
        stores: ['other'],
      },
    }, {
      cache: {
        default: 'memory',
        stores: {
          memory: { driver: 'memory' },
          other: { driver: 'memory' },
        },
      },
    })
    await Tenancy.run(tenants.acme, async () => {
      await Cache.set('a', 1)
      await Cache.store('other').set('b', 2)
    })
    expect(await app.make(CacheManager).store().store.get('haze:a')).toBe('1')
    expect(await app.make(CacheManager).store('other').store.get('haze:tenant:acme:b')).toBe('2')
  })

  it('prefixes storage paths per tenant, including signed temporary urls', async () => {
    const app = await boot()
    const acme = { 'x-tenant': 'acme' }
    expect((await json(app.request('/files', { method: 'POST', headers: acme }))).body.data.files).toEqual(['report.txt'])
    expect((await json(app.request('/files', { headers: acme }))).body.data.text).toBe('report of acme')
    expect((await json(app.request('/files', {
      headers: { 'x-tenant': 'globex' },
    }))).body.data.text).toBeNull()

    const base = app.make(StorageManager).disk()
    expect(await base.text('tenants/acme/report.txt')).toBe('report of acme')

    // 签名链接中的路径已带前缀，中央上下文（无租户请求头）也能访问
    const url = await Tenancy.run(tenants.acme, () => Storage.temporaryUrl('report.txt', 60))
    expect(url).toContain('/tenants/acme/report.txt')
    const res = await app.request(url)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('report of acme')
  })

  it('keeps fake disk assertions working inside a tenant', async () => {
    const app = await boot()
    const fake = app.make(StorageManager).fake()
    await Tenancy.run(tenants.globex, async () => {
      await Storage.put('a/b.txt', 'x')
      const scoped = Storage.disk() as typeof fake
      await scoped.assertExists('a/b.txt')
      await scoped.assertCount('a', 1)
    })
    await fake.assertExists('tenants/globex/a/b.txt')
    await fake.assertMissing('a/b.txt')
  })

  it('scopes the session cookie and key per tenant', async () => {
    const app = await boot({}, {
      session: { driver: 'cookie' },
    })
    const login = await app.request('/session', {
      method: 'POST',
      headers: { 'x-tenant': 'acme' },
    })
    const cookie = login.headers.getSetCookie()[0]!
    expect(cookie.startsWith('haze_session_acme=')).toBe(true)
    const pair = cookie.split(';')[0]!
    expect((await json(app.request('/session', {
      headers: { 'x-tenant': 'acme', 'cookie': pair },
    }))).body.data.owner).toBe('acme')
    // 把 acme 的 Cookie 改名后发给 globex：密钥不同，无法解密
    const forged = pair.replace('haze_session_acme', 'haze_session_globex')
    expect((await json(app.request('/session', {
      headers: { 'x-tenant': 'globex', 'cookie': forged },
    }))).body.data.owner).toBeNull()
  })
})

describe('tenant context outside requests', () => {
  it('runs code for a tenant object or key, and in the central context', async () => {
    await boot()
    expect(Tenancy.check()).toBe(false)
    expect(await Tenancy.run('acme', () => useTenant<TestTenant>().name)).toBe('Acme Inc.')
    expect(await Tenancy.run(tenants.globex, async () => {
      const inner = await Tenancy.run('acme', () => Tenancy.key())
      return [
        inner,
        Tenancy.key(),
        Tenancy.central(() => Tenancy.check()),
      ]
    })).toEqual(['acme', 'globex', false])
    await expect(Tenancy.run('nope', () => 1)).rejects.toBeInstanceOf(TenantNotFoundException)
    expect(() => useTenant()).toThrow(/outside of a tenant context/)
    await expect(Tenancy.run({ id: '../etc' }, () => 1)).rejects.toThrow(/Invalid tenant id/)
  })

  it('carries the tenant through queued jobs and restores it in the worker', async () => {
    const app = await boot()
    await app.request('/job', {
      method: 'POST',
      headers: { 'x-tenant': 'acme' },
    })
    await Tenancy.run('globex', () => TenantJob.dispatch({ label: 'run' }))
    await TenantJob.dispatch({ label: 'central' })
    await Queue.idle()
    expect(seen.sort()).toEqual(['central:central', 'http:acme', 'run:globex'])
  })

  it('fails the job when its tenant no longer exists', async () => {
    await boot({}, {
      queue: { default: 'sync' },
    })
    tenants.temp = { id: 'temp', name: 'Temp' }
    await Tenancy.run('temp', async () => {
      delete tenants.temp
      // 同一租户内的 sync 执行不重新查找
      await TenantJob.dispatch({ label: 'same' })
    })
    expect(seen).toEqual(['same:temp'])
    const result = await Queue.manager().process({
      id: '1',
      job: 'TenantJob',
      payload: { label: 'gone' },
      queue: 'default',
      attempts: 0,
      dispatchedAt: Date.now(),
      context: { tenant: 'temp' },
    }, 1)
    expect(result.status).toBe('failed')
    expect(seen).toEqual(['same:temp'])
  })
})

describe('framework middleware (h3 level)', () => {
  /** 模拟框架的请求作用域：先建立 HttpContext，再交给 tenancyMiddleware */
  function server(tenancyConfig: Partial<TenancyConfig> | undefined): H3 {
    const config = new Config(tenancyConfig
      ? {
          tenancy: { find, ...tenancyConfig },
        }
      : {})
    const h3 = new H3()
    h3.use((event, next) => {
      setHttpContext(event, new HttpContext(event, new Container(), { config }))
      return next()
    })
    h3.use(tenancyMiddleware({ config }))
    h3.get('/whoami', () => ({ key: Tenancy.key() ?? null }))
    return h3
  }

  it('resolves the tenant before the routes and answers 404 for unknown tenants', async () => {
    const h3 = server({})
    expect(await (await h3.request('/whoami', {
      headers: { 'x-tenant': 'globex' },
    })).json()).toEqual({ key: 'globex' })
    expect((await h3.request('/whoami', {
      headers: { 'x-tenant': 'nope' },
    })).status).toBe(404)
  })

  it('does nothing without config/tenancy.ts or with global: false', async () => {
    expect(await (await server(undefined).request('/whoami', {
      headers: { 'x-tenant': 'acme' },
    })).json()).toEqual({ key: null })
    expect(await (await server({ global: false }).request('/whoami', {
      headers: { 'x-tenant': 'acme' },
    })).json()).toEqual({ key: null })
  })
})
