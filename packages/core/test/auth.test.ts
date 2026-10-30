import type { Application, ApplicationOptions, RouteRegistrar, SessionStore, UserProvider } from '../src'
import { generateKeyPairSync } from 'node:crypto'
import { decodeJwt } from 'jose'
import { describe, expect, it } from 'vitest'
import { createApplication, defineRoutes, defineUserProvider, ForbiddenException, generateKey, Hash, issueTestCredentials, memorySessionStore, UnauthorizedException } from '../src'

const APP_KEY = generateKey()

interface User {
  id: number
  email: string
  password: string
}

async function users(): Promise<UserProvider<User>> {
  const rows: User[] = [
    { id: 1, email: 'ada@example.com', password: await Hash.make('secret') },
  ]
  return defineUserProvider<User>({
    retrieveById: id => rows.find(user => user.id === Number(id)),
    retrieveByCredentials: credentials => rows.find(user => user.email === credentials.email),
    validateCredentials: (user, credentials) => Hash.verify(user.password, String(credentials.password)),
    getId: user => user.id,
  })
}

function boot(routes: RouteRegistrar, config: Record<string, unknown> = {}, options: ApplicationOptions = {}) {
  return createApplication({
    mode: 'test',
    env: false,
    ...options,
    config: {
      logger: { level: 'silent' },
      ...config,
      app: { key: APP_KEY, ...config.app as object },
    },
    routes: [
      defineRoutes(routes),
    ],
  })
}

/** 保存 Set-Cookie 并在后续请求中带上（模拟浏览器） */
function browser(app: Application) {
  const jar = new Map<string, string>()
  return async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers)
    if (jar.size)
      headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '))
    const res = await app.request(path, { ...init, headers })
    for (const cookie of res.headers.getSetCookie()) {
      const [pair, ...attributes] = cookie.split(';')
      const [name, value] = pair.split('=')
      if (attributes.some(attribute => /max-age=0/i.test(attribute)) || !value)
        jar.delete(name)
      else
        jar.set(name, value)
    }
    return res
  }
}

const json = { 'content-type': 'application/json' }

/** Set-Cookie 的各项（名值在前，属性排序后比较） */
function attributes(cookie: string): string[] {
  const [pair, ...rest] = cookie.split('; ')
  return [
    pair,
    ...rest.sort(),
  ]
}

describe('hash', () => {
  it('hashes with scrypt by default, verifies, and reports when to rehash', async () => {
    const hash = await Hash.make('secret')
    expect(hash).toMatch(/^\$scrypt\$n=16384,r=8,p=1\$/)
    expect(await Hash.verify(hash, 'secret')).toBe(true)
    expect(await Hash.verify(hash, 'wrong')).toBe(false)
    expect(Hash.needsRehash(hash)).toBe(false)

    const pbkdf2 = await Hash.make('secret', { algorithm: 'pbkdf2', iterations: 1000 })
    expect(pbkdf2).toMatch(/^\$pbkdf2-sha256\$i=1000\$/)
    expect(await Hash.verify(pbkdf2, 'secret')).toBe(true)
    expect(Hash.needsRehash(pbkdf2)).toBe(true)
    expect(await Hash.verify('not-a-hash', 'secret')).toBe(false)
  })
})

describe('cookies', () => {
  it('sets defaults, signs and rejects tampered signed cookies', async () => {
    const app = await boot((r) => {
      r.get('/set', async (ctx) => {
        ctx.setCookie('theme', 'dark')
        await ctx.setSignedCookie('uid', '42')
        return 'ok'
      })
      r.get('/read', async ctx => ({
        theme: ctx.cookie('theme'),
        uid: await ctx.signedCookie('uid'),
      }))
    })
    const set = await app.request('/set')
    const cookies = set.headers.getSetCookie()
    expect(attributes(cookies[0])).toEqual([
      'theme=dark',
      'HttpOnly',
      'Path=/',
      'SameSite=Lax',
      'Secure',
    ])
    const signed = cookies[1].split(';')[0]
    const read = async (cookie: string) => (await (await app.request('/read', {
      headers: { cookie },
    })).json() as any).data
    expect(await read(`theme=dark; ${signed}`)).toEqual({ theme: 'dark', uid: '42' })
    expect(await read(signed.replace('uid=42', 'uid=1'))).toEqual({ uid: undefined })
  })

  it('requires an APP_KEY of at least 32 characters', async () => {
    const app = await boot(r => r.get('/', async ctx => ctx.setSignedCookie('a', 'b').then(() => 'ok')), {
      app: { key: 'short' },
    })
    const res = await app.request('/')
    expect(res.status).toBe(500)
  })
})

const sessionRoutes: RouteRegistrar = (r) => {
  r.group({
    middleware: ['session'],
  }, (r) => {
    r.post('/cart', async (ctx) => {
      const items = ctx.session.get<string[]>('items', [])!
      ctx.session.set('items', [...items, (await ctx.body<{ item: string }>()).item])
      return ctx.session.get('items')
    })
    r.get('/cart', ctx => ({
      items: ctx.session.get('items', []),
      id: ctx.session.id,
    }))
    r.post('/flash', (ctx) => {
      ctx.session.flash('notice', 'saved')
      return 'ok'
    })
    r.get('/flash', ctx => ({ notice: ctx.session.get('notice') ?? null }))
    r.post('/regenerate', (ctx) => {
      ctx.session.regenerate()
      return { id: ctx.session.id }
    })
    r.delete('/cart', (ctx) => {
      ctx.session.invalidate()
      return 'bye'
    })
    r.get('/anonymous', () => 'no session data')
  })
  r.get('/no-session', ctx => ctx.session.get('x'))
}

describe.each([
  { driver: 'cookie' as const },
  { driver: 'memory' as const },
  {
    driver: 'custom',
    store: memorySessionStore(),
  },
])('session ($driver driver)', ({ driver, store }) => {
  const config = {
    session: { driver: store ?? driver, cookie: 'sid', lifetime: '1h' },
  }

  it('persists data across requests, without a cookie for untouched sessions', async () => {
    const app = await boot(sessionRoutes, config)
    const request = browser(app)
    expect((await request('/anonymous')).headers.getSetCookie()).toEqual([])
    const first = await request('/cart', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ item: 'apple' }),
    })
    expect(attributes(first.headers.getSetCookie()[0]).slice(1)).toEqual([
      'HttpOnly',
      'Max-Age=3600',
      'Path=/',
      'SameSite=Lax',
      'Secure',
    ])
    await request('/cart', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ item: 'pear' }),
    })
    expect((await (await request('/cart')).json() as any).data.items).toEqual(['apple', 'pear'])
    // 只读请求不重写 Cookie
    expect((await request('/cart')).headers.getSetCookie()).toEqual([])
  })

  it('flashes data for exactly the next request', async () => {
    const app = await boot(sessionRoutes, config)
    const request = browser(app)
    await request('/flash', { method: 'POST' })
    expect((await (await request('/flash')).json() as any).data.notice).toBe('saved')
    expect((await (await request('/flash')).json() as any).data.notice).toBeNull()
  })

  it('regenerates the id keeping data, invalidates and clears the cookie', async () => {
    const app = await boot(sessionRoutes, config)
    const request = browser(app)
    await request('/cart', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ item: 'apple' }),
    })
    const before = (await (await request('/cart')).json() as any).data.id
    const after = (await (await request('/regenerate', { method: 'POST' })).json() as any).data.id
    expect(after).not.toBe(before)
    expect((await (await request('/cart')).json() as any).data).toEqual({
      items: ['apple'],
      id: after,
    })

    const bye = await request('/cart', { method: 'DELETE' })
    expect(bye.headers.getSetCookie()[0]).toMatch(/^sid=; Max-Age=0/)
    expect((await (await request('/cart')).json() as any).data.items).toEqual([])
  })

  it('ignores forged cookies', async () => {
    const app = await boot(sessionRoutes, config)
    const res = await app.request('/cart', {
      headers: { cookie: 'sid=forged.value' },
    })
    expect((await res.json() as any).data.items).toEqual([])
  })
})

describe('session errors', () => {
  it('explains a missing session middleware', async () => {
    const app = await boot(sessionRoutes)
    expect((await app.request('/no-session')).status).toBe(500)
  })

  it('refuses data too large for the cookie driver', async () => {
    const app = await boot(r => r.post('/big', async (ctx) => {
      (await ctx.startSession()).set('blob', 'x'.repeat(5000))
      return 'ok'
    }))
    expect((await app.request('/big', { method: 'POST' })).status).toBe(500)
  })

  it('custom stores receive ids, data and ttl', async () => {
    const calls: string[] = []
    const store: SessionStore = {
      get: async () => undefined,
      set: async (id, data, ttl) => void calls.push(`set:${typeof id}:${JSON.stringify(data)}:${ttl}`),
      destroy: async id => void calls.push(`destroy:${typeof id}`),
    }
    const app = await boot(sessionRoutes, {
      session: { driver: store, lifetime: '10m' },
    })
    await app.request('/cart', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ item: 'x' }),
    })
    expect(calls).toEqual(['set:string:{"items":["x"]}:600'])
  })
})

function authRoutes(): RouteRegistrar {
  return (r) => {
    r.post('/login', async (ctx) => {
      const issued = await ctx.auth.jwt('api').attempt(await ctx.body(), { role: 'admin' })
      if (!issued)
        throw new UnauthorizedException('账号或密码错误')
      return issued
    }).middleware('guest:api')
    r.post('/web/login', async (ctx) => {
      if (!await ctx.auth.session('web').attempt(await ctx.body()))
        throw new UnauthorizedException('账号或密码错误')
      return { id: await ctx.auth.guard('web').id() }
    })
    r.post('/web/logout', async (ctx) => {
      await ctx.auth.guard('web').logout()
      return 'bye'
    })
    r.group({
      middleware: ['auth:api,web'],
    }, (r) => {
      r.get('/me', async ctx => ({ email: (await ctx.auth.user() as User | undefined)?.email, guard: ctx.auth.defaultGuard }))
      r.get('/claims', async ctx => ctx.auth.jwt().payload())
    })
  }
}

async function authConfig(api: Record<string, unknown> = {}) {
  return {
    auth: {
      default: 'api',
      guards: {
        api: {
          driver: 'jwt',
          provider: 'users',
          expiresIn: '15m',
          issuer: 'hazejs',
          ...api,
        },
        web: { driver: 'session', provider: 'users' },
      },
      providers: { users: await users() },
    },
  }
}

describe('jwt guard', () => {
  it('issues tokens on valid credentials and authenticates Bearer requests', async () => {
    const app = await boot(authRoutes(), await authConfig())
    const login = await app.request('/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ada@example.com', password: 'secret' }),
    })
    const { data } = await login.json() as any
    expect(data).toMatchObject({ type: 'Bearer', expiresIn: 900 })
    expect(decodeJwt(data.token)).toMatchObject({ sub: '1', iss: 'hazejs', role: 'admin' })

    const headers = { authorization: `Bearer ${data.token}` }
    expect((await (await app.request('/me', { headers })).json() as any).data).toEqual({ email: 'ada@example.com', guard: 'api' })
    expect((await (await app.request('/claims', { headers })).json() as any).data.role).toBe('admin')
    // guest:api：已登录时拒绝
    expect((await app.request('/login', {
      method: 'POST',
      headers: {
        ...headers,
        ...json,
      },
      body: '{}',
    })).status).toBe(403)
  })

  it('rejects wrong passwords, missing, tampered and expired tokens with 401', async () => {
    const app = await boot(authRoutes(), await authConfig())
    const wrong = await app.request('/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ada@example.com', password: 'nope' }),
    })
    expect([wrong.status, (await wrong.json() as any).message]).toEqual([401, '账号或密码错误'])

    const missing = await app.request('/me')
    expect([missing.status, (await missing.json() as any).message]).toEqual([401, '未登录或登录已过期'])
    expect((await app.request('/me', {
      headers: { authorization: 'Bearer abc.def.ghi' },
    })).status).toBe(401)

    const expired = await boot(authRoutes(), await authConfig({ expiresIn: 0 }))
    const { data } = await (await expired.request('/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ada@example.com', password: 'secret' }),
    })).json() as any
    await new Promise(resolve => setTimeout(resolve, 1100))
    expect((await expired.request('/me', {
      headers: { authorization: `Bearer ${data.token}` },
    })).status).toBe(401)
  })

  it('signs with asymmetric keys (ES256)', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const app = await boot(authRoutes(), await authConfig({
      algorithm: 'ES256',
      privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    }))
    const { data } = await (await app.request('/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ada@example.com', password: 'secret' }),
    })).json() as any
    expect(JSON.parse(atob(data.token.split('.')[0]))).toMatchObject({ alg: 'ES256' })
    expect((await app.request('/me', {
      headers: { authorization: `Bearer ${data.token}` },
    })).status).toBe(200)
  })
})

describe('jwt guard hooks', () => {
  /** 会话表：sid → 是否有效（模拟数据库中的会话，退出 / 踢下线后立即失效） */
  const sessions = new Map<string, boolean>([
    ['s1', true],
    ['s2', false],
  ])

  async function hooked(extra: Record<string, unknown> = {}) {
    return boot((r) => {
      r.post('/issue', async (ctx) => {
        const body = await ctx.body<{ sid: string, purpose?: string, ttl?: string }>()
        const claims = {
          sid: body.sid,
          ...(body.purpose && { purpose: body.purpose }),
        }
        return ctx.auth.jwt().login({ id: 1, email: 'ada@example.com', password: '' }, claims, body.ttl
          ? { expiresIn: body.ttl }
          : {})
      })
      r.get('/me', async ctx => ({ user: await ctx.auth.user() })).middleware('auth')
      r.get('/maybe', async ctx => ({ user: (await ctx.auth.user()) ?? null })).middleware('auth:api,optional')
      r.get('/org', async ctx => ({ org: ((await ctx.auth.user()) as { org: string }).org })).middleware('auth')
    }, {
      auth: {
        default: 'api',
        guards: {
          api: {
            driver: 'jwt',
            provider: 'users',
            expiresIn: () => '10m',
            rejectClaims: ['purpose'],
            // 每个请求检查会话，并按请求头解析当前组织；抛出的异常原样作为响应
            resolveUser: (payload: Record<string, unknown>, ctx: { header: (name: string) => string | undefined }) => {
              if (!sessions.get(String(payload.sid)))
                throw new UnauthorizedException('会话已失效', { code: 'session_invalid' })
              const org = ctx.header('x-org-id')
              if (org === 'other')
                throw new ForbiddenException('无权访问该组织', { code: 'org_forbidden' })
              return {
                id: Number(payload.sub),
                sid: payload.sid,
                org: org ?? 'home',
              }
            },
            ...extra,
          },
        },
        providers: { users: await users() },
      },
    })
  }

  async function issue(app: Application, body: Record<string, unknown>): Promise<string> {
    const res = await app.request('/issue', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(body),
    })
    return ((await res.json()) as any).data.token
  }

  it('resolves users from claims and request headers, passing HttpExceptions through', async () => {
    const app = await hooked()
    const valid = await issue(app, { sid: 's1' })
    const bearer = (token: string, headers: Record<string, string> = {}) => ({
      headers: { authorization: `Bearer ${token}`, ...headers },
    })
    expect(((await (await app.request('/me', bearer(valid))).json()) as any).data.user).toEqual({ id: 1, sid: 's1', org: 'home' })
    expect(((await (await app.request('/org', bearer(valid, { 'x-org-id': 'branch' }))).json()) as any).data.org).toBe('branch')

    const revoked = await app.request('/me', bearer(await issue(app, { sid: 's2' })))
    expect([revoked.status, ((await revoked.json()) as any).code]).toEqual([401, 'session_invalid'])
    const forbidden = await app.request('/org', bearer(valid, { 'x-org-id': 'other' }))
    expect([forbidden.status, ((await forbidden.json()) as any).code]).toEqual([403, 'org_forbidden'])
  })

  it('distinguishes missing and invalid credentials, and rejects tokens carrying rejectClaims', async () => {
    const app = await hooked()
    const missing = await app.request('/me')
    expect([missing.status, ((await missing.json()) as any).code]).toEqual([401, 'unauthenticated'])
    const invalid = await app.request('/me', {
      headers: { authorization: 'Bearer abc.def.ghi' },
    })
    expect([invalid.status, ((await invalid.json()) as any).code]).toEqual([401, 'token_invalid'])
    // 同一密钥签发的找回密码凭证不能当作登录令牌
    const ticket = await issue(app, { sid: 's1', purpose: 'reset' })
    const reset = await app.request('/me', {
      headers: { authorization: `Bearer ${ticket}` },
    })
    expect([reset.status, ((await reset.json()) as any).code]).toEqual([401, 'token_invalid'])
  })

  it('evaluates expiresIn functions per login and lets login() override it', async () => {
    const app = await hooked()
    const token = await issue(app, { sid: 's1' })
    const claims = decodeJwt(token)
    expect(claims.exp! - claims.iat!).toBe(600)
    const short = decodeJwt(await issue(app, { sid: 's1', ttl: '30s' }))
    expect(short.exp! - short.iat!).toBe(30)
  })

  it('treats failures as guests with auth:optional', async () => {
    const app = await hooked()
    const read = async (init?: RequestInit) => ((await (await app.request('/maybe', init)).json()) as any).data.user
    expect(await read()).toBeNull()
    expect(await read({
      headers: { authorization: 'Bearer abc.def.ghi' },
    })).toBeNull()
    expect(await read({
      headers: { authorization: `Bearer ${await issue(app, { sid: 's2' })}` },
    })).toBeNull()
    expect(await read({
      headers: { authorization: `Bearer ${await issue(app, { sid: 's1' })}` },
    })).toMatchObject({ sid: 's1' })
  })
})

describe('session guard', () => {
  it('logs in with a regenerated session, authenticates via cookie and logs out', async () => {
    const app = await boot(authRoutes(), await authConfig())
    const request = browser(app)
    const login = await request('/web/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ada@example.com', password: 'secret' }),
    })
    expect((await login.json() as any).data).toEqual({ id: 1 })
    // auth:api,web：JWT 未通过时改用 session
    expect((await (await request('/me')).json() as any).data).toEqual({ email: 'ada@example.com', guard: 'web' })

    await request('/web/logout', { method: 'POST' })
    expect((await request('/me')).status).toBe(401)
  })

  it('does not log in with wrong credentials', async () => {
    const app = await boot(authRoutes(), await authConfig())
    const res = await app.request('/web/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ada@example.com', password: 'x' }),
    })
    expect(res.status).toBe(401)
    expect(res.headers.getSetCookie()).toEqual([])
  })
})

describe('issueTestCredentials (actingAs)', () => {
  it('creates a real Bearer token or session cookie for a user', async () => {
    const app = await boot(authRoutes(), await authConfig())
    const ada = { id: 1, email: 'ada@example.com', password: '' }
    const jwt = await issueTestCredentials(app, ada)
    expect((await (await app.request('/me', { headers: jwt })).json() as any).data).toEqual({ email: 'ada@example.com', guard: 'api' })
    const session = await issueTestCredentials(app, ada, 'web')
    expect(Object.keys(session)).toEqual(['cookie'])
    expect((await (await app.request('/me', { headers: session })).json() as any).data).toEqual({ email: 'ada@example.com', guard: 'web' })
  })
})
