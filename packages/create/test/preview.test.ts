import type { PreviewServer } from 'vite'
import { execFileSync } from 'node:child_process'
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { previewServer } from '@hazejs/vite'
import { afterEach, describe, expect, it } from 'vitest'
import { binOf, createProject, csrfHeaders, freePort, run, socketIoFirst, wsExchange } from './utils'

let project: ReturnType<typeof createProject> | undefined
let server: PreviewServer | undefined

afterEach(async () => {
  await server?.close()
  server = undefined
  project?.cleanup()
  project = undefined
})

async function buildAndPreview(template: 'vue' | 'api', preset: string, prepare?: (project: ReturnType<typeof createProject>) => void) {
  project = createProject(template)
  prepare?.(project)
  const build = await run(binOf('@hazejs/cli', 'haze'), [
    'build',
    '--preset',
    preset,
    '--root',
    project.root,
  ], project.root, {})
  expect(build.code, build.output).toBe(0)
  server = await previewServer({ root: project.root, port: await freePort() })
  return {
    root: project.root,
    url: server.resolvedUrls!.local[0].replace(/\/$/, ''),
  }
}

const html = {
  headers: { accept: 'text/html' },
}

describe('vite preview runs the build output of every preset', () => {
  const presets = [
    'node',
    ...(hasBun()
      ? ['bun']
      : []),
    'docker',
    'deno',
    'aws-lambda',
    'vercel',
    'netlify',
    'cloudflare',
  ]
  it.each(presets)('%s', async (preset) => {
    const { root, url } = await buildAndPreview('vue', preset)

    const hello = await fetch(`${url}/api/hello`)
    expect(hello.status).toBe(200)
    expect((await hello.json() as any).data).toMatchObject({ message: 'Hello, hazejs!' })

    // 前端路由回退到 index.html，静态资源可访问
    const page = await fetch(`${url}/users/1`, html)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('<div id="app"></div>')
    const clientDir = preset === 'vercel'
      ? join(root, '.vercel/output/static')
      : preset === 'aws-lambda'
        ? join(root, 'dist/lambda/client')
        : join(root, 'dist/client')
    const script = readdirSync(join(clientDir, 'assets')).find(file => file.endsWith('.js'))!
    const asset = await fetch(`${url}/assets/${script}`)
    expect([
      asset.status,
      asset.headers.get('content-type'),
    ]).toEqual([
      200,
      expect.stringContaining('javascript'),
    ])

    // 请求体、Cookie 与状态码原样经过产物（全栈模板启用了 csrf）
    expect((await fetch(`${url}/api/users`, { method: 'POST' })).status).toBe(419)
    const invalid = await fetch(`${url}/api/users`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...await csrfHeaders(path => fetch(`${url}${path}`)),
      },
      body: JSON.stringify({ name: '' }),
    })
    expect(invalid.status).toBe(422)

    // WebSocket：进程型预设经预览服务器转发到产物进程
    if (['node', 'bun', 'docker', 'deno'].includes(preset))
      expect(await wsExchange(`${url.replace(/^http/, 'ws')}/api/ws`, 'ping', 2)).toEqual(['{"type":"connected"}', '{"type":"pong"}'])
    // Socket.IO：node / bun / docker 的产物（Deno 不支持 socket.io 服务端）
    if (['node', 'bun', 'docker'].includes(preset)) {
      expect(await socketIoFirst(`${url}/chat`, 'online')).toBe(1)
      expect(await socketIoFirst(`${url}/chat`, 'online', {
        transports: ['websocket'],
      })).toBe(1)
    }
  })

  it('cloudflare + D1: migrations are applied to the local preview database', async () => {
    const { url } = await buildAndPreview('vue', 'cloudflare', (project) => {
      project.edit('server/config/database.ts', `driver: 'sqlite',
      url: env('DATABASE_URL', 'file:./data/app.db'),`, `driver: 'd1',
      binding: 'DB',`)
      writeFileSync(join(project.root, 'haze.config.ts'), `export default {
  srcDir: 'server',
  cloudflare: { wrangler: { d1_databases: [{ binding: 'DB', database_name: 'demo', database_id: 'local' }] } },
}
`)
    })
    const created = await fetch(`${url}/api/users`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...await csrfHeaders(path => fetch(`${url}${path}`)),
      },
      body: JSON.stringify({ name: 'Ada', email: 'ada@example.com' }),
    })
    expect(created.status).toBe(201)

    // 再次预览：数据保留在 .haze/preview，迁移不会重复执行
    await server!.close()
    server = await previewServer({ root: project!.root, port: await freePort() })
    const again = server.resolvedUrls!.local[0].replace(/\/$/, '')
    expect((await (await fetch(`${again}/api/users`)).json() as any).data.total).toBe(1)
  })

  it('api template: haze preview serves a backend-only build', async () => {
    const { url } = await buildAndPreview('api', 'node')
    expect((await (await fetch(`${url}/api/hello`)).json() as any).data).toMatchObject({ app: 'demo-api' })
    expect((await fetch(`${url}/missing`)).status).toBe(404)
  })

  it('fails clearly when there is no build', async () => {
    project = createProject('api')
    await expect(previewServer({ root: project.root, port: await freePort() })).rejects.toThrow('No build found')
  })
})

function hasBun(): boolean {
  try {
    execFileSync('bun', ['--version'])
    return true
  }
  catch {
    return false
  }
}
