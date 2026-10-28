import type { Application } from '../src'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createApplication, defineRoutes, generateKey } from '../src'
import { I18nManager, setI18nManager } from '../src/i18n/manager'
import { signUrl, verifySignedUrl } from '../src/routing/signed'

const key = generateKey()
const apps: Application[] = []
afterAll(async () => {
  for (const app of apps)
    await app.dispose()
  setI18nManager(undefined)
  vi.useRealTimers()
})

async function boot(app: { [key: string]: unknown } = {}, extra: { [key: string]: unknown } = {}) {
  const instance = await createApplication({
    mode: 'test',
    env: false,
    config: {
      logger: { level: 'silent' },
      app: { key, ...app },
      ...extra,
    },
    routes: [
      defineRoutes((r) => {
        r.get('/unsubscribe/:id', ctx => ({
          id: ctx.param('id'),
        })).middleware('signed').name('unsubscribe')
        r.get('/download/:file', ctx => ({
          file: ctx.param('file'),
        })).middleware('signed:utm_source').name('download')
        r.get('/check', async ctx => ({ valid: await ctx.hasValidSignature() })).name('check')
      }),
    ],
    providers: [
      {
        register(container, app) {
          const i18n = new I18nManager(app.config)
          container.instance(I18nManager, i18n)
          setI18nManager(i18n)
        },
      },
    ],
  })
  apps.push(instance)
  return instance
}

describe('signed URLs', () => {
  it('signs route URLs and accepts them through the signed middleware', async () => {
    const app = await boot()
    const url = await app.router.signedUrl('unsubscribe', { id: 42 }, {
      query: { list: 'news' },
    })
    expect(url).toMatch(/^\/unsubscribe\/42\?list=news&signature=[\w-]+$/)
    const res = await app.request(url)
    expect([res.status, (await res.json() as any).data]).toEqual([
      200,
      { id: '42' },
    ])
    // 查询参数顺序不影响签名
    const reordered = url.replace(/\?list=news&(signature=[\w-]+)/, '?$1&list=news')
    expect((await app.request(reordered)).status).toBe(200)
    expect((await (await app.request(await app.router.signedUrl('check'))).json() as any).data).toEqual({ valid: true })
    expect((await (await app.request('/check')).json() as any).data).toEqual({ valid: false })
  })

  it('rejects tampered and unsigned URLs with 403', async () => {
    const app = await boot()
    const url = await app.router.signedUrl('unsubscribe', { id: 42 })
    for (const bad of [
      url.replace('/42', '/43'),
      `${url}&extra=1`,
      url.replace(/signature=[\w-]+/, 'signature=AAAA'),
      '/unsubscribe/42',
    ]) {
      const res = await app.request(bad)
      expect([res.status, (await res.json() as any).message]).toEqual([403, 'Invalid signature.'])
    }
    // 其它密钥签发的链接无效
    const foreign = await signUrl('/unsubscribe/42', { config: (await boot({
      key: generateKey(),
    })).config })
    expect((await app.request(foreign)).status).toBe(403)
  })

  it('expires temporary URLs', async () => {
    const app = await boot()
    const url = await app.router.temporarySignedUrl('unsubscribe', '30m', { id: 1 })
    expect(url).toMatch(/expires=\d+/)
    expect((await app.request(url)).status).toBe(200)
    // 修改过期时间会使签名失效
    const extended = url.replace(/expires=(\d+)/, (_, value: string) => `expires=${Number(value) + 3600}`)
    expect((await app.request(extended)).status).toBe(403)

    vi.useFakeTimers({
      toFake: ['Date'],
    })
    vi.setSystemTime(Date.now() + 31 * 60 * 1000)
    expect((await app.request(url)).status).toBe(403)
    vi.useRealTimers()

    const past = await app.router.temporarySignedUrl('unsubscribe', new Date(Date.now() - 1000), { id: 1 })
    expect((await app.request(past)).status).toBe(403)
  })

  it('uses APP_URL for absolute links, ignores listed params and accepts previous keys', async () => {
    const app = await boot({ url: 'https://example.com/' })
    const url = await app.router.signedUrl('download', { file: 'report.csv' })
    expect(url).toMatch(/^https:\/\/example\.com\/download\/report\.csv\?signature=/)
    const path = url.slice('https://example.com'.length)
    expect((await app.request(`${path}&utm_source=mail`)).status).toBe(200)
    expect((await app.request(`${path}&utm_medium=mail`)).status).toBe(403)
    expect(await app.router.signedUrl('check', {}, { absolute: false })).toMatch(/^\/check\?signature=/)
    await expect(app.router.signedUrl('unsubscribe', { id: 1 }, {
      query: { signature: 'x' },
    })).rejects.toThrow(/reserved/)

    // 密钥轮换：旧密钥签发的链接在 previousKeys 中时仍然有效
    const rotated = await boot({
      key: generateKey(),
      previousKeys: [key],
    })
    expect((await rotated.request(path)).status).toBe(200)
    expect(await verifySignedUrl(path, { config: rotated.config })).toBe(true)
  })

  it('translates the 403 message when i18n is configured', async () => {
    const app = await boot({}, {
      i18n: {
        defaultLocale: 'en',
        locales: ['en', 'zh-CN'],
      },
    })
    const res = await app.request('/unsubscribe/1', {
      headers: { 'accept-language': 'zh-CN' },
    })
    expect([res.status, (await res.json() as any).message]).toEqual([403, '签名无效或链接已过期'])
  })
})
