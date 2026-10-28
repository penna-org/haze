/* eslint-disable antfu/no-import-dist, antfu/no-top-level-await, no-console -- 以子进程运行的测试应用，使用构建产物 */
// 测试用应用：同进程测试直接导入，多实例 / Bun 测试作为子进程运行（node / bun fixtures/app.mjs）
import process from 'node:process'
import { createApplication, defineRoutes, defineUserProvider } from '@hazejs/core'
import { authenticate, defineNamespace, SocketIO, socketIoProvider } from '../../dist/index.mjs'

export const root = defineNamespace({
  connection(socket) {
    socket.on('echo', (text, ack) => ack(`echo:${text}`))
    socket.on('join', (room, ack) => {
      socket.join(room)
      ack('joined')
    })
    socket.on('say', ({ room, text }) => socket.to(room).emit('said', text))
  },
})

export const secure = defineNamespace({
  middleware: [
    authenticate(),
  ],
  connection(socket) {
    socket.emit('me', socket.data.user)
  },
})

export function createApp(config = {}) {
  return createApplication({
    mode: 'test',
    env: false,
    providers: [
      socketIoProvider(),
    ],
    discovered: {
      sockets: {
        '/app/socket/index.ts': { default: root },
        '/app/socket/secure.ts': { default: secure },
      },
    },
    config: {
      logger: { level: 'silent' },
      app: {
        key: 'k'.repeat(32),
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
            getId: user => user.id,
          }),
        },
      },
      ...config,
    },
    routes: [
      defineRoutes((r) => {
        r.post('/notify/:room', async (ctx) => {
          SocketIO.to(ctx.param('room')).emit('notice', await ctx.body())
          return 'sent'
        })
        // r.ws() 与 socket.io 共用一个服务器
        r.ws('/ws', {
          message: (peer, message) => peer.send(`ws:${message.text()}`),
        })
        r.get('/hello', () => 'hello')
      }),
    ],
  })
}

// 作为子进程运行：PORT、REDIS_URL
if (process.argv[1]?.endsWith('app.mjs')) {
  const app = await createApp(process.env.REDIS_URL
    ? {
        socketio: {
          adapter: { driver: 'redis', url: process.env.REDIS_URL, key: process.env.ADAPTER_KEY },
        },
      }
    : {})
  const server = app.serve({
    port: Number(process.env.PORT),
    hostname: '127.0.0.1',
    silent: true,
  })
  await server.ready()
  console.log('ready')
}
