import type { ChildProcess } from 'node:child_process'
import type { PresetName } from '../src'
import { Buffer } from 'node:buffer'
import { execFileSync, spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
async function build(preset: PresetName, hazeConfig?: string, existing?: ReturnType<typeof copyFixture>) {
  fixture = existing ?? copyFixture('basic')
  if (hazeConfig)
    fixture.write('haze.config.ts', hazeConfig)
  fixture.write('route/echo.ts', `
import { defineRoutes } from '@hazejs/core'
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
  it('node: bundles dependencies and traces externals into dist/node_modules', async () => {
    // consola 改为 external：验证追踪复制（数据库驱动等默认 external 的包同理）
    const result = await build('node', `export default { externals: { traceDeps: ['consola'] } }\n`)
    expect(result.entry).toBe(join(result.root, 'dist/index.mjs'))
    expect(result.externals).toEqual(['consola'])
    expect(result.traced?.packages).toEqual(['consola'])
    expect(existsSync(join(result.root, 'dist/node_modules/consola/package.json'))).toBe(true)
    // 产物自包含：拷到项目之外仍可运行
    const elsewhere = mkdtempSync(join(tmpdir(), 'hazejs-node-'))
    try {
      cpSync(join(result.root, 'dist'), elsewhere, { recursive: true })
      await expectServes(process.execPath, [
        join(elsewhere, 'index.mjs'),
      ], elsewhere, { APP_NAME: 'basic' })
    }
    finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('node: externals.trace false keeps dependencies in the project node_modules', async () => {
    const result = await build('node', `export default { externals: { trace: false } }\n`)
    expect(result.externals).toEqual(expect.arrayContaining(['srvx']))
    expect(result.traced).toBeUndefined()
    expect(existsSync(join(result.root, 'dist/node_modules'))).toBe(false)
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
    const fn = join(result.root, '.netlify/v1/functions/haze-server.mjs')
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
    fixture = copyFixture('basic')
    // 加密 Cookie Session（Web Crypto）在 workerd 中运行
    fixture.write('route/visits.ts', `
import { defineRoutes } from '@hazejs/core'
export default defineRoutes(r => r.get('/session-visits', (ctx) => {
  const visits = ctx.session.get('visits', 0) + 1
  ctx.session.set('visits', visits)
  return { visits }
}).middleware('session'))
`)
    // KV 缓存在 workerd 中运行
    fixture.write('config/cache.ts', `export default { default: 'kv', stores: { kv: { driver: 'kv', binding: 'CACHE' } } }\n`)
    fixture.write('route/kv.ts', `
import { Cache, defineRoutes } from '@hazejs/core'
export default defineRoutes(r => r.get('/kv', async () => ({
  hits: await Cache.increment('hits'),
  first: await Cache.remember('first', 120, () => 'cached once'),
})))
`)
    const result = await build('cloudflare', undefined, fixture)
    const dist = join(result.root, 'dist')
    const wrangler = JSON.parse(readFileSync(join(dist, 'wrangler.json'), 'utf8'))
    expect(wrangler).toMatchObject({
      main: 'index.mjs',
      compatibility_flags: ['nodejs_compat'],
    })

    // 单文件 Worker（驱动以字面量导入，构建时已解析）
    expect(readdirSync(dist)).toEqual(['index.mjs', 'index.mjs.map', 'wrangler.json'])
    const mf = new Miniflare({
      modules: true,
      scriptPath: join(dist, 'index.mjs'),
      compatibilityDate: wrangler.compatibility_date,
      compatibilityFlags: wrangler.compatibility_flags,
      bindings: {
        APP_NAME: 'from-binding',
        APP_KEY: 'k'.repeat(32),
      },
      kvNamespaces: ['CACHE'],
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

      expect((await (await mf.dispatchFetch('http://localhost/kv')).json() as any).data).toEqual({ hits: 1, first: 'cached once' })
      expect((await (await mf.dispatchFetch('http://localhost/kv')).json() as any).data).toEqual({ hits: 2, first: 'cached once' })
      const kv = await mf.getKVNamespace('CACHE') as unknown as { get: (key: string) => Promise<string | null> }
      expect(await kv.get('haze:hits')).toBe('2')

      const first = await mf.dispatchFetch('http://localhost/session-visits')
      expect((await first.json() as any).data).toEqual({ visits: 1 })
      const cookie = first.headers.getSetCookie()[0].split(';')[0]
      const second = await mf.dispatchFetch('http://localhost/session-visits', {
        headers: { cookie },
      })
      expect((await second.json() as any).data).toEqual({ visits: 2 })
    }
    finally {
      await mf.dispose()
    }
  })

  it('cloudflare: Queues consumer with retries and Cron Triggers run in workerd', async () => {
    fixture = copyFixture('basic')
    fixture.write('config/cache.ts', `export default { default: 'kv', stores: { kv: { driver: 'kv', binding: 'CACHE' } } }\n`)
    fixture.write('config/queue.ts', `export default { default: 'cf', connections: { cf: { driver: 'cloudflare', binding: 'QUEUE' } } }\n`)
    fixture.write('app/job/Record.ts', `
import { Cache, defineJob } from '@hazejs/core'
export default defineJob({
  tries: 2,
  async handle(payload: { id: number, fail?: boolean }, job) {
    if (payload.fail && job.attempt === 1)
      throw new Error('first attempt fails')
    await Cache.set('job:' + payload.id, job.attempt)
  },
})
`)
    fixture.write('route/enqueue.ts', `
import { defineRoutes } from '@hazejs/core'
import Record from '../app/job/Record'
export default defineRoutes(r => r.get('/enqueue/:id', async ctx => ({ id: await Record.dispatch({ id: Number(ctx.param('id')), fail: ctx.query('fail') === '1' }) })))
`)
    fixture.write('schedule/app.ts', `
import { Cache, defineSchedule } from '@hazejs/core'
export default defineSchedule(s => void s.call('tick', () => Cache.set('tick', new Date().toISOString())).everyMinute())
`)
    const result = await build('cloudflare', undefined, fixture)
    const dist = join(result.root, 'dist')
    const wrangler = JSON.parse(readFileSync(join(dist, 'wrangler.json'), 'utf8'))
    // 有定时任务时每分钟触发 scheduled()
    expect(wrangler.triggers).toEqual({
      crons: ['* * * * *'],
    })

    const mf = new Miniflare({
      modules: true,
      scriptPath: join(dist, 'index.mjs'),
      compatibilityDate: wrangler.compatibility_date,
      compatibilityFlags: wrangler.compatibility_flags,
      bindings: {
        APP_KEY: 'k'.repeat(32),
      },
      kvNamespaces: ['CACHE'],
      queueProducers: { QUEUE: 'jobs' },
      queueConsumers: {
        jobs: { maxBatchTimeout: 0.1, maxRetries: 3 },
      },
    })
    try {
      const kv = await mf.getKVNamespace('CACHE') as unknown as { get: (key: string) => Promise<string | null> }
      const waitFor = async (key: string) => {
        for (let attempt = 0; attempt < 100; attempt++) {
          const value = await kv.get(key)
          if (value !== null)
            return value
          await new Promise(resolve => setTimeout(resolve, 100))
        }
        throw new Error(`${key} was not written`)
      }
      expect((await mf.dispatchFetch('http://localhost/enqueue/1')).status).toBe(200)
      expect(await waitFor('haze:job:1')).toBe('1')
      // 第一次失败 → message.retry() → 第二次成功
      await mf.dispatchFetch('http://localhost/enqueue/2?fail=1')
      expect(await waitFor('haze:job:2')).toBe('2')

      const worker = await mf.getWorker() as unknown as { scheduled: (options: { scheduledTime: Date, cron: string }) => Promise<unknown> }
      await worker.scheduled({
        scheduledTime: new Date('2026-10-27T03:00:00Z'),
        cron: '* * * * *',
      })
      expect(await waitFor('haze:tick')).toMatch(/^"20/)
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
