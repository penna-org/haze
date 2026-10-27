import type { ApplicationOptions, HttpContext, MiddlewareHandler, NormalizedError } from '../src'
import { describe, expect, it } from 'vitest'
import {
  Config,
  config,
  createApplication,
  defineRoutes,
  ExceptionHandler,
  inject,
  matchDomain,
  NotFoundException,
  ResponseFormatter,
  Scope,
} from '../src'

const trace: string[] = []
function mark(name: string): MiddlewareHandler {
  return (_ctx, next) => {
    trace.push(name)
    return next()
  }
}

class SettingsController {
  static scope = Scope.Request
  private config = inject(Config)

  show(ctx: HttpContext) {
    return {
      app: ctx.appName ?? null,
      injected: this.config.get('app.name'),
      helper: config('app.name'),
    }
  }
}

class ApiFormatter extends ResponseFormatter {
  override success(data: unknown) {
    return { ok: true, result: data }
  }

  override error(error: NormalizedError) {
    return { ok: false, error: error.message }
  }
}

class ApiHandler extends ExceptionHandler {
  override report() {}
}

const booted: string[] = []

/** 模拟 import.meta.glob('/app/*\/{route,config,provider,exception,response}/*') */
const apps: ApplicationOptions['apps'] = {
  '/app/admin/route/web.ts': {
    default: defineRoutes((r) => {
      r.get('/users', () => [
        { from: 'admin' },
      ]).name('users.index')
      r.get('/users/:id', ctx => ({
        id: ctx.param('id'),
      })).name('users.show')
      r.get('/settings', [SettingsController, 'show'])
      r.get('/secure', () => 'ok').middleware('auth')
    }),
  },
  '/app/admin/config/app.ts': {
    default: {
      name: 'Admin Console',
      response: { envelope: false },
    },
  },
  '/app/admin/config/middleware.ts': {
    default: {
      global: [
        mark('admin'),
      ],
      alias: {
        auth: mark('admin-auth'),
      },
    },
  },
  '/app/admin/provider/AdminProvider.ts': {
    default: {
      boot: () => void booted.push('admin'),
    },
  },

  '/app/api/route/v1.ts': {
    default: defineRoutes((r) => {
      r.get('/users', () => [
        { from: 'api' },
      ]).name('users.index')
      r.get('/boom', () => {
        throw new NotFoundException('用户不存在')
      })
    }),
  },
  '/app/api/response/Formatter.ts': { default: ApiFormatter },
  '/app/api/exception/Handler.ts': { default: ApiHandler },

  '/app/mobile/route/v1.ts': {
    default: defineRoutes(r => r.get('/ping', ctx => ({ app: ctx.appName }))),
  },
  // 未在 config/app.ts 中声明的目录不会启用
  '/app/common/route/ignored.ts': {
    default: defineRoutes(r => r.get('/common', () => 'never')),
  },
}

function boot(extra: Partial<ApplicationOptions> = {}) {
  trace.length = 0
  return createApplication({
    mode: 'test',
    env: false,
    config: {
      app: {
        name: 'Global',
        apps: {
          admin: { prefix: '/admin' },
          api: { domain: 'api.example.com' },
          mobile: { domain: '*.m.example.com', prefix: '/v1' },
        },
      },
      middleware: {
        global: [
          mark('global'),
        ],
        alias: {
          auth: mark('global-auth'),
        },
      },
    },
    routes: [
      defineRoutes((r) => {
        r.get('/users', () => [
          { from: 'global' },
        ]).name('users.index')
        r.get('/settings', [SettingsController, 'show'])
      }),
    ],
    apps,
    ...extra,
  })
}

async function json(res: Response | Promise<Response>): Promise<any> {
  return (await res).json()
}

describe('multi-app dispatch', () => {
  it('routes by prefix and domain, falling back to global routes', async () => {
    const app = await boot()
    expect(await json(app.request('/admin/users'))).toEqual([
      { from: 'admin' },
    ])
    expect(await json(app.request('http://api.example.com/users'))).toEqual({
      ok: true,
      result: [
        { from: 'api' },
      ],
    })
    expect((await json(app.request('/users'))).data).toEqual([
      { from: 'global' },
    ])
    expect((await json(app.request('http://shop.m.example.com/v1/ping'))).data).toEqual({ app: 'mobile' })
    // 通配域名不匹配根域名
    expect((await app.request('http://m.example.com/v1/ping')).status).toBe(404)
    expect((await app.request('/common')).status).toBe(404)
  })

  it('uses app-level config for formatting, injection and the config() helper', async () => {
    const app = await boot()
    expect(await json(app.request('/admin/settings'))).toEqual({ app: 'admin', injected: 'Admin Console', helper: 'Admin Console' })
    expect((await json(app.request('/settings'))).data).toEqual({ app: null, injected: 'Global', helper: 'Global' })
    // 全局配置未被应用配置污染
    expect(app.config.get('app.name')).toBe('Global')
  })

  it('runs global middleware for every app and app middleware only inside the app', async () => {
    const app = await boot()
    await app.request('/admin/secure')
    expect(trace).toEqual(['global', 'admin', 'admin-auth'])
    trace.length = 0
    await app.request('/users')
    expect(trace).toEqual(['global'])
  })

  it('renders errors with the app exception handler and formatter', async () => {
    const app = await boot()
    const boom = await app.request('http://api.example.com/boom')
    expect([boom.status, await boom.json()]).toEqual([
      404,
      { ok: false, error: '用户不存在' },
    ])

    const missing = await app.request('http://api.example.com/nope')
    expect((await missing.json() as { ok: boolean }).ok).toBe(false)

    const adminMissing = await app.request('/admin/nope')
    expect(adminMissing.status).toBe(404)
    expect(await adminMissing.json()).toMatchObject({ status: 404 })
  })

  it('prefixes route names with the app and builds full urls', async () => {
    const app = await boot()
    expect(app.router.url('admin.users.show', { id: 7 })).toBe('/admin/users/7')
    expect(app.router.url('users.index')).toBe('/users')
    expect(app.router.list().map(route => [
      route.app ?? '-',
      route.domain ?? '-',
      route.path,
      route.name ?? '-',
    ])).toEqual([
      ['-', '-', '/users', 'users.index'],
      ['-', '-', '/settings', '-'],
      [
        'admin',
        '-',
        '/admin/users',
        'admin.users.index',
      ],
      [
        'admin',
        '-',
        '/admin/users/:id',
        'admin.users.show',
      ],
      ['admin', '-', '/admin/settings', '-'],
      ['admin', '-', '/admin/secure', '-'],
      [
        'api',
        'api.example.com',
        '/users',
        'api.users.index',
      ],
      ['api', 'api.example.com', '/boom', '-'],
      [
        'mobile',
        '*.m.example.com',
        '/v1/ping',
        '-',
      ],
    ])
  })

  it('loads providers from enabled app directories', async () => {
    booted.length = 0
    await boot()
    expect(booted).toEqual(['admin'])
  })

  it('validates app declarations', async () => {
    await expect(createApplication({
      mode: 'test',
      env: false,
      config: {
        app: {
          apps: { bad: {} },
        },
      },
    }))
      .rejects
      .toThrow(/needs a prefix or a domain/)
    await expect(createApplication({
      mode: 'test',
      env: false,
      config: {
        app: {
          apps: {
            a: { prefix: '/x' },
            b: { prefix: 'x/' },
          },
        },
      },
    }))
      .rejects
      .toThrow(/both handle \/x/)
  })

  it('matches wildcard domains', () => {
    expect(matchDomain('*.example.com', 'a.example.com')).toBe(true)
    expect(matchDomain('*.example.com', 'a.b.example.com')).toBe(true)
    expect(matchDomain('*.example.com', 'example.com')).toBe(false)
    expect(matchDomain('api.example.com', 'API.example.com')).toBe(true)
  })
})
