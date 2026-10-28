import type { RouteRegistrar } from '../src'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, defineRoutes, defineUserProvider, defineWebSocket, generateKey, issueTestCredentials, Socket } from '../src'

const closers: Array<() => Promise<unknown>> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

const Chat = defineWebSocket({
  open(peer, ctx) {
    peer.subscribe('chat')
    peer.send(JSON.stringify({ type: 'welcome', user: ctx.get('user') ?? null }))
  },
  message(peer, message) {
    const text = message.text()
    if (text === 'ping')
      return peer.send('pong')
    peer.publish('chat', text)
  },
})

const routes: RouteRegistrar = (r) => {
  r.ws('/ws/chat', Chat)
  r.ws('/ws/private', {
    open(peer) {
      peer.send('secret')
    },
  }).middleware('auth')
  r.post('/announce', async (ctx) => {
    Socket.publish('chat', { announcement: (await ctx.body<{ text: string }>()).text })
    return {
      connections: Socket.connections(),
    }
  })
}

async function start(config: Record<string, unknown> = {}) {
  const app = await createApplication({
    mode: 'test',
    env: false,
    config: {
      logger: { level: 'silent' },
      app: {
        key: generateKey(),
      },
      auth: {
        default: 'api',
        guards: {
          api: { driver: 'jwt', provider: 'users' },
        },
        providers: {
          users: defineUserProvider({
            retrieveById: id => ({
              id: Number(id),
            }),
            retrieveByCredentials: () => undefined,
            validateCredentials: () => false,
            getId: (user: { id: number }) => user.id,
          }),
        },
      },
      ...config,
    },
    routes: [
      defineRoutes(routes),
    ],
  })
  const server = app.serve({ port: 0, hostname: '127.0.0.1', silent: true })
  await server.ready()
  closers.push(async () => {
    await server.close(true)
    await app.dispose()
  })
  return {
    app,
    url: server.url!.replace(/\/$/, ''),
    ws: server.url!.replace(/^http/, 'ws').replace(/\/$/, ''),
  }
}

/** 打开连接并收集消息 */
function connect(url: string, headers?: Record<string, string>) {
  const messages: string[] = []
  // Node 22 的 WebSocket 不支持自定义请求头：带认证时改用 ws 模块风格的 Cookie / 查询参数之外的方式，这里只用于无头连接
  const socket = new WebSocket(url, headers
    ? { headers } as never
    : undefined)
  socket.addEventListener('message', event => messages.push(String(event.data)))
  closers.push(async () => socket.close())
  const opened = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error('WebSocket error')))
  })
  const next = async (count = messages.length + 1) => {
    for (let attempt = 0; attempt < 100 && messages.length < count; attempt++)
      await new Promise(resolve => setTimeout(resolve, 20))
    return messages[count - 1]
  }
  return { socket, messages, opened, next }
}

describe('websocket', () => {
  it('upgrades r.ws() routes, echoes, and publishes between peers', async () => {
    const { ws } = await start()
    const ada = connect(`${ws}/ws/chat`)
    const bob = connect(`${ws}/ws/chat`)
    await Promise.all([ada.opened, bob.opened])
    expect(JSON.parse(await ada.next(1))).toEqual({ type: 'welcome', user: null })
    await bob.next(1)

    ada.socket.send('ping')
    expect(await ada.next(2)).toBe('pong')
    // peer.publish 发给其它订阅者
    ada.socket.send('hello everyone')
    expect(await bob.next(2)).toBe('hello everyone')
    expect(ada.messages).toHaveLength(2)
  })

  it('broadcasts from HTTP handlers with Socket.publish', async () => {
    const { url, ws } = await start()
    const client = connect(`${ws}/ws/chat`)
    await client.opened
    await client.next(1)
    const res = await fetch(`${url}/announce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'maintenance' }),
    })
    expect((await res.json() as any).data.connections).toBeGreaterThanOrEqual(1)
    expect(JSON.parse(await client.next(2))).toEqual({ announcement: 'maintenance' })
  })

  it('runs middleware on the upgrade request: auth rejects anonymous connections', async () => {
    const { app, url, ws } = await start()
    // 普通 GET 得到 426
    expect((await fetch(`${url}/ws/chat`)).status).toBe(426)
    const anonymous = connect(`${ws}/ws/private`)
    await expect(anonymous.opened).rejects.toThrow('WebSocket error')

    const { authorization } = await issueTestCredentials(app, { id: 1 })
    const authorized = connect(`${ws}/ws/private`, { authorization })
    await authorized.opened
    expect(await authorized.next(1)).toBe('secret')
  })

  it.runIf(process.env.HAZE_TEST_REDIS_URL)('broadcasts across instances through Redis', async () => {
    const config = {
      websocket: {
        broadcast: { driver: 'redis', url: process.env.HAZE_TEST_REDIS_URL, channel: `test:${crypto.randomUUID()}` },
      },
    }
    const [first, second] = await Promise.all([
      start(config),
      start(config),
    ])
    const onFirst = connect(`${first.ws}/ws/chat`)
    const onSecond = connect(`${second.ws}/ws/chat`)
    await Promise.all([onFirst.opened, onSecond.opened])
    await Promise.all([
      onFirst.next(1),
      onSecond.next(1),
    ])
    // 等待 Redis 订阅就绪
    await new Promise(resolve => setTimeout(resolve, 300))

    // 连接在第一个实例上的 peer.publish 到达第二个实例的订阅者
    onFirst.socket.send('across instances')
    expect(await onSecond.next(2)).toBe('across instances')
    // 第二个实例的 HTTP 接口广播，第一个实例的连接收到
    await fetch(`${second.url}/announce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'from second' }),
    })
    expect(JSON.parse(await onFirst.next(2))).toEqual({ announcement: 'from second' })
  })
})
