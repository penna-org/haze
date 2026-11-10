import process from 'node:process'
import { BroadcastManager, createApplication, defineUserProvider, issueTestCredentials } from '@hazejs/core'
import { io } from 'socket.io-client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authenticate, defineNamespace, socketIoProvider } from '../src'

const cleanups: Array<() => unknown> = []
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
})

async function start(config: Record<string, unknown> = {}) {
  const app = await createApplication({
    mode: 'test',
    env: false,
    providers: [
      socketIoProvider(),
    ],
    discovered: {
      sockets: {
        '/app/socket/secure.ts': {
          default: defineNamespace({
            middleware: [
              authenticate(),
            ],
            connection: socket => void socket.emit('me', socket.data.user),
          }),
        },
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
            }),
            retrieveByCredentials: () => undefined,
            validateCredentials: () => false,
            getId: (user: { id: number }) => user.id,
          }),
        },
      },
      ...config,
    },
  })
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

function connect(url: string, options: Record<string, unknown> = {}) {
  const socket = io(url, {
    transports: ['websocket'],
    reconnection: false,
    ...options,
  })
  cleanups.push(() => socket.close())
  return socket
}

describe('socket.io hardening', () => {
  it('answers failing broadcasting listeners with an error instead of an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (error: unknown): void => void unhandled.push(error)
    process.on('unhandledRejection', onUnhandled)
    cleanups.push(() => process.off('unhandledRejection', onUnhandled))
    const { app, url } = await start()
    const errors: unknown[][] = []
    vi.spyOn(app.logger, 'error').mockImplementation((...args: unknown[]) => void errors.push(args))
    const boom = async (): Promise<never> => {
      throw new Error('redis is down')
    }
    vi.spyOn(app.make(BroadcastManager), 'connect').mockReturnValue({
      subscribe: boom,
      unsubscribe: boom,
      whisper: boom,
      close: async () => {},
    } as never)

    const socket = connect(`${url}/broadcasting`)
    await new Promise<void>(resolve => socket.once('connect', () => resolve()))
    const failure = {
      event: 'haze:subscription_error',
      channel: 'orders',
      data: { status: 500, message: 'Internal server error' },
    }
    expect(await socket.emitWithAck('subscribe', { channel: 'orders' })).toEqual(failure)
    expect(await socket.emitWithAck('unsubscribe', { channel: 'orders' })).toEqual(failure)
    expect(await socket.emitWithAck('whisper', { channel: 'orders', name: 'typing' })).toEqual(failure)
    // 不带 ack 的调用同样不会抛到事件循环
    const pushed = new Promise(resolve => socket.once('broadcast', resolve))
    socket.emit('subscribe', { channel: 'orders' })
    socket.emit('whisper', { channel: 'orders', name: 'typing' })
    expect(await pushed).toEqual(failure)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(unhandled).toEqual([])
    expect(errors.map(args => args[0])).toEqual(expect.arrayContaining([
      'socket.io broadcasting subscribe failed',
      'socket.io broadcasting unsubscribe failed',
      'socket.io broadcasting whisper failed',
    ]))
  })

  it('disposes the handshake context created by authenticate()', async () => {
    const { app, url } = await start()
    const disposed: boolean[] = []
    const contextFor = app.contextFor.bind(app)
    vi.spyOn(app, 'contextFor').mockImplementation((...args) => {
      const ctx = contextFor(...args)
      const index = disposed.push(false) - 1
      const dispose = ctx.container.dispose.bind(ctx.container)
      ctx.container.dispose = async () => {
        disposed[index] = true
        await dispose()
      }
      return ctx
    })
    const token = (await issueTestCredentials(app, { id: 7 })).authorization.replace('Bearer ', '')
    const socket = connect(`${url}/secure`, {
      auth: { token },
    })
    expect(await new Promise(resolve => socket.once('me', resolve))).toEqual({ id: 7 })
    // 拒绝的握手同样释放
    const anonymous = connect(`${url}/secure`)
    await new Promise(resolve => anonymous.once('connect_error', resolve))
    expect(disposed).toEqual([true, true])
  })

  it('only allows credentials by default when config/cors.ts names an origin', async () => {
    const handshake = (url: string) => fetch(`${url}/socket.io/?EIO=4&transport=polling`, {
      headers: { origin: 'https://evil.example' },
    })

    const open = await start()
    const reflected = await handshake(open.url)
    await reflected.text()
    expect(reflected.headers.get('access-control-allow-origin')).toBe('https://evil.example')
    expect(reflected.headers.get('access-control-allow-credentials')).toBeNull()
    for (const cleanup of cleanups.splice(0).reverse())
      await cleanup()

    const pinned = await start({
      cors: {
        origin: ['https://app.example'],
      },
    })
    const rejected = await handshake(pinned.url)
    await rejected.text()
    expect(rejected.headers.get('access-control-allow-origin')).toBeNull()
    const allowed = await fetch(`${pinned.url}/socket.io/?EIO=4&transport=polling`, {
      headers: { origin: 'https://app.example' },
    })
    await allowed.text()
    expect(allowed.headers.get('access-control-allow-origin')).toBe('https://app.example')
    expect(allowed.headers.get('access-control-allow-credentials')).toBe('true')
    for (const cleanup of cleanups.splice(0).reverse())
      await cleanup()

    // 显式的 socketio.cors 原样使用
    const explicit = await start({
      socketio: {
        cors: { origin: true, credentials: true },
      },
    })
    const kept = await handshake(explicit.url)
    await kept.text()
    expect(kept.headers.get('access-control-allow-credentials')).toBe('true')
  })
})
