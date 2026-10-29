# Socket.IO

Many frontends talk to the server through `socket.io-client`, which uses the Engine.IO / Socket.IO protocol (long-polling handshake, upgrade, namespaces, acks, rooms) and cannot connect to a plain [WebSocket](./websocket) route. `@hazejs/socket.io` integrates the official `socket.io` server instead: it shares the HTTP port, discovers namespaces from files, authenticates with your guards and scales out with the Redis adapter.

::: tip Paths
Examples on this page use the API template layout (`app/...`, `config/...`). In a full-stack project these live under `server/`. The Vue and React templates come with Socket.IO already set up.
:::

## Installation

```bash
pnpm add @hazejs/socket.io socket.io
pnpm add socket.io-client   # in the frontend
```

Register the provider:

```ts
// app/provider/SocketProvider.ts
import { socketIoProvider } from '@hazejs/socket.io'

// Namespaces in app/socket are registered automatically; served on the HTTP port at /socket.io/
export default socketIoProvider()
```

## Namespaces

Each file in `app/socket/*.ts` default-exports a namespace created with `defineNamespace()`. The file name decides the namespace: `index.ts` is `/`, `chat.ts` is `/chat`, `ChatRoom.ts` is `/chat-room`. Set `name` to override it.

```ts
// app/socket/chat.ts
import { defineNamespace } from '@hazejs/socket.io'

export default defineNamespace({
  connection(socket, io, chat) {
    chat.emit('online', chat.sockets.size)
    socket.on('chat:send', (text: string, ack?: (result: string) => void) => {
      chat.emit('chat:message', text)
      ack?.('ok')
    })
    socket.on('disconnect', () => chat.emit('online', chat.sockets.size))
  },
})
```

| Option | Description |
| --- | --- |
| `name` | Namespace, e.g. `'/admin'`; defaults to the file name |
| `middleware` | Array of Socket.IO middleware `(socket, next) => ...`, run in order on the handshake |
| `connection(socket, io, namespace)` | Called for each connection with the socket, the `Server` and this `Namespace` |

The `socket`, `io` and `namespace` objects are the regular Socket.IO ones, so rooms (`socket.join()`), acks and broadcasts work as documented by Socket.IO. During development, edits to a namespace apply to new connections without a restart.

## Authentication

`authenticate()` identifies the user with a guard from `config/auth.ts` (see [Authentication](./authentication)) and stores it on `socket.data.user`:

```ts
// app/socket/notifications.ts
import { authenticate, defineNamespace } from '@hazejs/socket.io'

export default defineNamespace({
  middleware: [
    authenticate(), // default guard; or authenticate({ guard: 'web' })
  ],
  connection(socket) {
    socket.join(`user:${socket.data.user.id}`)
  },
})
```

- The token is read from the client's `auth.token` (sent as a Bearer token) or from the handshake's `Authorization` header. Session guards read the handshake cookies.
- Unauthenticated clients are rejected; the client receives `connect_error` with the message `unauthorized`.
- `authenticate({ optional: true })` lets guests connect, with `socket.data.user` left `undefined`.

## Emitting from anywhere

The `SocketIO` facade reaches the running server from controllers, [jobs](./queues) and [event listeners](./events):

```ts
import { SocketIO } from '@hazejs/socket.io'

SocketIO.of('/chat').emit('chat:message', 'hi')
SocketIO.to(`user:${userId}`).emit('notice', { text: 'Your export is ready' })
SocketIO.except('banned').emit('announcement', 'Maintenance at 22:00')
SocketIO.emit('ping') // main namespace "/"
```

`SocketIO.server` returns the underlying `Server`. You can also inject it through the `SocketIOServer` token (see [Service Container](./container)):

```ts
// app/service/PresenceService.ts
import { inject } from '@hazejs/core'
import { SocketIOServer } from '@hazejs/socket.io'

export class PresenceService {
  private io = inject(SocketIOServer)

  online() {
    return this.io.of('/chat').sockets.size
  }
}
```

## Configuration

`config/socketio.ts` is optional:

```ts
// config/socketio.ts
import { env } from '@hazejs/core'
import { defineSocketIOConfig } from '@hazejs/socket.io'

// Set SOCKET_ADAPTER=redis when running several instances
export default defineSocketIOConfig(() => env('SOCKET_ADAPTER', '') === 'redis'
  ? {
      adapter: {
        driver: 'redis',
        // A connection from config/redis.ts (default: its `default` connection)
        connection: 'default',
        key: 'my-app',
      },
    }
  : {})
```

| Option | Description |
| --- | --- |
| `path` | Endpoint path. Default `/socket.io/` (the client's default) |
| `cors` | Socket.IO CORS options. Defaults to the `origin` from `config/cors.ts` with credentials; `false` disables it (same-origin) |
| `adapter` | `{ driver: 'redis', connection?, url?, key? }` for multiple instances, using `@socket.io/redis-adapter` (`pnpm add @socket.io/redis-adapter ioredis`). `connection` names a [Redis connection](./redis) (default: the `default` one); an inline `url` takes precedence. `key` (default `socket.io`) prefixes the pub/sub channels; the connection's `keyPrefix` does not apply to them |
| `options` | Passed through to the Socket.IO `Server` (`pingInterval`, `connectionStateRecovery`, …) |

With the Redis adapter, rooms and broadcasts (including `SocketIO.to()`) reach clients on every instance. The adapter publishes on the connection's shared command client and subscribes on one dedicated connection.

## Client

```ts
// src/socket.ts
import type { Socket } from 'socket.io-client'
import { io } from 'socket.io-client'

// Same origin as the page; in development the Vite dev server hands it to the backend
export const chat: Socket = io('/chat', { autoConnect: false })
```

```ts
// src/chat.ts
import { chat } from './socket'

chat.on('chat:message', (text: string) => console.log(text))
chat.connect()
const result = await chat.emitWithAck('chat:send', 'hello') // 'ok'
```

For an authenticated namespace pass the token: `io('/notifications', { auth: { token } })`, and handle `connect_error`.

## Runtime support

| Environment | Support |
| --- | --- |
| `haze dev` / Vite full-stack dev server | Yes, both long-polling and WebSocket transports |
| node / docker builds | Yes; `haze preview` works too |
| bun | Yes, through the official `@socket.io/bun-engine` (`pnpm add @socket.io/bun-engine`) |
| deno | No |
| cloudflare | No; the provider logs a warning and skips. Use [`r.ws()`](./websocket) with Durable Objects |
| vercel / netlify / aws-lambda | No (no long-lived connections) |

Socket.IO and `r.ws()` routes can live on the same server; each handles its own paths.

::: tip
A handshake that arrives while the dev server is still booting the app can fail once; `socket.io-client` reconnects automatically.
:::
