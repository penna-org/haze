import type { RouteRegistrar, UserProvider } from '../src'
import { describe, expect, it } from 'vitest'
import { allow, allowGuest, createApplication, defineAbilities, definePolicy, defineRoutes, defineUserProvider, deny, Gate, generateKey, issueTestCredentials, NotFoundException } from '../src'

interface User {
  id: number
  role: 'admin' | 'member'
}

class Post {
  constructor(public id = 0, public userId = 0, public published = false) {}

  static rows = new Map<number, Post>([
    [
      1,
      new Post(1, 1, true),
    ],
    [
      2,
      new Post(2, 2, false),
    ],
  ])

  /** 与 ORM 模型相同的静态接口（can:update,Post,id 使用） */
  static async findOrFail(id: unknown): Promise<Post> {
    const post = Post.rows.get(Number(id))
    if (!post)
      throw new NotFoundException(`Post ${String(id)} 不存在`)
    return post
  }
}

class DraftPost extends Post {}

const PostPolicy = definePolicy(Post, {
  before: (user: User | undefined) => user?.role === 'admin' || undefined,
  view: allowGuest((user: User | undefined, post: Post) => post.published || post.userId === user?.id),
  update: (user: User, post: Post) => post.userId === user.id || deny('只能修改自己的文章'),
  publish: async (user: User, post: Post) => (post.userId === user.id
    ? allow()
    : deny()),
  create: (user: User) => user.id > 0,
})

const abilities = defineAbilities({
  'admin.access': (user: User) => user.role === 'admin',
  'report.export': (user: User, format: string) => format === 'csv' || deny('只支持 csv'),
})

const users: User[] = [
  { id: 1, role: 'member' },
  { id: 2, role: 'member' },
  { id: 9, role: 'admin' },
]

const provider: UserProvider<User> = defineUserProvider<User>({
  retrieveById: id => users.find(user => user.id === Number(id)),
  retrieveByCredentials: () => undefined,
  validateCredentials: () => false,
  getId: user => user.id,
})

function boot(routes: RouteRegistrar, extra: { policies?: unknown[], config?: Record<string, unknown> } = {}) {
  return createApplication({
    mode: 'test',
    env: false,
    policies: extra.policies ?? [PostPolicy, abilities],
    config: {
      logger: { level: 'silent' },
      app: {
        key: generateKey(),
      },
      auth: {
        default: 'api',
        guards: {
          api: { driver: 'jwt', provider: 'users' },
          web: { driver: 'session', provider: 'users' },
        },
        providers: { users: provider },
      },
      ...extra.config,
    },
    routes: [
      defineRoutes(routes),
    ],
  })
}

describe('gate', () => {
  it('evaluates policies by model instance (including subclasses) and class, before hooks and deny messages', async () => {
    const app = await boot(() => {})
    const gate = app.make(Gate)
    const [ada, bob, admin] = users
    const mine = Post.rows.get(1)!
    const theirs = Post.rows.get(2)!

    expect(await gate.allows(ada, 'update', mine)).toBe(true)
    expect(await gate.inspect(ada, 'update', theirs)).toEqual({ allowed: false, message: '只能修改自己的文章', guest: false })
    // before：管理员直接放行
    expect(await gate.allows(admin, 'update', theirs)).toBe(true)
    expect(await gate.allows(bob, 'publish', theirs)).toBe(true)
    expect(await gate.allows(ada, 'publish', theirs)).toBe(false)
    // 子类沿用父类的策略
    expect(await gate.allows(ada, 'update', new DraftPost(3, 1))).toBe(true)
    // 类级能力只收到 user
    expect(await gate.allows(ada, 'create', Post)).toBe(true)
  })

  it('denies guests without calling the ability unless allowGuest() is used', async () => {
    const app = await boot(() => {})
    const gate = app.make(Gate)
    expect(await gate.inspect(undefined, 'update', Post.rows.get(1)!)).toEqual({ allowed: false, guest: true })
    expect(await gate.allows(undefined, 'view', Post.rows.get(1)!)).toBe(true)
    expect(await gate.allows(undefined, 'view', Post.rows.get(2)!)).toBe(false)
  })

  it('supports plain abilities with arguments, global hooks and errors for unknown abilities', async () => {
    const app = await boot(() => {})
    const gate = app.make(Gate)
    const audit: string[] = []
    gate.after((user, ability, allowed) => void audit.push(`${(user as User | undefined)?.id}:${ability}:${allowed}`))
    gate.before((_user, ability) => (ability === 'report.export'
      ? undefined
      : undefined))
    gate.define('beta', (user: User) => user.id === 2)

    expect(await gate.allows(users[2], 'admin.access')).toBe(true)
    expect(await gate.inspect(users[0], 'report.export', 'xlsx')).toMatchObject({ allowed: false, message: '只支持 csv' })
    expect(await gate.forUser(users[1]).can('beta')).toBe(true)
    expect(audit).toEqual(['9:admin.access:true', '1:report.export:false', '2:beta:true'])
    await expect(gate.allows(users[0], 'nope')).rejects.toThrow('Unknown ability "nope"')
    await expect(gate.allows(users[0], 'destroy', Post.rows.get(1)!)).rejects.toThrow('has no "destroy" ability')
    expect(() => gate.register({})).toThrow(TypeError)
  })
})

describe('ctx.can / authorize and the can middleware', () => {
  const routes: RouteRegistrar = (r) => {
    r.get('/posts/:id', async (ctx) => {
      const post = await Post.findOrFail(ctx.param('id'))
      return { canUpdate: await ctx.can('update', post), cannotPublish: await ctx.cannot('publish', post) }
    })
    r.put('/posts/:id', async (ctx) => {
      const post = await Post.findOrFail(ctx.param('id'))
      await ctx.authorize('update', post)
      return { updated: post.id }
    })
    r.get('/admin', () => 'secret').middleware('can:admin.access')
    r.post('/posts', () => 'created').middleware('can:create,Post')
    r.delete('/posts/:id', ctx => ({ loaded: (ctx.get('post') as Post).id })).middleware('can:update,Post,id')
  }

  async function as(app: Awaited<ReturnType<typeof boot>>, id?: number) {
    const user = users.find(item => item.id === id)
    return user
      ? issueTestCredentials(app, user)
      : {}
  }

  it('answers can / cannot for the current user', async () => {
    const app = await boot(routes)
    const res = await app.request('/posts/1', { headers: await as(app, 1) })
    expect((await res.json() as any).data).toEqual({ canUpdate: true, cannotPublish: false })
    // 未登录：能力未调用，直接为 false
    expect((await (await app.request('/posts/1')).json() as any).data).toEqual({ canUpdate: false, cannotPublish: true })
  })

  it('authorize throws 403 with the deny message, 401 for guests', async () => {
    const app = await boot(routes)
    const forbidden = await app.request('/posts/2', { method: 'PUT', headers: await as(app, 1) })
    expect([forbidden.status, (await forbidden.json() as any).message]).toEqual([403, '只能修改自己的文章'])
    expect((await app.request('/posts/2', { method: 'PUT' })).status).toBe(401)
    expect((await app.request('/posts/2', { method: 'PUT', headers: await as(app, 9) })).status).toBe(200)
  })

  it('can:<ability>, can:<ability>,<Model> and can:<ability>,<Model>,<param>', async () => {
    const app = await boot(routes)
    expect((await app.request('/admin', { headers: await as(app, 1) })).status).toBe(403)
    expect((await app.request('/admin', { headers: await as(app, 9) })).status).toBe(200)
    expect((await app.request('/posts', { method: 'POST', headers: await as(app, 1) })).status).toBe(200)
    expect((await app.request('/posts', { method: 'POST' })).status).toBe(401)

    const loaded = await app.request('/posts/1', { method: 'DELETE', headers: await as(app, 1) })
    expect((await loaded.json() as any).data).toEqual({ loaded: 1 })
    expect((await app.request('/posts/2', { method: 'DELETE', headers: await as(app, 1) })).status).toBe(403)
    expect((await app.request('/posts/404', { method: 'DELETE', headers: await as(app, 1) })).status).toBe(404)
  })

  it('treats everyone as a guest without config/auth.ts', async () => {
    const app = await createApplication({
      mode: 'test',
      env: false,
      policies: [PostPolicy, abilities],
      config: {
        logger: { level: 'silent' },
      },
      routes: [
        defineRoutes(r => r.get('/view/:id', async ctx => ctx.can('view', await Post.findOrFail(ctx.param('id'))))),
      ],
    })
    expect((await (await app.request('/view/1')).json() as any).data).toBe(true)
    expect((await (await app.request('/view/2')).json() as any).data).toBe(false)
  })
})

describe('csrf', () => {
  const routes: RouteRegistrar = (r) => {
    r.group({
      middleware: ['csrf'],
    }, (r) => {
      r.get('/form', async ctx => ({ token: await ctx.csrfToken() }))
      r.post('/submit', async ctx => ({ ok: true, body: await ctx.body() }))
      r.post('/hooks/stripe', () => ({ hook: true }))
      r.post('/login', async (ctx) => {
        await ctx.auth.session('web').login(users[0])
        return 'ok'
      })
    })
  }
  const config = {
    config: {
      csrf: {
        testing: true,
        except: ['/hooks/*'],
      },
    },
  }

  /** 浏览器：保存 Cookie，读取 XSRF-TOKEN */
  function browser(app: Awaited<ReturnType<typeof boot>>) {
    const jar = new Map<string, string>()
    const request = async (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers)
      if (jar.size)
        headers.set('cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '))
      const res = await app.request(path, { ...init, headers })
      for (const cookie of res.headers.getSetCookie()) {
        const [pair] = cookie.split(';')
        const index = pair.indexOf('=')
        jar.set(pair.slice(0, index), decodeURIComponent(pair.slice(index + 1)))
      }
      return res
    }
    return { request, jar }
  }

  it('issues a readable XSRF-TOKEN cookie and accepts it back in X-XSRF-TOKEN', async () => {
    const app = await boot(routes, config)
    const { request, jar } = browser(app)
    const page = await request('/form')
    const xsrf = page.headers.getSetCookie().find(cookie => cookie.startsWith('XSRF-TOKEN='))!
    expect(xsrf).not.toContain('HttpOnly')
    expect((await page.json() as any).data.token).toBe(jar.get('XSRF-TOKEN'))

    const ok = await request('/submit', {
      method: 'POST',
      headers: {
        'x-xsrf-token': jar.get('XSRF-TOKEN')!,
        'content-type': 'application/json',
      },
      body: '{"a":1}',
    })
    expect((await ok.json() as any).data).toEqual({
      ok: true,
      body: { a: 1 },
    })
  })

  it('accepts the _token form field and X-CSRF-TOKEN, rejects missing or wrong tokens with 419', async () => {
    const app = await boot(routes, config)
    const { request, jar } = browser(app)
    await request('/form')
    const token = jar.get('XSRF-TOKEN')!
    expect((await request('/submit', {
      method: 'POST',
      body: new URLSearchParams({ _token: token, name: 'Ada' }),
    })).status).toBe(200)
    const form = new FormData()
    form.set('_token', token)
    expect((await request('/submit', { method: 'POST', body: form })).status).toBe(200)
    expect((await request('/submit', {
      method: 'POST',
      headers: { 'x-csrf-token': token },
    })).status).toBe(200)

    const missing = await request('/submit', { method: 'POST' })
    expect([missing.status, (await missing.json() as any).message]).toEqual([419, 'CSRF token 无效或已过期，请刷新页面后重试'])
    expect((await request('/submit', {
      method: 'POST',
      headers: { 'x-csrf-token': `${token}x` },
    })).status).toBe(419)
    // 其他会话的 token 无效
    const other = browser(app)
    await other.request('/form')
    expect((await request('/submit', {
      method: 'POST',
      headers: {
        'x-csrf-token': other.jar.get('XSRF-TOKEN')!,
      },
    })).status).toBe(419)
  })

  it('skips Bearer requests, excepted paths, and test mode unless enabled', async () => {
    const app = await boot(routes, config)
    expect((await app.request('/submit', {
      method: 'POST',
      headers: { authorization: 'Bearer anything' },
    })).status).toBe(200)
    expect((await app.request('/hooks/stripe', { method: 'POST' })).status).toBe(200)
    const testing = await boot(routes)
    expect((await testing.request('/submit', { method: 'POST' })).status).toBe(200)
  })

  it('rotates the token on session login', async () => {
    const app = await boot(routes, config)
    const { request, jar } = browser(app)
    await request('/form')
    const before = jar.get('XSRF-TOKEN')!
    await request('/login', {
      method: 'POST',
      headers: { 'x-xsrf-token': before },
    })
    expect(jar.get('XSRF-TOKEN')).not.toBe(before)
    expect((await request('/submit', {
      method: 'POST',
      headers: { 'x-xsrf-token': before },
    })).status).toBe(419)
    expect((await request('/submit', {
      method: 'POST',
      headers: {
        'x-xsrf-token': jar.get('XSRF-TOKEN')!,
      },
    })).status).toBe(200)
  })
})
