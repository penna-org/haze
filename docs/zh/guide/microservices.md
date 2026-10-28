# 微服务

`@hazejs/microservices` 让 hazejs 服务之间通过消息模式通信，风格类似 NestJS 微服务。服务为 `orders.find` 这样的模式声明处理器，其它服务用 `send()`（请求 / 回复）或 `emit()`（事件，发出即返回）调用。同一套处理器可以运行在 Redis、NATS、gRPC 上，测试时使用内存传输。

::: tip 目录约定
本页示例使用 API 模板的目录结构（`app/...`、`config/...`）。全栈项目中这些目录位于 `server/` 下。
:::

## 安装

```bash
pnpm add @hazejs/microservices
# 再安装所用传输的客户端库
pnpm add ioredis                              # redis
pnpm add @nats-io/transport-node              # nats
pnpm add @grpc/grpc-js @grpc/proto-loader     # grpc
```

传输库都是可选的 peer 依赖，只在使用对应驱动时加载。内存传输不需要任何依赖。

注册服务提供者：

```ts
// app/provider/MicroserviceProvider.ts
import { microservicesProvider } from '@hazejs/microservices'

// app/message 下的处理器自动注册
export default microservicesProvider()
```

## 配置

```ts
// config/microservices.ts
import { env } from '@hazejs/core'
import { defineMicroservicesConfig } from '@hazejs/microservices'

export default defineMicroservicesConfig(() => ({
  default: env('MICROSERVICE_TRANSPORT', 'nats'),
  // 本服务的名字：NATS 与内存传输的队列组
  name: 'orders',
  timeout: 5000,
  transports: {
    nats: { driver: 'nats', servers: env('NATS_URL', 'nats://127.0.0.1:4222') },
    redis: { driver: 'redis', url: env('REDIS_URL', 'redis://127.0.0.1:6379') },
    grpc: { driver: 'grpc', url: '0.0.0.0:50051', protoPath: 'proto/orders.proto', package: 'orders' },
    memory: { driver: 'memory' },
  },
}))
```

| 选项 | 说明 |
| --- | --- |
| `default` | `Microservice.send()` / `emit()` 与不传名字的 `client()` 使用的传输，默认第一个 |
| `name` | 服务名，作为队列组：同名实例分担消息，不同服务各收到一份事件。不设置时每个实例都会收到每条消息 |
| `timeout` | `send()` 的默认超时（毫秒），默认 `5000` |
| `listen` | 监听进程处理哪些传输，默认只有 `default` |
| `autoListen` | 应用启动时即开始监听（单体部署、测试），默认 `false` |
| `transports` | 具名的传输，见[传输](#传输) |

## 消息处理器

`app/message/*.ts` 中每个文件默认导出一个处理器或处理器数组，用 `defineMessageHandler(pattern, options?, handle)` 定义：

```ts
// app/message/orders.ts
import { NotFoundException } from '@hazejs/core'
import { defineMessageHandler } from '@hazejs/microservices'
import * as v from 'valibot'
import { Order } from '~/app/model/Order'

export default [
  // 请求 / 回复：返回值回传给调用方
  defineMessageHandler('orders.find', { schema: v.object({ id: v.number() }) }, async ({ id }) => {
    const order = await Order.find(id)
    if (!order)
      throw new NotFoundException(`Order ${id} not found`)
    return order
  }),

  // 事件：返回值被忽略
  defineMessageHandler('orders.created', async (order: { id: number }, ctx) => {
    ctx.logger.info(`order ${order.id} created`)
  }),
]
```

同一个处理器可以同时响应 `send()` 与 `emit()`，用 `ctx.kind`（`'request'` 或 `'event'`）区分。

| 选项 | 说明 |
| --- | --- |
| `schema` | 载荷的 Standard Schema（valibot、zod、arktype …），校验失败时调用方收到带 `issues` 的 `422` |
| `transport` | 只在这些传输上处理（`'grpc'` 或 `['nats', 'redis']`），默认所有监听中的传输 |

处理器收到的上下文：

| 成员 | 说明 |
| --- | --- |
| `ctx.pattern` / `ctx.kind` / `ctx.id` | 消息本身 |
| `ctx.transport` | 消息来自哪个传输 |
| `ctx.app` / `ctx.logger` | 应用，以及带模式标记的日志器 |
| `ctx.container` / `ctx.make(key)` | 本条消息的子[容器](./container)，处理结束后释放 |

`inject()` 只能在处理器的同步部分调用（与构造函数中一样）；`await` 之后请用 `ctx.make()`。

## 调用其它服务

```ts
// app/controller/CheckoutController.ts
import type { HttpContext } from '@hazejs/core'
import { Microservice } from '@hazejs/microservices'

export class CheckoutController {
  async show(ctx: HttpContext) {
    const orders = Microservice.client('nats')
    const order = await orders.send<Order>('orders.find', { id: Number(ctx.param('id')) }, { timeout: 3000 })
    await orders.emit('orders.viewed', { id: order.id })
    return order
  }
}
```

- `Microservice.client(name?)` 返回某个已配置传输的客户端；`Microservice.send()` / `Microservice.emit()` 使用默认传输。
- `send(pattern, data, { timeout })` 得到回复；`timeout: 0` 表示一直等待。
- `emit(pattern, data)` 在事件发出后即返回，不等待处理。
- 服务之间共享代码时，可以传入处理器定义代替字符串，载荷与回复类型自动推断：`client.send(FindOrder, { id: 1 })`。

客户端在第一次使用时连接，应用关闭时断开。也可以从容器解析 `MicroserviceManager`（`app.make(MicroserviceManager).client('nats')`）。

## 错误

| 情况 | 调用方收到的错误 | 状态码 |
| --- | --- | --- |
| 处理器抛出状态码小于 500 的 `HttpException`（`NotFoundException`、`BusinessException` …） | `RemoteError`，保留远端的状态码、`code` 与 `data` | 同远端 |
| 载荷未通过处理器的 `schema` | 带 `issues` 的 `RemoteError` | `422` |
| 处理器抛出其它错误 | `RemoteError`；未开启 `app.debug` 时不向 HTTP 客户端暴露消息 | `502` |
| `timeout` 内没有回复 | `MicroserviceTimeoutError` | `504` |
| 没有服务在监听（NATS no responders、内存传输、gRPC 服务不可达、未映射的 gRPC 模式） | `MicroserviceUnavailableError` | `503` |
| 监听方没有该模式的处理器 | 由 `NoHandlerError` 转成的 `RemoteError` | `404` |

这些错误都继承自 `HttpException`，在控制器中未捕获时会以合理的状态码渲染。`RemoteError` 提供 `pattern`、`remote`（序列化后的远端错误）与 `issues`。事件处理器抛出的错误只在接收方记录日志，不会传回发送方。

载荷与回复经 JSON 序列化（gRPC 为 protobuf），日期会变成字符串，类实例会变成普通对象。

## 运行监听进程

只有监听进程运行时，处理器才会收到消息。开发时：

```bash
npx haze microservice:listen                  # 监听 listen（或 default）中的传输
npx haze microservice:listen --transport nats,grpc
```

该命令在开发服务器的模块图中运行应用，不监听 HTTP 端口。每条消息都使用最新的代码，修改处理器无需重启；新增消息模式需要重启。

生产环境在 worker 入口中调用 `listenMicroservices(app)`，或设置 `autoListen: true` 在 Web 进程内监听：

```ts
// worker 入口
import { listenMicroservices } from '@hazejs/microservices'

const listener = await listenMicroservices(app, { transports: ['nats'] })
process.once('SIGTERM', async () => {
  await listener.close() // 停止接收，等待执行中的处理器完成
  await app.dispose()
})
```

## 传输

### NATS

使用官方的 [`@nats-io/transport-node`](https://github.com/nats-io/nats.js) 客户端（如果安装的是已弃用的 `nats` v2 包，也可以使用）。

| 选项 | 说明 |
| --- | --- |
| `servers` | 服务器地址，默认 `nats://127.0.0.1:4222` |
| `prefix` | 主题前缀；默认模式即主题（`orders.created`） |
| `queue` | 队列组，默认取配置的 `name` |
| `options` | 透传给 `connect()`（`user`、`pass`、`token`、`tls` …） |

`send()` 使用 NATS 的请求 / 回复，没有订阅者时立即以 `503` 失败。监听方按队列组订阅：每个请求与事件在同一服务的实例中只由一个处理，而每个服务各收到一份事件。

### Redis

使用 [ioredis](https://github.com/redis/ioredis)。

| 选项 | 说明 |
| --- | --- |
| `url` | 默认 `redis://127.0.0.1:6379` |
| `prefix` | 键与频道前缀，默认 `haze:ms:` |
| `concurrency` | 监听方同时处理的请求数，默认 `10` |
| `options` | 透传给 ioredis |

- `send()` 把请求写入列表（`<prefix>req:<pattern>`），监听方用 `BRPOP` 竞争消费，每个请求只由一个实例处理；回复经 pub/sub 发到调用方独占的频道。
- `emit()` 发布到 `<prefix>evt:<pattern>`。Redis pub/sub 没有队列组：**每个**监听中的实例都会收到每个事件。请让事件处理器保持幂等；需要每个服务只处理一次时请使用 NATS。
- Redis 无法得知是否有监听方，没有服务在线时 `send()` 会一直等到超时；过期的请求之后被取出时不再处理。

### gRPC

仅支持 Node，基于 [`@grpc/grpc-js`](https://github.com/grpc/grpc-node) 与 `@grpc/proto-loader`。`.proto` 中的一元方法映射为消息模式，由同一套处理器处理。

```proto
// proto/orders.proto
syntax = "proto3";
package orders;

service OrderService {
  rpc FindOne (OrderById) returns (Order);
}
message OrderById { int32 id = 1; }
message Order { int32 id = 1; string item = 2; }
```

```ts
// config/microservices.ts（节选）
transports: {
  grpc: {
    driver: 'grpc',
    url: '0.0.0.0:50051',          // 监听方绑定、客户端连接的地址
    protoPath: 'proto/orders.proto',
    package: 'orders',
    methods: { 'OrderService.FindOne': 'orders.find' }, // 不写时模式为 'OrderService.FindOne'
  },
},
```

| 选项 | 说明 |
| --- | --- |
| `url` | 监听方绑定、客户端连接的地址 |
| `protoPath` | 一个或多个 `.proto` 文件 |
| `package` | 只使用该 proto 包中的服务 |
| `methods` | 方法 → 模式；未列出的方法使用 `服务名.方法名` |
| `loader` | `@grpc/proto-loader` 选项，默认 `keepCase`、`longs: String`、`enums: String`、`defaults`、`oneofs` |
| `credentials` | `{ server, client }` TLS 凭据，默认不加密 |
| `channelOptions` | 透传给 gRPC 服务端与客户端 |

处理器的错误映射为 gRPC 状态码（404 → `NOT_FOUND`、422 → `INVALID_ARGUMENT`、401 → `UNAUTHENTICATED` …），完整的错误放在 `x-haze-error-bin` 元数据中，hazejs 客户端得到的 `RemoteError` 与其它传输一致。

限制：只支持一元调用（流式方法返回 `UNIMPLEMENTED`）；载荷按 proto 定义编解码，未声明的字段会丢失；`emit()` 是忽略结果的一元调用；不能在 Bun、Deno 或边缘运行时使用。

### 内存

进程内传输，用于测试，或在单体应用中先按模块拆分、之后再分开部署。同一进程中的客户端与监听方共用一条总线（`channel`，默认 `default`）。它的行为与网络传输一致：载荷经过 JSON，没有监听方时 `send()` 以 `503` 失败，队列组的负载均衡与 NATS 相同。

### 自定义传输

`{ driver: 'custom', create: () => transport }` 接入自己实现的 `Transport` 接口（`send`、`emit`、`listen`、`close`）。`createTransport(config)` 与 `createClient(transport)` 也可以在 hazejs 应用之外使用。

## 测试

使用内存传输，并在测试中开始监听：

```ts
// tests/orders.test.ts
import { listenMicroservices, MicroserviceManager } from '@hazejs/microservices'
import { useTestApp } from '@hazejs/testing'
import { expect, it } from 'vitest'

// .env.test：MICROSERVICE_TRANSPORT=memory（config/microservices.ts 的 default 读取它）
const t = useTestApp()

it('finds an order', async () => {
  await listenMicroservices(t.app)
  const order = await t.make(MicroserviceManager).client().send('orders.find', { id: 1 })
  expect(order).toMatchObject({ id: 1 })
})
```

## 限制

- 消息不持久化、不重试。需要在重启后继续执行的工作请使用[队列](./queues)。
- 消息模式在监听开始时订阅，新增模式需要重启。
- Redis 的事件会到达每个实例（见上文）；内存传输只在单个进程内有效。
