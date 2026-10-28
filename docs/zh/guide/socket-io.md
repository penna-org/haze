# Socket.IO

很多前端通过 `socket.io-client` 与服务端通信。它使用 Engine.IO / Socket.IO 协议（长轮询握手、升级、命名空间、ack、房间），无法直接连接普通的 [WebSocket](./websocket) 路由。`@hazejs/socket.io` 集成了官方的 `socket.io` 服务端：与 HTTP 共用端口，按文件发现命名空间，用现有的 Guard 鉴权，并通过 Redis 适配器支持多实例。

::: tip 目录约定
本页示例使用 API 模板的目录结构（`app/...`、`config/...`）。全栈项目中这些目录位于 `server/` 下。Vue 与 React 模板已经集成好了 Socket.IO。
:::

## 安装

```bash
pnpm add @hazejs/socket.io socket.io
pnpm add socket.io-client   # 前端
```

注册服务提供者：

```ts
// app/provider/SocketProvider.ts
import { socketIoProvider } from '@hazejs/socket.io'

// app/socket 下的命名空间自动注册，与 HTTP 共用端口（/socket.io/）
export default socketIoProvider()
```

## 命名空间

`app/socket/*.ts` 中每个文件默认导出一个用 `defineNamespace()` 定义的命名空间。文件名决定命名空间：`index.ts` 为 `/`，`chat.ts` 为 `/chat`，`ChatRoom.ts` 为 `/chat-room`。也可以用 `name` 指定。

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

| 选项 | 说明 |
| --- | --- |
| `name` | 命名空间，例如 `'/admin'`；默认取文件名 |
| `middleware` | Socket.IO 中间件数组 `(socket, next) => ...`，握手时按顺序执行 |
| `connection(socket, io, namespace)` | 每个连接建立时调用，参数为 socket、`Server` 与当前 `Namespace` |

`socket`、`io`、`namespace` 都是 Socket.IO 原生对象，房间（`socket.join()`）、ack、广播等用法与 Socket.IO 官方文档一致。开发时修改命名空间无需重启，新连接即使用新代码。

## 鉴权

`authenticate()` 使用 `config/auth.ts` 中的 Guard 识别用户（见 [认证](./authentication)），并存入 `socket.data.user`：

```ts
// app/socket/notifications.ts
import { authenticate, defineNamespace } from '@hazejs/socket.io'

export default defineNamespace({
  middleware: [
    authenticate(), // 默认 Guard；也可以 authenticate({ guard: 'web' })
  ],
  connection(socket) {
    socket.join(`user:${socket.data.user.id}`)
  },
})
```

- 令牌取自客户端的 `auth.token`（按 Bearer 令牌处理）或握手请求的 `Authorization` 头；Session Guard 读取握手请求的 Cookie。
- 未登录时拒绝连接，客户端收到 `connect_error`，message 为 `unauthorized`。
- `authenticate({ optional: true })` 允许游客连接，此时 `socket.data.user` 为 `undefined`。

## 在任意位置推送

`SocketIO` 门面可以在控制器、[队列任务](./queues)、[事件监听器](./events) 中访问正在运行的服务端：

```ts
import { SocketIO } from '@hazejs/socket.io'

SocketIO.of('/chat').emit('chat:message', 'hi')
SocketIO.to(`user:${userId}`).emit('notice', { text: 'Your export is ready' })
SocketIO.except('banned').emit('announcement', 'Maintenance at 22:00')
SocketIO.emit('ping') // 主命名空间 "/"
```

`SocketIO.server` 返回底层的 `Server`。也可以通过 `SocketIOServer` 令牌注入（见 [服务容器](./container)）：

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

## 配置

`config/socketio.ts` 是可选的：

```ts
// config/socketio.ts
import { env } from '@hazejs/core'
import { defineSocketIOConfig } from '@hazejs/socket.io'

// 多实例部署时设置 SOCKET_ADAPTER=redis
export default defineSocketIOConfig(() => env('SOCKET_ADAPTER', '') === 'redis'
  ? {
      adapter: {
        driver: 'redis',
        url: env('REDIS_URL', 'redis://127.0.0.1:6379'),
        key: 'my-app',
      },
    }
  : {})
```

| 选项 | 说明 |
| --- | --- |
| `path` | 路径，默认 `/socket.io/`（与客户端默认值一致） |
| `cors` | Socket.IO 的 CORS 选项。默认沿用 `config/cors.ts` 的 `origin` 并允许携带凭据；设为 `false` 关闭（同源） |
| `adapter` | 多实例：`{ driver: 'redis', url?, key? }`，基于 `@socket.io/redis-adapter`（`pnpm add @socket.io/redis-adapter ioredis`）。`key` 默认 `socket.io` |
| `options` | 透传给 Socket.IO `Server` 的其他选项（`pingInterval`、`connectionStateRecovery` 等） |

启用 Redis 适配器后，房间与广播（包括 `SocketIO.to()`）可以到达所有实例上的客户端。

## 客户端

```ts
// src/socket.ts
import type { Socket } from 'socket.io-client'
import { io } from 'socket.io-client'

// 与页面同源，开发时由 Vite 开发服务器交给后端
export const chat: Socket = io('/chat', { autoConnect: false })
```

```ts
// src/chat.ts
import { chat } from './socket'

chat.on('chat:message', (text: string) => console.log(text))
chat.connect()
const result = await chat.emitWithAck('chat:send', 'hello') // 'ok'
```

需要登录的命名空间请传入令牌：`io('/notifications', { auth: { token } })`，并处理 `connect_error`。

## 运行时支持

| 环境 | 支持情况 |
| --- | --- |
| `haze dev` / Vite 全栈开发服务器 | 支持，长轮询与 WebSocket 两种传输都可用 |
| node / docker 产物 | 支持；`haze preview` 也可连接 |
| bun | 支持，使用官方的 `@socket.io/bun-engine`（`pnpm add @socket.io/bun-engine`） |
| deno | 不支持 |
| cloudflare | 不支持；服务提供者会输出警告并跳过。请改用 [`r.ws()`](./websocket) 加 Durable Object |
| vercel / netlify / aws-lambda | 不支持（没有长连接） |

Socket.IO 与 `r.ws()` 路由可以共用同一个服务器，各自处理自己的路径。

::: tip
开发服务器刚启动、应用还没准备好时到达的第一次握手可能会失败，`socket.io-client` 会自动重连。
:::
