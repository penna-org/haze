import type { DevServer } from '../src'
import { execFile, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { createApplication, MaintenanceManager } from '@hazejs/core'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer, createDevServer } from '../src'
import { copyFixture, nextReload, settle } from './utils'

const exec = promisify(execFile)

let dev: DevServer | undefined
let fixture: ReturnType<typeof copyFixture> | undefined

afterEach(async () => {
  await dev?.close()
  fixture?.cleanup()
  dev = undefined
  fixture = undefined
})

/** 基础 fixture + TSX 视图（无 tsconfig：JSX 运行时完全由插件配置） */
function withViews() {
  fixture = copyFixture('basic')
  fixture.write('app/view/Layout.tsx', `
import type { ViewChild } from '@hazejs/core'
export default function Layout(props: { title: string, children?: ViewChild }) {
  return <html lang="en"><head><title>{props.title}</title></head><body>{props.children}</body></html>
}
`)
  fixture.write('app/view/Hello.tsx', `
import Layout from './Layout'
async function Name(props: { name: string }) {
  await new Promise(resolve => setTimeout(resolve, 1))
  return <strong data-name={props.name}>{props.name}</strong>
}
export default function Hello(props: { name: string }) {
  return <Layout title="Hello"><p class="v1">Hello, <Name name={props.name} /></p><>{['a', 'b'].map(item => <i>{item}</i>)}</></Layout>
}
`)
  fixture.write('app/view/Maintenance.tsx', `
export default function Maintenance(props: { message: string, status: number }) {
  return <html><body><h1>custom {props.status}</h1><p>{props.message}</p></body></html>
}
`)
  fixture.write('route/views.ts', `
import { defineRoutes } from '@hazejs/core'
import Hello from '~/app/view/Hello'
export default defineRoutes((r) => {
  r.get('/page', ctx => ctx.view(Hello, { name: ctx.query('name') ?? '<world>' }))
  r.get('/named', ctx => ctx.view('Hello', { name: 'named' }))
})
`)
  return fixture
}

const expectedPage = '<!DOCTYPE html><html lang="en"><head><title>Hello</title></head><body><p class="v1">Hello, <strong data-name="&lt;world&gt;">&lt;world&gt;</strong></p><i>a</i><i>b</i></body></html>'

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

describe('tsx views', () => {
  it('renders in dev, hot-reloads view edits and picks up maintenance mode without a restart', async () => {
    const fixture = withViews()
    // 文件驱动：模拟另一个进程（haze down）写入状态
    fixture.write('config/maintenance.ts', `export default { driver: 'file', interval: 0 }\n`)
    dev = await createDevServer({ root: fixture.root, port: 0, debounce: 10 })
    await settle()
    const page = await fetch(new URL('/page', dev.url))
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await page.text()).toBe(expectedPage)
    expect(await (await fetch(new URL('/named', dev.url))).text()).toContain('data-name="named"')

    const reloaded = nextReload(dev)
    fixture.edit('app/view/Hello.tsx', 'class="v1"', 'class="v2"')
    expect(await reloaded).toMatchObject({ ok: true, file: 'app/view/Hello.tsx' })
    expect(await (await fetch(new URL('/page', dev.url))).text()).toContain('<p class="v2">')

    // 另一个进程进入维护模式：写入 storage/framework/down
    const app = dev.app!
    const other = await createApplication({
      mode: 'development',
      rootDir: fixture.root,
      env: false,
      config: {
        maintenance: { driver: 'file' },
        logger: { level: 'silent' },
      },
    })
    await other.make(MaintenanceManager).down({ render: 'Maintenance' })
    const down = await fetch(new URL('/page', dev.url), {
      headers: { accept: 'text/html' },
    })
    expect(down.status).toBe(503)
    expect(await down.text()).toBe('<!DOCTYPE html><html><body><h1>custom 503</h1><p>The application is down for maintenance. Please check back soon.</p></body></html>')
    expect(dev.app).toBe(app)
    await other.make(MaintenanceManager).up()
    expect((await fetch(new URL('/page', dev.url))).status).toBe(200)
    await other.dispose()
  })

  it('renders in a node build and runs worker.mjs down / up', async () => {
    const fixture = withViews()
    fixture.write('config/maintenance.ts', `export default { driver: 'file', interval: 0 }\n`)
    const { entry } = await buildServer({ root: fixture.root })
    const worker = join(fixture.root, 'dist/worker.mjs')
    expect(existsSync(worker)).toBe(true)

    const port = await freePort()
    const child = spawn(process.execPath, [entry], {
      cwd: fixture.root,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'production',
      },
      stdio: 'pipe',
    })
    try {
      const url = `http://127.0.0.1:${port}`
      let page: Response | undefined
      for (let attempt = 0; attempt < 100 && !page; attempt++) {
        page = await fetch(`${url}/page`).catch(() => undefined)
        if (!page)
          await new Promise(resolve => setTimeout(resolve, 100))
      }
      expect(await page!.text()).toBe(expectedPage)

      const env = { ...process.env, NODE_ENV: 'production' }
      const down = await exec(process.execPath, [
        worker,
        'down',
        '--secret',
        'let-me-in',
        '--retry=30',
      ], { cwd: fixture.root, env })
      expect(down.stdout).toContain('Application is now in maintenance mode')
      expect(down.stdout).toContain('Bypass: visit /let-me-in')
      expect(JSON.parse(readFileSync(join(fixture.root, 'storage/framework/down'), 'utf8'))).toMatchObject({ status: 503, retry: 30 })
      const blocked = await fetch(`${url}/hello`)
      expect([
        blocked.status,
        blocked.headers.get('retry-after'),
      ]).toEqual([503, '30'])
      const status = await exec(process.execPath, [worker, 'maintenance:status'], { cwd: fixture.root, env })
      expect(status.stdout).toContain('Application is down since')

      const up = await exec(process.execPath, [worker, 'up'], { cwd: fixture.root, env })
      expect(up.stdout).toContain('Application is now live')
      expect((await fetch(`${url}/hello`)).status).toBe(200)
    }
    finally {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
  })

  it('renders in a cloudflare build and reads maintenance state from KV', async () => {
    const fixture = withViews()
    fixture.write('config/cache.ts', `export default { default: 'kv', stores: { kv: { driver: 'kv', binding: 'CACHE' } } }\n`)
    fixture.write('config/maintenance.ts', `export default { interval: 0 }\n`)
    await buildServer({ root: fixture.root, preset: 'cloudflare' })
    const dist = join(fixture.root, 'dist')
    const wrangler = JSON.parse(readFileSync(join(dist, 'wrangler.json'), 'utf8'))
    const mf = new Miniflare({
      modules: true,
      scriptPath: join(dist, 'index.mjs'),
      compatibilityDate: wrangler.compatibility_date,
      compatibilityFlags: wrangler.compatibility_flags,
      bindings: {
        APP_KEY: 'k'.repeat(32),
      },
      kvNamespaces: ['CACHE'],
    })
    try {
      const page = await mf.dispatchFetch('http://localhost/page')
      expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
      expect(await page.text()).toBe(expectedPage)
      expect(await (await mf.dispatchFetch('http://localhost/named')).text()).toContain('data-name="named"')

      // Edge：通过共享的缓存存储（KV）进入维护模式
      const kv = await mf.getKVNamespace('CACHE') as unknown as { put: (key: string, value: string) => Promise<void>, delete: (key: string) => Promise<void> }
      await kv.put('haze:framework:down', JSON.stringify({
        time: Date.now(),
        status: 503,
        retry: 60,
        render: 'Maintenance',
      }))
      const down = await mf.dispatchFetch('http://localhost/page', {
        headers: { accept: 'text/html' },
      })
      expect(down.status).toBe(503)
      expect(await down.text()).toContain('<h1>custom 503</h1>')
      const json = await mf.dispatchFetch('http://localhost/hello')
      expect([json.status, (await json.json() as any).code]).toEqual([503, 503])
      await kv.delete('haze:framework:down')
      expect((await mf.dispatchFetch('http://localhost/hello')).status).toBe(200)
    }
    finally {
      await mf.dispose()
    }
  })
})
