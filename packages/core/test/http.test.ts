import type { ApplicationOptions, Middleware, MiddlewareHandler, Next, RouteRegistrar } from '../src'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'
import {
  BusinessException,
  createApplication,
  defineProvider,
  defineRoutes,
  ExceptionHandler,
  HttpContext,
  inject,
  Logger,
  NotFoundException,
  renderErrorPage,
  Scope,
  UnauthorizedException,
  useContext,
} from '../src'

function boot(routes: RouteRegistrar, options: ApplicationOptions = {}) {
  return createApplication({
    mode: 'test',
    env: false,
    ...options,
    config: {
      logger: { level: 'silent' },
      ...options.config,
    },
    routes: [
      defineRoutes(routes),
    ],
  })
}

async function json(res: Response): Promise<any> {
  return res.json()
}

describe('responses', () => {
  it('wraps data in the default envelope', async () => {
    const app = await boot(r => r.get('/users', () => [
      { id: 1 },
    ]))
    const res = await app.request('/users')
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      code: 0,
      message: 'ok',
      data: [
        { id: 1 },
      ],
    })
  })

  it('keeps strings and Responses untouched', async () => {
    const app = await boot((r) => {
      r.get('/text', () => 'hello')
      r.get('/raw', () => new Response('raw', { status: 202 }))
    })
    expect(await (await app.request('/text')).text()).toBe('hello')
    const raw = await app.request('/raw')
    expect([raw.status, await raw.text()]).toEqual([202, 'raw'])
  })

  it('can disable the envelope globally or per route', async () => {
    const app = await boot(r => r.get('/a', () => ({ a: 1 })))
    const plain = await boot(r => r.get('/a', () => ({ a: 1 })), {
      config: {
        app: {
          response: { envelope: false },
        },
      },
    })
    const perRoute = await boot(r => r.get('/a', () => ({ a: 1 })).meta({ envelope: false }))

    expect((await json(await app.request('/a'))).data).toEqual({ a: 1 })
    expect(await json(await plain.request('/a'))).toEqual({ a: 1 })
    expect(await json(await perRoute.request('/a'))).toEqual({ a: 1 })
  })

  it('supports status helpers on the context', async () => {
    const app = await boot((r) => {
      r.post('/items', ctx => ctx.created({ id: 1 }))
      r.delete('/items/:id', ctx => ctx.noContent())
      r.get('/old', ctx => ctx.redirect('/new', 301))
    })
    expect((await app.request('/items', { method: 'POST' })).status).toBe(201)
    expect((await app.request('/items/1', { method: 'DELETE' })).status).toBe(204)
    const redirect = await app.request('/old')
    expect([
      redirect.status,
      redirect.headers.get('location'),
    ]).toEqual([301, '/new'])
  })
})

describe('controllers and dependency injection', () => {
  class Counter {
    count = 0
  }

  class RequestInfo {
    static scope = Scope.Request
    ctx = inject(HttpContext)
    get path(): string {
      return this.ctx.path
    }
  }

  class UserService {
    counter = inject(Counter)

    find(id: string): { id: string, hits: number } {
      return { id, hits: ++this.counter.count }
    }
  }

  class UserController {
    users = inject(UserService)
    info = inject(RequestInfo)

    show(ctx: HttpContext) {
      return {
        ...this.users.find(ctx.param('id')!),
        path: this.info.path,
      }
    }
  }

  it('resolves controllers per request with injected singletons', async () => {
    const app = await boot(r => r.get('/users/:id', [UserController, 'show']))
    expect((await json(await app.request('/users/7'))).data).toEqual({ id: '7', hits: 1, path: '/users/7' })
    expect((await json(await app.request('/users/8'))).data).toEqual({ id: '8', hits: 2, path: '/users/8' })
  })

  it('gives each request its own request-scoped instances', async () => {
    class Bag {
      static scope = Scope.Request
      items: string[] = []
    }
    const app = await boot(r => r.get('/bag', (ctx) => {
      ctx.make(Bag).items.push('x')
      return ctx.make(Bag).items
    }))
    expect((await json(await app.request('/bag'))).data).toEqual(['x'])
    expect((await json(await app.request('/bag'))).data).toEqual(['x'])
  })

  it('exposes the current request through useContext() deep in services', async () => {
    class Audit {
      who(): string | undefined {
        return useContext().header('x-user')
      }
    }
    const app = await boot(r => r.get('/who', () => ({
      user: inject(Audit).who(),
    })))
    const res = await app.request('/who', {
      headers: { 'x-user': 'alice' },
    })
    expect((await json(res)).data).toEqual({ user: 'alice' })
  })

  it('lets setup() replace bindings for tests', async () => {
    class FakeService extends UserService {
      override find(id: string) {
        return { id, hits: 999 }
      }
    }
    const app = await boot(r => r.get('/users/:id', [UserController, 'show']), {
      setup: app => void app.container.singleton(UserService, FakeService),
    })
    expect((await json(await app.request('/users/1'))).data.hits).toBe(999)
  })
})

describe('middleware', () => {
  const trace: string[] = []
  const mark = (name: string): MiddlewareHandler => async (_ctx, next) => {
    trace.push(`${name}:in`)
    const res = await next()
    trace.push(`${name}:out`)
    return res
  }

  it('runs global → group → route → controller middleware as an onion', async () => {
    trace.length = 0
    class Controller {
      static middleware = [
        'ctrl',
        {
          use: 'onlyStore',
          only: ['store'],
        },
      ]

      index(): string {
        trace.push('handler')
        return 'ok'
      }
    }
    const app = await boot((r) => {
      r.group({
        middleware: ['group'],
      }, (r) => {
        r.get('/', [Controller, 'index']).middleware('route')
      })
    }, {
      config: {
        middleware: {
          global: [
            mark('global'),
          ],
          alias: {
            group: mark('group'),
            route: mark('route'),
            ctrl: mark('ctrl'),
            onlyStore: mark('onlyStore'),
          },
        },
      },
    })

    await app.request('/')
    expect(trace).toEqual([
      'global:in',
      'group:in',
      'route:in',
      'ctrl:in',
      'handler',
      'ctrl:out',
      'route:out',
      'group:out',
      'global:out',
    ])
  })

  it('passes alias arguments and supports class middleware with injection', async () => {
    class Limits {
      seen: string[] = []
    }
    class Throttle implements Middleware {
      limits = inject(Limits)
      handle(ctx: HttpContext, next: Next, max?: string, window?: string) {
        this.limits.seen.push(`${max}/${window}`)
        ctx.setHeader('x-limit', max!)
        return next()
      }
    }
    const app = await boot(r => r.get('/', () => 'ok').middleware('throttle:10,60'), {
      config: {
        middleware: {
          alias: { throttle: Throttle },
        },
      },
    })
    const res = await app.request('/')
    expect(res.headers.get('x-limit')).toBe('10')
    expect(app.make(Limits).seen).toEqual(['10/60'])
  })

  it('short-circuits by returning a value or throwing', async () => {
    const auth: MiddlewareHandler = (ctx, next) => {
      if (ctx.header('authorization') !== 'Bearer ok')
        throw new UnauthorizedException('请先登录')
      ctx.set('user', 'alice')
      return next()
    }
    const maintenance: MiddlewareHandler = () => ({ maintenance: true })
    const app = await boot((r) => {
      r.get('/me', ctx => ({
        user: ctx.get('user'),
      })).middleware('auth')
      r.get('/down', () => 'never').middleware(maintenance)
    }, {
      config: {
        middleware: {
          alias: { auth },
        },
      },
    })

    const denied = await app.request('/me')
    expect(denied.status).toBe(401)
    expect(await json(denied)).toEqual({ code: 401, message: '请先登录', data: null })

    const ok = await app.request('/me', {
      headers: { authorization: 'Bearer ok' },
    })
    expect((await json(ok)).data).toEqual({ user: 'alice' })

    // 中间件短路返回的数据同样经过统一响应格式
    expect(await json(await app.request('/down'))).toEqual({
      code: 0,
      message: 'ok',
      data: { maintenance: true },
    })
  })

  it('expands middleware groups', async () => {
    trace.length = 0
    const app = await boot(r => r.get('/', () => 'ok').middleware('web'), {
      config: {
        middleware: {
          alias: {
            a: mark('a'),
            b: mark('b'),
          },
          groups: {
            web: ['a', 'b'],
          },
        },
      },
    })
    await app.request('/')
    expect(trace).toEqual(['a:in', 'b:in', 'b:out', 'a:out'])
  })
})

describe('validation', () => {
  const CreateUser = v.object({
    name: v.pipe(v.string(), v.minLength(2, '名称至少 2 个字符')),
    age: v.pipe(v.number(), v.minValue(0)),
  })

  it('validates body / params / query and exposes typed results', async () => {
    const app = await boot(r => r.post('/teams/:team/users', (ctx: HttpContext<{ body: typeof CreateUser, params: v.ObjectSchema<{ team: v.StringSchema<undefined> }, undefined> }>) => ({
      team: ctx.validated.params.team,
      user: ctx.validated.body,
    })).validate({
      body: CreateUser,
      params: v.object({
        team: v.string(),
      }),
    }))

    const res = await app.request('/teams/core/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bob', age: 20 }),
    })
    expect((await json(res)).data).toEqual({
      team: 'core',
      user: { name: 'Bob', age: 20 },
    })
  })

  it('decodes route parameters before reading and validating them', async () => {
    const Params = v.object({
      name: v.string(),
    })
    const app = await boot(r => r.get('/files/:name', (ctx: HttpContext<{ params: typeof Params }>) => ({
      param: ctx.param('name'),
      validated: ctx.validated.params.name,
    })).validate({ params: Params }))
    const res = await app.request(`/files/${encodeURIComponent('季度 报表/终版')}`)
    expect((await json(res)).data).toEqual({ param: '季度 报表/终版', validated: '季度 报表/终版' })
  })

  it('reports the client origin, trusting forwarded headers only when configured', async () => {
    const routes: RouteRegistrar = r => r.get('/origin', (ctx: HttpContext) => ({ origin: ctx.origin, secure: ctx.secure }))
    const forwarded = {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'admin.example.com' },
    }
    const direct = await boot(routes)
    expect((await json(await direct.request('http://localhost:3000/origin', forwarded))).data)
      .toEqual({ origin: 'http://localhost:3000', secure: false })
    const proxied = await boot(routes, {
      config: {
        app: { trustProxy: true },
      },
    })
    expect((await json(await proxied.request('http://localhost:3000/origin', forwarded))).data)
      .toEqual({ origin: 'https://admin.example.com', secure: true })
  })

  it('responds 422 with all field issues', async () => {
    const app = await boot(r => r.post('/users', () => 'ok').validate({
      body: CreateUser,
      query: v.object({
        dryRun: v.literal('1'),
      }),
    }))
    const res = await app.request('/users', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'B', age: -1 }),
    })
    expect(res.status).toBe(422)
    const body = await json(res)
    expect(body.code).toBe(422)
    expect(body.message).toBe('Validation Failed')
    expect(body.errors).toEqual([
      expect.objectContaining({ target: 'query', path: 'dryRun' }),
      { target: 'body', path: 'name', message: '名称至少 2 个字符' },
      expect.objectContaining({ target: 'body', path: 'age' }),
    ])
  })
})

describe('exception handling', () => {
  it('renders unknown routes as enveloped 404', async () => {
    const app = await boot(r => r.get('/', () => 'home'))
    const res = await app.request('/nope')
    expect(res.status).toBe(404)
    expect(await json(res)).toMatchObject({ code: 404, data: null })
  })

  it('renders business exceptions with custom codes', async () => {
    const app = await boot(r => r.post('/pay', () => {
      throw new BusinessException(10001, '余额不足', {
        data: { balance: 0 },
      })
    }))
    const res = await app.request('/pay', { method: 'POST' })
    expect(res.status).toBe(200)
    expect(await json(res)).toEqual({
      code: 10001,
      message: '余额不足',
      data: { balance: 0 },
    })
  })

  it('hides internal errors in production and shows stacks in debug', async () => {
    const routes: RouteRegistrar = r => r.get('/boom', () => {
      throw new Error('db password leaked')
    })
    const prod = await boot(routes, { mode: 'production' })
    const res = await prod.request('/boom')
    expect(res.status).toBe(500)
    expect(await json(res)).toEqual({ code: 500, message: 'Internal Server Error', data: null })

    const dev = await boot(routes, {
      config: {
        app: { debug: true },
      },
    })
    const body = await json(await dev.request('/boom'))
    expect(body.message).toBe('db password leaked')
    expect(body.stack[0]).toContain('db password leaked')
  })

  it('reports server errors but not client errors', async () => {
    const reported: unknown[] = []
    class SpyLogger extends Logger {
      override error(message: unknown, ...args: unknown[]): void {
        reported.push(args[0] ?? message)
      }
    }
    const app = await boot((r) => {
      r.get('/404', () => {
        throw new NotFoundException()
      })
      r.get('/500', () => {
        throw new Error('boom')
      })
    }, {
      setup: app => void app.container.instance(Logger, new SpyLogger({ level: 'silent' })),
    })

    await app.request('/404')
    await app.request('/500')
    expect(reported).toHaveLength(1)
    expect((reported[0] as Error).message).toBe('boom')
  })

  it('uses a custom exception handler', async () => {
    class Handler extends ExceptionHandler {
      override render(error: unknown, ctx: HttpContext) {
        if (error instanceof NotFoundException) {
          ctx.status(404)
          return { ok: false, reason: 'missing' }
        }
        return super.render(error, ctx)
      }
    }
    const app = await boot(r => r.get('/', () => 'x'), { exceptionHandler: Handler })
    expect(await json(await app.request('/missing'))).toEqual({ ok: false, reason: 'missing' })
  })
})

describe('application lifecycle', () => {
  it('runs provider register → setup → boot → shutdown in order', async () => {
    const order: string[] = []
    class ProviderClass {
      register(): void {
        order.push('class:register')
      }

      shutdown(): void {
        order.push('class:shutdown')
      }
    }
    const app = await createApplication({
      mode: 'test',
      env: false,
      providers: [
        defineProvider({
          register: () => void order.push('a:register'),
          boot: () => void order.push('a:boot'),
          shutdown: () => void order.push('a:shutdown'),
        }),
        ProviderClass,
      ],
      setup: () => void order.push('setup'),
    })
    await app.dispose()
    expect(order).toEqual([
      'a:register',
      'class:register',
      'setup',
      'a:boot',
      'class:shutdown',
      'a:shutdown',
    ])
  })

  it('serves real HTTP requests', async () => {
    const app = await boot(r => r.get('/ping', () => ({ pong: true })))
    const server = app.serve({ port: 0, silent: true })
    try {
      await server.ready()
      const res = await fetch(new URL('/ping', server.url))
      expect(await res.json()).toEqual({
        code: 0,
        message: 'ok',
        data: { pong: true },
      })
    }
    finally {
      await server.close(true)
    }
  })
})

describe('static files', () => {
  async function bootStatic(spaFallback = true) {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'haze-static-'))
    mkdirSync(join(dir, 'assets'))
    writeFileSync(join(dir, 'index.html'), '<div id="app"></div>')
    writeFileSync(join(dir, 'assets', 'main-abc123.js'), 'console.log(1)')
    writeFileSync(join(dir, 'robots.txt'), 'User-agent: *')
    return boot(r => r.get('/api/ping', () => 'pong'), {
      static: {
        dir,
        spaFallback,
        exclude: ['/api'],
      },
    })
  }
  const html = {
    headers: { accept: 'text/html' },
  }

  it('serves files with long-term caching for hashed assets', async () => {
    const app = await bootStatic()
    const asset = await app.request('/assets/main-abc123.js')
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect(await asset.text()).toBe('console.log(1)')

    const robots = await app.request('/robots.txt')
    expect(robots.headers.get('cache-control')).toBeNull()
    expect(await (await app.request('/', html)).text()).toBe('<div id="app"></div>')
  })

  it('falls back to index.html for client-side routes only', async () => {
    const app = await bootStatic()
    const page = await app.request('/users/42', html)
    expect([page.status, await page.text()]).toEqual([200, '<div id="app"></div>'])

    const api = await app.request('/api/missing', html)
    expect(api.status).toBe(404)
    expect((await json(api)).code).toBe(404)

    expect((await app.request('/missing.js')).status).toBe(404)
    expect(await (await app.request('/api/ping')).text()).toBe('pong')
  })

  it('rejects path traversal and can disable the fallback', async () => {
    const app = await bootStatic(false)
    expect((await app.request('/../package.json')).status).toBe(404)
    expect((await app.request('/%2e%2e/%2e%2e/etc/passwd')).status).toBe(404)
    expect((await app.request('/users/42', html)).status).toBe(404)
  })

  it('serves pages without caching and applies global middleware such as secureHeaders', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'haze-static-'))
    writeFileSync(join(dir, 'index.html'), '<div id="app"></div>')
    const app = await boot(r => r.get('/api/ping', () => 'pong'), {
      static: {
        dir,
        spaFallback: true,
        exclude: ['/api'],
      },
      config: {
        middleware: {
          global: ['secureHeaders'],
        },
      },
    })
    for (const url of ['/', '/users/42']) {
      const page = await app.request(url, html)
      expect(page.headers.get('cache-control')).toBe('no-cache')
      expect(page.headers.get('x-frame-options')).toBe('SAMEORIGIN')
      expect(page.headers.get('x-content-type-options')).toBe('nosniff')
    }
  })

  it('serves precompressed copies by Accept-Encoding', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const { gzipSync } = await import('node:zlib')
    const dir = mkdtempSync(join(tmpdir(), 'haze-static-'))
    writeFileSync(join(dir, 'app.js'), 'console.log("plain")')
    writeFileSync(join(dir, 'app.js.gz'), gzipSync('console.log("plain")'))
    writeFileSync(join(dir, 'only.js'), 'only plain')
    writeFileSync(join(dir, 'both.js'), 'both')
    writeFileSync(join(dir, 'both.js.br'), 'br-bytes')
    writeFileSync(join(dir, 'both.js.gz'), 'gz-bytes')
    const app = await boot(r => r.get('/api/ping', () => 'pong'), {
      static: { dir, precompressed: true },
    })

    const gzip = await app.request('/app.js', {
      headers: { 'accept-encoding': 'gzip' },
    })
    expect(gzip.headers.get('content-encoding')).toBe('gzip')
    expect(gzip.headers.get('content-type')).toContain('javascript')
    expect(gzip.headers.get('vary')).toContain('accept-encoding')

    const plain = await app.request('/app.js')
    expect([
      plain.headers.get('content-encoding'),
      await plain.text(),
    ]).toEqual([null, 'console.log("plain")'])
    // 同等权重时按配置顺序（br 优先），q=0 表示拒绝
    expect((await app.request('/both.js', {
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    })).headers.get('content-encoding')).toBe('br')
    expect((await app.request('/both.js', {
      headers: { 'accept-encoding': 'br;q=0, gzip' },
    })).headers.get('content-encoding')).toBe('gzip')
    // 没有压缩副本时返回原文件；直接请求 .gz 文件本身不标记 content-encoding
    expect((await app.request('/only.js', {
      headers: { 'accept-encoding': 'gzip' },
    })).headers.get('content-encoding')).toBeNull()
    expect((await app.request('/app.js.gz', {
      headers: { 'accept-encoding': 'gzip' },
    })).headers.get('content-encoding')).toBeNull()
  })
})

describe('debug error page', () => {
  const browser = {
    headers: { accept: 'text/html,application/xhtml+xml' },
  }
  const routes: RouteRegistrar = (r) => {
    r.get('/boom', () => {
      throw new Error('<script>alert(1)</script> exploded')
    })
    r.post('/users', () => 'ok').validate({
      body: v.object({
        name: v.string('名称必填'),
      }),
    }).name('users.store')
  }

  it('renders html with source frame, stack and request info for browsers', async () => {
    const app = await boot(routes, {
      config: {
        app: { debug: true },
      },
    })
    const res = await app.request('/boom?x=1', {
      headers: { ...browser.headers, authorization: 'Bearer secret-token-value' },
    })
    expect(res.status).toBe(500)
    expect(res.headers.get('content-type')).toContain('text/html')
    const html = await res.text()
    // 消息被转义
    expect(html).toContain('&#60;script&#62;alert(1)&#60;/script&#62; exploded')
    expect(html).not.toContain('<script>alert(1)')
    // 源码定位到本测试文件中的抛出行
    expect(html).toContain('test/http.test.ts:')
    expect(html).toContain('throw new Error(')
    expect(html).toContain('GET /boom?x=1')
    // 敏感请求头被隐藏
    expect(html).not.toContain('secret-token-value')
  })

  it('lists validation issues and available routes', async () => {
    const app = await boot(routes, {
      config: {
        app: { debug: true },
      },
    })
    const invalid = await (await app.request('/users', { method: 'POST', ...browser })).text()
    expect(invalid).toContain('校验错误')
    expect(invalid).toContain('名称必填')

    const missing = await (await app.request('/nope', browser)).text()
    expect(missing).toContain('可用路由')
    expect(missing).toContain('users.store')
  })

  it('keeps json for api clients and never renders html without debug', async () => {
    const debug = await boot(routes, {
      config: {
        app: { debug: true },
      },
    })
    expect((await debug.request('/boom')).headers.get('content-type')).toContain('json')

    const prod = await boot(routes, { mode: 'production' })
    const res = await prod.request('/boom', browser)
    expect(res.headers.get('content-type')).toContain('json')
    expect(await res.text()).not.toContain('exploded')
  })
})

describe('debug error page details', () => {
  it('shows exception class names instead of HTTPError', async () => {
    const app = await boot(r => r.get('/x', () => 'x'), {
      config: {
        app: { debug: true },
      },
    })
    const html = await (await app.request('/missing', {
      headers: { accept: 'text/html' },
    })).text()
    expect(html).toContain('NotFoundException')
  })

  it('hides framework-only stacks for client errors but keeps them for server errors', () => {
    const error = new NotFoundException()
    error.stack = 'Error\n    at eval (/app/node_modules/@hazejs/core/dist/index.mjs:10:5)'
    expect(renderErrorPage({ error, status: 404, message: 'Not Found' })).not.toContain('调用栈')

    const crash = new Error('boom')
    crash.stack = 'Error: boom\n    at eval (/app/node_modules/@hazejs/core/dist/index.mjs:10:5)'
    expect(renderErrorPage({ error: crash, status: 500, message: 'boom' })).toContain('<details open>')
  })
})
