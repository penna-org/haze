import type { DevServer } from '@hazejs/vite'
import type { RouteRow } from '../src'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createDevServer } from '@hazejs/vite'
import { afterEach, describe, expect, it } from 'vitest'
import { filterRoutes, inspectApp } from '../src'
import { errorSummary } from '../src/views'

const testDir = dirname(fileURLToPath(import.meta.url))
let dev: DevServer | undefined
let root: string | undefined

/**
 * 复制 fixture 到 test/.tmp 下：fixture 没有 package.json，
 * 从这里解析 `@hazejs/devtools` 时会自引用本包（需要先构建 dist）
 */
async function start(options: { devtools?: boolean } = {}): Promise<DevServer> {
  root = join(testDir, '.tmp', `app-${process.pid}-${Date.now()}`)
  mkdirSync(dirname(root), { recursive: true })
  cpSync(join(testDir, 'fixtures', 'app'), root, { recursive: true })
  dev = await createDevServer({
    root,
    port: 0,
    debounce: 10,
    ...options,
  })
  return dev
}

afterEach(async () => {
  await dev?.close()
  if (root)
    rmSync(root, { recursive: true, force: true })
  dev = undefined
  root = undefined
})

describe('filterRoutes', () => {
  const routes: RouteRow[] = [
    {
      method: 'GET',
      path: '/api/users',
      name: 'users.index',
      handler: 'UserController@index',
      middleware: '',
      module: '',
      app: '',
    },
    {
      method: 'PUT',
      path: '/api/users/:id',
      name: 'users.update',
      handler: 'UserController@update',
      middleware: 'auth',
      module: '',
      app: '',
    },
    {
      method: 'GET',
      path: '/blog/posts',
      name: 'blog.posts',
      handler: 'closure',
      middleware: '',
      module: 'blog',
      app: '',
    },
  ]

  it('matches every word against any column, case-insensitively', () => {
    expect(filterRoutes(routes, '')).toHaveLength(3)
    expect(filterRoutes(routes, 'users').map(route => route.name)).toEqual(['users.index', 'users.update'])
    expect(filterRoutes(routes, 'AUTH put').map(route => route.name)).toEqual(['users.update'])
    expect(filterRoutes(routes, 'blog get').map(route => route.name)).toEqual(['blog.posts'])
    expect(filterRoutes(routes, 'delete')).toEqual([])
  })
})

describe('errorSummary', () => {
  it('strips terminal colors and collapses the message to one short line', () => {
    const error = new Error('\u001B[31m[PARSE_ERROR]\u001B[0m Unexpected token\n  at route/api.ts:8')
    expect(errorSummary(error)).toBe('[PARSE_ERROR] Unexpected token at route/api.ts:8')
    expect(errorSummary('x'.repeat(200), 10)).toBe(`${'x'.repeat(10)}…`)
  })
})

describe('devtools on the dev server', () => {
  it('serves the hub next to the app and inspects modules and routes', async () => {
    const dev = await start()
    expect(dev.devtools).toBe(new URL('/__devtools/', dev.url).href)

    const meta = await fetch(new URL('/__devtools/__connection.json', dev.url))
    expect(meta.status).toBe(200)
    expect(await meta.json()).toMatchObject({ backend: 'websocket' })

    const page = await fetch(dev.devtools!)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')

    // 其它路径仍由应用处理
    const hello = await fetch(new URL('/hello', dev.url))
    expect(((await hello.json()) as { data: unknown }).data).toEqual({ message: 'hello' })

    const snapshot = inspectApp(dev.app!)
    expect(snapshot.app).toMatchObject({ name: 'devtools-fixture', mode: 'development' })
    expect(snapshot.modules).toEqual([
      expect.objectContaining({
        name: 'blog',
        source: 'local',
        prefix: '/blog',
        routes: 2,
      }),
    ])
    expect(snapshot.routes.map(route => `${route.method} ${route.path}`)).toEqual(expect.arrayContaining([
      'GET /hello',
      'POST /users',
      'GET /blog/posts',
      'GET /blog/posts/:id',
    ]))
    expect(snapshot.routes.find(route => route.path === '/blog/posts')?.module).toBe('blog')
    expect(snapshot.dashboard).toEqual({ path: '/__haze' })
  })

  it('serves the panels SPA and an MCP endpoint for coding agents', async () => {
    const dev = await start()

    const spa = await fetch(new URL('/__devtools/hazejs/', dev.url))
    expect(spa.status).toBe(200)
    expect(await spa.text()).toContain('<div id="app">')

    const mcp = (body: unknown, origin?: string): Promise<Response> => fetch(new URL('/__devtools/__mcp', dev.url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'accept': 'application/json, text/event-stream',
        ...(origin && { origin }),
      },
      body: JSON.stringify(body),
    })
    const data = async (response: Response): Promise<any> => JSON.parse((await response.text()).split('data: ')[1]!)

    // 只接受带本机 Origin 的请求（DNS rebinding 防护）
    expect((await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).status).toBe(403)
    // dev.url 可能是 [::] / 0.0.0.0，Origin 要写成本机地址
    const origin = `http://localhost:${new URL(dev.url!).port}`
    const tools = await data(await mcp({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, origin))
    const names = tools.result.tools.map((tool: { name: string }) => tool.name)
    expect(names).toEqual(expect.arrayContaining([
      'hazejs_snapshot',
      'hazejs_routes',
      'hazejs_graph',
      'hazejs_requests',
      'hazejs_request',
      'hazejs_ai',
      'hazejs_openapi',
      'hazejs_run-schedule',
    ]))
    const routes = tools.result.tools.find((tool: { name: string }) => tool.name === 'hazejs_routes')
    expect(routes.inputSchema.properties.arg0.properties.query.type).toBe('string')

    await fetch(new URL('/hello', dev.url))
    const call = async (name: string, arg0?: unknown): Promise<any> => {
      const result = (await data(await mcp({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name,
          arguments: arg0 === undefined
            ? {}
            : { arg0 },
        },
      }, origin))).result
      expect(result.isError).toBeFalsy()
      return JSON.parse(result.content[0].text)
    }
    const snapshot = await call('hazejs_snapshot')
    expect(snapshot.modules.map((module: { name: string }) => module.name)).toEqual(['blog'])
    expect((await call('hazejs_routes', { query: 'blog show' })).map((route: { path: string }) => route.path)).toEqual(['/blog/posts/:id'])
    const requests = await call('hazejs_requests', { limit: 10 })
    expect(requests[0]).toMatchObject({ method: 'GET', path: '/hello', status: 200 })
    const detail = await call('hazejs_request', { requestId: requests[0].requestId })
    expect(detail.request.content.path).toBe('/hello')
  })

  it('can be turned off', async () => {
    const dev = await start({ devtools: false })
    expect(dev.devtools).toBeUndefined()
    expect((await fetch(new URL('/__devtools/__connection.json', dev.url))).status).toBe(404)
  })
})
