import type { Application, UserProvider } from '../src'
import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApplication, defineRoutes, defineUserProvider, generateKey, Hash, UnauthorizedException } from '../src'
import { memoryTwoFactorStore, totp, TwoFactor } from '../src/auth/two-factor'

const jose = vi.hoisted(() => ({ spki: 0, pkcs8: 0 }))
vi.mock('jose', async (original) => {
  const actual = await original<typeof import('jose')>()
  return {
    ...actual,
    importSPKI: (...args: Parameters<typeof actual.importSPKI>) => {
      jose.spki++
      return actual.importSPKI(...args)
    },
    importPKCS8: (...args: Parameters<typeof actual.importPKCS8>) => {
      jose.pkcs8++
      return actual.importPKCS8(...args)
    },
  }
})

const json = { 'content-type': 'application/json' }

interface User {
  id: number
  email: string
  password: string
}

const apps: Application[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(apps.splice(0).map(app => app.dispose()))
})

async function boot(auth: Record<string, unknown> = {}, options: Record<string, unknown> = {}): Promise<{ app: Application, rows: User[] }> {
  const rows: User[] = [
    { id: 1, email: 'ada@example.com', password: await Hash.make('secret') },
  ]
  const users: UserProvider<User> = defineUserProvider<User>({
    retrieveById: id => rows.find(user => user.id === Number(id)),
    retrieveByCredentials: credentials => rows.find(user => user.email === credentials.email),
    validateCredentials: (user, credentials) => Hash.verify(user.password, String(credentials.password)),
    getId: user => user.id,
  })
  const app = await createApplication({
    mode: 'test',
    env: false,
    ...options,
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
        providers: { users },
        ...auth,
      },
    },
    routes: [
      defineRoutes((r) => {
        r.post('/login', async (ctx) => {
          const issued = await ctx.auth.jwt('api').attempt(await ctx.body())
          if (!issued)
            throw new UnauthorizedException('账号或密码错误')
          return issued
        })
        r.get('/me', async ctx => ({ id: await ctx.auth.id() })).middleware('auth:api')
      }),
    ],
  })
  apps.push(app)
  return { app, rows }
}

function login(app: Application, body: Record<string, unknown>) {
  return app.request('/login', {
    method: 'POST',
    headers: json,
    body: JSON.stringify(body),
  })
}

describe('credential validation timing', () => {
  it('verifies a dummy hash when the user does not exist', async () => {
    const { app } = await boot()
    const verify = vi.spyOn(Hash, 'verify')
    expect((await login(app, { email: 'ghost@example.com', password: 'secret' })).status).toBe(401)
    // 与“用户存在、密码错误”一样做一次哈希校验
    expect(verify).toHaveBeenCalledTimes(1)
    expect(verify.mock.calls[0]![0]).toMatch(/^\$(scrypt|pbkdf2-sha256)\$/)
    verify.mockClear()
    expect((await login(app, { email: 'ada@example.com', password: 'wrong' })).status).toBe(401)
    expect(verify).toHaveBeenCalledTimes(1)
    verify.mockClear()
    expect((await login(app, { email: 'ada@example.com', password: 'secret' })).status).toBe(200)
    expect(verify).toHaveBeenCalledTimes(1)
  })
})

describe('jwt guard keys', () => {
  it('imports asymmetric keys once, not on every request', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    const { app } = await boot({
      guards: {
        api: {
          driver: 'jwt',
          provider: 'users',
          algorithm: 'ES256',
          privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
          publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
        },
      },
    })
    jose.spki = 0
    jose.pkcs8 = 0
    const tokens: string[] = []
    for (let index = 0; index < 3; index++)
      tokens.push(((await (await login(app, { email: 'ada@example.com', password: 'secret' })).json()) as any).data.token)
    for (const token of tokens) {
      expect((await app.request('/me', {
        headers: { authorization: `Bearer ${token}` },
      })).status).toBe(200)
    }
    expect(jose).toEqual({ spki: 1, pkcs8: 1 })
  })
})

describe('two-factor hardening', () => {
  it('consumes a TOTP step or a recovery code only once under concurrent requests', async () => {
    const { rows } = await boot({
      twoFactor: {
        store: memoryTwoFactorStore(`hardening-${Math.random()}`),
      },
    })
    const user = rows[0]!
    const setup = await TwoFactor.enable(user)
    const period = 30_000
    const now = Date.now()
    expect(await TwoFactor.confirm(user, await totp(setup.secret, { time: now - period }))).toBe(true)
    const code = await totp(setup.secret, { time: now })
    const results = await Promise.all(Array.from({ length: 5 }, () => TwoFactor.verify(user, code)))
    expect(results.filter(Boolean)).toHaveLength(1)

    const recovery = await Promise.all(Array.from({ length: 5 }, () => TwoFactor.useRecoveryCode(user, setup.recoveryCodes[0]!)))
    expect(recovery.filter(Boolean)).toHaveLength(1)
    expect(await TwoFactor.remainingRecoveryCodes(user)).toBe(setup.recoveryCodes.length - 1)
  })

  it('warns once in production when secrets are kept in the in-process store', async () => {
    const { app, rows } = await boot({}, { mode: 'production' })
    const warn = vi.spyOn(app.logger, 'warn').mockImplementation(() => {})
    await TwoFactor.enabled(rows[0]!)
    await TwoFactor.enabled(rows[0]!)
    const warnings = warn.mock.calls.filter(([message]) => String(message).includes('two-factor'))
    expect(warnings).toHaveLength(1)
    expect(String(warnings[0]![0])).toContain('twoFactor.store')
  })

  it('does not warn outside production', async () => {
    const { app, rows } = await boot()
    const warn = vi.spyOn(app.logger, 'warn').mockImplementation(() => {})
    await TwoFactor.enabled(rows[0]!)
    expect(warn.mock.calls.filter(([message]) => String(message).includes('two-factor'))).toHaveLength(0)
  })
})
