import type { ChildProcess } from 'node:child_process'
import type { Socket } from 'socket.io-client'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { issueTestCredentials } from '@hazejs/core'
import { io } from 'socket.io-client'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error 测试用的 .mjs 应用
import { createApp } from './fixtures/app.mjs'

const fixture = fileURLToPath(new URL('./fixtures/app.mjs', import.meta.url))
const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

async function start(config = {}) {
  const app = await createApp(config)
  const server = app.serve({ port: 0, hostname: '127.0.0.1', silent: true })
  await server.ready()
  cleanups.push(async () => {
    await server.close(true)
    await app.dispose()
  })
  return {
    app,
    url: server.url!.replace(/\/$/, ''),
  }
}

function client(url: string, options: Parameters<typeof io>[1] = {}): Socket {
  const socket = io(url, { reconnection: false, ...options })
  cleanups.push(() => socket.close())
  return socket
}

function connected(socket: Socket) {
  return new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve())
    socket.once('connect_error', reject)
  })
}

/** 等待从长轮询升级到 WebSocket（可能在 connect 之后立即完成） */
async function upgraded(socket: Socket): Promise<string> {
  for (let attempt = 0; attempt < 100 && socket.io.engine.transport.name !== 'websocket'; attempt++)
    await new Promise(resolve => setTimeout(resolve, 50))
  return socket.io.engine.transport.name
}

const nextEvent = <T = unknown>(socket: Socket, event: string) => new Promise<T>(resolve => socket.once(event, resolve as never))

describe('socket.io', () => {
  it.each([
    ['polling'],
    ['websocket'],
  ])('connects over %s and supports acks', async (transport) => {
    const { url } = await start()
    const socket = client(url, {
      transports: [transport as 'polling'],
    })
    await connected(socket)
    expect(socket.io.engine.transport.name).toBe(transport)
    expect(await socket.emitWithAck('echo', 'hi')).toBe('echo:hi')
  })

  it('upgrades from polling to websocket like a default client', async () => {
    const { url } = await start()
    const socket = client(url)
    await connected(socket)
    expect(await upgraded(socket)).toBe('websocket')
  })

  it('broadcasts to rooms and pushes from HTTP handlers with SocketIO.to()', async () => {
    const { url } = await start()
    const ada = client(url, {
      transports: ['websocket'],
    })
    const bob = client(url, {
      transports: ['websocket'],
    })
    await Promise.all([
      connected(ada),
      connected(bob),
    ])
    await Promise.all([
      ada.emitWithAck('join', 'lobby'),
      bob.emitWithAck('join', 'lobby'),
    ])

    const said = nextEvent<string>(bob, 'said')
    ada.emit('say', { room: 'lobby', text: 'hello' })
    expect(await said).toBe('hello')

    const notice = nextEvent(ada, 'notice')
    const res = await fetch(`${url}/notify/lobby`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'deploy' }),
    })
    expect(await res.text()).toBe('sent')
    expect(await notice).toEqual({ text: 'deploy' })
  })

  it('authenticates handshakes with config/auth.ts guards', async () => {
    const { app, url } = await start()
    const anonymous = client(`${url}/secure`)
    await expect(connected(anonymous)).rejects.toThrow('unauthorized')

    const { authorization } = await issueTestCredentials(app, { id: 7 })
    const token = authorization.replace('Bearer ', '')
    const user = client(`${url}/secure`, {
      auth: { token },
    })
    const me = nextEvent(user, 'me')
    await connected(user)
    expect(await me).toEqual({ id: 7, name: 'user7' })
  })

  it('shares the server with HTTP routes and r.ws()', async () => {
    const { url } = await start()
    expect(await (await fetch(`${url}/hello`)).text()).toBe('hello')
    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`)
    cleanups.push(() => ws.close())
    const reply = new Promise<string>(resolve => ws.addEventListener('message', event => resolve(String(event.data))))
    await new Promise(resolve => ws.addEventListener('open', resolve))
    ws.send('ping')
    expect(await reply).toBe('ws:ping')
  })
})

/** 以子进程运行 fixtures/app.mjs */
async function spawnApp(command: string, env: Record<string, string>): Promise<string> {
  const port = await freePort()
  const child: ChildProcess = spawn(command, [fixture], {
    cwd: join(fixture, '..'),
    env: {
      ...process.env,
      ...env,
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  cleanups.push(() => new Promise((resolve) => {
    if (child.exitCode !== null)
      return resolve(null)
    child.once('exit', resolve).kill('SIGTERM')
    // 优雅退出超时则强制结束
    setTimeout(() => child.kill('SIGKILL'), 3000).unref()
  }))
  let output = ''
  await new Promise<void>((resolve, reject) => {
    child.stdout!.on('data', (chunk) => {
      output += chunk
      if (output.includes('ready'))
        resolve()
    })
    child.stderr!.on('data', chunk => (output += chunk))
    child.once('exit', () => reject(new Error(`app exited: ${output}`)))
  })
  return `http://127.0.0.1:${port}`
}

describe.runIf(process.env.HAZE_TEST_REDIS_URL)('socket.io across instances (redis-adapter)', () => {
  it('emits to a room from another instance', async () => {
    const env = { REDIS_URL: process.env.HAZE_TEST_REDIS_URL!, ADAPTER_KEY: `test-${crypto.randomUUID()}` }
    const [first, second] = await Promise.all([
      spawnApp(process.execPath, env),
      spawnApp(process.execPath, env),
    ])
    const onFirst = client(first, {
      transports: ['websocket'],
    })
    const onSecond = client(second, {
      transports: ['websocket'],
    })
    await Promise.all([
      connected(onFirst),
      connected(onSecond),
    ])
    await Promise.all([
      onFirst.emitWithAck('join', 'ops'),
      onSecond.emitWithAck('join', 'ops'),
    ])

    // 第二个实例的 HTTP 接口推送，第一个实例上的连接收到
    const notice = nextEvent(onFirst, 'notice')
    await fetch(`${second}/notify/ops`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"from":"second"}',
    })
    expect(await notice).toEqual({ from: 'second' })
    // 连接在第一个实例上的 socket.to(room) 到达第二个实例
    const said = nextEvent<string>(onSecond, 'said')
    onFirst.emit('say', { room: 'ops', text: 'across' })
    expect(await said).toBe('across')
  }, 30_000)
})

function bun(): string | undefined {
  try {
    return execFileSync('which', ['bun'], { encoding: 'utf8' }).trim() || undefined
  }
  catch {
    return undefined
  }
}

describe.runIf(bun())('socket.io on Bun (@socket.io/bun-engine)', () => {
  it('serves polling, websocket, auth and r.ws() from one Bun.serve', async () => {
    const url = await spawnApp(bun()!, {})
    for (const transport of ['polling', 'websocket'] as const) {
      const socket = client(url, {
        transports: [transport],
      })
      await connected(socket)
      expect(await socket.emitWithAck('echo', transport)).toBe(`echo:${transport}`)
    }
    const defaults = client(url)
    await connected(defaults)
    expect(await upgraded(defaults)).toBe('websocket')

    await expect(connected(client(`${url}/secure`))).rejects.toThrow('unauthorized')

    const ws = new WebSocket(`${url.replace('http', 'ws')}/ws`)
    cleanups.push(() => ws.close())
    const reply = new Promise<string>(resolve => ws.addEventListener('message', event => resolve(String(event.data))))
    await new Promise(resolve => ws.addEventListener('open', resolve))
    ws.send('bun')
    expect(await reply).toBe('ws:bun')
  }, 30_000)
})
