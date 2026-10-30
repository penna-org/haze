import type { PreviewServer, ViteDevServer } from 'vite'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createBuilder, createServer, preview } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { binOf, createProject, freePort, run, socketIoFirst, waitFor, wsExchange } from './utils'

let project: ReturnType<typeof createProject> | undefined
let server: ViteDevServer | PreviewServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  project?.cleanup()
  project = undefined
})

/** 不使用任何前端框架的 Vite 项目：haze() 与框架无关（Svelte / Solid 等同理） */
function vanilla(project: ReturnType<typeof createProject>) {
  rmSync(join(project.root, 'src'), { recursive: true })
  writeFileSync(join(project.root, 'vite.config.ts'), `import { haze } from '@hazejs/vite'
import { defineConfig } from 'vite'

export default defineConfig({ plugins: [haze()] })
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

describe.each(frameworks)('$name + haze()', (framework) => {
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
    expect((await (await fetch(`${base}/api/hello`)).json() as any).data).toEqual({ app: 'demo-react', message: 'Hello, hazejs!' })
    // WebSocket 经 Vite 开发服务器交给后端（与 Vite 的 HMR 连接并存）
    expect(await wsExchange(`${base.replace(/^http/, 'ws')}/api/ws`, 'ping', 2)).toEqual(['{"type":"connected"}', '{"type":"pong"}'])
    // Socket.IO（/socket.io/）：长轮询与升级都在同一个 Vite 端口上
    expect(await socketIoFirst(`${base}/chat`, 'online')).toBe(1)
    // 上一个（轮询）客户端的断开在服务端异步处理：等在线数回到 1
    await expect.poll(() => socketIoFirst(`${base}/chat`, 'online', {
      transports: ['websocket'],
    }), { timeout: 5000, interval: 200 }).toBe(1)

    // 热替换：修改命名空间后，新连接使用新代码
    project!.edit('server/app/socket/chat.ts', `chat.emit('online', chat.sockets.size)\n    socket.on`, `chat.emit('online', chat.sockets.size + 100)\n    socket.on`)
    await waitFor(async () => (await socketIoFirst(`${base}/chat`, 'online')) === 101, 15_000)
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
  it('backend TSX views use the hazejs runtime while the React frontend keeps React JSX', async () => {
    project = createProject('react')
    project.write('server/app/view/Page.tsx', `export default function Page(props: { name: string }) {
  return <section class="page" data-name={props.name}>{['a', 'b'].map(item => <i key={item}>{item}</i>)}</section>
}
`)
    project.write('server/route/page.ts', `import { defineRoutes } from '@hazejs/core'
import Page from '~/app/view/Page'

export default defineRoutes((r) => {
  r.get('/api/page', ctx => ctx.view(Page, { name: '<x>' }))
})
`)
    const typecheck = await run(binOf('typescript', 'tsc'), ['--build'], project.root)
    expect(typecheck.output).toBe('')

    server = await createServer({
      root: project.root,
      logLevel: 'silent',
      server: { port: await freePort() },
    })
    await server.listen()
    const base = url(server)
    const page = await fetch(`${base}/api/page`)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(await page.text()).toBe('<section class="page" data-name="&lt;x&gt;"><i>a</i><i>b</i></section>')
    // 前端组件仍由 React 的 JSX 运行时编译
    const app = await (await fetch(`${base}/src/App.tsx`)).text()
    // 依赖预构建后的路径为 react_jsx-dev-runtime.js
    expect(app).toMatch(/react[/_]jsx-dev-runtime/)
    expect(app).not.toContain('@hazejs/core')
    await server.close()
    server = undefined

    const builder = await createBuilder({ root: project.root, logLevel: 'silent' })
    await builder.buildApp()
    server = await preview({
      root: project.root,
      logLevel: 'silent',
      preview: { port: await freePort() },
    })
    expect(await (await fetch(`${url(server)}/api/page`)).text()).toContain('<section class="page"')
    expect(await (await fetch(`${url(server)}/`, {
      headers: { accept: 'text/html' },
    })).text()).toContain('<div id="app"></div>')
  })

  it('typechecks and passes its own tests', async () => {
    project = createProject('react')
    const typecheck = await run(binOf('typescript', 'tsc'), ['--build'], project.root)
    expect(typecheck.output).toBe('')
    expect(typecheck.code).toBe(0)

    const tests = await run(binOf('vitest'), ['run'], project.root)
    // greeting 3 + users 4 + auth 5 + chat 3 + account 4
    expect(tests.output, tests.output).toContain('19 passed')
  })
})
