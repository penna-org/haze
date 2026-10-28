# Broadcasting

Broadcasting pushes server-side events to the browser in real time. You authorize channels in `app/channel`, broadcast from controllers, jobs or events, and listen in the frontend with a small client whose API follows Laravel Echo. The same channels work over three transports: the built-in WebSocket endpoint, Server-Sent Events, and Socket.IO.

```ts
// Server
await broadcast({ channel: privateChannel(`orders.${order.id}`), event: 'OrderShipped', data: { id: order.id } })

// Browser
echo.private(`orders.${order.id}`).listen('OrderShipped', order => console.log(order))
```

::: tip Paths
Examples on this page use the API template layout (`app/...`, `config/...`). In a full-stack project these live under `server/`.
:::

## Channels

There are three kinds of channels, told apart by the name prefix:

| Kind | Name | Who can subscribe |
|------|------|-------------------|
| Public | `news` | Anyone, no definition needed. |
| Private | `private-orders.1` | Logged-in users that your callback allows. |
| Presence | `presence-chat.lobby` | Like private, and every subscriber sees who else is there. |

Use the helpers instead of writing prefixes by hand: `privateChannel('orders.1')` returns `private-orders.1`, `presenceChannel('chat.lobby')` returns `presence-chat.lobby`.

## Configuration

Broadcasting needs no configuration. The built-in endpoints are enabled as soon as there is a file in `app/channel` or a `config/broadcasting.ts`:

```ts
// config/broadcasting.ts
import { defineBroadcastingConfig, env } from '@hazejs/core'

export default defineBroadcastingConfig(() => ({
  // Extra route middleware for the endpoints (global middleware always runs)
  middleware: ['throttle:120,60'],
  bus: env('BROADCAST_BUS', 'memory') === 'redis'
    ? { driver: 'redis', url: env('REDIS_URL', 'redis://127.0.0.1:6379'), prefix: 'my-app:broadcast' }
    : { driver: 'memory' },
}))
```

| Option | Description |
|--------|-------------|
| `path` | Prefix of the endpoints. Defaults to `/broadcasting`. |
| `routes` | `false` registers no endpoints (for example when only Socket.IO is used). |
| `middleware` | Route middleware applied to the endpoints, such as `throttle:120,60`. |
| `bus` | How broadcasts reach every instance: `{ driver: 'memory' }` or `{ driver: 'redis', url?, prefix? }`, or your own `BroadcastBus`. Defaults to the Redis settings of `config/websocket.ts` when `broadcast.driver` is `redis`, otherwise `memory`. |
| `transports` | `{ ws?: boolean, sse?: boolean }`. Both default to `true`. |
| `heartbeat` | SSE keep-alive interval, `25` seconds by default. |
| `maxChannels` | Maximum channels per SSE connection. Defaults to 100. |

The endpoints are:

| Endpoint | Purpose |
|----------|---------|
| `POST /broadcasting/auth` | Signs a private or presence subscription for a socket. |
| `GET /broadcasting/sse?channels=…` | Server-Sent Events stream. |
| `/broadcasting/ws` | WebSocket endpoint. |

They go through your global middleware (sessions, CORS, CSRF) like any other route, and are hidden from the [OpenAPI](./openapi) document.

## Authorizing channels

Put channel definitions in `app/channel/*.ts`. Every file is loaded:

```ts
// app/channel/orders.ts
import type { User } from '~/app/model/User'
import { defineChannels } from '@hazejs/core'
import { Order } from '~/app/model/Order'

export default defineChannels((c) => {
  // Clients subscribe to "private-orders.<id>"
  c.private('orders.{id}', async (user: User, { id }) => (await Order.find(id))?.userId === user.id)

  // Return the member info other subscribers will see, or false to deny
  c.presence('chat.{room}', (user: User, { room }) => room !== 'archived' && { id: user.id, name: user.name })

  // Use specific guards (any one that authenticates is enough)
  c.private('admin', (user: User) => user.role === 'admin', { guards: ['web', 'api'] })
})
```

- `{name}` placeholders match one dot-separated segment and are passed as strings.
- The callback receives the user from the [auth guard](./authentication) (the default guard unless `guards` is set), the parameters and the `HttpContext`. Guests are always denied with 401.
- A private callback allows the subscription when it returns a truthy value.
- A presence callback returns an object. When it has no `id`, the guard's user ID is used; members are de-duplicated by `id`, so one user with three tabs counts once.
- When a callback throws, the subscription is denied with 403 and the error is logged.

## Broadcasting from the server

`broadcast()` works anywhere: controllers, jobs, listeners, commands.

```ts
import { broadcast, presenceChannel, privateChannel } from '@hazejs/core'

await broadcast({ channel: 'news', event: 'Published', data: { title } })
await broadcast({ channel: [privateChannel('orders.1'), privateChannel('orders.2')], event: 'OrderShipped', data })

// Skip the browser that made the current request (it sends X-Socket-ID)
await broadcast({ channel: presenceChannel('chat.lobby'), event: 'Message', data, toOthers: true })
```

`data` is sent as JSON. Use `except: socketId` to skip a specific connection.

### Broadcasting events

Events defined with `defineEvent()` can broadcast themselves. When `broadcastOn` is set, `Events.emit()` broadcasts before running the listeners:

```ts
// app/event/OrderShipped.ts
import { defineEvent, privateChannel } from '@hazejs/core'

export default defineEvent<{ orderId: number, userId: number }>({
  broadcastOn: ({ orderId }) => privateChannel(`orders.${orderId}`),
  // Optional: the event name the browser sees (defaults to the file name, "OrderShipped")
  broadcastAs: 'order.shipped',
  // Optional: the data sent (defaults to the payload)
  broadcastWith: ({ orderId }) => ({ orderId }),
  // Optional: return false to skip broadcasting
  broadcastWhen: ({ orderId }) => orderId > 0,
})
```

`broadcast(OrderShipped, payload)` broadcasts an event without running its listeners. `Events.fake()` also stops events from broadcasting.

## The client

`@hazejs/core/echo` is a zero-dependency browser client:

```ts
// src/echo.ts
import { createEcho } from '@hazejs/core/echo'

export const echo = createEcho({
  transport: 'ws', // 'ws' | 'sse' | 'socket.io'
  // Sent with the auth request and the SSE request
  headers: () => ({ authorization: `Bearer ${localStorage.getItem('token')}` }),
})
```

| Option | Description |
|--------|-------------|
| `transport` | `ws` (default), `sse` or `socket.io`. |
| `url` | Server origin. Defaults to the page's origin. |
| `path` | Prefix of the endpoints, `/broadcasting` by default. |
| `authEndpoint` | Full URL of the auth endpoint, `<path>/auth` by default. |
| `headers` | Headers for the auth and SSE requests, or a function returning them. |
| `credentials` | `fetch` credentials, `same-origin` by default. Use `include` for cross-origin cookies. |
| `reconnect` | Reconnect after the connection drops (1 s, 2 s, 4 s … up to 30 s). Defaults to `true`. |
| `io` | For `socket.io`: the `io` function from `socket.io-client`. |
| `namespace` / `ioOptions` | For `socket.io`: the namespace (default `/broadcasting`) and options passed to `io()`. |

With session cookies, the client also sends the `XSRF-TOKEN` cookie as `X-XSRF-TOKEN`, so the auth request passes the [CSRF](./security) check.

```ts
echo.channel('news').listen('Published', post => {})

echo.private('orders.1')
  .listen('OrderShipped', order => {})
  .notification(notification => {}) // notifications sent with the broadcast channel
  .subscribed(() => {})
  .error(({ status }) => {}) // 401 / 403

echo.join('chat.lobby') // or echo.presence('chat.lobby')
  .here(members => {})
  .joining(member => {})
  .leaving(member => {})
  .listenForWhisper('typing', ({ name }) => {})
  .whisper('typing', { name: 'Ada' }) // to the other members, without a server round trip

echo.leave('orders.1') // leaves news / private-orders.1 / presence-orders.1 with that name
echo.socketId() // send it as X-Socket-ID to make toOthers work
echo.disconnect()
```

Event names may start with a dot (`.OrderShipped`) for compatibility with Laravel Echo code. Whispers are only allowed on private and presence channels, and are not available over SSE.

## Transports

### WebSocket

The client connects to `/broadcasting/ws` and receives `{ "event": "haze:connected", "data": { "socket_id": "…" } }`. For a private or presence channel it calls `POST /broadcasting/auth` with that `socket_id`, then sends the signature over the socket:

```json
{ "event": "subscribe", "channel": "private-orders.1", "auth": "…" }
{ "event": "unsubscribe", "channel": "private-orders.1" }
{ "event": "whisper", "channel": "presence-chat.lobby", "name": "typing", "data": {} }
{ "event": "ping" }
```

Every message from the server has the same shape: `{ event, channel?, data? }`. Framework events start with `haze:` (`haze:subscribed`, `haze:subscription_error`, `haze:member_added`, `haze:member_removed`, `haze:pong`).

A client that sends `subscribe` without `auth` is authorized with the headers of the upgrade request (cookies or `Authorization`), which is convenient for non-browser clients. The endpoint uses the same [WebSocket](./websocket) support as `r.ws()`, so it works on Node, Bun, Deno and in the dev server.

### Server-Sent Events

`GET /broadcasting/sse?channels=news,private-orders.1` authorizes each channel with the current request (cookies or headers) and streams `data: <json>` messages. Channels the user may not join get a `haze:subscription_error` message instead of failing the whole stream. The client reads the stream with `fetch`, so it can send an `Authorization` header, which `EventSource` cannot.

SSE is one-way: when you subscribe to another channel, the client opens a new stream with the full channel list and closes the old one once the new one is connected.

### Socket.IO

With [`@hazejs/socket.io`](./socket-io) installed, enable the broadcasting namespace:

```ts
// config/socketio.ts
import { defineSocketIOConfig } from '@hazejs/socket.io'

export default defineSocketIOConfig({
  broadcasting: true, // or { namespace: '/realtime' }
})
```

```ts
import { createEcho } from '@hazejs/core/echo'
import { io } from 'socket.io-client'

const echo = createEcho({ transport: 'socket.io', io })
```

Each subscribed socket also joins a room named after the channel. A socket that subscribes without a signature is authorized with its handshake (cookies, or `io({ auth: { token } })`).

## The auth endpoint

`POST /broadcasting/auth` takes `socket_id` and `channel_name` (JSON or form data) and runs the channel callback for the current user:

- 401 when nobody is logged in, 403 when the callback denies the channel or none matches, 400 for invalid input;
- otherwise `{ "auth": "<signature>" }`, plus `"channel_data"` (the member JSON) for presence channels.

The signature is an HMAC-SHA256 of `socket_id:channel[:channel_data]` with `APP_KEY`, so any instance can verify it.

## Multiple instances

With the default `memory` bus, broadcasts reach only the connections of the current process. With several instances, use Redis so that every broadcast reaches every instance and presence members are shared:

```ts
// config/broadcasting.ts
export default defineBroadcastingConfig({
  bus: { driver: 'redis', url: env('REDIS_URL', 'redis://127.0.0.1:6379'), prefix: 'my-app:broadcast' },
})
```

This needs `ioredis` (`pnpm add ioredis`). If `config/websocket.ts` already sets `broadcast: { driver: 'redis' }`, broadcasting uses the same Redis automatically. Presence members are kept in a Redis hash per channel (`<prefix>:presence:<channel>`). The Socket.IO transport delivers through this bus too, so its own `adapter` setting is not needed for broadcasting.

## Testing

`Broadcast.fake()` records broadcasts instead of delivering them:

```ts
import { Broadcast } from '@hazejs/core'
import OrderShipped from '~/app/event/OrderShipped'

it('broadcasts when an order ships', async () => {
  const broadcasts = Broadcast.fake()
  await t.post('/api/orders/1/ship')
  broadcasts.assertBroadcast(OrderShipped)
  broadcasts.assertBroadcastOn('private-orders.1', 'OrderShipped', item => item.data.orderId === 1)
})
```

| Assertion | Description |
|-----------|-------------|
| `assertBroadcast(event, predicate?)` | Something was broadcast. `event` is an event name or a `defineEvent` definition. |
| `assertBroadcastOn(channel, event?, predicate?)` | Something was broadcast on this channel. |
| `assertNotBroadcast(event, predicate?)` | Nothing matching was broadcast. |
| `assertBroadcastTimes(event, n)` | Broadcast exactly `n` times. |
| `assertNothingBroadcast()` | Nothing was broadcast. |

The `broadcasts` array (`{ channels, event, data, except?, definition? }`) is available for custom checks; `Broadcast.restore()` removes the fake. Channel callbacks can be tested through `POST /broadcasting/auth` with `actingAs()`.

## Limitations

- Presence members are removed when their connection closes. If a process crashes, its members stay in the Redis hash (there is no expiry); clear `<prefix>:presence:*` when you redeploy if that matters.
- SSE cannot send whispers, and changing subscriptions reconnects the stream.
- On Cloudflare Workers the built-in WebSocket endpoint runs inside the Durable Object, but `broadcast()` called from the Worker does not reach it, and there is no shared bus. Use `Socket.publish()` with [Durable Objects](./websocket#cloudflare-workers) there.
- Vercel, Netlify and AWS Lambda cannot keep connections open; SSE responses end when the function times out.
