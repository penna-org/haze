import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { binOf, createProject, run } from './utils'

let project: ReturnType<typeof createProject> | undefined
afterEach(() => {
  project?.cleanup()
  project = undefined
})

async function buildVue(preset: string) {
  project = createProject('vue')
  const result = await run(binOf('@think-h3/cli', 'think-h3'), [
    'build',
    '--preset',
    preset,
    '--root',
    project.root,
  ], project.root, {})
  expect(result.code, result.output).toBe(0)
  return { root: project.root, output: result.output }
}

const html = {
  headers: { accept: 'text/html' },
}

describe('full-stack deployment presets (vue template)', () => {
  it('docker: client + server with runtime drivers for npm install in the image', async () => {
    const { root, output } = await buildVue('docker')
    expect(output).toContain('docker build -t demo-vue dist')
    expect(existsSync(join(root, 'dist/client/index.html'))).toBe(true)
    expect(existsSync(join(root, 'dist/server/index.mjs'))).toBe(true)
    // ORM 按需动态加载的 SQLite 驱动也要在镜像里安装
    expect(JSON.parse(readFileSync(join(root, 'dist/package.json'), 'utf8')).dependencies).toHaveProperty('@libsql/client')
  })

  it('aws-lambda: serves the SPA and the API from one function', async () => {
    const { root } = await buildVue('aws-lambda')
    const lambda = join(root, 'dist/lambda')
    expect(existsSync(join(lambda, 'client/index.html'))).toBe(true)
    expect(existsSync(join(lambda, 'node_modules/@libsql/client/package.json'))).toBe(true)
    const { handler } = await import(pathToFileURL(join(lambda, 'index.mjs')).href)
    const event = (path: string, headers: Record<string, string> = {}) => ({
      version: '2.0',
      rawPath: path,
      rawQueryString: '',
      headers: { host: 'x.lambda-url.aws', ...headers },
      requestContext: {
        http: { method: 'GET' },
      },
    })
    expect(JSON.parse((await handler(event('/api/hello'))).body).data).toMatchObject({ app: 'demo-vue' })
    const page = await handler(event('/users/1', html.headers))
    expect([page.statusCode, page.headers['content-type']]).toEqual([200, 'text/html; charset=utf-8'])
    expect(page.body).toContain('<div id="app"></div>')
  })

  it('vercel: static files on the CDN, API in a function, SPA fallback route', async () => {
    const { root } = await buildVue('vercel')
    const output = join(root, '.vercel/output')
    expect(existsSync(join(output, 'static/index.html'))).toBe(true)
    expect(readdirSync(join(output, 'static/assets')).some(file => file.endsWith('.js'))).toBe(true)
    expect(JSON.parse(readFileSync(join(output, 'config.json'), 'utf8')).routes).toEqual([
      { handle: 'filesystem' },
      { src: '^/api(?:/.*)?$', dest: '/__server' },
      { src: '/(.*)', dest: '/index.html' },
    ])
    const fn = join(output, 'functions/__server.func')
    expect(existsSync(join(fn, 'node_modules/@libsql/client'))).toBe(true)
    const { default: handler } = await import(pathToFileURL(join(fn, 'index.mjs')).href)
    const server = createServer(handler)
    await new Promise<void>(resolve => server.listen(0, resolve))
    try {
      const res = await fetch(`http://127.0.0.1:${(server.address() as { port: number }).port}/api/hello`)
      expect((await res.json() as any).data).toMatchObject({ app: 'demo-vue' })
    }
    finally {
      server.close()
    }
  })

  it('netlify: publish directory with SPA redirects and an API-only function', async () => {
    const { root } = await buildVue('netlify')
    expect(readFileSync(join(root, 'netlify.toml'), 'utf8')).toContain('publish = "dist/client"')
    expect(readFileSync(join(root, 'dist/client/_redirects'), 'utf8')).toContain('/index.html  200')
    const fn = join(root, '.netlify/v1/functions/think-h3-server.mjs')
    expect(readFileSync(fn, 'utf8')).toContain('path: ["/api","/api/*"]')
    const { default: handler } = await import(pathToFileURL(fn).href)
    const res: Response = await handler(new Request('https://demo.netlify.app/api/hello'), {})
    expect((await res.json() as any).data).toMatchObject({ app: 'demo-vue' })
  })

  it('cloudflare: worker with static assets config runs in workerd', async () => {
    const { root } = await buildVue('cloudflare')
    const dist = join(root, 'dist')
    const wrangler = JSON.parse(readFileSync(join(dist, 'wrangler.json'), 'utf8'))
    expect(wrangler.assets).toEqual({
      directory: './client',
      not_found_handling: 'single-page-application',
      run_worker_first: ['/api/*'],
    })
    expect(existsSync(join(dist, 'client/index.html'))).toBe(true)

    const mf = new Miniflare({
      modules: workerModules(dist),
      modulesRoot: dist,
      compatibilityDate: wrangler.compatibility_date,
      compatibilityFlags: wrangler.compatibility_flags,
      bindings: { APP_NAME: 'edge-app' },
    })
    try {
      const res = await mf.dispatchFetch('http://localhost/api/hello')
      expect((await res.json() as any).data).toEqual({ app: 'edge-app', message: 'Hello, think-h3!' })
    }
    finally {
      await mf.dispose()
    }
  })
})

/** 把产物中的全部 ESM 模块显式交给 Miniflare（不让它解析导入：ORM 驱动是按变量动态加载的） */
function workerModules(dist: string) {
  const files: string[] = []
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory() && entry.name !== 'client')
        walk(path)
      else if (entry.name.endsWith('.mjs'))
        files.push(path)
    }
  }
  walk(dist)
  // 入口必须是第一个模块
  files.sort((a, b) => Number(b.endsWith('/index.mjs') && dirname(b) === dist) - Number(a.endsWith('/index.mjs') && dirname(a) === dist))
  return files.map(path => ({
    type: 'ESModule' as const,
    path,
    contents: readFileSync(path, 'utf8'),
  }))
}
