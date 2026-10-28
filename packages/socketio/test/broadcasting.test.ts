import type { EchoChannel, PresenceMember } from '@hazejs/core/echo'
import { broadcast, createApplication, defineChannels, defineRoutes, defineUserProvider, issueTestCredentials } from '@hazejs/core'
import { createEcho } from '@hazejs/core/echo'
import { io } from 'socket.io-client'
import { afterEach, describe, expect, it } from 'vitest'
import { socketIoProvider } from '../src'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

const channels = defineChannels((c) => {
  c.private('orders.{id}', (user: { id: number }, { id }) => user.id === Number(id))
  c.presence('room.{name}', (user: { id: number, name: string }) => ({ name: user.name }))
})

async function start() {
  const app = await createApplication({
    mode: 'test',
    env: false,
    providers: [
      socketIoProvider(),
    ],
    discovered: {
      channels: {
        '/app/channel/app.ts': { default: channels },
      },
    },
    config: {
      logger: { level: 'silent' },
      app: {
        key: 'k'.repeat(32),
      },
      socketio: { broadcasting: true },
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
    },
    routes: [
      defineRoutes((r) => {
        r.post('/ship/:id', async (ctx) => {
          await broadcast({
            channel: `private-orders.${ctx.param('id')}`,
            event: 'OrderShipped',
            data: {
              id: Number(ctx.param('id')),
            },
          })
          return 'ok'
        })
      }),
    ],
  })
  const server = app.serve({ port: 0, hostname: '127.0.0.1', silent: true })
  await server.ready()
  cleanups.push(async () => {
    await server.close(true)
    await app.dispose()
  })
  const url = server.url!.replace(/\/$/, '')
  const authorization = async (id: number) => (await issueTestCredentials(app, { id })).authorization
  return { app, url, authorization }
}

function client(url: string, headers: Record<string, string> = {}, ioOptions: Record<string, unknown> = {}) {
  const echo = createEcho({
    transport: 'socket.io',
    url,
    io: io as never,
    headers,
    reconnect: false,
    ioOptions: {
      transports: ['websocket'],
      ...ioOptions,
    },
  })
  cleanups.push(() => echo.disconnect())
  return echo
}

function subscribed(channel: EchoChannel) {
  return new Promise<void>((resolve, reject) => {
    channel.subscribed(resolve)
    channel.error(error => reject(Object.assign(new Error(error.message), error)))
  })
}

describe('broadcasting over socket.io', () => {
  it('authorizes private channels and delivers broadcasts', async () => {
    const { url, authorization } = await start()
    const ada = client(url, { authorization: await authorization(7) })
    const orders = ada.private('orders.7')
    await subscribed(orders)
    const shipped = new Promise(resolve => orders.listen('OrderShipped', resolve))
    await fetch(`${url}/ship/7`, { method: 'POST' })
    expect(await shipped).toEqual({ id: 7 })

    await expect(subscribed(ada.private('orders.8'))).rejects.toMatchObject({ status: 403 })
    await expect(subscribed(client(url).private('orders.7'))).rejects.toMatchObject({ status: 401 })
  })

  it('authorizes from the handshake (auth.token) without the auth endpoint', async () => {
    const { url, authorization } = await start()
    const token = (await authorization(7)).replace('Bearer ', '')
    const socket = io(`${url}/broadcasting`, {
      transports: ['websocket'],
      reconnection: false,
      auth: { token },
    })
    cleanups.push(() => socket.close())
    await new Promise<void>(resolve => socket.once('connect', () => resolve()))
    expect(await socket.emitWithAck('subscribe', { channel: 'private-orders.7' })).toEqual({ event: 'haze:subscribed', channel: 'private-orders.7', data: {} })
    expect(await socket.emitWithAck('subscribe', { channel: 'private-orders.8' })).toMatchObject({
      event: 'haze:subscription_error',
      data: { status: 403 },
    })
  })

  it('tracks presence and relays whispers', async () => {
    const { url, authorization } = await start()
    const ada = client(url, { authorization: await authorization(1) })
    const room = ada.join('room.lobby')
    await subscribed(room)
    const joined = new Promise<PresenceMember>(resolve => room.joining(resolve))
    const left = new Promise<PresenceMember>(resolve => room.leaving(resolve))
    const typing = new Promise(resolve => room.listenForWhisper('typing', data => resolve(data)))

    const bob = client(url, { authorization: await authorization(2) })
    const bobRoom = bob.join('room.lobby')
    const here = new Promise<PresenceMember[]>(resolve => bobRoom.here(resolve))
    await subscribed(bobRoom)
    expect(await joined).toEqual({ id: 2, name: 'user2' })
    expect((await here).map(member => member.id).sort()).toEqual([1, 2])
    bobRoom.whisper('typing', { who: 'bob' })
    expect(await typing).toEqual({ who: 'bob' })
    bob.disconnect()
    expect(await left).toEqual({ id: 2, name: 'user2' })
  })
})
