import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { Miniflare } from 'miniflare'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { binOf, createProject, csrfHeaders, run, sqliteRows, startProduction } from './utils'

let project: ReturnType<typeof createProject> | undefined
// 进程内调用的函数产物（Lambda / Vercel / Netlify）读取运行环境中的 APP_KEY
beforeAll(() => {
  process.env.APP_KEY = 'k'.repeat(32)
})
afterEach(() => {
  project?.cleanup()
  project = undefined
})
afterAll(() => {
  delete process.env.APP_KEY
})

async function buildVue(preset: string, prepare?: (project: ReturnType<typeof createProject>) => void) {
  project = createProject('vue')
  prepare?.(project)
  const result = await run(binOf('@hazejs/cli', 'haze'), [
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
    // 项目安装的驱动在镜像里安装（测试环境另装了 bullmq、ioredis、socket.io）；未安装的驱动不会列入
    const dependencies = Object.keys(JSON.parse(readFileSync(join(root, 'dist/package.json'), 'utf8')).dependencies)
    expect(dependencies).toEqual([
      '@libsql/client',
      'bullmq',
      'ioredis',
      'socket.io',
    ])
    expect(output).toContain('docker run --rm demo-vue node server/migrate.mjs')

    // 生产迁移脚本：迁移已打包进产物，不需要源码与 drizzle-kit
    const dist = join(root, 'dist')
    const env = { NODE_ENV: 'production' }
    const first = await run(join(dist, 'server/migrate.mjs'), [], dist, env)
    expect(first.output).toContain('[main] 3 of 3 migrations applied (database/migrations)')
    const again = await run(join(dist, 'server/migrate.mjs'), [], dist, env)
    expect([again.code, again.output]).toEqual([
      0,
      expect.stringContaining('[main] 0 of 3 migrations applied'),
    ])
    expect((await sqliteRows(join(dist, 'data/app.db'), 'select count(*) as n from __drizzle_migrations'))[0].n).toBe(3)

    // 产物目录中没有 .env：APP_KEY 由部署环境提供（docker run -e APP_KEY=...）
    const server = await startProduction(join(dist, 'server/index.mjs'), dist, {
      APP_KEY: 'k'.repeat(32),
    })
    try {
      const created = await fetch(`${server.url}/api/users`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...await csrfHeaders(path => fetch(`${server.url}${path}`)),
        },
        body: JSON.stringify({ name: 'Ada', email: 'ada@example.com' }),
      })
      expect(created.status).toBe(201)
      expect((await (await fetch(`${server.url}/api/users`)).json() as any).data.total).toBe(1)
    }
    finally {
      await server.stop()
    }
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

  it('aws-lambda: exports a migrate handler running the bundled migrations', async () => {
    const { root, output } = await buildVue('aws-lambda')
    expect(output).toContain('handler index.migrate')
    expect(output).toContain('handler index.schedule')
    // 依赖由追踪复制进产物；在非 Linux 机器上构建时提示原生二进制平台不符
    if (process.platform !== 'linux')
      expect(output).toMatch(/native packages were traced from this \w+ machine: .*@libsql\/(?:darwin|win32)-/)
    const lambda = join(root, 'dist/lambda')
    // 进程内调用：数据库写到产物目录（真实环境变量优先于 .env）
    process.env.DATABASE_URL = `file:${join(lambda, 'data/app.db')}`
    try {
      const { migrate } = await import(pathToFileURL(join(lambda, 'index.mjs')).href)
      expect(await migrate({})).toEqual([
        {
          connection: 'main',
          folder: 'database/migrations',
          applied: 3,
          total: 3,
        },
      ])
      expect((await migrate({ all: true }))[0]).toMatchObject({ applied: 0 })

      // 定时任务：EventBridge 每分钟调用 index.schedule（schedule/app.ts 的 heartbeat 每天 03:00）
      const { schedule } = await import(pathToFileURL(join(lambda, 'index.mjs')).href)
      expect(await schedule({ time: '2026-10-27T03:00:00Z' })).toEqual([
        { name: 'heartbeat', status: 'ok' },
      ])
      expect(await schedule({ time: '2026-10-27T03:01:00Z' })).toEqual([])
    }
    finally {
      delete process.env.DATABASE_URL
    }
  })

  it('vercel: static files on the CDN, API in a function, SPA fallback route', async () => {
    const { root } = await buildVue('vercel')
    const output = join(root, '.vercel/output')
    expect(existsSync(join(output, 'static/index.html'))).toBe(true)
    expect(readdirSync(join(output, 'static/assets')).some(file => file.endsWith('.js'))).toBe(true)
    const config = JSON.parse(readFileSync(join(output, 'config.json'), 'utf8'))
    expect(config.routes).toEqual([
      { handle: 'filesystem' },
      // 定时任务（schedule/app.ts）：Vercel Cron 调用的内部路由
      { src: '^/__haze/schedule$', dest: '/__server' },
      { src: '^/api(?:/.*)?$', dest: '/__server' },
      { src: '/(.*)', dest: '/index.html' },
    ])
    expect(config.crons).toEqual([
      { path: '/__haze/schedule', schedule: '* * * * *' },
    ])
    const fn = join(output, 'functions/__server.func')
    expect(existsSync(join(fn, 'node_modules/@libsql/client'))).toBe(true)
    const { default: handler } = await import(pathToFileURL(join(fn, 'index.mjs')).href)
    const server = createServer(handler)
    await new Promise<void>(resolve => server.listen(0, resolve))
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
      const res = await fetch(`${base}/api/hello`)
      expect((await res.json() as any).data).toMatchObject({ app: 'demo-vue' })

      // Vercel Cron：需要 CRON_SECRET
      process.env.CRON_SECRET = 'cron-secret'
      expect((await fetch(`${base}/__haze/schedule`)).status).toBe(401)
      const cron = await fetch(`${base}/__haze/schedule`, {
        headers: { authorization: 'Bearer cron-secret' },
      })
      expect(cron.status).toBe(200)
      expect(Array.isArray(await cron.json())).toBe(true)
    }
    finally {
      delete process.env.CRON_SECRET
      server.close()
    }
  })

  it('netlify: publish directory with SPA redirects and an API-only function', async () => {
    const { root } = await buildVue('netlify')
    expect(readFileSync(join(root, 'netlify.toml'), 'utf8')).toContain('publish = "dist/client"')
    expect(readFileSync(join(root, 'dist/client/_redirects'), 'utf8')).toContain('/index.html  200')
    const fn = join(root, '.netlify/v1/functions/haze-server.mjs')
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

    // 单文件 Worker：驱动以字面量导入并打包，无需额外模块
    expect(readdirSync(dist).filter(file => file.endsWith('.mjs'))).toEqual(['index.mjs'])
    const mf = new Miniflare({
      modules: true,
      scriptPath: join(dist, 'index.mjs'),
      compatibilityDate: wrangler.compatibility_date,
      compatibilityFlags: wrangler.compatibility_flags,
      bindings: {
        APP_NAME: 'edge-app',
        APP_KEY: 'k'.repeat(32),
      },
    })
    try {
      const res = await mf.dispatchFetch('http://localhost/api/hello')
      expect((await res.json() as any).data).toEqual({ app: 'edge-app', message: 'Hello, hazejs!' })
    }
    finally {
      await mf.dispose()
    }
  })

  it('cloudflare: D1 through the worker binding, migrations applied the way wrangler does', async () => {
    const { root, output } = await buildVue('cloudflare', (project) => {
      project.edit('server/config/database.ts', `driver: 'sqlite',
      url: env('DATABASE_URL', 'file:./data/app.db'),`, `driver: 'd1',
      binding: 'DB',`)
      writeFileSync(join(project.root, 'haze.config.ts'), `import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  srcDir: 'server',
  cloudflare: {
    wrangler: {
      d1_databases: [{ binding: 'DB', database_name: 'demo', database_id: '00000000-0000-0000-0000-000000000000' }],
    },
  },
})
`)
    })
    const dist = join(root, 'dist')
    const wrangler = JSON.parse(readFileSync(join(dist, 'wrangler.json'), 'utf8'))
    expect(wrangler.d1_databases).toEqual([
      {
        migrations_dir: 'migrations',
        binding: 'DB',
        database_name: 'demo',
        database_id: '00000000-0000-0000-0000-000000000000',
      },
    ])
    expect(output).toContain('npx wrangler d1 migrations apply demo --remote -c dist/wrangler.json')

    const mf = new Miniflare({
      modules: true,
      scriptPath: join(dist, 'index.mjs'),
      compatibilityDate: wrangler.compatibility_date,
      compatibilityFlags: wrangler.compatibility_flags,
      d1Databases: { DB: wrangler.d1_databases[0].database_id },
      // Workers 没有 .env：密钥通过 wrangler secret put APP_KEY 设置为绑定
      bindings: {
        APP_KEY: 'k'.repeat(32),
      },
    })
    try {
      // 与 wrangler d1 migrations apply 相同：按文件名顺序执行 migrations_dir 中的 SQL
      const db = await mf.getD1Database('DB')
      const files = readdirSync(join(dist, 'migrations')).filter(file => file.endsWith('.sql')).sort()
      expect(files).toEqual(['0000_create_users.sql', '0001_add_user_password.sql', '0002_add_user_role.sql'])
      for (const file of files) {
        const statements = readFileSync(join(dist, 'migrations', file), 'utf8').split('--> statement-breakpoint')
        await db.batch(statements.map(statement => db.prepare(statement)))
      }

      const csrf = await csrfHeaders(path => mf.dispatchFetch(`http://localhost${path}`) as unknown as Promise<Response>)
      const create = (email: string) => mf.dispatchFetch('http://localhost/api/users', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...csrf },
        body: JSON.stringify({ name: 'Ada', email }),
      })
      const created = await create('ada@example.com')
      expect(created.status).toBe(201)
      expect((await created.json() as any).data).toMatchObject({ id: 1, name: 'Ada' })
      expect((await create('ada@example.com')).status).toBe(409)
      const list = await (await mf.dispatchFetch('http://localhost/api/users')).json() as any
      expect(list.data).toMatchObject({
        total: 1,
        data: [
          { email: 'ada@example.com' },
        ],
      })
      // 授权：未登录不能删除用户（UserPolicy）
      expect((await mf.dispatchFetch('http://localhost/api/users/1', { method: 'DELETE', headers: csrf })).status).toBe(401)
      // CSRF：不带 token 的修改请求返回 419
      expect((await mf.dispatchFetch('http://localhost/api/users', { method: 'POST' })).status).toBe(419)

      // JWT 登录在 workerd 中运行（jose + 密码哈希）
      const register = await mf.dispatchFetch('http://localhost/api/auth/register', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...csrf },
        body: JSON.stringify({ name: 'Edge', email: 'edge@example.com', password: 'workers-rock' }),
      })
      expect(register.status, await register.clone().text()).toBe(201)
      const login = await (await mf.dispatchFetch('http://localhost/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...csrf },
        body: JSON.stringify({ email: 'edge@example.com', password: 'workers-rock' }),
      })).json() as any
      const me = await mf.dispatchFetch('http://localhost/api/auth/me', {
        headers: { authorization: `Bearer ${login.data.token}` },
      })
      expect((await me.json() as any).data).toMatchObject({ email: 'edge@example.com' })
      expect((await mf.dispatchFetch('http://localhost/api/auth/me')).status).toBe(401)
    }
    finally {
      await mf.dispose()
    }
  })

  // Turso / sqld：HAZE_TEST_TURSO_URL=http://127.0.0.1:8080
  it.runIf(process.env.HAZE_TEST_TURSO_URL)('cloudflare: Turso over HTTP from the worker, migrated with haze db:migrate', async () => {
    const url = process.env.HAZE_TEST_TURSO_URL!
    const { createClient } = await import('@libsql/client/web')
    const client = createClient({ url })
    await client.batch(['drop table if exists users', 'drop table if exists __drizzle_migrations'])
    client.close()

    const { root } = await buildVue('cloudflare', (project) => {
      project.edit('server/config/database.ts', `driver: 'sqlite',`, `driver: 'turso',`)
    })
    // Edge 没有迁移脚本：在 CI / 本地对远程库执行 db:migrate
    const migrate = await run(binOf('@hazejs/cli', 'haze'), ['db:migrate', '--root', root], root, { DATABASE_URL: url })
    expect(migrate.output, migrate.output).toContain('[main] migrated: 3 of 3 applied (database/migrations)')

    const dist = join(root, 'dist')
    const wrangler = JSON.parse(readFileSync(join(dist, 'wrangler.json'), 'utf8'))
    const mf = new Miniflare({
      modules: true,
      scriptPath: join(dist, 'index.mjs'),
      compatibilityDate: wrangler.compatibility_date,
      compatibilityFlags: wrangler.compatibility_flags,
      bindings: {
        DATABASE_URL: url,
        APP_KEY: 'k'.repeat(32),
      },
    })
    try {
      const created = await mf.dispatchFetch('http://localhost/api/users', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...await csrfHeaders(path => mf.dispatchFetch(`http://localhost${path}`) as unknown as Promise<Response>),
        },
        body: JSON.stringify({ name: 'Turso', email: 'turso@example.com' }),
      })
      expect(created.status).toBe(201)
      const list = await (await mf.dispatchFetch('http://localhost/api/users')).json() as any
      expect(list.data).toMatchObject({
        total: 1,
        data: [
          { name: 'Turso' },
        ],
      })
    }
    finally {
      await mf.dispose()
    }
  })

  // 真实 Redis：HAZE_TEST_REDIS_URL=redis://127.0.0.1:6379
  it.runIf(process.env.HAZE_TEST_REDIS_URL)('node: two instances share throttle counts through Redis, with ioredis traced into dist', async () => {
    project = createProject('api')
    const build = await run(binOf('@hazejs/cli', 'haze'), ['build', '--root', project.root], project.root, {})
    expect(build.code, build.output).toBe(0)
    expect(existsSync(join(project.root, 'dist/node_modules/ioredis/package.json'))).toBe(true)

    // 产物拷到项目之外运行，两个实例共用 Redis
    const elsewhere = mkdtempSync(join(tmpdir(), 'hazejs-redis-'))
    cpSync(join(project.root, 'dist'), elsewhere, { recursive: true })
    const env = {
      APP_KEY: 'k'.repeat(32),
      CACHE_STORE: 'redis',
      REDIS_URL: process.env.HAZE_TEST_REDIS_URL!,
      CACHE_PREFIX: `e2e:${crypto.randomUUID()}:`,
    }
    const servers = await Promise.all([
      startProduction(join(elsewhere, 'index.mjs'), elsewhere, env),
      startProduction(join(elsewhere, 'index.mjs'), elsewhere, env),
    ])
    try {
      // /api/auth/login 为 throttle:10,60：两个实例轮流请求，第 11 次被拒绝
      const statuses: number[] = []
      for (let index = 0; index < 11; index++) {
        const res = await fetch(`${servers[index % 2].url}/api/auth/login`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        statuses.push(res.status)
      }
      expect(statuses.slice(0, 10)).toEqual(Array.from({ length: 10 }).fill(422))
      expect(statuses[10]).toBe(429)
    }
    finally {
      await Promise.all(servers.map(server => server.stop()))
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  // 真实 Redis：web 进程投递，独立的 worker.mjs 进程消费（BullMQ 追踪进产物）
  it.runIf(process.env.HAZE_TEST_REDIS_URL)('node: worker.mjs consumes jobs dispatched by the web process through Redis', async () => {
    project = createProject('api')
    const cli = binOf('@hazejs/cli', 'haze')
    const build = await run(cli, ['build', '--root', project.root], project.root, {})
    expect(build.code, build.output).toBe(0)
    expect(build.output).toContain('worker.mjs queue')
    expect(existsSync(join(project.root, 'dist/node_modules/bullmq/package.json'))).toBe(true)

    const elsewhere = mkdtempSync(join(tmpdir(), 'hazejs-worker-'))
    cpSync(join(project.root, 'dist'), elsewhere, { recursive: true })
    const env = {
      APP_KEY: 'k'.repeat(32),
      QUEUE_CONNECTION: 'redis',
      REDIS_URL: process.env.HAZE_TEST_REDIS_URL!,
      DATABASE_URL: `file:${join(elsewhere, 'data/app.db')}`,
    }
    const migrated = await run(join(elsewhere, 'migrate.mjs'), [], elsewhere, { ...env, NODE_ENV: 'production' })
    expect(migrated.code, migrated.output).toBe(0)
    const web = await startProduction(join(elsewhere, 'index.mjs'), elsewhere, env)
    const worker = spawn(process.execPath, [
      join(elsewhere, 'worker.mjs'),
      'queue',
      '--concurrency',
      '2',
    ], {
      cwd: elsewhere,
      env: {
        ...process.env,
        ...env,
        NODE_ENV: 'production',
      },
    })
    let output = ''
    worker.stdout.on('data', chunk => (output += chunk))
    worker.stderr.on('data', chunk => (output += chunk))
    try {
      const email = `${crypto.randomUUID()}@example.com`
      const registered = await fetch(`${web.url}/api/auth/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada', email, password: 'correct horse' }),
      })
      expect(registered.status).toBe(201)
      for (let attempt = 0; attempt < 100 && !output.includes(`Welcome email sent to ${email}`); attempt++)
        await new Promise(resolve => setTimeout(resolve, 100))
      expect(output).toContain(`Welcome email sent to ${email}`)

      const schedule = await run(join(elsewhere, 'worker.mjs'), ['schedule:run'], elsewhere, { ...env, NODE_ENV: 'production' })
      expect(schedule.code, schedule.output).toBe(0)
    }
    finally {
      worker.kill('SIGTERM')
      await new Promise(resolve => worker.once('exit', resolve))
      await web.stop()
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  it('node (api template): migrate.mjs finds migrations when the source dir is the project root', async () => {
    project = createProject('api')
    const build = await run(binOf('@hazejs/cli', 'haze'), ['build', '--root', project.root], project.root, {})
    expect(build.code, build.output).toBe(0)
    const dist = join(project.root, 'dist')
    const migrated = await run(join(dist, 'migrate.mjs'), [], dist, { NODE_ENV: 'production', DATABASE_URL: `file:${join(dist, 'data/app.db')}` })
    expect(migrated.output, migrated.output).toContain('[main] 3 of 3 migrations applied (database/migrations)')
  })
})
