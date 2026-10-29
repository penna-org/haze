# WebSocket

hazejs 基于 [crossws](https://crossws.h3.dev) 提供原生 WebSocket 支持：WebSocket 和 HTTP 路由写在一起，升级请求同样经过中间件；同一份代码可以运行在开发服务器、Node、Bun、Deno、Docker，以及 Cloudflare Workers（借助 Durable Object）上。

如果前端使用的是 `socket.io-client`，请看 [Socket.IO](./socket-io)：两者的协议不同。

::: tip 目录约定
本页示例使用 API 模板的目录结构（`route/...`、`app/...`、`config/...`）。全栈项目中这些目录位于 `server/` 下。
:::

## 定义 WebSocket

在任意路由文件中使用 `r.ws(path, hooks)`：

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

用 `new WebSocket('ws://localhost:3000/api/ws')` 连接即可。对同一路径发起普通 `GET` 请求会得到 `426 Upgrade Required`。

处理逻辑较多时，可以用 `defineWebSocket()` 放到单独的文件中：

```ts
// app/websocket/ChatSocket.ts
import { defineWebSocket } from '@hazejs/core'

export default defineWebSocket({
  open(peer, ctx) {
    peer.subscribe('chat')
  },
  message(peer, message) {
    // 发给 chat 的其他订阅者
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

目录可以随意选择，但不要放在 `app/socket/`：该目录专门用于 [Socket.IO 命名空间](./socket-io)。

### 钩子

| 钩子 | 参数 | 说明 |
| --- | --- | --- |
| `upgrade` | `(request, ctx)` | 返回 `Response` 拒绝升级，或返回 `{ headers }` 附加响应头 |
| `open` | `(peer, ctx)` | 连接建立 |
| `message` | `(peer, message, ctx)` | 收到消息 |
| `close` | `(peer, { code, reason }, ctx)` | 连接关闭 |
| `error` | `(peer, error, ctx)` | 连接出错 |

每个钩子的最后一个参数都是升级请求的 `ctx`。

### Peer 与消息

`peer` 和 `message` 是 crossws 的对象，常用成员如下：

| | |
| --- | --- |
| `peer.id` | 连接的唯一 ID |
| `peer.send(data)` | 发给当前连接 |
| `peer.subscribe(topic)` / `peer.unsubscribe(topic)` | 订阅 / 取消订阅主题 |
| `peer.publish(topic, data)` | 发给该主题的*其他*订阅者 |
| `peer.context` | 每个连接独有的存储对象 |
| `peer.close(code?, reason?)` | 关闭连接 |
| `message.text()` / `message.json()` | 以字符串或 JSON 读取消息内容 |

## 认证与中间件

升级请求会经过全局中间件与路由中间件。如果某个中间件返回了响应（例如 `auth` 返回 `401`），升级就会以该响应被拒绝：

```ts
// route/ws.ts
r.ws('/api/notifications', {
  async open(peer, ctx) {
    const user = await ctx.auth.user()
    // 升级完成后请求级容器会被释放，需要的数据先保存下来
    peer.context.userId = user?.id
    peer.subscribe(`user:${user?.id}`)
  },
}).middleware('auth')
```

::: warning 在 `open` 中读取请求数据
升级完成后，请求级容器即被释放。用户、配置等需要从 `ctx` 读取的数据，请在 `upgrade` / `open` 中读取并保存到 `peer.context`。
:::

浏览器的 `new WebSocket()` 无法携带 `Authorization` 头，因此浏览器客户端通常用基于 Cookie 的 Guard（例如 session Guard）最省事。详见 [认证](./authentication)。

## 在任意位置推送

`Socket.publish(topic, data)` 会发给订阅了该主题的所有连接，可以在控制器、[队列任务](./queues) 或 [事件监听器](./events) 中调用。非字符串数据会自动转成 JSON。

```ts
// app/listener/BroadcastRegistration.ts
import { defineListener, Socket } from '@hazejs/core'
import UserRegistered from '~/app/event/UserRegistered'

export default defineListener(UserRegistered, ({ userId }) => {
  Socket.publish('users', { type: 'user.registered', userId })
})
```

`Socket.connections()` 返回当前进程的连接数。

## 多实例

默认情况下，推送只能到达同一进程内的连接。多实例部署时配置 Redis 广播（需要安装 `ioredis`）：

```ts
// config/websocket.ts
import { defineWebSocketConfig, env } from '@hazejs/core'

export default defineWebSocketConfig(() => env('WS_BROADCAST', '') === 'redis'
  ? {
      broadcast: {
        driver: 'redis',
        // config/redis.ts 中的连接（默认为其 default 连接）
        connection: 'default',
        // 多个应用共用一个 Redis 时用频道区分（默认 haze:ws）
        channel: 'my-app:ws',
      },
    }
  : {})
```

`Socket.publish()` 与 `peer.publish()` 都会转发到所有实例。发布使用该连接的共享命令连接，每个服务器另建一个专用的订阅连接。连接的 `keyPrefix` 不作用于 `channel`。原来的内联 `url`（及 `options`）写法仍然可用，并且优先于 `connection`，见 [Redis](./redis)。

## 运行时支持

| 环境 | 支持情况 |
| --- | --- |
| `haze dev` / Vite 全栈开发服务器 | 支持。不会影响 Vite 自己的 HMR 连接；修改代码后新连接使用新代码 |
| node / bun / deno / docker 产物 | 支持。`haze preview` 也会把升级请求转发给产物 |
| cloudflare | 支持，借助 Durable Object（见下文） |
| vercel / netlify / aws-lambda | 不支持。平台没有 WebSocket，升级请求返回 `426` |

### Cloudflare Workers

无需手动接线。构建时如果在路由中发现 `.ws(`，Worker 入口会用 `@hazejs/core/cloudflare` 的 `createWebSocketDurableObject()` 创建 Durable Object，导出为 `HazeWebSocket`，并把升级请求交给它处理；`dist/wrangler.json` 会自动加上 `HAZE_WEBSOCKET` 绑定与 SQLite Durable Object 的迁移。钩子仍在你的应用中解析，中间件照常生效。

所有连接都在同一个 Durable Object 中，因此主题是全局的，`Socket.publish()` 经 RPC 到达这些连接。可以用 `haze.config.ts` 的 `cloudflare.websocket` 强制开启或关闭：

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
基于 Miniflare 的预览不转发 WebSocket，本地调试请用 `wrangler dev -c dist/wrangler.json`。
:::

## 测试

进程内的测试客户端只处理 HTTP，可以用它验证普通 `GET` 被拒绝：

```ts
// tests/ws.test.ts
import { useTestApp } from '@hazejs/testing'
import { expect, it } from 'vitest'

const t = useTestApp()

it('requires an upgrade', async () => {
  expect((await t.get('/api/ws')).status).toBe(426)
})
```

需要真实连接时，把应用启动在随机端口上，再用全局的 `WebSocket` 客户端连接（框架自身的测试也是这样做的）：

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

## 限制

- 热替换之前建立的连接仍使用旧的钩子，需要重新连接才会使用新代码。
- 升级请求中的数据必须在 `upgrade` / `open` 中读取。
