import type { ApplicationOptions, HttpContext, LogEntry, SessionStore } from '../src'
import { Buffer } from 'node:buffer'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  Application,
  Cache,
  CacheManager,
  createApplication,
  defineRoutes,
  ExceptionHandler,
  Logger,
  MaintenanceManager,
  QueueManager,
  Scheduler,
  Scope,
} from '../src'
import { stringifyJson } from '../src/utils'

const KEY = 'k'.repeat(32)

function boot(routes: Parameters<typeof defineRoutes>[0], options: ApplicationOptions = {}, config: Record<string, any> = {}): Promise<Application> {
  return createApplication({
    mode: 'test',
    env: false,
    routes: [
      defineRoutes(routes),
    ],
    ...options,
    config: {
      logger: { level: 'silent' },
      ...config,
      app: { key: KEY, ...config.app },
    },
  })
}

/** 把日志收集到数组（替换容器里的 Logger，请求日志器由它派生） */
function captureLogs(app: Application): LogEntry[] {
  const entries: LogEntry[] = []
  const logger = new Logger({
    level: 'debug',
    format: 'json',
    write: line => void entries.push(JSON.parse(line)),
  })
  app.container.instance(Logger, logger)
  app.logger = logger
  return entries
}

describe('outbound phase errors', () => {
  it('reports and renders errors thrown from ctx.onResponse through the ExceptionHandler', async () => {
    const reported: unknown[] = []
    class Handler extends ExceptionHandler {
      override report(error: unknown): void {
        reported.push(error)
      }
    }
    const app = await boot((r) => {
      r.get('/hook', (ctx) => {
        ctx.onResponse(() => {
          throw new Error('write-back failed')
        })
        return { ok: true }
      })
    }, { exceptionHandler: Handler })
    const response = await app.request('/hook')
    expect(response.status).toBe(500)
    const body = await response.json() as Record<string, unknown>
    // 框架的统一错误格式，而不是 h3 的 {"unhandled":true}
    expect(body).not.toHaveProperty('unhandled')
    expect(body).toMatchObject({ code: 500 })
    expect(response.headers.get('x-request-id')).toBeTruthy()
    expect(reported).toHaveLength(1)
    expect((reported[0] as Error).message).toBe('write-back failed')
  })

  it('handles a failing session write-back (cookie driver overflow)', async () => {
    const app = await boot((r) => {
      r.get('/big', async (ctx) => {
        (await ctx.startSession()).set('blob', 'x'.repeat(8000))
        return { ok: true }
      })
    })
    const entries = captureLogs(app)
    const response = await app.request('/big')
    expect(response.status).toBe(500)
    expect(await response.json()).not.toHaveProperty('unhandled')
    expect(entries.some(entry => entry.level === 'error' && entry.msg.includes('/big'))).toBe(true)
  })

  it('reports and renders errors thrown from interceptors', async () => {
    const app = await boot(r => r.get('/x', () => ({ ok: true })), {
      interceptors: [
        () => {
          throw new Error('interceptor failed')
        },
      ],
    })
    const entries = captureLogs(app)
    const response = await app.request('/x')
    expect(response.status).toBe(500)
    expect(await response.json()).not.toHaveProperty('unhandled')
    expect(entries.filter(entry => entry.level === 'error')).toHaveLength(1)
  })

  it('falls back to a fresh container and logs when the ExceptionHandler itself fails', async () => {
    let renders = 0
    class Broken extends ExceptionHandler {
      override render(error: unknown, ctx: HttpContext): unknown {
        // 第一次（请求作用域内）失败，h3 的 onError 兜底时请求容器已释放
        if (renders++ === 0)
          throw new Error('render failed')
        return super.render(error, ctx)
      }
    }
    const app = await boot(r => r.get('/boom', () => {
      throw new Error('boom')
    }), { exceptionHandler: Broken })
    const response = await app.request('/boom')
    expect(response.status).toBe(500)
    expect(await response.json()).not.toHaveProperty('unhandled')
    expect(renders).toBe(2)

    class AlwaysBroken extends ExceptionHandler {
      override render(): unknown {
        throw new Error('render failed')
      }
    }
    const broken = await boot(r => r.get('/boom', () => {
      throw new Error('boom')
    }), { exceptionHandler: AlwaysBroken })
    const entries = captureLogs(broken)
    expect((await broken.request('/boom')).status).toBe(500)
    expect(entries.some(entry => entry.msg.includes('ExceptionHandler failed'))).toBe(true)
  })
})

describe('request container and streaming responses', () => {
  class Service {
    static scope = Scope.Request
    static disposed = 0
    readonly value = 'svc';

    [Symbol.dispose](): void {
      Service.disposed++
    }
  }
  const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 5))

  it('keeps the request container alive until an SSE stream finishes', async () => {
    Service.disposed = 0
    const errors: unknown[] = []
    const app = await boot((r) => {
      r.get('/events', ctx => ctx.sse((async function* () {
        yield { data: 'first' }
        await tick()
        // 处理器已经返回：之前这里会抛 “container has been disposed”
        yield { data: ctx.make(Service).value }
      })(), {
        heartbeat: false,
        onError: error => void errors.push(error),
      }))
    })
    const response = await app.request('/events')
    expect(Service.disposed).toBe(0)
    expect(await response.text()).toBe('data: first\n\ndata: svc\n\n')
    expect(errors).toEqual([])
    await vi.waitFor(() => expect(Service.disposed).toBe(1))
  })

  it('also defers when ctx.onResponse hooks run, and releases on cancel', async () => {
    Service.disposed = 0
    const app = await boot((r) => {
      r.get('/stream', (ctx) => {
        ctx.onResponse(response => void response.headers.set('x-hook', '1'))
        ctx.make(Service)
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('chunk'))
          },
        }), {
          headers: { 'content-type': 'text/plain' },
        })
      })
    })
    const response = await app.request('/stream')
    expect(response.headers.get('x-hook')).toBe('1')
    const reader = response.body!.getReader()
    expect(new TextDecoder().decode((await reader.read()).value)).toBe('chunk')
    expect(Service.disposed).toBe(0)
    await reader.cancel()
    await vi.waitFor(() => expect(Service.disposed).toBe(1))
  })

  it('disposes before responding for non-streaming results', async () => {
    Service.disposed = 0
    const app = await boot((r) => {
      r.get('/json', (ctx) => {
        ctx.make(Service)
        return { ok: true }
      })
      r.get('/sized', (ctx) => {
        ctx.make(Service)
        return new Response('hello', {
          headers: { 'content-length': '5' },
        })
      })
    })
    await app.request('/json')
    expect(Service.disposed).toBe(1)
    await app.request('/sized')
    expect(Service.disposed).toBe(2)
  })
})

describe('json serialization', () => {
  it('converts BigInt only when needed, including inside toJSON() results', async () => {
    class Model {
      toJSON(): unknown {
        return {
          id: 9007199254740993n,
          nested: [1n],
        }
      }
    }
    const plain = {
      a: [
        1,
        { b: 'x' },
      ],
    }
    expect(stringifyJson(plain)).toBe(JSON.stringify(plain))
    expect(stringifyJson({
      id: 5n,
      at: new Date(0),
    })).toBe('{"id":"5","at":"1970-01-01T00:00:00.000Z"}')
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    expect(() => stringifyJson(cyclic)).toThrow(TypeError)

    const app = await boot((r) => {
      r.get('/model', () => new Model())
      r.get('/list', () => [
        new Model(),
      ]).meta({ envelope: false })
      r.get('/created', (ctx) => {
        ctx.status(201)
        ctx.setHeader('x-extra', '1')
        return { id: 1n }
      })
      r.get('/text', () => 'plain')
    })
    expect((await (await app.request('/model')).json() as any).data).toEqual({
      id: '9007199254740993',
      nested: ['1'],
    })
    expect(await (await app.request('/list')).json()).toEqual([
      {
        id: '9007199254740993',
        nested: ['1'],
      },
    ])
    const created = await app.request('/created')
    expect([
      created.status,
      created.headers.get('x-extra'),
      created.headers.get('content-type'),
    ]).toEqual([201, '1', 'application/json;charset=UTF-8'])
    expect((await created.json() as any).data).toEqual({ id: '1' })
    const head = await app.request('/created', { method: 'HEAD' })
    expect([head.status, await head.text()]).toEqual([201, ''])
    expect(await (await app.request('/text')).text()).toContain('plain')
  })
})

describe('compress levels', () => {
  // 确定性的伪随机文本（重复度适中，压缩级别之间才有稳定的大小差异）
  const words = [
    'haze',
    'router',
    'queue',
    'cache',
    'session',
    'worker',
    'stream',
    'driver',
    'schema',
    'tenant',
    'policy',
    'signal',
  ]
  let seed = 7
  const next = (): number => (seed = (seed * 1103515245 + 12345) % 2147483648)
  const big = {
    items: Array.from({ length: 800 }, (_, index) => ({
      index,
      text: Array.from({ length: 6 }, () => words[next() % words.length]).join(' '),
      score: next() % 100000,
    })),
  }

  it('uses a fast brotli quality by default and honours compress.level', async () => {
    const sizes: Record<string, number> = {}
    for (const [name, level] of [
      ['default', undefined],
      [
        'max',
        { br: 11, gzip: 9 },
      ],
      [
        'min',
        { br: 0, gzip: 1 },
      ],
    ] as const) {
      const app = await boot(r => r.get('/big', () => big), {}, {
        middleware: {
          global: ['compress'],
        },
        compress: level
          ? { level }
          : {},
      })
      const br = await app.request('/big', {
        headers: { 'accept-encoding': 'br' },
      })
      expect(br.headers.get('content-encoding')).toBe('br')
      const bytes = Buffer.from(await br.arrayBuffer())
      expect(JSON.parse(brotliDecompressSync(bytes).toString()).data).toEqual(big)
      sizes[`br:${name}`] = bytes.byteLength
      const gzip = await app.request('/big', {
        headers: { 'accept-encoding': 'gzip' },
      })
      const zipped = Buffer.from(await gzip.arrayBuffer())
      expect(JSON.parse(gunzipSync(zipped).toString()).data).toEqual(big)
      sizes[`gzip:${name}`] = zipped.byteLength
    }
    // 默认 quality 4：介于 0 与 11 之间（之前默认是 11）
    expect(sizes['br:max']).toBeLessThan(sizes['br:default'])
    expect(sizes['br:default']).toBeLessThan(sizes['br:min'])
    expect(sizes['gzip:max']).toBeLessThan(sizes['gzip:min'])
  })
})

describe('cacheResponse keys', () => {
  it('does not share entries between sub-apps, hosts or locales', async () => {
    let hits = 0
    const routes = (name: string): unknown => ({
      default: defineRoutes(r => r.get('/stats', ctx => ({ from: name, locale: ctx.locale, hits: ++hits })).middleware('cacheResponse:60')),
    })
    const app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        logger: { level: 'silent' },
        app: {
          key: KEY,
          apps: {
            admin: { prefix: '/admin' },
            shop: { prefix: '/shop' },
            api: { domain: '*.example.com' },
          },
        },
        i18n: {
          defaultLocale: 'en',
          locales: ['en', 'zh-CN'],
        },
      },
      lang: {
        'en': {
          messages: { hi: 'hi' },
        },
        'zh-CN': {
          messages: { hi: '你好' },
        },
      },
      apps: {
        '/app/admin/route/web.ts': routes('admin'),
        '/app/shop/route/web.ts': routes('shop'),
        '/app/api/route/web.ts': routes('api'),
      },
    })
    const get = async (url: string, headers: Record<string, string> = {}): Promise<[string | null, any]> => {
      const response = await app.request(url, { headers })
      return [
        response.headers.get('x-cache'),
        (await response.json() as any).data,
      ]
    }
    expect(await get('/admin/stats')).toEqual([
      'MISS',
      { from: 'admin', locale: 'en', hits: 1 },
    ])
    expect(await get('/admin/stats')).toEqual([
      'HIT',
      { from: 'admin', locale: 'en', hits: 1 },
    ])
    // 另一个应用下去掉前缀后是同一个路径：不能命中 admin 的缓存
    expect(await get('/shop/stats')).toEqual([
      'MISS',
      { from: 'shop', locale: 'en', hits: 2 },
    ])
    // 同一个应用的不同域名
    expect(await get('http://a.example.com/stats')).toEqual([
      'MISS',
      { from: 'api', locale: 'en', hits: 3 },
    ])
    expect(await get('http://b.example.com/stats')).toEqual([
      'MISS',
      { from: 'api', locale: 'en', hits: 4 },
    ])
    expect((await get('http://a.example.com/stats'))[0]).toBe('HIT')
    // 语言不同
    expect(await get('/admin/stats', { 'accept-language': 'zh-CN' })).toEqual([
      'MISS',
      { from: 'admin', locale: 'zh-CN', hits: 5 },
    ])
    expect((await get('/admin/stats', { 'accept-language': 'zh-CN' }))[0]).toBe('HIT')
    await Cache.flush()
  })
})

describe('session sliding expiry', () => {
  const cookieOf = (response: Response): string | undefined => response.headers.getSetCookie().find(value => value.startsWith('haze_session='))?.split(';')[0]

  for (const driver of ['cookie', 'memory'] as const) {
    it(`re-issues the cookie for read-only requests past half of the lifetime (${driver})`, async () => {
      vi.useFakeTimers({
        toFake: ['Date'],
      })
      try {
        const sets: number[] = []
        const store: SessionStore | undefined = driver === 'memory'
          ? (() => {
              const data = new Map<string, Record<string, unknown>>()
              return {
                get: async id => data.get(id),
                set: async (id, value, ttl) => {
                  data.set(id, value)
                  sets.push(ttl)
                },
                destroy: async id => void data.delete(id),
              }
            })()
          : undefined
        const app = await boot((r) => {
          r.get('/login', async (ctx) => {
            (await ctx.startSession()).set('user', 1)
            return { ok: true }
          })
          r.get('/me', async ctx => ({ user: (await ctx.startSession()).get('user') ?? null }))
        }, {}, {
          session: { driver: store ?? 'cookie', lifetime: 100 },
        })
        let cookie = cookieOf(await app.request('/login'))!
        expect(cookie).toBeTruthy()
        const me = (): Promise<Response> => app.request('/me', {
          headers: { cookie },
        })

        // 前一半有效期内：只读请求不写 Cookie
        vi.setSystemTime(Date.now() + 40_000)
        expect(cookieOf(await me())).toBeUndefined()
        // 过半：续期一次（完整的有效期）
        vi.setSystemTime(Date.now() + 20_000)
        const renewed = await me()
        expect((await renewed.json() as any).data).toEqual({ user: 1 })
        expect(renewed.headers.getSetCookie().find(value => value.startsWith('haze_session='))).toContain('Max-Age=100')
        cookie = cookieOf(renewed)!
        if (store)
          expect(sets).toEqual([100, 100])
        // 续期后重新计时：原来的 100 秒已过，会话仍然有效，且不再重复下发
        vi.setSystemTime(Date.now() + 45_000)
        const later = await me()
        expect((await later.json() as any).data).toEqual({ user: 1 })
        expect(cookieOf(later)).toBeUndefined()
      }
      finally {
        vi.useRealTimers()
      }
    })
  }

  it('accepts server-side session cookies in the previous <id>.<signature> format', async () => {
    const data = new Map<string, Record<string, unknown>>()
    const store: SessionStore = {
      get: async id => data.get(id),
      set: async (id, value) => void data.set(id, value),
      destroy: async id => void data.delete(id),
    }
    const app = await boot((r) => {
      r.get('/login', async (ctx) => {
        (await ctx.startSession()).set('user', 7)
        return {}
      })
      r.get('/me', async ctx => ({ user: (await ctx.startSession()).get('user') ?? null }))
    }, {}, {
      session: { driver: store },
    })
    const cookie = decodeURIComponent(cookieOf(await app.request('/login'))!.split('=')[1])
    const [id] = cookie.split('.')
    const { sign } = await import('../src/security/key')
    const legacy = `haze_session=${id}.${await sign(id, KEY)}`
    const response = await app.request('/me', {
      headers: { cookie: legacy },
    })
    expect((await response.json() as any).data).toEqual({ user: 7 })
    // 旧格式没有过期时间：续期一次并换成新格式
    expect(cookieOf(response)).toBeTruthy()
  })
})

describe('application dispose and boot', () => {
  it('isolates failing shutdown steps and still releases everything', async () => {
    const calls: string[] = []
    const app = await boot(() => {}, {
      providers: [
        {
          shutdown: () => void calls.push('first'),
        },
        {
          shutdown: () => {
            calls.push('second')
            throw new Error('shutdown failed')
          },
        },
        {
          shutdown: () => void calls.push('third'),
        },
      ],
    })
    const entries = captureLogs(app)
    const closeQueue = vi.spyOn(app.make(QueueManager), 'close')
    const closeLogger = vi.spyOn(app.logger, 'close')
    await expect(app.dispose()).rejects.toThrow('shutdown failed')
    // 逆序执行，抛错的提供者不影响其余步骤
    expect(calls).toEqual(['third', 'second', 'first'])
    expect(closeQueue).toHaveBeenCalledTimes(1)
    expect(closeLogger).toHaveBeenCalledTimes(1)
    expect(() => app.make(CacheManager)).toThrow('disposed')
    expect(entries.some(entry => entry.level === 'error' && entry.msg.includes('shut down provider'))).toBe(true)
  })

  it('shares one boot between concurrent calls', async () => {
    let registered = 0
    const app = new Application({
      mode: 'test',
      env: false,
      config: {
        logger: { level: 'silent' },
        app: { key: KEY },
      },
      providers: [
        {
          register: async () => {
            registered++
            await new Promise(resolve => setTimeout(resolve, 5))
          },
        },
      ],
    })
    const [a, b] = await Promise.all([
      app.boot(),
      app.boot(),
    ])
    expect(a).toBe(b)
    expect(registered).toBe(1)
    await app.dispose()
  })

  it('cleans up and restores the previous app\'s global managers when boot fails midway', async () => {
    const previous = await boot(() => {})
    await previous.make(CacheManager).store().set('who', 'previous')
    const calls: string[] = []
    const failing = new Application({
      mode: 'test',
      env: false,
      config: {
        logger: { level: 'silent' },
        app: { key: KEY },
      },
      providers: [
        {
          boot: () => void calls.push('boot:a'),
          shutdown: () => void calls.push('shutdown:a'),
        },
        {
          boot: () => {
            throw new Error('boot failed')
          },
          shutdown: () => void calls.push('shutdown:b'),
        },
      ],
    })
    await expect(failing.boot()).rejects.toThrow('boot failed')
    expect(calls).toEqual(['boot:a', 'shutdown:b', 'shutdown:a'])
    expect(failing.booted).toBe(false)
    // 再次调用得到同一个错误，不会重复启动
    await expect(failing.boot()).rejects.toThrow('boot failed')
    expect(calls).toHaveLength(3)
    // 请求之外的门面仍然指向之前的应用，且它继续可用
    expect(await Cache.get('who')).toBe('previous')
    expect(previous.make(MaintenanceManager)).toBeInstanceOf(MaintenanceManager)
    expect((await previous.request('/missing')).status).toBe(404)
    await previous.dispose()
  })
})

describe('in-process workers', () => {
  it('start from serve() without relying on the Node server extension, exactly once', async () => {
    const work = vi.spyOn(Scheduler.prototype, 'work').mockImplementation(async () => {})
    const extensions = await import('../src/server/extensions')
    try {
      const app = await createApplication({
        mode: 'production',
        env: false,
        config: {
          logger: { level: 'silent' },
          app: { key: KEY },
          schedule: { runInServer: true },
        },
      })
      // 模拟 Bun / Deno：没有 http.Server 可挂，服务器扩展的 node 钩子不会被调用
      const extension = extensions.serverExtensions().find(item => item.name === 'haze:in-process-workers')!
      const viaExtension = vi.spyOn(extension, 'node' as never)
      extensions.unregisterServerExtension(extension.name)
      const server = app.serve({ port: 0, hostname: '127.0.0.1', silent: true })
      await server.ready()
      await vi.waitFor(() => expect(work).toHaveBeenCalledTimes(1))
      expect(viaExtension).not.toHaveBeenCalled()
      // 之后扩展钩子再触发（Node / Vite 开发服务器）也不会重复启动
      extension.node!({} as never)
      await new Promise(resolve => setTimeout(resolve, 10))
      expect(work).toHaveBeenCalledTimes(1)
      const signal = work.mock.calls[0]![0]!
      await server.close()
      await app.dispose()
      expect(signal.aborted).toBe(true)
    }
    finally {
      work.mockRestore()
    }
  })
})

describe('cached lookups', () => {
  it('router.url() sees routes loaded after the first lookup', async () => {
    const app = await boot(r => r.get('/users/:id', () => ({})).name('users.show'))
    expect(app.router.url('users.show', { id: 1 })).toBe('/users/1')
    const url = (name: string): string => (app.router.url as (name: string) => string)(name)
    expect(() => url('late')).toThrow('not defined')
    app.router.load(defineRoutes(r => r.get('/late', () => ({})).name('late')))
    expect(url('late')).toBe('/late')
  })

  it('maintenance state is served stale while it refreshes in the background', async () => {
    const app = await boot(() => {}, {}, {
      maintenance: { interval: 50 },
    })
    const manager = app.make(MaintenanceManager)
    const driver = manager.driver()
    expect(await manager.state()).toBeUndefined()
    await driver.put({
      time: Date.now(),
      status: 503,
      retry: 60,
    })
    let release!: () => void
    const gate = new Promise<void>(resolve => (release = resolve))
    const get = vi.spyOn(driver, 'get').mockImplementation(async () => {
      await gate
      return {
        time: Date.now(),
        status: 503,
        retry: 60,
      }
    })
    await new Promise(resolve => setTimeout(resolve, 60))
    // 缓存刚过期：存储读取还没返回，请求立即拿到旧状态，并发请求共用一次读取
    expect(await Promise.all([
      manager.state(),
      manager.state(),
      manager.state(),
    ])).toEqual([undefined, undefined, undefined])
    expect(get).toHaveBeenCalledTimes(1)
    release()
    await vi.waitFor(async () => expect(await manager.state()).toMatchObject({ status: 503 }))
    get.mockRestore()
    await driver.forget()
  })
})
