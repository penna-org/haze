import type { DevServer } from '../src'
import { afterEach, describe, expect, it } from 'vitest'
import { createDevServer } from '../src'
import { copyFixture, getJson, nextReload, settle } from './utils'

let dev: DevServer | undefined
let fixture: ReturnType<typeof copyFixture> | undefined

async function start(): Promise<DevServer> {
  fixture = copyFixture('basic')
  dev = await createDevServer({ root: fixture.root, port: 0, debounce: 10 })
  await settle()
  return dev
}

afterEach(async () => {
  await dev?.close()
  fixture?.cleanup()
  dev = undefined
  fixture = undefined
})

describe('dev server', () => {
  it('discovers config, routes, .env and the exception handler', async () => {
    const dev = await start()
    expect((await getJson(dev, '/hello')).body).toEqual({
      code: 0,
      message: 'ok',
      data: { message: 'hello v1' },
    })
    expect((await getJson(dev, '/name')).body.data).toEqual({ name: 'basic' })

    const missing = await getJson(dev, '/missing')
    expect(missing.status).toBe(404)
    expect(missing.headers.get('x-handler')).toBe('custom')
  })

  it('discovers a custom response formatter and interceptors, and hot-reloads them', async () => {
    fixture = copyFixture('basic')
    fixture.write('app/response/Formatter.ts', `
import { ResponseFormatter } from '@think-h3/core'
export default class Formatter extends ResponseFormatter {
  override success(data: unknown) {
    return { ok: true, result: data }
  }
}
`)
    fixture.write('app/interceptor/powered-by.ts', `
import { defineInterceptor } from '@think-h3/core'
export default defineInterceptor(response => void response.headers.set('x-powered-by', 'think-h3'))
`)
    dev = await createDevServer({ root: fixture.root, port: 0, debounce: 10 })
    await settle()

    const res = await getJson(dev, '/hello')
    expect(res.body).toEqual({ ok: true, result: { message: 'hello v1' } })
    expect(res.headers.get('x-powered-by')).toBe('think-h3')

    const reloaded = nextReload(dev)
    fixture.edit('app/response/Formatter.ts', 'ok: true', 'success: true')
    expect((await reloaded).ok).toBe(true)
    expect((await getJson(dev, '/hello')).body).toEqual({ success: true, result: { message: 'hello v1' } })
  })

  it('hot-swaps service changes without restarting the server', async () => {
    const dev = await start()
    const url = dev.url
    const firstApp = dev.app

    const reloaded = nextReload(dev)
    fixture!.edit('app/service/GreetService.ts', 'hello v1', 'hello v2')
    const result = await reloaded

    expect(result).toMatchObject({ ok: true, file: 'app/service/GreetService.ts' })
    expect((await getJson(dev, '/hello')).body.data).toEqual({ message: 'hello v2' })
    expect(dev.url).toBe(url)
    expect(dev.app).not.toBe(firstApp)
  })

  it('picks up new route files', async () => {
    const dev = await start()
    expect((await getJson(dev, '/extra')).status).toBe(404)

    const reloaded = nextReload(dev)
    fixture!.write('route/extra.ts', `
import { defineRoutes } from '@think-h3/core'
export default defineRoutes(r => r.get('/extra', () => ({ extra: true })))
`)
    expect((await reloaded).ok).toBe(true)
    expect((await getJson(dev, '/extra')).body.data).toEqual({ extra: true })
  })

  it('keeps serving the previous version when a change breaks the app', async () => {
    const dev = await start()

    const failed = nextReload(dev)
    fixture!.edit('route/api.ts', `r.get('/hello'`, `r.get('/hello', [HelloController, 'missingMethod' as any])\n  r.get('/hello2'`)
    expect((await failed).ok).toBe(false)
    expect((await getJson(dev, '/hello')).body.data).toEqual({ message: 'hello v1' })

    const fixed = nextReload(dev)
    fixture!.edit('route/api.ts', `r.get('/hello', [HelloController, 'missingMethod' as any])\n  r.get('/hello2'`, `r.get('/hello'`)
    expect((await fixed).ok).toBe(true)
  })

  it('reloads environment variables when .env changes', async () => {
    const dev = await start()
    const reloaded = nextReload(dev)
    fixture!.write('.env', 'APP_NAME=changed\n')
    expect((await reloaded).file).toBe('.env')
    expect((await getJson(dev, '/name')).body.data).toEqual({ name: 'changed' })
  })

  it('keeps persistent resources across reloads', async () => {
    const dev = await start()
    await getJson(dev, '/visits')
    expect((await getJson(dev, '/visits')).body.data.count).toBe(2)

    await dev.reload('manual')
    expect((await getJson(dev, '/visits')).body.data.count).toBe(3)
  })

  it('lets in-flight requests finish on the previous app', async () => {
    const dev = await start()
    const slow = getJson(dev, '/slow')
    await settle(50)
    fixture!.edit('app/service/GreetService.ts', 'hello v1', 'hello v2')
    await dev.reload('app/service/GreetService.ts')

    expect((await slow).body.data).toEqual({ message: 'hello v1' })
    expect((await getJson(dev, '/slow')).body.data).toEqual({ message: 'hello v2' })
  })

  it('reports startup errors as responses until fixed', async () => {
    fixture = copyFixture('basic')
    fixture.edit('route/api.ts', `[HelloController, 'index']`, `[HelloController, 'nope' as any]`)
    dev = await createDevServer({ root: fixture.root, port: 0, debounce: 10 })
    await settle()

    const res = await getJson(dev, '/hello')
    expect(res.status).toBe(500)
    expect(res.body.message).toContain('HelloController.nope is not a method')

    const fixed = nextReload(dev)
    fixture.edit('route/api.ts', `[HelloController, 'nope' as any]`, `[HelloController, 'index']`)
    expect((await fixed).ok).toBe(true)
    expect((await getJson(dev, '/hello')).status).toBe(200)
  })
})
