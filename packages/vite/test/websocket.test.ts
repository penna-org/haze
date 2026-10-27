import type { ChildProcess } from 'node:child_process'
import type { DevServer } from '../src'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'
import { Miniflare } from 'miniflare'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer, createDevServer } from '../src'
import { copyFixture, nextReload, settle } from './utils'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

/** 回显 + 广播的 WebSocket 路由，前缀由 reply 决定（用于验证热替换） */
function chatRoute(reply: string): string {
  return `
import { defineRoutes, Socket } from '@think-h3/core'
export default defineRoutes((r) => {
  r.ws('/ws', {
    open(peer) {
      peer.subscribe('room')
    },
    message(peer, message) {
      peer.send('${reply}:' + message.text())
    },
  })
  r.get('/broadcast', () => {
    Socket.publish('room', 'broadcast')
    return 'sent'
  })
})
`
}

function fixtureWithChat() {
  const fixture = copyFixture('basic')
  cleanups.push(() => fixture.cleanup())
  fixture.write('route/ws.ts', chatRoute('v1'))
  return fixture
}

/** 连接并发送一条消息，返回收到的前 count 条 */
async function exchange(url: string, send?: string, count = 1, during?: () => Promise<unknown>): Promise<string[]> {
  const socket = new WebSocket(url)
  const messages: string[] = []
  socket.addEventListener('message', event => messages.push(String(event.data)))
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error(`WebSocket ${url} failed`)))
  })
  if (send !== undefined)
    socket.send(send)
  await during?.()
  for (let attempt = 0; attempt < 100 && messages.length < count; attempt++)
    await new Promise(resolve => setTimeout(resolve, 30))
  socket.close()
  return messages
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

describe('websocket across environments', () => {
  it('think-h3 dev: upgrades r.ws() routes and new connections pick up hot reloads', async () => {
    const fixture = fixtureWithChat()
    const dev: DevServer = await createDevServer({ root: fixture.root, port: 0, debounce: 10 })
    cleanups.push(() => dev.close())
    await settle()
    const ws = dev.url!.replace(/^http/, 'ws').replace(/\/$/, '')
    expect(await exchange(`${ws}/ws`, 'hi')).toEqual(['v1:hi'])

    const reloaded = nextReload(dev)
    fixture.write('route/ws.ts', chatRoute('v2'))
    expect((await reloaded).ok).toBe(true)
    expect(await exchange(`${ws}/ws`, 'hi')).toEqual(['v2:hi'])
    // Socket.publish（应用代码中的 core 实例）到达开发服务器上的连接
    expect(await exchange(`${ws}/ws`, undefined, 1, () => fetch(`${dev.url}broadcast`))).toEqual(['broadcast'])
  })

  it('node build: the production server handles WebSocket upgrades', async () => {
    const fixture = fixtureWithChat()
    const result = await buildServer({ root: fixture.root, preset: 'node' })
    const port = await freePort()
    const child: ChildProcess = spawn(process.execPath, [result.entry], {
      cwd: fixture.root,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'production',
      },
      stdio: 'ignore',
    })
    cleanups.push(() => new Promise(resolve => child.once('exit', resolve).kill('SIGTERM')))
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await fetch(`http://127.0.0.1:${port}/hello`).then(() => true, () => false))
        break
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    expect(await exchange(`ws://127.0.0.1:${port}/ws`, 'prod')).toEqual(['v1:prod'])
    expect(await exchange(`ws://127.0.0.1:${port}/ws`, undefined, 1, () => fetch(`http://127.0.0.1:${port}/broadcast`))).toEqual(['broadcast'])
  })

  it('cloudflare: connections live in a Durable Object, Socket.publish reaches them over RPC', async () => {
    const fixture = fixtureWithChat()
    await buildServer({ root: fixture.root, preset: 'cloudflare' })
    const dist = join(fixture.root, 'dist')
    const wrangler = JSON.parse(readFileSync(join(dist, 'wrangler.json'), 'utf8'))
    expect(wrangler.durable_objects).toEqual({
      bindings: [
        { name: 'THINK_WEBSOCKET', class_name: 'ThinkWebSocket' },
      ],
    })
    expect(wrangler.migrations).toEqual([
      {
        tag: 'think-websocket-v1',
        new_sqlite_classes: ['ThinkWebSocket'],
      },
    ])

    const mf = new Miniflare({
      modules: true,
      scriptPath: join(dist, 'index.mjs'),
      compatibilityDate: wrangler.compatibility_date,
      compatibilityFlags: wrangler.compatibility_flags,
      bindings: {
        APP_KEY: 'k'.repeat(32),
      },
      durableObjects: { THINK_WEBSOCKET: 'ThinkWebSocket' },
    })
    cleanups.push(() => mf.dispose())
    const open = async () => {
      const res = await mf.dispatchFetch('http://localhost/ws', {
        headers: { upgrade: 'websocket' },
      })
      const socket = res.webSocket!
      const messages: string[] = []
      socket.addEventListener('message', event => messages.push(String(event.data)))
      socket.accept()
      return { socket, messages }
    }
    const waitFor = async (messages: string[], count: number) => {
      for (let attempt = 0; attempt < 100 && messages.length < count; attempt++)
        await new Promise(resolve => setTimeout(resolve, 30))
      return messages
    }
    const first = await open()
    const second = await open()
    first.socket.send('edge')
    expect(await waitFor(first.messages, 1)).toEqual(['v1:edge'])
    // Worker 中的 HTTP 接口广播：经 RPC 进入 DO，发给所有订阅者
    expect(await (await mf.dispatchFetch('http://localhost/broadcast')).text()).toBe('sent')
    expect(await waitFor(second.messages, 1)).toEqual(['broadcast'])
    expect(first.messages).toContain('broadcast')
    first.socket.close()
    second.socket.close()
  })
})
