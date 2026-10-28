import type { Application } from '../src'
import type { EchoChannel, EchoOptions, PresenceMember } from '../src/broadcast/echo'
import process from 'node:process'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, defineEvent, defineRoutes, defineUserProvider, Events, generateKey, issueTestCredentials } from '../src'
import { Broadcast, broadcast, setBroadcastManager } from '../src/broadcast/broadcast'
import { redisBus } from '../src/broadcast/bus'
import { ChannelRegistry, defineChannels, parseChannel, presenceChannel, privateChannel } from '../src/broadcast/channels'
import { createEcho } from '../src/broadcast/echo'
import { localHub } from '../src/broadcast/hub'
import { BroadcastManager } from '../src/broadcast/manager'

const closers: Array<() => unknown> = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse())
    await close()
})

const OrderShipped = defineEvent<{ orderId: number, secret?: string }>({
  broadcastOn: ({ orderId }) => privateChannel(`orders.${orderId}`),
  broadcastWith: ({ orderId }) => ({ orderId }),
})

const Quiet = defineEvent<{ orderId: number }>({
  name: 'Quiet',
  broadcastOn: ({ orderId }) => privateChannel(`orders.${orderId}`),
  broadcastAs: 'order.quiet',
  broadcastWhen: ({ orderId }) => orderId > 10,
})

const channels = defineChannels((c) => {
  c.private('orders.{id}', (user: { id: number }, { id }) => user.id === Number(id))
  c.presence('chat.{room}', (user: { id: number, name: string }, { room }) => room !== 'closed' && { name: user.name })
  c.private('broken', () => {
    throw new Error('boom')
  })
})

/** 与 application.ts 中的接线相同（application.ts 已接线时跳过） */
function wire(app: Application): void {
  if (app.container.has(BroadcastManager))
    return
  const manager = new BroadcastManager(app)
  app.container.instance(BroadcastManager, manager)
  setBroadcastManager(manager, BroadcastManager)
  app.router.load(manager.routes())
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
              name: `user${id}`,
            }),
            retrieveByCredentials: () => undefined,
            validateCredentials: () => false,
            getId: (user: { id: number }) => user.id,
          }),
        },
      },
      ...config,
    },
    events: {
      '/app/event/OrderShipped.ts': { default: OrderShipped },
      '/app/event/Quiet.ts': { default: Quiet },
    },
    discovered: {
      channels: {
        '/app/channel/app.ts': { default: channels },
      },
    },
    routes: [
      defineRoutes((r) => {
        r.post('/announce', async (ctx) => {
          const { channel, data, toOthers } = await ctx.body<{ channel: string, data: unknown, toOthers?: boolean }>()
          await broadcast({
            channel,
            event: 'Announcement',
            data,
            toOthers,
          })
          return 'ok'
        })
        r.post('/ship/:id', async (ctx) => {
          await Events.emit(OrderShipped, {
            orderId: Number(ctx.param('id')),
            secret: 'hidden',
          })
          return 'ok'
        })
      }),
    ],
    setup: wire,
  })
  const server = app.serve({ port: 0, hostname: '127.0.0.1', silent: true })
  await server.ready()
  closers.push(async () => {
    await server.close(true)
    await app.dispose()
  })
  const url = server.url!.replace(/\/$/, '')
  const token = async (id: number) => (await issueTestCredentials(app, { id })).authorization
  return { app, url, token }
}

function echo(url: string, options: EchoOptions = {}) {
  const client = createEcho({ url, reconnect: false, ...options })
  closers.push(() => client.disconnect())
  return client
}

function subscribed(channel: EchoChannel) {
  return new Promise<void>((resolve, reject) => {
    channel.subscribed(resolve)
    channel.error(error => reject(Object.assign(new Error(error.message), error)))
  })
}
const next = <T = any>(channel: EchoChannel, event: string) => new Promise<T>(resolve => channel.listen(event, resolve))
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function waitFor(check: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline)
      throw new Error('Timed out')
    await sleep(10)
  }
}

describe('channels', () => {
  it('parses channel names and matches patterns with params', () => {
    expect(parseChannel('news')).toEqual({ type: 'public', name: 'news' })
    expect(parseChannel(privateChannel('orders.1'))).toEqual({ type: 'private', name: 'orders.1' })
    expect(parseChannel(presenceChannel('chat.lobby'))).toEqual({ type: 'presence', name: 'chat.lobby' })
    const registry = new ChannelRegistry().register(channels)
    expect(registry.match('private', 'orders.42')?.params).toEqual({ id: '42' })
    expect(registry.match('private', 'orders.42.items')).toBeUndefined()
    expect(registry.match('presence', 'chat.lobby')?.params).toEqual({ room: 'lobby' })
    expect(registry.match('presence', 'orders.1')).toBeUndefined()
    expect(() => new ChannelRegistry().register({})).toThrow('defineChannels')
  })
})

describe('broadcast auth endpoint', () => {
  it('signs allowed private / presence subscriptions and rejects the rest', async () => {
    const { url, token } = await start()
    const auth = async (channel: string, authorization?: string, socketId = 'socket-1') => fetch(`${url}/broadcasting/auth`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(authorization && { authorization }),
      },
      body: JSON.stringify({ socket_id: socketId, channel_name: channel }),
    })
    const ada = await token(7)

    const allowed = await auth('private-orders.7', ada)
    expect(allowed.status).toBe(200)
    expect(await allowed.json()).toEqual({
      auth: expect.any(String),
    })
    expect((await auth('private-orders.8', ada)).status).toBe(403)
    expect((await auth('private-orders.7')).status).toBe(401)
    expect((await auth('private-unknown', ada)).status).toBe(403)
    expect((await auth('private-broken', ada)).status).toBe(403)
    expect((await auth('presence-chat.closed', ada)).status).toBe(403)
    expect((await auth('private-orders.7', ada, 'bad socket id')).status).toBe(400)
    expect((await auth('bad channel!', ada)).status).toBe(400)

    // 在线频道返回成员信息（id 缺省为 Guard 的用户 ID），签名覆盖 channel_data
    const presence = await (await auth('presence-chat.lobby', ada)).json() as { auth: string, channel_data: string }
    expect(JSON.parse(presence.channel_data)).toEqual({ name: 'user7', id: 7 })
    // 公共频道也可签名（无需登录）
    expect((await auth('news')).status).toBe(200)
  })

  it('does not register the endpoints when broadcasting is not used', async () => {
    const app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        logger: { level: 'silent' },
      },
      setup: wire,
    })
    closers.push(() => app.dispose())
    expect(app.router.list().some(route => route.path.startsWith('/broadcasting'))).toBe(false)
    expect((await app.request('/broadcasting/auth', { method: 'POST' })).status).toBe(404)
  })
})

describe.each([
  ['ws'],
  ['sse'],
] as const)('broadcasting over %s', (transport) => {
  it('delivers public broadcasts and events with broadcastOn', async () => {
    const { url, token } = await start()
    const authorization = await token(7)
    const client = echo(url, {
      transport,
      headers: { authorization },
    })
    const news = client.channel('news')
    const orders = client.private('orders.7')
    await Promise.all([
      subscribed(news),
      subscribed(orders),
    ])

    const announcement = next(news, 'Announcement')
    await fetch(`${url}/announce`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: 'news',
        data: { text: 'hello' },
      }),
    })
    expect(await announcement).toEqual({ text: 'hello' })

    // defineEvent 的 broadcastOn：Events.emit 时同时广播，broadcastWith 过滤数据
    const shipped = next(orders, '.OrderShipped')
    await fetch(`${url}/ship/7`, { method: 'POST' })
    expect(await shipped).toEqual({ orderId: 7 })
    expect(client.socketId()).toEqual(expect.any(String))
  })

  it('rejects private channels the user may not join', async () => {
    const { url, token } = await start()
    const client = echo(url, {
      transport,
      headers: { authorization: await token(7) },
    })
    await expect(subscribed(client.private('orders.8'))).rejects.toMatchObject({ status: 403 })
    const anonymous = echo(url, { transport })
    await expect(subscribed(anonymous.private('orders.7'))).rejects.toMatchObject({ status: 401 })
  })

  it('tracks presence members (here / joining / leaving)', async () => {
    const { url, token } = await start()
    const ada = echo(url, {
      transport,
      headers: { authorization: await token(1) },
    })
    const room = ada.join('chat.lobby')
    const here = new Promise<PresenceMember[]>(resolve => room.here(resolve))
    await subscribed(room)
    expect(await here).toEqual([
      { id: 1, name: 'user1' },
    ])

    const joined = new Promise<PresenceMember>(resolve => room.joining(resolve))
    const bob = echo(url, {
      transport,
      headers: { authorization: await token(2) },
    })
    const bobRoom = bob.presence('chat.lobby')
    const bobHere = new Promise<PresenceMember[]>(resolve => bobRoom.here(resolve))
    await subscribed(bobRoom)
    expect(await joined).toEqual({ id: 2, name: 'user2' })
    expect((await bobHere).map(member => member.id).sort()).toEqual([1, 2])
    expect(await Broadcast.members('presence-chat.lobby')).toHaveLength(2)

    // 同一用户的第二个连接不触发 joining，离开时也不触发 leaving
    const bobAgain = echo(url, {
      transport,
      headers: { authorization: await token(2) },
    })
    await subscribed(bobAgain.join('chat.lobby'))
    bobAgain.disconnect()

    const left = new Promise<PresenceMember>(resolve => room.leaving(resolve))
    bob.leave('chat.lobby')
    if (transport === 'sse')
      bob.disconnect()
    expect(await left).toEqual({ id: 2, name: 'user2' })
    await waitFor(() => room.members.length === 1)
  })
})

describe('broadcasting over ws only', () => {
  it('whispers to other members and skips the sender with toOthers', async () => {
    const { url, token } = await start()
    const ada = echo(url, {
      headers: { authorization: await token(1) },
    })
    const bob = echo(url, {
      headers: { authorization: await token(2) },
    })
    const adaRoom = ada.join('chat.lobby')
    const bobRoom = bob.join('chat.lobby')
    await Promise.all([
      subscribed(adaRoom),
      subscribed(bobRoom),
    ])

    const typing = new Promise(resolve => bobRoom.listenForWhisper('typing', resolve))
    const echoed: unknown[] = []
    adaRoom.listenForWhisper('typing', data => echoed.push(data))
    adaRoom.whisper('typing', { name: 'ada' })
    expect(await typing).toEqual({ name: 'ada' })

    // toOthers：请求头 X-Socket-ID 对应的连接收不到
    const adaNews = ada.channel('news')
    const bobNews = bob.channel('news')
    await Promise.all([
      subscribed(adaNews),
      subscribed(bobNews),
    ])
    const received: string[] = []
    adaNews.listen('Announcement', () => received.push('ada'))
    const toBob = next(bobNews, 'Announcement')
    await fetch(`${url}/announce`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-socket-id': ada.socketId()!,
      },
      body: JSON.stringify({ channel: 'news', data: 1, toOthers: true }),
    })
    await toBob
    await sleep(50)
    expect(received).toEqual([])
    expect(echoed).toEqual([])
  })

  it('authorizes directly from the upgrade request when no signature is sent', async () => {
    const { url, token } = await start()
    const socket = new WebSocket(`${url.replace('http', 'ws')}/broadcasting/ws`, {
      headers: { authorization: await token(7) },
    } as never)
    closers.push(() => socket.close())
    const messages: any[] = []
    socket.addEventListener('message', event => messages.push(JSON.parse(String(event.data))))
    await waitFor(() => messages.length === 1)
    expect(messages[0]).toEqual({
      event: 'haze:connected',
      data: {
        socket_id: expect.any(String),
      },
    })
    socket.send(JSON.stringify({ event: 'subscribe', channel: 'private-orders.7' }))
    socket.send(JSON.stringify({ event: 'subscribe', channel: 'private-orders.8' }))
    // 伪造的签名被拒绝
    socket.send(JSON.stringify({ event: 'subscribe', channel: 'private-orders.9', auth: 'forged' }))
    socket.send(JSON.stringify({ event: 'ping' }))
    await waitFor(() => messages.length === 5)
    expect(messages.slice(1)).toEqual(expect.arrayContaining([
      { event: 'haze:subscribed', channel: 'private-orders.7', data: {} },
      {
        event: 'haze:subscription_error',
        channel: 'private-orders.8',
        data: { status: 403, message: 'Forbidden' },
      },
      {
        event: 'haze:subscription_error',
        channel: 'private-orders.9',
        data: { status: 403, message: 'Invalid signature' },
      },
      { event: 'haze:pong' },
    ]))
  })

  it('reconnects SSE with the new channel list and closes the old stream', async () => {
    const { url } = await start()
    const before = localHub.count('sse')
    const client = echo(url, { transport: 'sse' })
    const news = client.channel('news')
    await subscribed(news)
    const updates = client.channel('updates')
    await subscribed(updates)
    await waitFor(() => localHub.count('sse') === before + 1)
    const received = Promise.all([
      next(news, 'Announcement'),
      next(updates, 'Announcement'),
    ])
    for (const channel of ['news', 'updates']) {
      await fetch(`${url}/announce`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel, data: channel }),
      })
    }
    expect(await received).toEqual(['news', 'updates'])
    expect(() => news.whisper('typing', {})).toThrow('not supported')
    client.leave('news')
    client.leave('updates')
    await waitFor(() => localHub.count('sse') === before)
  })

  it('keeps SSE responses streaming and cleans up on disconnect', async () => {
    const { url } = await start()
    const before = localHub.count('sse')
    const controller = new AbortController()
    const response = await fetch(`${url}/broadcasting/sse?channels=news`, { signal: controller.signal })
    expect(response.headers.get('content-type')).toContain('text/event-stream')
    const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader()
    let text = ''
    while (!text.includes('haze:subscribed'))
      text += (await reader.read()).value
    expect(localHub.count('sse')).toBe(before + 1)
    controller.abort()
    await waitFor(() => localHub.count('sse') === before)
  })
})

describe('broadcast.fake()', () => {
  it('records broadcasts and event broadcasts without delivering', async () => {
    const { app } = await start()
    const fake = app.make(BroadcastManager).fake()
    await app.request('/ship/3', { method: 'POST' })
    fake.assertBroadcast(OrderShipped, item => item.event === 'OrderShipped')
    fake.assertBroadcastOn('private-orders.3', 'OrderShipped', item => (item.data as { orderId: number }).orderId === 3)
    // broadcastWhen 为 false 时不广播；broadcastAs 改变事件名
    await Events.emit(Quiet, { orderId: 1 })
    fake.assertNotBroadcast(Quiet)
    await Broadcast.event(Quiet, { orderId: 11 })
    fake.assertBroadcastOn('private-orders.11', 'order.quiet')
    await broadcast({
      channel: ['a', 'b'],
      event: 'Multi',
    })
    fake.assertBroadcastTimes('Multi', 1)
    expect(() => fake.assertNothingBroadcast()).toThrow()

    // Events.fake() 时不广播
    app.make(BroadcastManager).restore()
    const broadcasts = app.make(BroadcastManager).fake()
    Events.fake()
    await Events.emit(OrderShipped, { orderId: 4 })
    broadcasts.assertNothingBroadcast()
    Events.restore()
    await expect(broadcast({ channel: 'bad channel!', event: 'x' })).rejects.toThrow('Invalid broadcast channel')
  })
})

describe.runIf(process.env.HAZE_TEST_REDIS_URL)('broadcasting through Redis', () => {
  it('delivers through Redis pub/sub and shares presence members', async () => {
    const prefix = `test:${crypto.randomUUID()}`
    const bus = redisBus({ url: process.env.HAZE_TEST_REDIS_URL, prefix })
    const received: unknown[] = []
    localHub.add({
      id: 'redis-peer',
      transport: 'test',
      send: envelope => received.push(envelope),
    })
    localHub.join('redis-peer', 'news')
    closers.push(() => localHub.remove('redis-peer'))
    // 首次使用时建立订阅
    await bus.presence.members('presence-room')
    await sleep(200)

    // 模拟另一个实例：直接用 ioredis 发布到同一频道
    const { Redis } = await import('ioredis')
    const other = new Redis(process.env.HAZE_TEST_REDIS_URL!)
    closers.push(() => other.quit())
    await other.publish(prefix, JSON.stringify({
      id: crypto.randomUUID(),
      channels: ['news'],
      event: 'FromOther',
      data: 1,
    }))
    await waitFor(() => received.length === 1)
    expect(received[0]).toEqual({ event: 'FromOther', channel: 'news', data: 1 })

    // 本实例的广播经 Redis 回到本进程
    await bus.publish({
      id: crypto.randomUUID(),
      channels: ['news'],
      event: 'FromSelf',
    })
    await waitFor(() => received.length === 2)

    // 在线成员存在 Redis Hash 中：两个实例看到同一份成员
    const second = redisBus({ url: process.env.HAZE_TEST_REDIS_URL, prefix })
    expect((await bus.presence.join('presence-room', 's1', { id: 1 })).first).toBe(true)
    expect((await second.presence.join('presence-room', 's2', { id: 1 })).first).toBe(false)
    expect(await second.presence.join('presence-room', 's3', { id: 2 })).toEqual({
      first: true,
      members: [
        { id: 1 },
        { id: 2 },
      ],
    })
    expect((await bus.presence.leave('presence-room', 's1')).last).toBe(false)
    expect(await second.presence.leave('presence-room', 's2')).toEqual({
      last: true,
      member: { id: 1 },
    })
    expect(await bus.presence.members('presence-room')).toEqual([
      { id: 2 },
    ])
    await second.presence.leave('presence-room', 's3')
  })

  it('reuses config/websocket.ts broadcast for the bus', async () => {
    const { app } = await start({
      websocket: {
        broadcast: { driver: 'redis', url: process.env.HAZE_TEST_REDIS_URL, channel: `test:${crypto.randomUUID()}` },
      },
    })
    expect(app.make(BroadcastManager).bus().driver).toBe('redis')
  })
})
