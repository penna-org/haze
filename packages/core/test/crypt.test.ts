import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, defineRoutes, generateKey } from '../src'
import { Crypt, DecryptException, Encrypter } from '../src/security/crypt'
import { fromBase64Url, toBase64Url } from '../src/security/key'

const key = generateKey()

afterEach(() => {
  delete process.env.APP_KEY
  delete process.env.APP_PREVIOUS_KEYS
})

describe('encrypter', () => {
  const encrypter = new Encrypter(key)

  it('round-trips JSON values and strings', async () => {
    const value = {
      id: 1,
      tags: ['a', 'b'],
      nested: { ok: true },
      nothing: null,
      text: '中文 ✓',
    }
    const payload = await encrypter.encrypt(value)
    expect(payload).toMatch(/^v1\.[\w-]+$/)
    expect(await encrypter.decrypt(payload)).toEqual(value)
    expect(await encrypter.decrypt(await encrypter.encrypt(42))).toBe(42)
    expect(await encrypter.decrypt(await encrypter.encrypt('str'))).toBe('str')

    const secret = await encrypter.encryptString('plain text')
    expect(await encrypter.decryptString(secret)).toBe('plain text')
    // 随机 IV：相同明文每次结果不同
    expect(await encrypter.encryptString('plain text')).not.toBe(secret)
    expect(() => encrypter.encrypt(undefined)).toThrow(TypeError)
  })

  it('rejects tampered, truncated and foreign payloads', async () => {
    const payload = await encrypter.encrypt({ admin: false })
    const bytes = fromBase64Url(payload.slice(3))
    bytes[bytes.length - 1] ^= 1
    const tampered = `v1.${toBase64Url(bytes)}`
    for (const bad of [
      tampered,
      'v1.AAAA',
      `v2.${payload.slice(3)}`,
      'not-a-payload',
      'v1.$$$$',
      payload.slice(0, -4),
    ])
      await expect(encrypter.decrypt(bad)).rejects.toBeInstanceOf(DecryptException)
    await expect(new Encrypter(generateKey()).decrypt(payload)).rejects.toThrow('The MAC is invalid.')
    // 非 JSON 的字符串载荷
    await expect(encrypter.decrypt(await encrypter.encryptString('{oops'))).rejects.toThrow(/not valid JSON/)
  })

  it('decrypts with previous keys after rotation', async () => {
    const old = await encrypter.encrypt({ v: 1 })
    const rotated = new Encrypter(generateKey(), [
      generateKey(),
      key,
    ])
    expect(await rotated.decrypt(old)).toEqual({ v: 1 })
    // 新加密使用新密钥，旧加密器无法解密
    await expect(encrypter.decrypt(await rotated.encrypt({ v: 2 }))).rejects.toBeInstanceOf(DecryptException)
  })
})

describe('crypt facade', () => {
  it('uses the application key inside and outside requests', async () => {
    const app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        logger: { level: 'silent' },
        app: { key },
      },
      routes: [
        defineRoutes((r) => {
          r.post('/seal', async ctx => ({ token: await Crypt.encrypt(await ctx.body()) }))
          r.post('/open', async ctx => Crypt.decrypt(((await ctx.body()) as { token: string }).token))
        }),
      ],
    })
    try {
      const sealed = await (await app.request('/seal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 7 }),
      })).json() as any
      // 请求之外（最近启动的应用）使用同一个密钥
      expect(await Crypt.decrypt(sealed.data.token)).toEqual({ userId: 7 })
      const token = await Crypt.encrypt({ userId: 8 })
      const opened = await (await app.request('/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })).json() as any
      expect(opened.data).toEqual({ userId: 8 })
      expect(await new Encrypter(key).decryptString(await Crypt.encryptString('x'))).toBe('x')
    }
    finally {
      await app.dispose()
    }
  })

  it('falls back to APP_KEY / APP_PREVIOUS_KEYS without an application', async () => {
    const previous = generateKey()
    const old = await new Encrypter(previous).encryptString('legacy')
    process.env.APP_KEY = key
    process.env.APP_PREVIOUS_KEYS = `${generateKey()}, ${previous}`
    expect(await Crypt.decryptString(old)).toBe('legacy')
    expect(await new Encrypter(key).decryptString(await Crypt.encryptString('now'))).toBe('now')
  })
})
