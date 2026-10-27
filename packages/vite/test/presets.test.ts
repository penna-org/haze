import type { ChildProcess } from 'node:child_process'
import type { PresetName } from '../src'
import { Buffer } from 'node:buffer'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer } from '../src'
import { copyFixture } from './utils'

let fixture: ReturnType<typeof copyFixture> | undefined
const children: ChildProcess[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
  }
  fixture?.cleanup()
  fixture = undefined
})

/** 基础 fixture + 一个回显请求的路由（验证方法、请求体、查询参数、Cookie 的转换） */
async function build(preset: PresetName) {
  fixture = copyFixture('basic')
  fixture.write('route/echo.ts', `
import { defineRoutes } from '@think-h3/core'
export default defineRoutes(r => r.post('/echo', async ctx => ({
  method: ctx.method,
  query: ctx.query(),
  body: await ctx.body(),
  cookie: ctx.header('cookie') ?? null,
  name: process.env.APP_NAME ?? null,
})))
`)
  const result = await buildServer({ root: fixture.root, preset })
  return { ...result, root: fixture.root }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createNetServer().listen(0, () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

async function poll(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      return await fetch(url)
    }
    catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error(`${url} did not respond`)
}

/** 启动常驻进程型产物并验证 HTTP 响应 */
async function expectServes(command: string, args: string[], cwd: string, env: Record<string, string> = {}) {
  const port = await freePort()
  const child = spawn(command, args, {
    cwd,
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
      NODE_ENV: 'production',
    },
    stdio: 'pipe',
  })
  let output = ''
  child.stdout?.on('data', chunk => (output += chunk))
  child.stderr?.on('data', chunk => (output += chunk))
  children.push(child)
  const hello = await poll(`http://127.0.0.1:${port}/hello`).catch((error) => {
    throw new Error(`${error.message}\n${output}`)
  })
  expect(await hello.json()).toEqual({
    code: 0,
    message: 'ok',
    data: { message: 'hello v1' },
  })
  // .env 从运行时工作目录加载
  expect((await (await fetch(`http://127.0.0.1:${port}/name`)).json() as any).data.name).toBe('basic')
}

const echoBody = { name: 'Ada' }

describe('deployment presets', () => {
  it('node: external dependencies, dist/index.mjs', async () => {
    const result = await build('node')
    expect(result.entry).toBe(join(result.root, 'dist/index.mjs'))
    // 依赖保持 external（运行时从 node_modules 加载）
    expect(result.externals.length).toBeGreaterThan(0)
    await expectServes(process.execPath, [result.entry], result.root)
  })

  it('bun: runs the build with Bun', async () => {
    const bun = which('bun')
    if (!bun)
      return
    const result = await build('bun')
    await expectServes(bun, [result.entry], result.root)
  })

  it('deno: fully bundled single entry runs with deno run', async () => {
    const result = await build('deno')
    expect(result.entry).toBe(join(result.root, 'dist/server/index.mjs'))
    // 只保留 Node 内置模块，不依赖 node_modules
    expect(result.externals).toEqual([])
    const deno = fileURLToPath(new URL('../node_modules/deno/bin.cjs', import.meta.url))
    await expectServes(process.execPath, [deno, 'run', '-A', result.entry], result.root)
  })

  it('docker: self-contained build context with Dockerfile', async () => {
    const result = await build('docker')
    const dist = join(result.root, 'dist')
    expect(existsSync(join(dist, 'server/index.mjs'))).toBe(true)
    expect(readFileSync(join(dist, 'Dockerfile'), 'utf8')).toContain('CMD ["node", "server/index.mjs"]')
    expect(JSON.parse(readFileSync(join(dist, 'package.json'), 'utf8'))).toMatchObject({ type: 'module', dependencies: {} })
    // 构建上下文本身即可运行（框架已打包）
    await expectServes(process.execPath, ['server/index.mjs'], dist, { APP_NAME: 'basic' })
  })

  it('aws-lambda: handles API Gateway v2, v1 and binary bodies', async () => {
    const result = await build('aws-lambda')
    expect(result.entry).toBe(join(result.root, 'dist/lambda/index.mjs'))
    const { handler } = await import(pathToFileURL(result.entry).href)

    const v2 = await handler({
      version: '2.0',
      rawPath: '/echo',
      rawQueryString: 'a=1&a=2&b=x',
      cookies: ['sid=abc', 'theme=dark'],
      headers: { 'host': 'api.example.com', 'content-type': 'application/json' },
      requestContext: {
        http: { method: 'POST' },
      },
      body: Buffer.from(JSON.stringify(echoBody)).toString('base64'),
      isBase64Encoded: true,
    })
    expect(v2.statusCode).toBe(200)
    expect(JSON.parse(v2.body).data).toMatchObject({
      method: 'POST',
      query: {
        a: ['1', '2'],
        b: 'x',
      },
      body: echoBody,
      cookie: 'sid=abc; theme=dark',
    })
    expect(v2.headers['x-request-id']).toBeTruthy()

    const v1 = await handler({
      httpMethod: 'GET',
      path: '/missing',
      multiValueHeaders: {
        host: ['api.example.com'],
      },
      multiValueQueryStringParameters: null,
    })
    expect(v1.statusCode).toBe(404)
    expect(v1.multiValueHeaders['content-type'][0]).toContain('json')
  })

  it('vercel: build output api with a node function', async () => {
    const result = await build('vercel')
    const output = join(result.root, '.vercel/output')
    expect(JSON.parse(readFileSync(join(output, 'config.json'), 'utf8')).routes).toEqual([
      { handle: 'filesystem' },
      { src: '/(.*)', dest: '/__server' },
    ])
    expect(JSON.parse(readFileSync(join(output, 'functions/__server.func/.vc-config.json'), 'utf8'))).toMatchObject({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs' })
    expect(existsSync(join(output, 'static'))).toBe(true)

    const { default: handler } = await import(pathToFileURL(result.entry).href)
    const server = createServer(handler)
    await new Promise<void>(resolve => server.listen(0, resolve))
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      expect((await (await fetch(`${base}/hello`)).json() as any).data).toEqual({ message: 'hello v1' })
      const echo = await fetch(`${base}/echo?x=1`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(echoBody),
      })
      expect((await echo.json() as any).data).toMatchObject({
        body: echoBody,
        query: { x: '1' },
      })
    }
    finally {
      server.close()
    }
  })

  it('netlify: frameworks api function with static config', async () => {
    const result = await build('netlify')
    const fn = join(result.root, '.netlify/v1/functions/think-h3-server.mjs')
    const source = readFileSync(fn, 'utf8')
    expect(source).toContain(`path: ["/*"]`)
    expect(source).toContain('preferStatic: true')
    expect(readFileSync(join(result.root, 'netlify.toml'), 'utf8')).toContain('publish = "dist/public"')

    const { default: handler } = await import(pathToFileURL(fn).href)
    const response: Response = await handler(new Request('https://site.netlify.app/echo?y=2', {
      method: 'POST',
      body: JSON.stringify(echoBody),
      headers: { 'content-type': 'application/json' },
    }), {})
    expect((await response.json() as any).data).toMatchObject({
      body: echoBody,
      query: { y: '2' },
    })
  })

  it('cloudflare: runs in workerd with bindings as environment variables', async () => {
    const result = await build('cloudflare')
    const dist = join(result.root, 'dist')
    const wrangler = JSON.parse(readFileSync(join(dist, 'wrangler.json'), 'utf8'))
    expect(wrangler).toMatchObject({
      main: 'index.mjs',
      compatibility_flags: ['nodejs_compat'],
    })

    const mf = new Miniflare({
      modules: workerModules(dist),
      modulesRoot: dist,
      compatibilityDate: wrangler.compatibility_date,
      compatibilityFlags: wrangler.compatibility_flags,
      bindings: { APP_NAME: 'from-binding' },
    })
    try {
      const hello = await mf.dispatchFetch('http://localhost/hello')
      expect(await hello.json()).toEqual({
        code: 0,
        message: 'ok',
        data: { message: 'hello v1' },
      })
      const echo = await mf.dispatchFetch('http://localhost/echo?z=3', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'cookie': 'k=v' },
        body: JSON.stringify(echoBody),
      })
      expect((await echo.json() as any).data).toEqual({
        method: 'POST',
        query: { z: '3' },
        body: echoBody,
        cookie: 'k=v',
        name: 'from-binding',
      })
      expect((await mf.dispatchFetch('http://localhost/missing')).status).toBe(404)
    }
    finally {
      await mf.dispose()
    }
  })
})

function which(command: string): string | undefined {
  try {
    return execFileSync('which', [command], { encoding: 'utf8' }).trim() || undefined
  }
  catch {
    return undefined
  }
}

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
