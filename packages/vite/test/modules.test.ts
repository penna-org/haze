import type { DevServer } from '../src'
import { spawn } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, symlinkSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer, createDevServer } from '../src'
import { findModulePackages } from '../src/modules'
import { copyFixture, getJson, nextReload, settle } from './utils'

let dev: DevServer | undefined
let fixture: ReturnType<typeof copyFixture> | undefined

afterEach(async () => {
  await dev?.close()
  fixture?.cleanup()
  dev = undefined
  fixture = undefined
})

/** 复制 fixture，并像 pnpm 的 link: 一样把 packages/news 链接进 node_modules */
function setup(): ReturnType<typeof copyFixture> {
  fixture = copyFixture('modules')
  mkdirSync(join(fixture.root, 'node_modules/@demo'), { recursive: true })
  symlinkSync(join(fixture.root, 'packages/news'), join(fixture.root, 'node_modules/@demo/news'), 'dir')
  return fixture
}

describe('modules', () => {
  it('detects linked module packages from package.json', () => {
    const { root } = setup()
    expect(findModulePackages(root)).toEqual([
      {
        name: '@demo/news',
        dir: join(root, 'packages/news'),
        linked: true,
      },
    ])
  })

  it('serves local and package modules in dev, hot-reloads both and generates their types', async () => {
    const { root, edit } = setup()
    dev = await createDevServer({ root, port: 0, debounce: 10 })
    await settle()

    // 本地模块：module.ts 的前缀，项目的 config/blog.ts 覆盖模块的默认配置
    expect((await getJson(dev, '/blog/posts')).body.data).toEqual({ title: 'Project Blog', perPage: 20, message: 'posts v1' })
    expect((await getJson(dev, '/blog/posts/7')).body.data).toEqual({ id: '7' })
    // 模块包：config/modules.ts 中启用时传入的前缀
    expect((await getJson(dev, '/news/latest')).body.data).toEqual({ headline: 'news v1', limit: 5 })
    expect(dev.app!.modules().map(module => [module.name, module.source, module.prefix])).toEqual([
      ['news', 'package', '/news'],
      ['blog', 'local', '/blog'],
    ])

    const types = readFileSync(join(root, '.haze/types/haze.d.ts'), 'utf8')
    expect(types).toContain('"blog.posts.show": { id: string | number }')
    expect(types).toContain('"news.latest": Record<never, never>')
    expect(types).toContain('"blog": ConfigValue<typeof import("../../config/blog").default>')
    // 本地模块的配置文件：项目没有同名配置时加入（模块包的配置类型由包自己的声明扩充提供）
    expect(types).not.toContain('modules/blog/config/blog')
    expect(types).toContain('"feed": ConfigValue<typeof import("../../modules/blog/config/feed").default>')

    // 修改本地模块
    let reloaded = nextReload(dev)
    edit('modules/blog/app/controller/PostController.ts', 'posts v1', 'posts v2')
    expect((await reloaded).ok).toBe(true)
    expect((await getJson(dev, '/blog/posts')).body.data.message).toBe('posts v2')

    // 修改链接进来的模块包（由 Vite 处理，不需要重启）
    reloaded = nextReload(dev)
    edit('packages/news/src/index.ts', 'news v1', 'news v2')
    expect((await reloaded).ok).toBe(true)
    expect((await getJson(dev, '/news/latest')).body.data.headline).toBe('news v2')
  })

  it('bundles module routes and rewrites package migration folders for production', async () => {
    const { root } = setup()
    const { entry, outDir } = await buildServer({ root })
    const bundle = walk(outDir).filter(file => file.endsWith('.mjs')).map(file => readFileSync(file, 'utf8')).join('\n')
    // 打包后的 import.meta.url 不再指向包目录：迁移目录改写为内嵌迁移文件的键
    expect(bundle).toContain('"node_modules/@demo/news/database/migrations"')
    expect(bundle).not.toContain(`new URL("../database/migrations"`)

    const port = await freePort()
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'production',
      },
      stdio: 'pipe',
    })
    try {
      expect(await poll(`http://localhost:${port}/blog/posts`)).toMatchObject({
        data: { title: 'Project Blog', message: 'posts v1' },
      })
      expect(await poll(`http://localhost:${port}/news/latest`)).toMatchObject({
        data: { headline: 'news v1' },
      })
    }
    finally {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
  })
})

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? entry.name === 'node_modules'
      ? []
      : walk(join(dir, entry.name))
    : [
        join(dir, entry.name),
      ])
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

async function poll(url: string, attempts = 50): Promise<unknown> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await (await fetch(url)).json()
    }
    catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error(`Server at ${url} did not start`)
}
