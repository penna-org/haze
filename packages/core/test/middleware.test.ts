import type { ApplicationOptions, RouteRegistrar } from '../src'
import { Buffer } from 'node:buffer'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import * as v from 'valibot'
import { afterAll, describe, expect, it } from 'vitest'
import { createApplication, defineRoutes, negotiateEncoding, UploadedFile, validate } from '../src'

function boot(routes: RouteRegistrar, options: ApplicationOptions & { config?: Record<string, unknown> } = {}) {
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

describe('cors', () => {
  const app = boot(r => r.get('/data', () => ({ ok: true })), {
    config: {
      middleware: {
        global: ['cors'],
      },
      cors: {
        origin: ['https://app.example.com'],
        credentials: true,
        maxAge: '600',
      },
    },
  })

  it('answers preflight requests before routing', async () => {
    const res = await (await app).request('/data', {
      method: 'OPTIONS',
      headers: { 'origin': 'https://app.example.com', 'access-control-request-method': 'POST' },
    })
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
    expect(res.headers.get('access-control-allow-credentials')).toBe('true')
    expect(res.headers.get('access-control-max-age')).toBe('600')
  })

  it('adds headers to actual responses only for allowed origins', async () => {
    const allowed = await (await app).request('/data', {
      headers: { origin: 'https://app.example.com' },
    })
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example.com')
    const denied = await (await app).request('/data', {
      headers: { origin: 'https://evil.test' },
    })
    expect(denied.headers.get('access-control-allow-origin')).toBeNull()
  })
})

describe('throttle', () => {
  it('limits per client with RateLimit headers, Retry-After and a 429 envelope', async () => {
    const app = await boot(r => r.get('/limited', () => 'ok').middleware('throttle:2,60'))
    const hit = (ip: string) => app.request('/limited', {
      headers: { 'x-forwarded-for': ip },
    })
    // 默认不信任代理：IP 取不到时按 unknown 计数
    expect((await hit('1.1.1.1')).headers.get('ratelimit-remaining')).toBe('1')
    expect((await hit('1.1.1.1')).headers.get('ratelimit-remaining')).toBe('0')
    const blocked = await hit('1.1.1.1')
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(await blocked.json()).toMatchObject({ code: 429, message: '请求过于频繁，请稍后再试' })
  })

  it('uses named limiters and trusted proxy IPs', async () => {
    const app = await boot(r => r.get('/named', () => 'ok').middleware('throttle:login'), {
      config: {
        app: { trustProxy: true },
        throttle: {
          limiters: {
            login: { max: 1, window: '1m' },
          },
        },
      },
    })
    const hit = (ip: string) => app.request('/named', {
      headers: { 'x-forwarded-for': ip },
    })
    expect((await hit('10.0.0.1')).status).toBe(200)
    expect((await hit('10.0.0.1')).status).toBe(429)
    // 不同 IP 分别计数
    expect((await hit('10.0.0.2')).status).toBe(200)
  })
})

describe('secureHeaders', () => {
  it('sets helmet-like defaults, HSTS only on https outside debug', async () => {
    const app = await boot(r => r.get('/', () => 'home'), {
      config: {
        middleware: {
          global: ['secureHeaders'],
        },
        secureHeaders: { frameOptions: 'DENY', contentSecurityPolicy: 'default-src \'self\'' },
      },
    })
    const http = await app.request('http://localhost/')
    expect(http.headers.get('x-content-type-options')).toBe('nosniff')
    expect(http.headers.get('x-frame-options')).toBe('DENY')
    expect(http.headers.get('content-security-policy')).toBe('default-src \'self\'')
    expect(http.headers.get('strict-transport-security')).toBeNull()
    const https = await app.request('https://example.com/')
    expect(https.headers.get('strict-transport-security')).toContain('max-age=')
    // 异常响应同样带上
    expect((await app.request('/missing')).headers.get('x-content-type-options')).toBe('nosniff')
  })
})

describe('compress', () => {
  const big = {
    items: Array.from({ length: 200 }, (_, index) => ({ index, text: 'think-h3 compression' })),
  }
  const app = boot((r) => {
    r.get('/big', () => big)
    r.get('/small', () => ({ ok: true }))
  }, {
    config: {
      middleware: {
        global: ['compress'],
      },
    },
  })

  it('negotiates br > gzip and skips small bodies', async () => {
    const br = await (await app).request('/big', {
      headers: { 'accept-encoding': 'gzip, br' },
    })
    expect([
      br.headers.get('content-encoding'),
      br.headers.get('vary'),
    ]).toEqual(['br', 'Accept-Encoding'])
    expect(JSON.parse(brotliDecompressSync(Buffer.from(await br.arrayBuffer())).toString()).data).toEqual(big)

    const gzip = await (await app).request('/big', {
      headers: { 'accept-encoding': 'gzip' },
    })
    expect(gzip.headers.get('content-encoding')).toBe('gzip')
    expect(JSON.parse(gunzipSync(Buffer.from(await gzip.arrayBuffer())).toString()).data).toEqual(big)

    const small = await (await app).request('/small', {
      headers: { 'accept-encoding': 'gzip' },
    })
    expect(small.headers.get('content-encoding')).toBeNull()
    expect((await (await app).request('/big')).headers.get('content-encoding')).toBeNull()
  })

  it('parses q-values', () => {
    expect(negotiateEncoding('gzip;q=0.5, br;q=0, *;q=0.1', ['br', 'gzip', 'deflate'])).toEqual(['gzip', 'deflate'])
    expect(negotiateEncoding('identity', ['br', 'gzip'])).toEqual([])
  })
})

describe('request body limit and uploads', () => {
  const dir = mkdtempSync(join(tmpdir(), 'think-h3-upload-'))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const AvatarSchema = v.object({
    name: v.string(),
    avatar: v.pipe(v.file(), v.mimeType(['image/png']), v.maxSize(1024)),
  })

  const app = boot((r) => {
    r.post('/echo', async ctx => ({ length: JSON.stringify(await ctx.body()).length }))
    r.post('/big', async ctx => ({ length: JSON.stringify(await ctx.body()).length })).middleware('bodyLimit:2mb')
    r.post('/avatar', async (ctx) => {
      const input = await validate(AvatarSchema, await ctx.body())
      const file = (await ctx.file('avatar'))!
      const path = await file.store(join(dir, 'avatars'))
      return {
        name: input.name,
        file: file.toJSON(),
        extension: file.extension,
        path,
        isFile: input.avatar instanceof UploadedFile,
      }
    })
    r.post('/photos', async ctx => (await ctx.files('photos')).map(file => file.name))
  }, {
    config: {
      app: { bodyLimit: '1kb' },
    },
  })

  it('rejects bodies over the default limit with 413, per-route limits override it', async () => {
    const payload = JSON.stringify({
      text: 'x'.repeat(2048),
    })
    const tooLarge = await (await app).request('/echo', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })
    expect(tooLarge.status).toBe(413)
    expect((await (await app).request('/big', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })).status).toBe(200)
  })

  it('parses multipart into fields and UploadedFile, validates with valibot and stores files', async () => {
    const form = new FormData()
    form.set('name', 'Ada')
    form.set('avatar', new File([
      new Uint8Array([137, 80, 78, 71]),
    ], 'Me.PNG', { type: 'image/png' }))
    const res = await (await app).request('/avatar', { method: 'POST', body: form })
    const { data, message } = await res.json() as any
    expect(res.status, message).toBe(200)
    expect(data).toMatchObject({
      name: 'Ada',
      file: {
        field: 'avatar',
        name: 'Me.PNG',
        size: 4,
        type: 'image/png',
      },
      extension: 'png',
      isFile: true,
    })
    expect(data.path).toMatch(/avatars\/[\w-]+\.png$/)
    expect([
      ...readFileSync(data.path),
    ]).toEqual([137, 80, 78, 71])

    const invalid = new FormData()
    invalid.set('name', 'Ada')
    invalid.set('avatar', new File(['text'], 'a.txt', { type: 'text/plain' }))
    expect((await (await app).request('/avatar', { method: 'POST', body: invalid })).status).toBe(422)
  })

  it('collects repeated file fields and ignores empty file inputs', async () => {
    const form = new FormData()
    form.append('photos', new File(['a'], 'a.jpg'))
    form.append('photos', new File(['b'], 'b.jpg'))
    form.append('photos', new File([], ''))
    const res = await (await app).request('/photos', { method: 'POST', body: form })
    expect((await res.json() as any).data).toEqual(['a.jpg', 'b.jpg'])
  })

  it('refuses path traversal in storeAs', async () => {
    const file = new UploadedFile(new File(['x'], 'x.txt'), 'file')
    expect(await file.storeAs(dir, '../../escape.txt')).toBe(join(dir, 'escape.txt'))
  })
})
