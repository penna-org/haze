import type { Application, RouteRegistrar, UserProvider } from '../src'
import type { VerifyEmailPayload } from '../src/auth/mails'
import { describe, expect, it, vi } from 'vitest'
import { createApplication, defineRoutes, defineUserProvider, Events, generateKey, Hash, issueTestCredentials, MailManager } from '../src'
import { EmailVerified, PasswordResetCompleted } from '../src/auth/events'
import { ResetPasswordMail, VerifyEmailMail } from '../src/auth/mails'
import { memoryPasswordResetStore, PasswordReset } from '../src/auth/passwords'
import { authRoutes } from '../src/auth/routes'
import { abilityMatches, createAccessToken, memoryTokenStore, PersonalAccessTokens } from '../src/auth/tokens'
import { hasVerifiedEmail, sendEmailVerification, verificationUrl, verifyEmail } from '../src/auth/verification'

const APP_KEY = generateKey()
const json = { 'content-type': 'application/json' }

interface User {
  id: number
  name: string
  email: string
  password: string
  emailVerifiedAt: Date | null
  saves: number
  save: () => Promise<void>
}

async function users(): Promise<{ rows: User[], provider: UserProvider<User> }> {
  const make = async (id: number, name: string, email: string): Promise<User> => {
    const user: User = {
      id,
      name,
      email,
      password: await Hash.make('secret-password'),
      emailVerifiedAt: null,
      saves: 0,
      save: async () => {
        user.saves++
      },
    }
    return user
  }
  const rows = [
    await make(1, 'Ada', 'ada@example.com'),
    await make(2, 'Bob', 'bob@example.com'),
  ]
  return {
    rows,
    provider: defineUserProvider<User>({
      retrieveById: id => rows.find(user => user.id === Number(id)),
      retrieveByCredentials: credentials => rows.find(user => user.email === credentials.email),
      validateCredentials: (user, credentials) => Hash.verify(user.password, String(credentials.password)),
      getId: user => user.id,
    }),
  }
}

let seq = 0

async function boot(routes: RouteRegistrar, auth: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<{ app: Application, rows: User[] }> {
  const { rows, provider } = await users()
  const app = await createApplication({
    mode: 'test',
    env: false,
    config: {
      logger: { level: 'silent' },
      app: { key: APP_KEY, name: 'Demo', url: 'https://demo.test' },
      mail: {
        default: 'array',
        mailers: {
          array: { driver: 'array' },
        },
      },
      ...extra,
      auth: {
        default: 'api',
        guards: {
          // 每个应用独立的内存存储，用例之间互不影响
          api: {
            driver: 'token',
            provider: 'users',
            store: memoryTokenStore(`test-${++seq}`),
          },
          jwt: { driver: 'jwt', provider: 'users' },
        },
        providers: { users: provider },
        ...auth,
      },
    },
    routes: [
      defineRoutes(routes),
    ],
  })
  return { app, rows }
}

describe('personal access tokens', () => {
  it('issues id|secret tokens, stores only the hash and authenticates Bearer requests', async () => {
    const store = memoryTokenStore(`hash-${++seq}`)
    const { app, rows } = await boot((r) => {
      r.get('/me', async ctx => ({
        id: await ctx.auth.id(),
        token: (await ctx.auth.currentAccessToken())?.name,
      })).middleware('auth')
    }, {
      guards: {
        api: {
          driver: 'token',
          provider: 'users',
          store,
          prefix: 'haze_',
        },
      },
    })
    const { plainTextToken, accessToken } = await createAccessToken(rows[0], 'cli')
    expect(plainTextToken).toMatch(/^1\|haze_[\w-]{40}$/)
    const stored = await store.find(String(accessToken.id))
    expect(stored).toMatchObject({
      tokenableType: 'users',
      tokenableId: '1',
      name: 'cli',
      abilities: ['*'],
      expiresAt: null,
    })
    // 只保存 SHA-256 摘要
    expect(stored!.token).toMatch(/^[0-9a-f]{64}$/)
    expect(stored!.token).not.toContain(plainTextToken.split('|')[1])

    const res = await app.request('/me', {
      headers: { authorization: `Bearer ${plainTextToken}` },
    })
    expect((await res.json() as any).data).toEqual({ id: 1, token: 'cli' })
    expect((await store.find(String(accessToken.id)))!.lastUsedAt).toBeInstanceOf(Date)

    // 篡改密钥、错误的 ID、没有分隔符都视为未登录
    for (const bad of [`${plainTextToken}x`, `2|${plainTextToken.split('|')[1]}`, plainTextToken.split('|')[1]]) {
      expect((await app.request('/me', {
        headers: { authorization: `Bearer ${bad}` },
      })).status).toBe(401)
    }
  })

  it('checks abilities with ctx.auth.tokenCan and the abilities / ability middleware', async () => {
    const { app, rows } = await boot((r) => {
      r.get('/can', async ctx => ({ read: await ctx.auth.tokenCan('posts:read'), write: await ctx.auth.tokenCan('posts:write') })).middleware('auth')
      r.post('/posts', () => 'created').middleware('auth', 'abilities:posts:write,posts:read')
      r.get('/posts', () => 'list').middleware('auth', 'ability:posts:read,admin')
      r.get('/jwt', async ctx => ctx.auth.tokenCan('anything')).middleware('auth:jwt')
    })
    const reader = (await createAccessToken(rows[0], 'reader', {
      abilities: ['posts:read'],
    })).plainTextToken
    const writer = (await createAccessToken(rows[0], 'writer', {
      abilities: ['posts:*'],
    })).plainTextToken
    const bearer = (token: string) => ({
      headers: { authorization: `Bearer ${token}` },
    })

    expect((await (await app.request('/can', bearer(reader))).json() as any).data).toEqual({ read: true, write: false })
    expect((await (await app.request('/can', bearer(writer))).json() as any).data).toEqual({ read: true, write: true })
    expect((await app.request('/posts', {
      method: 'POST',
      ...bearer(reader),
    })).status).toBe(403)
    expect((await app.request('/posts', {
      method: 'POST',
      ...bearer(writer),
    })).status).toBe(200)
    expect((await app.request('/posts', bearer(reader))).status).toBe(200)
    expect((await app.request('/posts')).status).toBe(401)

    // jwt / session 认证的第一方请求：tokenCan 始终为 true
    const jwt = await issueTestCredentials(app, rows[0], 'jwt')
    expect((await (await app.request('/jwt', { headers: jwt })).json() as any).data).toBe(true)

    expect(abilityMatches(['*'], 'x')).toBe(true)
    expect(abilityMatches(['posts:*'], 'postsx')).toBe(false)
  })

  it('expires tokens, lists and revokes them, and logout revokes the current token', async () => {
    const { app, rows } = await boot((r) => {
      r.get('/me', ctx => ctx.auth.id()).middleware('auth')
      r.post('/logout', async (ctx) => {
        await ctx.auth.logout()
        return ctx.noContent()
      }).middleware('auth')
    }, {
      guards: {
        api: {
          driver: 'token',
          provider: 'users',
          store: memoryTokenStore(`expiry-${++seq}`),
          expiresIn: '1h',
        },
      },
    })
    const bearer = (token: string) => ({
      headers: { authorization: `Bearer ${token}` },
    })
    const expired = await createAccessToken(rows[0], 'old', {
      expiresAt: new Date(Date.now() - 1000),
    })
    expect((await app.request('/me', bearer(expired.plainTextToken))).status).toBe(401)
    const fresh = await createAccessToken(rows[0], 'fresh')
    expect(fresh.accessToken.expiresAt!.getTime()).toBeGreaterThan(Date.now() + 3500_000)

    const other = await createAccessToken(rows[1], 'bob')
    expect((await PersonalAccessTokens.list(rows[0])).map(token => token.name)).toEqual(['old', 'fresh'])
    // 不能吊销别人的令牌
    expect(await PersonalAccessTokens.revoke(other.accessToken.id, rows[0])).toBe(false)
    expect(await PersonalAccessTokens.revoke(expired.accessToken.id, rows[0])).toBe(true)

    expect((await app.request('/logout', {
      method: 'POST',
      ...bearer(fresh.plainTextToken),
    })).status).toBe(204)
    expect((await app.request('/me', bearer(fresh.plainTextToken))).status).toBe(401)
    expect(await PersonalAccessTokens.list(rows[0])).toEqual([])

    await createAccessToken(rows[1], 'bob-2')
    expect(await PersonalAccessTokens.revokeAll(rows[1])).toBe(2)
  })

  it('serves token endpoints from authRoutes and actingAs issues real tokens', async () => {
    const { app, rows } = await boot((r) => {
      r.group({ prefix: '/auth', as: 'auth.' }, (r) => {
        authRoutes(r, {
          tokens: {
            abilities: ['posts:read', 'posts:write'],
          },
        })
      })
    })
    const headers = {
      ...json,
      ...await issueTestCredentials(app, rows[0], 'api'),
    }
    const created = await app.request('/auth/tokens', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'ci',
        abilities: ['posts:read'],
      }),
    })
    expect(created.status).toBe(201)
    const { data } = await created.json() as any
    expect(data.token).toMatch(/^\d+\|/)
    expect(data.accessToken).toMatchObject({
      name: 'ci',
      abilities: ['posts:read'],
    })
    expect(data.accessToken.token).toBeUndefined()

    const denied = await app.request('/auth/tokens', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'x',
        abilities: ['admin'],
      }),
    })
    expect(denied.status).toBe(422)

    const list = (await (await app.request('/auth/tokens', { headers })).json() as any).data as Array<{ id: number, name: string, token?: string }>
    expect(list.map(token => token.name)).toEqual(['test', 'ci'])
    expect(list.every(token => token.token === undefined)).toBe(true)
    expect((await app.request(`/auth/tokens/${data.accessToken.id}`, { method: 'DELETE', headers })).status).toBe(204)
    expect((await app.request(`/auth/tokens/${data.accessToken.id}`, { method: 'DELETE', headers })).status).toBe(404)
  })
})

describe('email verification', () => {
  it('sends a signed link, verifies it once and guards routes with verified', async () => {
    const { app, rows } = await boot((r) => {
      r.group({ prefix: '/api/auth', as: 'auth.' }, (r) => {
        authRoutes(r, { verification: true })
      })
      r.get('/dashboard', () => 'ok').middleware('auth', 'verified')
    }, {
      verification: { route: 'auth.verification.verify', expire: '30m' },
    })
    const verifiedEvents: string[] = []
    const off = Events.on(EmailVerified, ({ id }) => void verifiedEvents.push(id))
    const fake = app.make(MailManager).fake()
    const headers = await issueTestCredentials(app, rows[0], 'api')

    expect((await app.request('/dashboard', { headers })).status).toBe(403)
    const sent = await app.request('/api/auth/email/verification-notification', { method: 'POST', headers })
    expect((await sent.json() as any).data).toEqual({ status: 'sent' })
    fake.assertSent(VerifyEmailMail, mail => mail.message.to === 'ada@example.com')
    const payload = fake.sent[0].payload as VerifyEmailPayload
    expect(payload).toMatchObject({ appName: 'Demo', name: 'Ada', expiresInMinutes: 30 })
    const link = new URL(payload.url)
    expect(link.origin).toBe('https://demo.test')
    expect(link.pathname).toMatch(/^\/api\/auth\/email\/verify\/1\/[0-9a-f]{64}$/)
    expect(fake.sent[0].message.html).toContain(payload.url.replace(/&/g, '&amp;'))

    // 篡改签名 / 换成别的用户 → 403
    expect((await app.request(`${link.pathname}${link.search.replace(/signature=./, 'signature=x')}`)).status).toBe(403)
    expect((await app.request(`${link.pathname.replace('/verify/1/', '/verify/2/')}${link.search}`)).status).toBe(403)

    const ok = await app.request(`${link.pathname}${link.search}`)
    expect((await ok.json() as any).data).toEqual({ status: 'verified' })
    expect(rows[0].emailVerifiedAt).toBeInstanceOf(Date)
    expect(rows[0].saves).toBe(1)
    expect(hasVerifiedEmail(rows[0])).toBe(true)
    expect(verifiedEvents).toEqual(['1'])
    expect((await (await app.request(`${link.pathname}${link.search}`)).json() as any).data).toEqual({ status: 'already-verified' })
    expect((await app.request('/dashboard', { headers })).status).toBe(200)

    // 已验证的用户不再发送
    expect((await (await app.request('/api/auth/email/verification-notification', { method: 'POST', headers })).json() as any).data).toEqual({ status: 'verified' })
    expect(verifiedEvents).toEqual(['1'])
    off()
  })

  it('rejects links after the email changed or the link expired, and supports path-based links', async () => {
    const { app, rows } = await boot((r) => {
      r.get('/verify/:id/:hash', async (ctx) => {
        return { verified: (await verifyEmail(ctx)).verified }
      })
    }, {
      verification: {
        path: '/verify',
        expire: 60,
        url: (link: { url: string }) => `https://app.demo.test/verify?to=${encodeURIComponent(link.url)}`,
      },
    })
    const fake = app.make(MailManager).fake()
    const link = await verificationUrl(rows[1])
    expect(link.url).toMatch(/^https:\/\/demo\.test\/verify\/2\/[0-9a-f]{64}\?expires=\d+&signature=/)
    await sendEmailVerification(rows[1])
    expect((fake.sent[0].payload as VerifyEmailPayload).url).toBe(`https://app.demo.test/verify?to=${encodeURIComponent(link.url)}`)

    const path = new URL(link.url).pathname + new URL(link.url).search
    rows[1].email = 'bob@new.example.com'
    expect((await app.request(path)).status).toBe(403)
    rows[1].email = 'bob@example.com'

    const now = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    try {
      expect((await app.request(path)).status).toBe(403)
    }
    finally {
      spy.mockRestore()
    }
    expect((await (await app.request(path)).json() as any).data).toEqual({ verified: true })
  })
})

describe('password reset', () => {
  it('sends a throttled link with a hashed token and resets the password once', async () => {
    const store = memoryPasswordResetStore()
    const { app, rows } = await boot((r) => {
      authRoutes(r, { passwordReset: true, throttle: false })
    }, {
      passwords: {
        store,
        expire: '15m',
        throttle: '60s',
        path: '/reset',
      },
    })
    const fake = app.make(MailManager).fake()
    const completed: unknown[] = []
    const off = Events.on(PasswordResetCompleted, payload => void completed.push(payload.id))

    const post = (path: string, body: unknown) => app.request(path, {
      method: 'POST',
      headers: json,
      body: JSON.stringify(body),
    })
    expect((await post('/forgot-password', { email: 'nope' })).status).toBe(422)
    // 未注册的邮箱同样返回 sent，且不发邮件
    expect((await (await post('/forgot-password', { email: 'ghost@example.com' })).json() as any).data).toEqual({ status: 'sent' })
    fake.assertNothingSent()

    expect((await (await post('/forgot-password', { email: 'ada@example.com' })).json() as any).data).toEqual({ status: 'sent' })
    expect((await (await post('/forgot-password', { email: 'ada@example.com' })).json() as any).data).toEqual({ status: 'throttled' })
    fake.assertSentTimes(ResetPasswordMail, 1)
    const url = new URL((fake.sent[0].payload as { url: string }).url)
    expect(url.origin + url.pathname).toBe('https://demo.test/reset')
    const token = url.searchParams.get('token')!
    expect(url.searchParams.get('email')).toBe('ada@example.com')
    const record = await store.get('ada@example.com')
    expect(record!.token).toMatch(/^[0-9a-f]{64}$/)
    expect(record!.token).not.toBe(token)

    expect((await post('/reset-password', { email: 'ada@example.com', token: 'wrong', password: 'new-password' })).status).toBe(422)
    expect((await post('/reset-password', { email: 'ada@example.com', token, password: 'short' })).status).toBe(422)
    expect((await (await post('/reset-password', { email: 'ada@example.com', token, password: 'new-password' })).json() as any).data).toEqual({ status: 'reset' })
    expect(await Hash.verify(rows[0].password, 'new-password')).toBe(true)
    expect(completed).toEqual(['1'])
    // 令牌只能使用一次
    expect((await post('/reset-password', { email: 'ada@example.com', token, password: 'other-password' })).status).toBe(422)
    off()
  })

  it('expires tokens and supports cache stores and custom reset callbacks', async () => {
    // store 为字符串时使用 config/cache.ts 中的缓存存储
    const { app, rows } = await boot(() => {}, {
      passwords: { store: 'memory', expire: 60, throttle: 0 },
    }, {
      cache: {
        default: 'memory',
        stores: {
          memory: { driver: 'memory' },
        },
      },
    })
    app.make(MailManager).fake()
    const token = await PasswordReset.createToken(rows[1])
    expect(await PasswordReset.tokenExists(rows[1], token)).toBe(true)

    const now = Date.now()
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)
    try {
      expect(await PasswordReset.tokenExists(rows[1], token)).toBe(false)
    }
    finally {
      spy.mockRestore()
    }

    const fresh = await PasswordReset.createToken(rows[1])
    const changed: string[] = []
    const status = await PasswordReset.reset<User>({ email: 'bob@example.com', token: fresh, password: 'x' }, (user, password) => {
      changed.push(`${user.name}:${password}`)
    })
    expect(status).toBe('reset')
    expect(changed).toEqual(['Bob:x'])
    expect(await PasswordReset.reset({ email: 'ghost@example.com', token: fresh, password: 'x' })).toBe('invalid-user')
    expect(EmailVerified.name).toBe('auth:email-verified')
  })
})
