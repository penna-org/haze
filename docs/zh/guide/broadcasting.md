# 广播

广播把服务端发生的事件实时推送到浏览器。频道授权写在 `app/channel` 中，在控制器、任务或事件里广播，前端用一个 API 与 Laravel Echo 相近的小客户端监听。同一套频道可以走三种传输：内置的 WebSocket 接口、Server-Sent Events（SSE）以及 Socket.IO。

```ts
// 服务端
await broadcast({ channel: privateChannel(`orders.${order.id}`), event: 'OrderShipped', data: { id: order.id } })

// 浏览器
echo.private(`orders.${order.id}`).listen('OrderShipped', order => console.log(order))
```

::: tip 路径
本页示例使用 API 模板的目录结构（`app/...`、`config/...`）。全栈项目中这些目录位于 `server/` 下。
:::

## 频道

频道分三种，由名字的前缀区分：

| 类型 | 名字 | 谁可以订阅 |
|------|------|------------|
| 公共频道 | `news` | 任何人，无需定义。 |
| 私有频道 | `private-orders.1` | 已登录、且授权回调允许的用户。 |
| 在线频道 | `presence-chat.lobby` | 与私有频道相同，另外每个订阅者都能看到还有谁在。 |

不必手写前缀，用辅助函数即可：`privateChannel('orders.1')` 返回 `private-orders.1`，`presenceChannel('chat.lobby')` 返回 `presence-chat.lobby`。

## 配置

广播无需配置。只要 `app/channel` 下有文件，或者存在 `config/broadcasting.ts`，内置接口就会启用：

```ts
// config/broadcasting.ts
import { defineBroadcastingConfig, env } from '@hazejs/core'

export default defineBroadcastingConfig(() => ({
  // 内置接口额外使用的路由中间件（全局中间件始终生效）
  middleware: ['throttle:120,60'],
  bus: env('BROADCAST_BUS', 'memory') === 'redis'
    ? { driver: 'redis', url: env('REDIS_URL', 'redis://127.0.0.1:6379'), prefix: 'my-app:broadcast' }
    : { driver: 'memory' },
}))
```

| 选项 | 说明 |
|------|------|
| `path` | 内置接口的前缀，默认 `/broadcasting`。 |
| `routes` | 为 `false` 时不注册接口（例如只用 Socket.IO）。 |
| `middleware` | 作用于内置接口的路由中间件，如 `throttle:120,60`。 |
| `bus` | 广播如何到达所有实例：`{ driver: 'memory' }`、`{ driver: 'redis', url?, prefix? }`，或者自己实现的 `BroadcastBus`。`config/websocket.ts` 的 `broadcast.driver` 为 `redis` 时默认沿用它的 Redis，否则为 `memory`。 |
| `transports` | `{ ws?: boolean, sse?: boolean }`，默认都启用。 |
| `heartbeat` | SSE 心跳间隔，默认 `25` 秒。 |
| `maxChannels` | 每个 SSE 连接最多订阅的频道数，默认 100。 |

内置接口如下：

| 接口 | 用途 |
|------|------|
| `POST /broadcasting/auth` | 为某个连接签发私有 / 在线频道的订阅签名。 |
| `GET /broadcasting/sse?channels=…` | Server-Sent Events 推送流。 |
| `/broadcasting/ws` | WebSocket 接口。 |

它们和普通路由一样经过全局中间件（Session、CORS、CSRF），并且不会出现在 [OpenAPI](./openapi) 文档中。

## 频道授权

频道定义放在 `app/channel/*.ts`，目录下每个文件都会被加载：

```ts
// app/channel/orders.ts
import type { User } from '~/app/model/User'
import { defineChannels } from '@hazejs/core'
import { Order } from '~/app/model/Order'

export default defineChannels((c) => {
  // 客户端订阅 "private-orders.<id>"
  c.private('orders.{id}', async (user: User, { id }) => (await Order.find(id))?.userId === user.id)

  // 返回其他订阅者能看到的成员信息，返回 false 表示拒绝
  c.presence('chat.{room}', (user: User, { room }) => room !== 'archived' && { id: user.id, name: user.name })

  // 指定 Guard（任一通过即可）
  c.private('admin', (user: User) => user.role === 'admin', { guards: ['web', 'api'] })
})
```

- `{name}` 占位符匹配以点分隔的一段，以字符串传入。
- 回调依次收到[认证 Guard](./authentication) 取得的用户（未设置 `guards` 时为默认 Guard）、参数和 `HttpContext`。未登录的访客一律以 401 拒绝。
- 私有频道的回调返回真值时允许订阅。
- 在线频道的回调返回一个对象。对象中没有 `id` 时使用 Guard 的用户 ID；成员按 `id` 去重，同一用户开三个标签页也只算一个。
- 回调抛出异常时以 403 拒绝订阅，并记录错误日志。

## 服务端广播

`broadcast()` 在任何地方都能用：控制器、任务、监听器、命令。

```ts
import { broadcast, presenceChannel, privateChannel } from '@hazejs/core'

await broadcast({ channel: 'news', event: 'Published', data: { title } })
await broadcast({ channel: [privateChannel('orders.1'), privateChannel('orders.2')], event: 'OrderShipped', data })

// 不发给发起当前请求的浏览器（它会带上 X-Socket-ID）
await broadcast({ channel: presenceChannel('chat.lobby'), event: 'Message', data, toOthers: true })
```

`data` 以 JSON 发送。用 `except: socketId` 可以跳过指定的连接。

### 广播事件

用 `defineEvent()` 定义的事件可以自己广播。设置了 `broadcastOn` 后，`Events.emit()` 会先广播，再执行监听器：

```ts
// app/event/OrderShipped.ts
import { defineEvent, privateChannel } from '@hazejs/core'

export default defineEvent<{ orderId: number, userId: number }>({
  broadcastOn: ({ orderId }) => privateChannel(`orders.${orderId}`),
  // 可选：浏览器收到的事件名（默认为文件名 "OrderShipped"）
  broadcastAs: 'order.shipped',
  // 可选：发送的数据（默认为 payload）
  broadcastWith: ({ orderId }) => ({ orderId }),
  // 可选：返回 false 时不广播
  broadcastWhen: ({ orderId }) => orderId > 0,
})
```

`broadcast(OrderShipped, payload)` 只广播事件、不执行监听器。`Events.fake()` 同样会阻止事件广播。

## 客户端

`@hazejs/core/echo` 是一个零依赖的浏览器客户端：

```ts
// src/echo.ts
import { createEcho } from '@hazejs/core/echo'

export const echo = createEcho({
  transport: 'ws', // 'ws' | 'sse' | 'socket.io'
  // 授权请求与 SSE 请求附带的请求头
  headers: () => ({ authorization: `Bearer ${localStorage.getItem('token')}` }),
})
```

| 选项 | 说明 |
|------|------|
| `transport` | `ws`（默认）、`sse` 或 `socket.io`。 |
| `url` | 服务端地址，默认为当前页面的 origin。 |
| `path` | 内置接口的前缀，默认 `/broadcasting`。 |
| `authEndpoint` | 授权接口的完整地址，默认 `<path>/auth`。 |
| `headers` | 授权请求与 SSE 请求的请求头，也可以是返回请求头的函数。 |
| `credentials` | `fetch` 的 credentials，默认 `same-origin`；跨域携带 Cookie 时设为 `include`。 |
| `reconnect` | 断线后自动重连（1 秒、2 秒、4 秒……最长 30 秒），默认 `true`。 |
| `io` | `socket.io` 传输：传入 `socket.io-client` 的 `io` 函数。 |
| `namespace` / `ioOptions` | `socket.io` 传输：命名空间（默认 `/broadcasting`）与传给 `io()` 的选项。 |

使用 Session Cookie 时，客户端会把 `XSRF-TOKEN` Cookie 作为 `X-XSRF-TOKEN` 一并发送，授权请求可以通过 [CSRF](./security) 校验。

```ts
echo.channel('news').listen('Published', post => {})

echo.private('orders.1')
  .listen('OrderShipped', order => {})
  .notification(notification => {}) // 经 broadcast 渠道发送的通知
  .subscribed(() => {})
  .error(({ status }) => {}) // 401 / 403

echo.join('chat.lobby') // 或 echo.presence('chat.lobby')
  .here(members => {})
  .joining(member => {})
  .leaving(member => {})
  .listenForWhisper('typing', ({ name }) => {})
  .whisper('typing', { name: 'Ada' }) // 直接发给其他成员，不经过业务接口

echo.leave('orders.1') // 退出同名的 news / private-orders.1 / presence-orders.1
echo.socketId() // 作为 X-Socket-ID 发送，toOthers 才能生效
echo.disconnect()
```

事件名可以带前导点（`.OrderShipped`），与 Laravel Echo 的写法兼容。客户端事件（whisper）只能发到私有频道和在线频道，SSE 不支持。

## 传输方式

### WebSocket

客户端连接 `/broadcasting/ws` 后收到 `{ "event": "haze:connected", "data": { "socket_id": "…" } }`。订阅私有或在线频道时，客户端先带着这个 `socket_id` 请求 `POST /broadcasting/auth`，再把签名经 WebSocket 发给服务端：

```json
{ "event": "subscribe", "channel": "private-orders.1", "auth": "…" }
{ "event": "unsubscribe", "channel": "private-orders.1" }
{ "event": "whisper", "channel": "presence-chat.lobby", "name": "typing", "data": {} }
{ "event": "ping" }
```

服务端发出的消息格式统一为 `{ event, channel?, data? }`，框架事件以 `haze:` 开头（`haze:subscribed`、`haze:subscription_error`、`haze:member_added`、`haze:member_removed`、`haze:pong`）。

如果 `subscribe` 没有带 `auth`，服务端会用升级请求的请求头（Cookie 或 `Authorization`）直接授权，方便非浏览器客户端使用。这个接口与 `r.ws()` 使用同一套 [WebSocket](./websocket) 支持，Node、Bun、Deno 和开发服务器中都可以用。

### Server-Sent Events

`GET /broadcasting/sse?channels=news,private-orders.1` 用当前请求（Cookie 或请求头）逐个授权频道，然后以 `data: <json>` 推送消息。用户无权订阅的频道会收到一条 `haze:subscription_error`，不影响其他频道。客户端用 `fetch` 读取推送流，因此可以带 `Authorization` 请求头，这是 `EventSource` 做不到的。

SSE 是单向的：订阅新频道时，客户端会带着完整的频道列表建立新连接，新连接就绪后再关闭旧连接。

### Socket.IO

安装 [`@hazejs/socket.io`](./socket-io) 后，启用广播命名空间：

```ts
// config/socketio.ts
import { defineSocketIOConfig } from '@hazejs/socket.io'

export default defineSocketIOConfig({
  broadcasting: true, // 或 { namespace: '/realtime' }
})
```

```ts
import { createEcho } from '@hazejs/core/echo'
import { io } from 'socket.io-client'

const echo = createEcho({ transport: 'socket.io', io })
```

订阅成功的 socket 同时加入与频道同名的房间。不带签名订阅时，按握手信息（Cookie 或 `io({ auth: { token } })`）直接授权。

## 授权接口

`POST /broadcasting/auth` 接收 `socket_id` 和 `channel_name`（JSON 或表单），并为当前用户执行频道的授权回调：

- 未登录返回 401，回调拒绝或没有匹配的定义返回 403，参数不合法返回 400；
- 否则返回 `{ "auth": "<签名>" }`，在线频道另外返回 `"channel_data"`（成员信息的 JSON）。

签名是用 `APP_KEY` 对 `socket_id:channel[:channel_data]` 计算的 HMAC-SHA256，任何实例都能校验。

## 多实例

默认的 `memory` 总线只能把广播送到当前进程的连接。部署多个实例时请使用 Redis，这样每条广播都会到达所有实例，在线成员也在实例之间共享：

```ts
// config/broadcasting.ts
export default defineBroadcastingConfig({
  bus: { driver: 'redis', url: env('REDIS_URL', 'redis://127.0.0.1:6379'), prefix: 'my-app:broadcast' },
})
```

需要安装 `ioredis`（`pnpm add ioredis`）。如果 `config/websocket.ts` 已经设置了 `broadcast: { driver: 'redis' }`，广播会自动使用同一个 Redis。在线成员按频道存在 Redis Hash 中（`<prefix>:presence:<channel>`）。Socket.IO 传输同样经这条总线投递，广播不依赖 Socket.IO 自己的 `adapter` 设置。

## 测试

`Broadcast.fake()` 只记录广播，不实际投递：

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

| 断言 | 说明 |
|------|------|
| `assertBroadcast(event, predicate?)` | 有过广播。`event` 为事件名或 `defineEvent` 定义。 |
| `assertBroadcastOn(channel, event?, predicate?)` | 在这个频道上有过广播。 |
| `assertNotBroadcast(event, predicate?)` | 没有匹配的广播。 |
| `assertBroadcastTimes(event, n)` | 恰好广播了 `n` 次。 |
| `assertNothingBroadcast()` | 没有任何广播。 |

`broadcasts` 数组（`{ channels, event, data, except?, definition? }`）可用于自定义检查，`Broadcast.restore()` 取消 fake。频道授权可以配合 `actingAs()` 请求 `POST /broadcasting/auth` 来测试。

## 限制

- 连接关闭时会移除对应的在线成员。如果进程崩溃，它的成员会留在 Redis Hash 中（没有过期时间）；如有需要，可在重新部署时清理 `<prefix>:presence:*`。
- SSE 不能发送客户端事件（whisper），变更订阅会重新建立连接。
- Cloudflare Workers 上，内置的 WebSocket 接口运行在 Durable Object 中，但在 Worker 中调用的 `broadcast()` 到达不了那里，也没有共享的总线。请改用 [Durable Objects](./websocket#cloudflare-workers) 配合 `Socket.publish()`。
- Vercel、Netlify 和 AWS Lambda 无法保持长连接；SSE 响应会在函数超时后结束。
