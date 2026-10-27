import type { PreviewServer, ViteDevServer } from 'vite'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBuilder, createServer, preview } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { binOf, createProject, freePort, run, wsExchange } from './utils'

let project: ReturnType<typeof createProject> | undefined
let server: ViteDevServer | PreviewServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  project?.cleanup()
  project = undefined
})

/** 不使用任何前端框架的 Vite 项目：thinkH3() 与框架无关（Svelte / Solid 等同理） */
function vanilla(project: ReturnType<typeof createProject>) {
  rmSync(join(project.root, 'src'), { recursive: true })
  writeFileSync(join(project.root, 'vite.config.ts'), `import { thinkH3 } from '@think-h3/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [thinkH3()] })
`)
  project.edit('index.html', '/src/main.tsx', '/src/main.js')
  project.write('src/main.js', `const res = await fetch('/api/hello')
document.querySelector('#app').textContent = (await res.json()).data.message
`)
}

const frameworks = [
  {
    name: 'react',
    entry: '/src/main.tsx',
    prepare: () => {},
  },
  { name: 'vanilla', entry: '/src/main.js', prepare: vanilla },
]

const url = (target: ViteDevServer | PreviewServer) => target.resolvedUrls!.local[0].replace(/\/$/, '')

describe.each(frameworks)('$name + thinkH3()', (framework) => {
  function create() {
    project = createProject('react')
    framework.prepare(project)
    return project.root
  }

  it('dev: frontend modules and the API share one Vite server', async () => {
    const root = create()
    server = await createServer({
      root,
      logLevel: 'silent',
      server: { port: await freePort() },
    })
    await server.listen()
    const base = url(server)
    expect(await (await fetch(`${base}/`)).text()).toContain('<div id="app"></div>')
    expect((await fetch(`${base}${framework.entry}`)).status).toBe(200)
    expect((await (await fetch(`${base}/api/hello`)).json() as any).data).toEqual({ app: 'demo-react', message: 'Hello, think-h3!' })
    // WebSocket 经 Vite 开发服务器交给后端（与 Vite 的 HMR 连接并存）
    expect(await wsExchange(`${base.replace(/^http/, 'ws')}/api/ws`, 'ping', 2)).toEqual(['{"type":"connected"}', '{"type":"pong"}'])
  })

  it('build + vite preview: runs the built server with the built client', async () => {
    const root = create()
    const builder = await createBuilder({ root, logLevel: 'silent' })
    await builder.buildApp()
    expect(existsSync(join(root, 'dist/client/index.html'))).toBe(true)
    expect(existsSync(join(root, 'dist/server/index.mjs'))).toBe(true)

    server = await preview({
      root,
      logLevel: 'silent',
      preview: { port: await freePort() },
    })
    const base = url(server)
    expect(await (await fetch(`${base}/users/1`, {
      headers: { accept: 'text/html' },
    })).text()).toContain('<div id="app"></div>')
    expect((await (await fetch(`${base}/api/hello`)).json() as any).data.app).toBe('demo-react')
  })
})

describe('react template', () => {
  it('typechecks and passes its own tests', async () => {
    project = createProject('react')
    const typecheck = await run(binOf('typescript', 'tsc'), ['--build'], project.root)
    expect(typecheck.output).toBe('')
    expect(typecheck.code).toBe(0)

    const tests = await run(binOf('vitest'), ['run'], project.root)
    // greeting 3 + users 4 + auth 4
    expect(tests.output, tests.output).toContain('11 passed')
  })
})
