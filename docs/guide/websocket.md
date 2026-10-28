# WebSocket

hazejs has native WebSocket support built on [crossws](https://crossws.h3.dev). You declare a socket next to your HTTP routes, the upgrade request goes through your middleware, and the same code runs in the dev server, on Node, Bun, Deno, Docker and on Cloudflare Workers (through a Durable Object).

If your frontend uses `socket.io-client`, see [Socket.IO](./socket-io) instead: it speaks a different protocol.

::: tip Paths
Examples on this page use the API template layout (`route/...`, `app/...`, `config/...`). In a full-stack project these live under `server/`.
:::

## Defining a socket

Use `r.ws(path, hooks)` in any route file:

```ts
// route/ws.ts
import { defineRoutes } from '@hazejs/core'

export default defineRoutes((r) => {
  r.ws('/api/ws', {
    open(peer) {
      peer.subscribe('users')
      peer.send(JSON.stringify({ type: 'connected' }))
    },
    message(peer, message) {
      if (message.text() === 'ping')
        peer.send(JSON.stringify({ type: 'pong' }))
    },
  })
})
```

Connect with `new WebSocket('ws://localhost:3000/api/ws')`. A plain `GET` to the same path gets `426 Upgrade Required`.

For larger handlers, move them into their own file with `defineWebSocket()`:

```ts
// app/websocket/ChatSocket.ts
import { defineWebSocket } from '@hazejs/core'

export default defineWebSocket({
  open(peer, ctx) {
    peer.subscribe('chat')
  },
  message(peer, message) {
    // Send to every other subscriber of "chat"
    peer.publish('chat', message.text())
  },
  close(peer, details) {
    console.log(`closed ${peer.id}`, details.code, details.reason)
  },
  error(peer, error) {
    console.error(error)
  },
})
```

```ts
// route/ws.ts
import ChatSocket from '~/app/websocket/ChatSocket'

r.ws('/api/chat', ChatSocket)
```

Any directory works, except `app/socket/`, which is reserved for [Socket.IO namespaces](./socket-io).

### Hooks

| Hook | Arguments | Description |
| --- | --- | --- |
| `upgrade` | `(request, ctx)` | Return a `Response` to reject the upgrade, or `{ headers }` to add response headers |
| `open` | `(peer, ctx)` | Connection established |
| `message` | `(peer, message, ctx)` | Message received |
| `close` | `(peer, { code, reason }, ctx)` | Connection closed |
| `error` | `(peer, error, ctx)` | Error on the connection |

Every hook receives the upgrade request's `ctx` as its last argument.

### Peers and messages

`peer` and `message` are crossws objects. The members you will use most:

| | |
| --- | --- |
| `peer.id` | Unique connection ID |
| `peer.send(data)` | Send to this connection |
| `peer.subscribe(topic)` / `peer.unsubscribe(topic)` | Join or leave a topic |
| `peer.publish(topic, data)` | Send to all *other* subscribers of a topic |
| `peer.context` | Per-connection storage object |
| `peer.close(code?, reason?)` | Close the connection |
| `message.text()` / `message.json()` | Read the payload as a string or parsed JSON |

## Authentication and middleware

The upgrade request runs through global and route middleware. If a middleware returns a response (such as `401` from `auth`), the upgrade is rejected with it:

```ts
// route/ws.ts
r.ws('/api/notifications', {
  async open(peer, ctx) {
    const user = await ctx.auth.user()
    // Keep what you need: the request container is released after the upgrade
    peer.context.userId = user?.id
    peer.subscribe(`user:${user?.id}`)
  },
}).middleware('auth')
```

::: warning Read request data in `open`
Once the upgrade completes, the request-scoped container is disposed. Read the user, config or anything else from `ctx` in `upgrade` / `open` and store it on `peer.context`.
:::

Browsers cannot send an `Authorization` header with `new WebSocket()`, so for browser clients a cookie-based guard (such as the session guard) is usually the simplest choice. See [Authentication](./authentication).

## Publishing from anywhere

`Socket.publish(topic, data)` sends to every connection subscribed to a topic. Call it from controllers, [jobs](./queues) or [event listeners](./events). Non-string data is JSON-encoded.

```ts
// app/listener/BroadcastRegistration.ts
import { defineListener, Socket } from '@hazejs/core'
import UserRegistered from '~/app/event/UserRegistered'

export default defineListener(UserRegistered, ({ userId }) => {
  Socket.publish('users', { type: 'user.registered', userId })
})
```

`Socket.connections()` returns the number of open connections in the current process.

## Multiple instances

By default a publish only reaches connections on the same process. To fan out across instances, configure Redis broadcasting (requires `ioredis`):

```ts
// config/websocket.ts
import { defineWebSocketConfig, env } from '@hazejs/core'

export default defineWebSocketConfig(() => env('WS_BROADCAST', '') === 'redis'
  ? {
      broadcast: {
        driver: 'redis',
        url: env('REDIS_URL', 'redis://127.0.0.1:6379'),
        // Separate apps sharing one Redis (default haze:ws)
        channel: 'my-app:ws',
      },
    }
  : {})
```

Both `Socket.publish()` and `peer.publish()` are forwarded to every instance.

## Runtime support

| Environment | Support |
| --- | --- |
| `haze dev` / Vite full-stack dev server | Yes. Vite's own HMR socket is left alone; new connections pick up code changes |
| node / bun / deno / docker builds | Yes. `haze preview` forwards upgrades to the built server too |
| cloudflare | Yes, through a Durable Object (see below) |
| vercel / netlify / aws-lambda | No. The platforms do not support WebSocket; upgrades get `426` |

### Cloudflare Workers

Nothing to wire up by hand. When the build finds `.ws(` in your routes, the Worker entry creates a Durable Object with `createWebSocketDurableObject()` from `@hazejs/core/cloudflare`, exports it as `HazeWebSocket`, and forwards upgrade requests to it. `dist/wrangler.json` gets the `HAZE_WEBSOCKET` binding and the SQLite Durable Object migration. Hooks still run inside your app, including middleware.

All connections share one Durable Object, so topics are global and `Socket.publish()` reaches them via RPC. Force generation on or off with `cloudflare.websocket` in `haze.config.ts`:

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  cloudflare: {
    websocket: true,
  },
})
```

::: tip
Miniflare-based preview does not proxy WebSocket; use `wrangler dev -c dist/wrangler.json` to try it locally.
:::

## Testing

The in-process test client handles HTTP only, so it can check that a plain `GET` is refused:

```ts
// tests/ws.test.ts
import { useTestApp } from '@hazejs/testing'
import { expect, it } from 'vitest'

const t = useTestApp()

it('requires an upgrade', async () => {
  expect((await t.get('/api/ws')).status).toBe(426)
})
```

For real connections, start the app on a random port and use the global `WebSocket` client, the same approach the framework's own tests take:

```ts
// tests/ws.test.ts
import { useTestApp } from '@hazejs/testing'
import { expect, it } from 'vitest'

const t = useTestApp()

it('answers ping with pong', async () => {
  const server = t.app.serve({ port: 0, hostname: '127.0.0.1', silent: true })
  await server.ready()
  const socket = new WebSocket(`${server.url!.replace(/^http/, 'ws').replace(/\/$/, '')}/api/ws`)
  const messages: string[] = []
  socket.addEventListener('message', event => messages.push(String(event.data)))
  await new Promise(resolve => socket.addEventListener('open', resolve))

  socket.send('ping')
  await expect.poll(() => messages.at(-1)).toBe(JSON.stringify({ type: 'pong' }))
  socket.close()
  await server.close(true)
})
```

## Limitations

- Connections opened before a hot reload keep the old hooks; reconnect to use new code.
- Data from the upgrade request must be captured in `upgrade` / `open`.
