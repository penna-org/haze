import type { DevServer } from '../src'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer, createDevServer } from '../src'
import { copyFixture, getJson, nextReload, settle } from './utils'

let dev: DevServer | undefined
let fixture: ReturnType<typeof copyFixture> | undefined

async function start(name = 'auto-import'): Promise<DevServer> {
  fixture = copyFixture(name)
  dev = await createDevServer({
    root: fixture.root,
    port: 0,
    debounce: 10,
    devtools: false,
  })
  await settle()
  return dev
}

/** 开发服务器中 ssr 环境的转换结果 */
async function transformed(dev: DevServer, file: string): Promise<string> {
  const result = await dev.vite.environments.ssr.transformRequest(`${fixture!.root}/${file}`)
  return result!.code
}

afterEach(async () => {
  await dev?.close()
  fixture?.cleanup()
  dev = undefined
  fixture = undefined
})

describe('auto import', () => {
  it('injects imports for controllers, services and default exports', async () => {
    const dev = await start()
    expect((await getJson(dev, '/hello')).body.data).toEqual({ message: 'hello auto' })
    expect((await getJson(dev, '/event')).body.data).toEqual({ event: 'UserRegistered' })

    const controller = await transformed(dev, 'app/controller/HelloController.ts')
    expect(controller).toContain('GreetService.ts')
    // 只在类型位置出现，TS 转换之后才注入，不产生运行时导入
    expect(controller).not.toContain('TypedOnlyService.ts')
    // drizzle-kit 加载的目录不注入
    expect(await transformed(dev, 'database/schema/users.ts')).not.toContain('GreetService.ts')
  })

  it('writes the global type declarations', async () => {
    await start()
    const dts = readFileSync(`${fixture!.root}/.haze/types/auto-imports.d.ts`, 'utf8')
    expect(dts).toContain(`export { default as UserRegistered } from "../../app/event/UserRegistered.ts"`)
    expect(dts).toContain(`export import HelloController = __autoImports.HelloController`)
    expect(dts).toContain(`export import TypedOnlyService = __autoImports.TypedOnlyService`)
    // 依赖中的 @hazejs/core 提供的预设
    expect(dts).toContain(`export import defineRoutes = __autoImports.defineRoutes`)
    expect(dts).toContain(`export type { AuthUser,`)
  })

  it('re-transforms modules that use a name added later', async () => {
    const dev = await start()
    // 名字还不存在：运行时报 ReferenceError
    expect((await getJson(dev, '/bye')).status).toBe(500)

    const reloaded = nextReload(dev)
    fixture!.write('app/service/FarewellService.ts', `export class FarewellService {\n  bye() {\n    return 'bye'\n  }\n}\n`)
    expect((await reloaded).ok).toBe(true)
    expect((await getJson(dev, '/bye')).body.data).toEqual({ message: 'bye' })
    expect(readFileSync(`${fixture!.root}/.haze/types/auto-imports.d.ts`, 'utf8')).toContain('FarewellService')

    // 删除后名字不再可用
    const removed = nextReload(dev)
    rmSync(`${fixture!.root}/app/service/FarewellService.ts`)
    await removed
    expect((await getJson(dev, '/bye')).status).toBe(500)
  })

  it('is off unless enabled', async () => {
    const dev = await start('basic')
    expect((await getJson(dev, '/hello')).status).toBe(200)
    expect(existsSync(`${fixture!.root}/.haze/types/auto-imports.d.ts`)).toBe(false)
  })

  it('works in production builds', async () => {
    fixture = copyFixture('auto-import')
    const { entry } = await buildServer({ root: fixture.root })
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
      expect(await poll(`http://localhost:${port}/hello`)).toMatchObject({
        data: { message: 'hello auto' },
      })
    }
    finally {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
  })
})

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
      const res = await fetch(url)
      return await res.json()
    }
    catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error(`${url} did not respond`)
}
