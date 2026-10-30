import type { Application, RouteRegistrar, UserProvider } from '../src'
import type { PasskeyResponseJSON } from '../src/auth/passkeys'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApplication, defineRoutes, defineUserProvider, Events, generateKey, Hash } from '../src'
import { TwoFactorEnabled } from '../src/auth/events'
import { memoryPasskeyStore, Passkeys } from '../src/auth/passkeys'
import { base32Decode, base32Encode, generateRecoveryCodes, hotp, memoryTwoFactorStore, otpauthUri, totp, TwoFactor, verifyTotp } from '../src/auth/two-factor'
import { fromBase64Url, toBase64Url } from '../src/security/key'

const APP_KEY = generateKey()
const json = { 'content-type': 'application/json' }
const encoder = new TextEncoder()

interface User {
  id: number
  name: string
  email: string
  password: string
}

async function provider(): Promise<{ rows: User[], users: UserProvider<User> }> {
  const rows: User[] = [
    {
      id: 1,
      name: 'Ada',
      email: 'ada@example.com',
      password: await Hash.make('secret'),
    },
    {
      id: 2,
      name: 'Bob',
      email: 'bob@example.com',
      password: await Hash.make('secret'),
    },
  ]
  return {
    rows,
    users: defineUserProvider<User>({
      retrieveById: id => rows.find(user => user.id === Number(id)),
      retrieveByCredentials: credentials => rows.find(user => user.email === credentials.email),
      validateCredentials: (user, credentials) => Hash.verify(user.password, String(credentials.password)),
      getId: user => user.id,
    }),
  }
}

async function boot(routes: RouteRegistrar, auth: Record<string, unknown> = {}, extra: Record<string, unknown> = {}): Promise<{ app: Application, rows: User[] }> {
  const { rows, users } = await provider()
  const app = await createApplication({
    mode: 'test',
    env: false,
    config: {
      logger: { level: 'silent' },
      app: { key: APP_KEY, name: 'Demo', url: 'https://demo.test' },
      ...extra,
      auth: {
        default: 'web',
        guards: {
          web: { driver: 'session', provider: 'users' },
        },
        providers: { users },
        twoFactor: {
          store: memoryTwoFactorStore(`t1-${Math.random()}`),
        },
        passkeys: {
          store: memoryPasskeyStore(`t2-${Math.random()}`),
        },
        ...auth,
      },
    },
    routes: [
      defineRoutes(routes),
    ],
  })
  return { app, rows }
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('totp', () => {
  // RFC 6238 附录 B：8 位验证码，三种算法使用不同长度的 ASCII 种子
  const seeds = {
    SHA1: encoder.encode('12345678901234567890'),
    SHA256: encoder.encode('12345678901234567890123456789012'),
    SHA512: encoder.encode('1234567890123456789012345678901234567890123456789012345678901234'),
  }
  const vectors: Array<[number, string, string, string]> = [
    [59, '94287082', '46119246', '90693936'],
    [
      1111111109,
      '07081804',
      '68084774',
      '25091201',
    ],
    [
      1111111111,
      '14050471',
      '67062674',
      '99943326',
    ],
    [
      1234567890,
      '89005924',
      '91819424',
      '93441116',
    ],
    [
      2000000000,
      '69279037',
      '90698825',
      '38618901',
    ],
    [
      20000000000,
      '65353130',
      '77737706',
      '47863826',
    ],
  ]

  it('matches the RFC 6238 test vectors for SHA1 / SHA256 / SHA512', async () => {
    for (const [seconds, sha1, sha256, sha512] of vectors) {
      const time = seconds * 1000
      expect(await totp(seeds.SHA1, { time, digits: 8 })).toBe(sha1)
      expect(await totp(seeds.SHA256, { time, digits: 8, algorithm: 'SHA256' })).toBe(sha256)
      expect(await totp(seeds.SHA512, { time, digits: 8, algorithm: 'SHA512' })).toBe(sha512)
    }
  })

  it('matches the RFC 4226 HOTP vectors and round-trips base32', async () => {
    const expected = [
      '755224',
      '287082',
      '359152',
      '969429',
      '338314',
      '254676',
      '287922',
      '162583',
      '399871',
      '520489',
    ]
    for (const [counter, code] of expected.entries())
      expect(await hotp(seeds.SHA1, counter)).toBe(code)
    expect(base32Encode(encoder.encode('foobar'))).toBe('MZXW6YTBOI')
    expect(new TextDecoder().decode(base32Decode('mzxw 6ytb oi=='))).toBe('foobar')
    // base32 形式的密钥与字节形式等价
    expect(await totp(base32Encode(seeds.SHA1), { time: 59_000, digits: 8 })).toBe('94287082')
  })

  it('verifies within the window and refuses replayed steps', async () => {
    const secret = base32Encode(seeds.SHA1)
    const time = 1111111111 * 1000
    const code = await totp(secret, { time })
    const step = await verifyTotp(secret, code, { time })
    expect(step).toBe(Math.floor(1111111111 / 30))
    // 前一个时间步的验证码在窗口内有效，超出窗口无效
    expect(await verifyTotp(secret, code, { time: time + 30_000 })).toBe(step)
    expect(await verifyTotp(secret, code, { time: time + 90_000 })).toBeUndefined()
    expect(await verifyTotp(secret, code, { time, window: 0, afterStep: step })).toBeUndefined()
    expect(await verifyTotp(secret, 'abcdef', { time })).toBeUndefined()

    expect(otpauthUri({ secret, issuer: 'Demo App', account: 'ada@example.com' }))
      .toBe(`otpauth://totp/Demo%20App:ada%40example.com?secret=${secret}&issuer=Demo%20App&algorithm=SHA1&digits=6&period=30`)
    const codes = generateRecoveryCodes(8)
    expect(codes).toHaveLength(8)
    expect(new Set(codes).size).toBe(8)
    expect(codes[0]).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/)
  })

  it('enables, confirms and verifies with encrypted secrets, hashed recovery codes and replay protection', async () => {
    const store = memoryTwoFactorStore(`t3-${Math.random()}`)
    const { rows } = await boot(() => {}, {
      twoFactor: { store, issuer: 'Demo' },
    })
    const enabled: string[] = []
    Events.on(TwoFactorEnabled, ({ id }) => void enabled.push(id))
    const user = rows[0]
    const setup = await TwoFactor.enable(user)
    expect(setup.uri).toContain('otpauth://totp/Demo:ada%40example.com?secret=')
    const record = await store.get('users', '1')
    // 密钥加密保存，恢复码只保存摘要
    expect(record!.secret).not.toContain(setup.secret)
    expect(record!.recoveryCodes.every(hash => /^[0-9a-f]{64}$/.test(hash))).toBe(true)
    expect(await TwoFactor.enabled(user)).toBe(false)
    expect(await TwoFactor.verify(user, await totp(setup.secret))).toBe(false)

    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    expect(await TwoFactor.confirm(user, 'abcdef')).toBe(false)
    expect(await TwoFactor.confirm(user, await totp(setup.secret))).toBe(true)
    expect(await TwoFactor.enabled(user)).toBe(true)
    expect(enabled).toEqual(['1'])
    // 已启用时不能直接重新生成密钥（需 force）
    await expect(TwoFactor.enable(user)).rejects.toThrow('两步验证已启用')
    // 确认时用过的验证码不能再次使用
    expect(await TwoFactor.verify(user, await totp(setup.secret))).toBe(false)
    vi.spyOn(Date, 'now').mockReturnValue(now + 30_000)
    const next = await totp(setup.secret)
    expect(await TwoFactor.verify(user, next)).toBe(true)
    expect(await TwoFactor.verify(user, next)).toBe(false)

    expect(await TwoFactor.useRecoveryCode(user, setup.recoveryCodes[0].toUpperCase())).toBe(true)
    expect(await TwoFactor.useRecoveryCode(user, setup.recoveryCodes[0])).toBe(false)
    expect(await TwoFactor.remainingRecoveryCodes(user)).toBe(7)
    const fresh = await TwoFactor.regenerateRecoveryCodes(user)
    expect(await TwoFactor.useRecoveryCode(user, setup.recoveryCodes[1])).toBe(false)
    expect(await TwoFactor.useRecoveryCode(user, fresh[1])).toBe(true)

    await TwoFactor.disable(user)
    expect(await TwoFactor.enabled(user)).toBe(false)
  })

  it('runs the session login → challenge → confirm flow', async () => {
    const { app, rows } = await boot((r) => {
      r.post('/login', async (ctx) => {
        const result = await TwoFactor.attempt(ctx, await ctx.body())
        return { status: result.status }
      })
      r.post('/two-factor-challenge', async (ctx) => {
        const user = await TwoFactor.challenge<User>(ctx, await ctx.body())
        return { user: user?.id ?? null }
      })
      r.get('/me', async ctx => ({ id: await ctx.auth.id() ?? null, pending: await TwoFactor.hasPendingChallenge(ctx) }))
    }, {
      twoFactor: {
        store: memoryTwoFactorStore(`t4-${Math.random()}`),
        maxAttempts: 2,
      },
    })
    const setup = await TwoFactor.enable(rows[0])
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    await TwoFactor.confirm(rows[0], await totp(setup.secret))
    vi.spyOn(Date, 'now').mockReturnValue(now + 30_000)

    const fetch = browser(app)
    const post = (path: string, body: unknown) => fetch(path, {
      method: 'POST',
      headers: json,
      body: JSON.stringify(body),
    })
    expect((await (await post('/login', { email: 'ada@example.com', password: 'nope' })).json() as any).data).toEqual({ status: 'failed' })
    // Bob 没有启用两步验证：直接登录
    const bob = browser(app)
    await bob('/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'bob@example.com', password: 'secret' }),
    })
    expect((await (await bob('/me')).json() as any).data).toEqual({ id: 2, pending: false })

    expect((await (await post('/login', { email: 'ada@example.com', password: 'secret' })).json() as any).data).toEqual({ status: 'two-factor' })
    expect((await (await fetch('/me')).json() as any).data).toEqual({ id: null, pending: true })
    expect((await (await post('/two-factor-challenge', { code: 'abcdef' })).json() as any).data).toEqual({ user: null })
    expect((await (await post('/two-factor-challenge', { code: await totp(setup.secret) })).json() as any).data).toEqual({ user: 1 })
    expect((await (await fetch('/me')).json() as any).data).toEqual({ id: 1, pending: false })

    // 超过失败次数后需要重新输入密码
    const eve = browser(app)
    await eve('/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ada@example.com', password: 'secret' }),
    })
    for (let i = 0; i < 2; i++) {
      await eve('/two-factor-challenge', {
        method: 'POST',
        headers: json,
        body: JSON.stringify({ code: 'abcdef' }),
      })
    }
    expect((await (await eve('/me')).json() as any).data).toEqual({ id: null, pending: false })
    // 锁定持续 challengeTtl（默认 5 分钟），之后恢复码同样可以通过挑战
    vi.spyOn(Date, 'now').mockReturnValue(now + 30_000 + 6 * 60_000)
    await eve('/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ada@example.com', password: 'secret' }),
    })
    const passed = await eve('/two-factor-challenge', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ recoveryCode: setup.recoveryCodes[2] }),
    })
    expect((await passed.json() as any).data).toEqual({ user: 1 })
  })
})

// ---------------------------------------------------------------- 软件认证器（ES256，attestation: none）

async function digest(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', data as Uint8Array<ArrayBuffer>))
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((size, part) => size + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function uint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4)
  new DataView(bytes.buffer).setUint32(0, value)
  return bytes
}

/** Web Crypto 的 ECDSA 签名为 r‖s，WebAuthn 要求 DER 编码 */
function derSignature(raw: Uint8Array): Uint8Array {
  const integer = (bytes: Uint8Array) => {
    let start = 0
    while (start < bytes.length - 1 && bytes[start] === 0)
      start++
    let value: Uint8Array = bytes.slice(start)
    if (value[0] & 0x80)
      value = concat(new Uint8Array([0]), value)
    return concat(new Uint8Array([0x02, value.length]), value)
  }
  const body = concat(integer(raw.slice(0, 32)), integer(raw.slice(32)))
  return concat(new Uint8Array([0x30, body.length]), body)
}

type KeyPair = Awaited<ReturnType<typeof crypto.subtle.generateKey>> & { publicKey: any, privateKey: any }

class SoftwareAuthenticator {
  readonly credentialId = crypto.getRandomValues(new Uint8Array(16))
  counter = 0
  #keys: KeyPair | undefined

  constructor(readonly rpID: string, readonly origin: string) {}

  get id(): string {
    return toBase64Url(this.credentialId)
  }

  async #pair(): Promise<KeyPair> {
    this.#keys ??= await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as KeyPair
    return this.#keys
  }

  #clientData(type: string, challenge: string, origin = this.origin): Uint8Array {
    return encoder.encode(JSON.stringify({
      type,
      challenge,
      origin,
      crossOrigin: false,
    }))
  }

  async create(options: { challenge: string }, overrides: { origin?: string } = {}): Promise<PasskeyResponseJSON> {
    const jwk = await crypto.subtle.exportKey('jwk', (await this.#pair()).publicKey)
    const cose = isoCBOR.encode(new Map<number, number | Uint8Array>([
      [1, 2],
      [3, -7],
      [-1, 1],
      [
        -2,
        fromBase64Url(jwk.x!),
      ],
      [
        -3,
        fromBase64Url(jwk.y!),
      ],
    ]) as never)
    const authData = concat(
      await digest(encoder.encode(this.rpID)),
      // UP | UV | AT
      new Uint8Array([0x45]),
      uint32(this.counter),
      new Uint8Array(16),
      new Uint8Array([0, this.credentialId.length]),
      this.credentialId,
      cose,
    )
    const attestationObject = isoCBOR.encode(new Map<string, unknown>([
      ['fmt', 'none'],
      [
        'attStmt',
        new Map(),
      ],
      ['authData', authData],
    ]) as never)
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: toBase64Url(this.#clientData('webauthn.create', options.challenge, overrides.origin)),
        attestationObject: toBase64Url(attestationObject),
        transports: ['internal'],
      },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }

  async get(options: { challenge: string }): Promise<PasskeyResponseJSON> {
    this.counter++
    const authData = concat(await digest(encoder.encode(this.rpID)), new Uint8Array([0x05]), uint32(this.counter))
    const clientData = this.#clientData('webauthn.get', options.challenge)
    const signed = concat(authData, await digest(clientData))
    const raw = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, (await this.#pair()).privateKey, signed as Uint8Array<ArrayBuffer>))
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: toBase64Url(clientData),
        authenticatorData: toBase64Url(authData),
        signature: toBase64Url(derSignature(raw)),
      },
      clientExtensionResults: {},
    }
  }
}

describe('two-factor lockout', () => {
  it('counts wrong codes server-side, so replaying the login cookie cannot reset them', async () => {
    const { app, rows } = await boot((r) => {
      r.post('/login', async ctx => ({ status: (await TwoFactor.attempt(ctx, await ctx.body())).status }))
      r.post('/two-factor-challenge', async ctx => ({ user: (await TwoFactor.challenge<User>(ctx, await ctx.body()))?.id ?? null }))
      r.get('/me', async ctx => ({ id: await ctx.auth.id() ?? null, pending: await TwoFactor.hasPendingChallenge(ctx) }))
    }, {
      twoFactor: {
        store: memoryTwoFactorStore(`t4b-${Math.random()}`),
        maxAttempts: 3,
      },
    })
    const setup = await TwoFactor.enable(rows[0])
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now)
    await TwoFactor.confirm(rows[0], await totp(setup.secret))
    vi.spyOn(Date, 'now').mockReturnValue(now + 30_000)

    const credentials = { email: 'ada@example.com', password: 'secret' }
    const login = await app.request('/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(credentials),
    })
    expect((await login.json() as any).data).toEqual({ status: 'two-factor' })
    // 攻击者只重放登录响应里的 Cookie（默认 cookie 会话驱动把会话存在客户端），忽略之后的 Set-Cookie
    const cookie = login.headers.getSetCookie().map(item => item.split(';')[0]).join('; ')
    const replay = (body: unknown) => app.request('/two-factor-challenge', {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify(body),
    })
    for (let i = 0; i < 3; i++)
      expect((await (await replay({ code: 'abcdef' })).json() as any).data).toEqual({ user: null })
    // 输错 maxAttempts 次后，正确的验证码也被拒绝
    expect((await (await replay({ code: await totp(setup.secret) })).json() as any).data).toEqual({ user: null })
    // 重新输入密码也不能重置计数（在 challengeTtl 内）
    const again = browser(app)
    expect((await (await again('/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(credentials),
    })).json() as any).data).toEqual({ status: 'two-factor' })
    expect((await (await again('/me')).json() as any).data).toEqual({ id: null, pending: false })
    expect((await (await again('/two-factor-challenge', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ code: await totp(setup.secret) }),
    })).json() as any).data).toEqual({ user: null })

    // challengeTtl 过后恢复
    vi.spyOn(Date, 'now').mockReturnValue(now + 30_000 + 6 * 60_000)
    const later = browser(app)
    await later('/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(credentials),
    })
    expect((await (await later('/two-factor-challenge', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ code: await totp(setup.secret) }),
    })).json() as any).data).toEqual({ user: 1 })
  })
})

describe('passkeys', () => {
  function routes(): RouteRegistrar {
    return (r) => {
      r.post('/login', async (ctx) => {
        await ctx.auth.session().attempt(await ctx.body())
        return ctx.noContent()
      })
      r.post('/passkeys/options', async ctx => Passkeys.registrationOptions(ctx, (await ctx.auth.user())!)).middleware('auth')
      r.post('/passkeys', async (ctx) => {
        const credential = await Passkeys.verifyRegistration(ctx, (await ctx.auth.user())!, await ctx.body(), { name: 'Laptop' })
        return ctx.created({ id: credential.id, name: credential.name })
      }).middleware('auth')
      r.post('/passkeys/login/options', async ctx => Passkeys.authenticationOptions(ctx))
      r.post('/passkeys/login', async (ctx) => {
        const user = await Passkeys.login<User>(ctx, await ctx.body())
        return { id: user.id }
      })
      r.get('/me', async ctx => ({ id: await ctx.auth.id() ?? null }))
    }
  }

  it('registers a passkey and logs in with it (session challenges, counter updates)', async () => {
    const store = memoryPasskeyStore(`t5-${Math.random()}`)
    const { app, rows } = await boot(routes(), {
      passkeys: { store },
    })
    const ada = browser(app)
    await ada('/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ada@example.com', password: 'secret' }),
    })
    const authenticator = new SoftwareAuthenticator('demo.test', 'https://demo.test')

    const options = (await (await ada('/passkeys/options', { method: 'POST' })).json() as any).data
    expect(options).toMatchObject({
      rp: { name: 'Demo', id: 'demo.test' },
      user: { name: 'ada@example.com', displayName: 'Ada' },
      attestation: 'none',
    })
    const registered = await ada('/passkeys', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(await authenticator.create(options)),
    })
    expect(registered.status).toBe(201)
    expect((await registered.json() as any).data).toEqual({ id: authenticator.id, name: 'Laptop' })
    const [credential] = await Passkeys.credentials(rows[0])
    expect(credential).toMatchObject({
      id: authenticator.id,
      userType: 'users',
      userId: '1',
      counter: 0,
      transports: ['internal'],
    })

    // 挑战只能使用一次
    expect((await ada('/passkeys', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(await authenticator.create(options)),
    })).status).toBe(400)
    // 再次注册时排除已有凭据；来源不符时拒绝
    const again = (await (await ada('/passkeys/options', { method: 'POST' })).json() as any).data
    expect(again.excludeCredentials).toEqual([
      {
        id: authenticator.id,
        type: 'public-key',
        transports: ['internal'],
      },
    ])
    expect((await ada('/passkeys', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(await authenticator.create(again, { origin: 'https://evil.test' })),
    })).status).toBe(400)

    // 新的浏览器（未登录）用通行密钥登录
    const visitor = browser(app)
    const login = (await (await visitor('/passkeys/login/options', { method: 'POST' })).json() as any).data
    expect(login).toMatchObject({ rpId: 'demo.test', userVerification: 'preferred' })
    const assertion = await authenticator.get(login)
    expect((await (await visitor('/passkeys/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(assertion),
    })).json() as any).data).toEqual({ id: 1 })
    expect((await (await visitor('/me')).json() as any).data).toEqual({ id: 1 })
    expect((await store.find(authenticator.id))!.counter).toBe(1)
    expect((await store.find(authenticator.id))!.lastUsedAt).toBeInstanceOf(Date)

    // 重放同一个断言（挑战已作废）
    expect((await visitor('/passkeys/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(assertion),
    })).status).toBe(401)

    expect(await Passkeys.rename(rows[1], authenticator.id, 'x')).toBe(false)
    expect(await Passkeys.delete(rows[1], authenticator.id)).toBe(false)
    expect(await Passkeys.delete(rows[0], authenticator.id)).toBe(true)
  })

  it('rejects a replayed assertion even with the original session cookie (synced passkeys)', async () => {
    const store = memoryPasskeyStore(`t5b-${Math.random()}`)
    const { app } = await boot(routes(), {
      passkeys: { store },
    })
    const ada = browser(app)
    await ada('/login', {
      method: 'POST',
      headers: json,
      body: JSON.stringify({ email: 'ada@example.com', password: 'secret' }),
    })
    const authenticator = new SoftwareAuthenticator('demo.test', 'https://demo.test')
    const options = (await (await ada('/passkeys/options', { method: 'POST' })).json() as any).data
    expect((await ada('/passkeys', {
      method: 'POST',
      headers: json,
      body: JSON.stringify(await authenticator.create(options)),
    })).status).toBe(201)

    // 攻击者保留取得挑战时的 Cookie（默认 cookie 会话驱动把挑战存在客户端），之后一直重放它
    const optionsResponse = await app.request('/passkeys/login/options', { method: 'POST' })
    const cookie = optionsResponse.headers.getSetCookie().map(item => item.split(';')[0]).join('; ')
    const login = (await optionsResponse.json() as any).data
    // 同步通行密钥（iCloud 钥匙串、Google 密码管理器）的计数器始终为 0，靠计数器识别不了重放
    authenticator.counter = -1
    const assertion = await authenticator.get(login)
    const replay = () => app.request('/passkeys/login', {
      method: 'POST',
      headers: { ...json, cookie },
      body: JSON.stringify(assertion),
    })
    expect((await (await replay()).json() as any).data).toEqual({ id: 1 })
    expect((await replay()).status).toBe(401)
  })

  it('keeps challenges in the cache for stateless APIs and rejects unknown credentials', async () => {
    const { app, rows } = await boot((r) => {
      r.post('/register/options', ctx => Passkeys.registrationOptions(ctx, rows[1]))
      r.post('/register', async ctx => ({ id: (await Passkeys.verifyRegistration(ctx, rows[1], await ctx.body())).id }))
      r.post('/login/options', ctx => Passkeys.authenticationOptions(ctx, { user: rows[1] }))
      r.post('/login', async ctx => (await Passkeys.verifyAuthentication<User>(ctx, await ctx.body())).user.id)
    }, {
      passkeys: {
        store: memoryPasskeyStore(`t6-${Math.random()}`),
        challenge: 'cache',
        rpID: 'demo.test',
        origin: ['https://demo.test', 'https://app.demo.test'],
      },
    }, {
      cache: {
        default: 'memory',
        stores: {
          memory: { driver: 'memory' },
        },
      },
    })
    const authenticator = new SoftwareAuthenticator('demo.test', 'https://app.demo.test')
    const post = (path: string, body?: unknown) => app.request(path, {
      method: 'POST',
      headers: json,
      body: body === undefined
        ? undefined
        : JSON.stringify(body),
    })

    const options = (await (await post('/register/options')).json() as any).data
    const res = await post('/register', await authenticator.create(options))
    expect((await res.json() as any).data).toEqual({ id: authenticator.id })

    const login = (await (await post('/login/options')).json() as any).data
    expect(login.allowCredentials).toEqual([
      {
        id: authenticator.id,
        type: 'public-key',
        transports: ['internal'],
      },
    ])
    expect((await (await post('/login', await authenticator.get(login))).json() as any).data).toBe(2)

    // 未注册的凭据
    const stranger = new SoftwareAuthenticator('demo.test', 'https://demo.test')
    const next = (await (await post('/login/options')).json() as any).data
    expect((await post('/login', await stranger.get(next))).status).toBe(401)
    // 伪造的挑战
    expect((await post('/login', await authenticator.get({
      challenge: toBase64Url(encoder.encode('forged')),
    }))).status).toBe(401)
  })
})
