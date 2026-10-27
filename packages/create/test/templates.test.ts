import type { createProject as CreateProject } from './utils'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildServer, createDevServer } from '@think-h3/vite'
import { createBuilder, createServer } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { scaffold, toPackageName } from '../src/scaffold'
import { binOf, createProject, run, sqliteRows, startProduction, waitFor } from './utils'

let project: ReturnType<typeof CreateProject> | undefined
afterEach(() => {
  project?.cleanup()
  project = undefined
})

async function json(url: string, init?: RequestInit): Promise<any> {
  return (await fetch(url, init)).json()
}

describe('scaffold', () => {
  it('copies the template, renames dotfiles and fills placeholders', () => {
    project = createProject('api')
    expect(project.files).toContain('.gitignore')
    expect(project.files).not.toContain('_gitignore')
    expect(JSON.parse(project.read('package.json'))).toMatchObject({
      name: 'demo-api',
      dependencies: { '@think-h3/core': '^0.0.0' },
    })
    for (const file of project.files)
      expect(project.read(file), file).not.toMatch(/\{\{\w+\}\}/)
  })

  it('refuses to overwrite a non-empty directory without force', () => {
    project = createProject('api')
    expect(() => scaffold({ dir: project!.root, template: 'api' })).toThrow(/not empty/)
    expect(() => scaffold({ dir: project!.root, template: 'nope' as 'api' })).toThrow(/Unknown template/)
  })

  it('normalizes package names', () => {
    expect(toPackageName('My App')).toBe('my-app')
    expect(toPackageName('.hidden')).toBe('hidden')
  })
})

describe('api template', () => {
  it('typechecks and passes its own tests', async () => {
    project = createProject('api')
    const tsc = await run(binOf('typescript', 'tsc'), ['--noEmit', '-p', 'tsconfig.json'], project.root)
    expect(tsc.output).toBe('')
    expect(tsc.code).toBe(0)

    const tests = await run(binOf('vitest'), ['run'], project.root)
    // greeting 3 + users 3 + auth 3
    expect(tests.output, tests.output).toContain('9 passed')
    expect(tests.code).toBe(0)
  })

  it('runs in dev with hot reload and builds for production', async () => {
    project = createProject('api')
    const dev = await createDevServer({ root: project.root, port: 0, debounce: 10 })
    try {
      expect((await json(new URL('/api/hello', dev.url).href)).data.message).toBe('Hello, think-h3!')
      await new Promise(resolve => setTimeout(resolve, 150))
      // eslint-disable-next-line no-template-curly-in-string -- 模板源码中的字面量
      project.edit('app/service/GreetingService.ts', '`Hello, ${name}!`', '`你好，${name}！`')
      await waitFor(async () => (await json(new URL('/api/hello', dev.url).href)).data.message === '你好，think-h3！')
    }
    finally {
      await dev.close()
    }

    const { entry } = await buildServer({ root: project.root })
    const server = await startProduction(entry, project.root)
    try {
      expect(await json(`${server.url}/api/hello`)).toEqual({
        code: 0,
        message: 'ok',
        data: { app: 'demo-api', message: '你好，think-h3！' },
      })
    }
    finally {
      await server.stop()
    }
  })
})

describe('code generation and types', () => {
  it('scaffolds a unique APP_KEY and key:generate rotates it', async () => {
    project = createProject('api')
    const key = /^APP_KEY=(\S+)$/m.exec(project.read('.env'))![1]
    expect(key).toMatch(/^[\w-]{43}$/)
    const other = createProject('api')
    expect(/^APP_KEY=(\S+)$/m.exec(other.read('.env'))![1]).not.toBe(key)
    other.cleanup()

    const cli = binOf('@think-h3/cli', 'think-h3')
    const refused = await run(cli, ['key:generate', '--root', project.root], project.root, {})
    expect([refused.code, refused.output]).toEqual([
      1,
      expect.stringContaining('already exists'),
    ])
    const rotated = await run(cli, [
      'key:generate',
      '--force',
      '--root',
      project.root,
    ], project.root, {})
    expect(rotated.code, rotated.output).toBe(0)
    const next = /^APP_KEY=(\S+)$/m.exec(project.read('.env'))![1]
    expect(next).not.toBe(key)
    expect(project.read('.env').match(/APP_KEY=/g)).toHaveLength(1)
  })

  it('make:* output and generated types typecheck in a fresh project', async () => {
    project = createProject('api')
    const cli = binOf('@think-h3/cli', 'think-h3')
    // 不传 NODE_ENV=test，否则 consola 会隐藏命令的提示输出
    const think = (...args: string[]) => run(cli, [...args, '--root', project!.root], project!.root, {})

    const typegen = await think('typegen')
    expect(typegen.code, typegen.output).toBe(0)
    // api.hello + api.users.{index,store,show,update,destroy} + api.auth.{register,login,me}
    expect(typegen.output).toContain('9 named route(s)')
    expect(project.read('.think/types/think.d.ts')).toContain('"api.hello": Record<never, never>')

    for (const kind of [
      'controller',
      'service',
      'repository',
      'middleware',
      'provider',
      'validate',
      'test',
    ]) {
      const result = await think(`make:${kind}`, 'admin/order-item')
      expect(result.code, result.output).toBe(0)
    }
    for (const kind of ['config', 'route', 'interceptor']) {
      const result = await think(`make:${kind}`, 'order-item')
      expect(result.code, result.output).toBe(0)
    }
    // 新增配置 / 路由后重新生成类型
    await think('typegen')
    const resource = await think('make:controller', 'Product', '--resource')
    expect(resource.output).toContain('app/controller/ProductController.ts')
    expect((await think('make:service', 'admin/order-item')).output).toContain('already exists')

    // 模型 → 迁移 → 执行迁移 → 数据填充
    const model = await think('make:model', 'Product', '--soft-delete')
    expect(model.output, model.output).toContain('database/schema/products.ts')
    const generate = await think('db:generate', '--name', 'create_products')
    expect(generate.code, generate.output).toBe(0)
    expect(project.files.concat(readdirSync(join(project.root, 'database/migrations')))).toContain('0002_create_products.sql')
    const migrate = await think('db:migrate')
    expect(migrate.output, migrate.output).toContain('[main] migrated')
    writeFileSync(join(project.root, 'database/seeders/02-products.ts'), `
import { Product } from '~/app/model/Product'
export default async function seed() {
  await Product.create({ name: 'Keyboard' })
}
`)
    const seed = await think('db:seed')
    expect(seed.output, seed.output).toContain('Seeded 02-products.ts')
    const tables = await sqliteRows(join(project.root, 'data/app.db'), 'select (select count(*) from users) as users, (select name from products) as product')
    expect(tables).toEqual([
      { users: 1, product: 'Keyboard' },
    ])

    // 类型探针：生成的配置键 / 路由名必须能拦截拼写错误
    writeFileSync(join(project.root, 'probe.ts'), `
import { config, Router } from '@think-h3/core'
import { Product } from '~/app/model/Product'
declare const router: Router
const name: string = config('app.name')
const enabled: boolean = config('orderItem.enabled')
router.url('api.hello')
router.url('api.users.show', { id: 1 })
// @ts-expect-error 未知配置键
config('app.nope')
// @ts-expect-error 未知路由名
router.url('api.nope')
// 模型字段类型来自 drizzle 表结构
const product = await Product.findOrFail(1)
const productName: string = product.name
// @ts-expect-error 不存在的字段
product.nope
export { enabled, name, productName }
`)
    const tsc = await run(binOf('typescript', 'tsc'), ['--noEmit', '-p', 'tsconfig.json'], project.root)
    expect(tsc.output).toBe('')

    // 生成的测试与模板测试一起通过
    const tests = await run(binOf('vitest'), ['run'], project.root)
    // greeting 3 + users 3 + auth 3 + 生成的测试 1
    expect(tests.output, tests.output).toContain('10 passed')
  })
})

describe('vue template', () => {
  it('typechecks and passes its own tests', async () => {
    project = createProject('vue')
    const typecheck = await run(binOf('vue-tsc'), ['--build'], project.root)
    expect(typecheck.output).toBe('')
    expect(typecheck.code).toBe(0)

    const tests = await run(binOf('vitest'), ['run'], project.root)
    // greeting 3 + users 3 + auth 3
    expect(tests.output, tests.output).toContain('9 passed')
    expect(tests.code).toBe(0)
  })

  it('serves the Vue app and the API from one Vite dev server', async () => {
    project = createProject('vue')
    const vite = await createServer({
      root: project.root,
      logLevel: 'silent',
      server: { port: 0 },
    })
    await vite.listen()
    const base = vite.resolvedUrls!.local[0].replace(/\/$/, '')
    try {
      const html = await (await fetch(`${base}/`)).text()
      expect(html).toContain('<div id="app"></div>')
      expect(html).toContain('/@vite/client')
      expect((await fetch(`${base}/src/App.vue`)).status).toBe(200)
      // 前端路由由 Vite 回退到 index.html，/api 交给后端
      expect(await (await fetch(`${base}/about`, {
        headers: { accept: 'text/html' },
      })).text()).toContain('<div id="app"></div>')

      expect((await json(`${base}/api/hello`)).data).toEqual({ app: 'demo-vue', message: 'Hello, think-h3!' })
      const posted = await json(`${base}/api/hello`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Vue' }),
      })
      expect(posted.data).toEqual({ message: 'Hello, Vue!' })
      expect((await fetch(`${base}/api/nope`)).status).toBe(404)

      await new Promise(resolve => setTimeout(resolve, 150))
      // eslint-disable-next-line no-template-curly-in-string -- 模板源码中的字面量
      project.edit('server/app/service/GreetingService.ts', '`Hello, ${name}!`', '`Hi, ${name}!`')
      await waitFor(async () => (await json(`${base}/api/hello`)).data.message === 'Hi, think-h3!')
    }
    finally {
      await vite.close()
    }
  })

  it('builds client and server together and serves both in production', async () => {
    project = createProject('vue')
    const builder = await createBuilder({ root: project.root, logLevel: 'silent' })
    await builder.buildApp()

    const clientIndex = join(project.root, 'dist/client/index.html')
    const entry = join(project.root, 'dist/server/index.mjs')
    expect(existsSync(clientIndex)).toBe(true)
    expect(existsSync(entry)).toBe(true)
    const asset = readFileSync(clientIndex, 'utf8').match(/src="(\/assets\/[^"]+\.js)"/)![1]

    const server = await startProduction(entry, project.root)
    try {
      const page = await fetch(`${server.url}/`)
      expect(await page.text()).toContain('<div id="app"></div>')

      const js = await fetch(`${server.url}${asset}`)
      expect(js.status).toBe(200)
      expect(js.headers.get('cache-control')).toContain('immutable')

      const fallback = await fetch(`${server.url}/users/1`, {
        headers: { accept: 'text/html' },
      })
      expect(await fallback.text()).toContain('<div id="app"></div>')

      expect((await json(`${server.url}/api/hello`)).data.app).toBe('demo-vue')
      const missing = await fetch(`${server.url}/api/nope`, {
        headers: { accept: 'text/html' },
      })
      expect(missing.status).toBe(404)
      expect((await missing.json() as { code: number }).code).toBe(404)
    }
    finally {
      await server.stop()
    }
  })
})
