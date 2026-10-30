# Redis

hazejs 中有多个功能会用到 Redis：缓存存储、队列（BullMQ）、WebSocket 广播、广播总线、Socket.IO 适配器与微服务传输。它们的连接统一来自 `config/redis.ts`，各功能**按名字**引用连接。只需一个 `REDIS_URL` 就能配置全部功能，功能之间共用一个命令连接，而不是各自建立连接。

所有 TCP 访问都经由 [ioredis](https://github.com/redis/ioredis)（可选的 peer 依赖）：

```sh
pnpm add ioredis
```

::: tip 路径
本页示例使用 API 模板的目录结构（`app/...`、`config/...`）。全栈项目中这些目录位于 `server/` 下。
:::

## 配置

```ts
// config/redis.ts
import { defineRedisConfig, env } from '@hazejs/core'

export default defineRedisConfig(() => ({
  default: 'default',
  connections: {
    default: { url: env('REDIS_URL', 'redis://127.0.0.1:6379') },
    cache: { url: env('REDIS_CACHE_URL', 'redis://127.0.0.1:6379/1'), keyPrefix: 'cache:' },
  },
}))
```

| 选项 | 说明 |
| --- | --- |
| `default` | 功能未指定连接时使用的连接。默认 `default`，没有 `default` 时取第一个连接 |
| `connections` | 命名连接（见下文） |

**没有 `config/redis.ts` 时**只有一个隐式连接 `default`：读取 `REDIS_URL`，未设置时为 `redis://127.0.0.1:6379`。只用一个 Redis 的应用通常不需要这个文件。

然后在各功能中引用连接：

```ts
// config/cache.ts
stores: { redis: { driver: 'redis', connection: 'cache' } }

// config/queue.ts
connections: { redis: { driver: 'redis', connection: 'default' } }

// config/websocket.ts
broadcast: { driver: 'redis', connection: 'default', channel: 'my-app:ws' }
```

功能既没有设置 `connection` 也没有设置 `url` 时，使用 `default` 连接。

### 连接

一个连接是以下形式之一：

| 形式 | 选项 |
| --- | --- |
| 单机 | `url`（`redis://` 或 `rediss://`），或 `host`、`port`、`username`、`password`、`db`、`tls`（`true` 或 ioredis 的 TLS 选项） |
| Cluster | `cluster`：启动节点（`{ host, port }` 或 `'host:port'`）。节点选项（密码、TLS）放在 `options.redisOptions` 中；顶层的 `username` / `password` / `db` / `tls` 会复制过去 |
| Sentinel | `sentinels`：`[{ host, port }]`，加上 `name`（主节点名） |
| 自定义 | `client`：返回新 ioredis 实例的**工厂函数**，`() => new Redis(...)` |

每种形式都支持 `keyPrefix`（见[键前缀](#键前缀)）与 `options`（原样传给 ioredis：`connectTimeout`、`maxRetriesPerRequest`、`retryStrategy` 等）。

```ts
connections: {
  default: { url: env('REDIS_URL', 'redis://127.0.0.1:6379') },
  // TLS 与单独的账号密码
  managed: { host: 'redis.internal', port: 6380, username: 'app', password: env('REDIS_PASSWORD', ''), tls: true },
  cluster: {
    cluster: [{ host: '10.0.0.1', port: 6379 }, { host: '10.0.0.2', port: 6379 }],
    options: { redisOptions: { password: env('REDIS_PASSWORD', '') } },
  },
  sentinel: { sentinels: [{ host: '10.0.0.5', port: 26379 }], name: 'mymaster', password: env('REDIS_PASSWORD', '') },
  // 工厂函数而不是实例：hazejs 建立专用连接时会再次调用
  custom: { client: () => new Redis(env('REDIS_URL', ''), { enableAutoPipelining: true }) },
}
```

`client` 是工厂函数，这样 hazejs 才能用同样的设置建立专用连接（订阅、阻塞命令、BullMQ）。如果同一个文件里还用到 `Redis` 门面，请给 ioredis 的 `Redis` 起别名。

### 连接名的类型

开发服务器（以及 `haze typegen`）会与其它配置文件一起推导 `config/redis.ts` 的类型。生成之后，`config/cache.ts` 中的 `connection: 'cahce'` 或 `Redis.connection('cahce')` 无法通过类型检查。没有 `config/redis.ts` 时，连接名为普通字符串。

连接名生成在单独的接口（`GeneratedRedisConnections`）中，而不是从整个生成的配置中读取，因此其它配置文件可以引用连接名（`config/cache.ts` 中的 `connection: 'default'`）而不会形成循环类型。生成的导入带文件扩展名（`import("../../config/redis.ts")`），ESM 项目使用 `moduleResolution: "nodenext"` 时同样能解析。

## 直接使用 Redis

`Redis` 门面在默认连接上执行命令，`Redis.connection(name)` 切换连接：

```ts
import { Redis, useRedis } from '@hazejs/core'

await Redis.set('visits', 0)
await Redis.incr('visits')
await Redis.connection('cache').get('report:today')

// 函数形式，用于服务与组合函数
const cache = useRedis('cache')
await cache.hset('user:1', { name: 'Ada' })
```

命令发往该名字的**共享命令连接**（首次使用时建立）。常用命令带有类型，其它 ioredis 命令也可以同样调用，返回 `Promise<any>`。需要 pipeline、事务或完整的 ioredis 类型时，取客户端本身：

```ts
import type { Redis as IORedis } from 'ioredis'

const client = await Redis.client() as unknown as IORedis
await client.pipeline().set('a', 1).set('b', 2).exec()
```

不要在共享连接上 `SUBSCRIBE` 或执行阻塞命令（`BRPOP`、`XREAD BLOCK` 等），请另建专用连接；专用连接归调用方所有，用完 `quit()`：

```ts
const subscriber = await Redis.subscriber()
subscriber.on('message', (channel, message) => { /* ... */ })
await subscriber.subscribe('orders')

const blocking = await Redis.create('default', { maxRetriesPerRequest: null })
const item = await blocking.brpop('jobs', 5)
await blocking.quit()
```

在类中注入管理器：`inject(RedisManager).connection('cache')`。在应用之外（独立脚本）使用时，门面退回到读取 `REDIS_URL` 的隐式 `default` 连接。

## 缓存数据结构还是 Redis 门面

使用哈希、列表、集合与有序集合有两种方式：

```ts
// 通过缓存：自动加前缀、序列化、带类型
await Cache.store('redis').hash('user:1').set({ name: 'Ada', joined: new Date() }, '1h')

// 原始命令：发送什么就是什么
await Redis.hset('user:1', { name: 'Ada' })
```

| | `Cache.store('redis')` 的数据结构 | `Redis` 门面 |
| --- | --- | --- |
| 键 | 缓存 `prefix` + 租户前缀（+ 连接的 `keyPrefix`） | 只有连接的 `keyPrefix` |
| 值 | 与缓存值一样序列化（对象、`Date`、`BigInt` 原样读回），分数保持数字 | 传入的字符串与数字 |
| TTL | 按句柄设置，每次写入后应用；`expire()` / `ttl()` | 自己执行 `EXPIRE` |
| `Cache.clear()` | 随存储中的其它键一起清除 | 不受影响 |
| 测试 | `memory` 存储即可运行，不需要 Redis | 需要 Redis（或 mock 的 ioredis） |
| 覆盖范围 | 每种结构的常用命令 | 全部 Redis 命令、pipeline、事务、pub/sub、Stream、Lua |

属于缓存的业务数据用缓存的数据结构：排行榜、按字段计数、最近记录列表、在线用户集合等，凡是应当与缓存共用前缀、按租户隔离、随缓存一起清除的数据都适合。需要完全掌控键与编码（与其它服务或语言共享的数据）、缓存没有封装的命令（Stream、`SCAN`、`ZUNIONSTORE`、Lua）、pipeline 或 pub/sub 时，用 `Redis` 门面。两者使用同一个共享连接：存储配置为 `connection: 'default'` 时，`await Cache.store('redis').handler()` 与 `await Redis.client('default')` 是同一个客户端。详见 [缓存](./cache#redis-数据结构)。

## 各功能使用的连接

| 功能 | 配置 | 连接 |
| --- | --- | --- |
| 缓存存储 `redis`（以及基于它的限流、Session、锁、定时任务 `onOneServer`） | `config/cache.ts` 的 `stores.<name>.connection` | 共享命令连接 |
| 队列 `redis`（BullMQ） | `config/queue.ts` 的 `connections.<name>.connection` | BullMQ 自己的连接：每个队列一个，每个 Worker 两个（其中一个阻塞）。不与其它功能共用 |
| WebSocket 广播 | `config/websocket.ts` 的 `broadcast.connection` | 共享（发布）+ 1 个专用订阅连接 |
| 广播总线 | `config/broadcasting.ts` 的 `bus.connection`（缺省沿用 WebSocket 的设置） | 共享（发布、在线成员 Hash）+ 1 个专用订阅连接 |
| Socket.IO 适配器 | `config/socketio.ts` 的 `adapter.connection` | 共享（发布）+ 1 个专用订阅连接 |
| 微服务 `redis` 传输 | `config/microservices.ts` 的 `transports.<name>.connection` | 客户端：共享 + 1 个专用（回复）。监听：共享 + 2 个专用（`BRPOP`、事件） |
| `Redis` 门面、`useRedis()` | — | 共享；`subscriber()` / `create()` 为专用 |
| `redisCheck()` | `config/health.ts` | 共享（`PING`） |

因此，一个在同一个 `REDIS_URL` 上使用缓存、WebSocket 广播、广播与 Socket.IO 的应用，只建立一个共享连接，外加每个 pub/sub 功能一个订阅连接，而不是每个功能一对连接。队列是例外：BullMQ 自己管理连接，只接收连接设置。

共享连接按需建立，开发时跨热更新保留，应用关闭（`app.dispose()`、`SIGTERM`）时断开。专用连接由建立它的功能关闭，应用关闭时再兜底断开剩下的。

### BullMQ

BullMQ 要求 `maxRetriesPerRequest: null`，并且不允许 ioredis 的 `keyPrefix`。因此队列驱动拿到的是连接的**设置**（地址、主机、密码、TLS、Sentinel、`options`），去掉 `keyPrefix` 并设置 `maxRetriesPerRequest: null`，由 BullMQ 自己建立连接。区分应用请用队列的 `prefix` 选项（默认 `haze`）。Cluster 与自定义连接时，驱动拿到一个专用实例（队列共用、Worker 复制），随队列关闭。Cluster 上请给 `prefix` 加哈希标签，如 `{haze}`。

## 键前缀

`keyPrefix` 是 ioredis 的键前缀，只加在**键**上：

- **缓存**：连接的前缀加在缓存前缀之前：`cache:` + `my-app:` + `key`。`Cache.flush()` 会考虑它（ioredis 不给 `SCAN` 的模式加前缀，由存储处理）。[多租户](./tenancy)自己在缓存前缀之内为键加上租户，不受影响。
- **pub/sub 的频道名不加前缀。** WebSocket 广播（`channel`）、广播总线（`prefix`）与 Socket.IO 适配器（`key`）各自有频道前缀，多个应用共用一个 Redis 时请设置它们。广播总线的在线成员 Hash 与微服务的请求列表是键，会加上前缀。
- **BullMQ** 忽略它（见上文）。

## 内联设置（向后兼容）

原来各功能自己的写法仍然可用，并且优先于 `connection`：

```ts
stores: { redis: { driver: 'redis', url: env('REDIS_URL', 'redis://127.0.0.1:6379') } }
```

优先级为 `client`（仅缓存：已创建的 ioredis 实例）> `url` > `connection` > 默认连接。`options` 与 `url` 一起时是这个内联连接的选项；与 `connection` 一起时为该功能覆盖命名连接的选项，此时该功能使用单独的连接。缓存存储的内联 `url` 写法保持原来的默认值（`maxRetriesPerRequest: 2`）；命名连接严格使用你配置的选项。

也能在应用之外运行的功能（如 `@hazejs/microservices` 的 `createTransport()` / `redisTransport()`）以同样的方式解析连接，并退回到 `REDIS_URL`（或 `redis://127.0.0.1:6379`）；单独使用时，所有连接都归它自己并由它关闭。

## 健康检查

`config/health.ts` 中的 `redisCheck()` 在连接上发送 `PING`：

```ts
checks: {
  redis: redisCheck(),          // 默认连接
  cache: redisCheck('cache'),   // 命名连接
}
```

名字**先按 Redis 连接名**查找，再按**缓存存储名**查找（旧写法：对 `redis` 或 `upstash` 存储做读写检查）。两者都不是时结果为 `down`。仍然可以传入任何带 `ping()` 的对象。见[可观测性](./observability)。

## Upstash 与边缘运行时

ioredis 需要 TCP 套接字，不能在 Cloudflare Workers 等边缘运行时中运行（Workers 构建中会被替换为桩模块）。在这些平台上请使用缓存的 `upstash` 驱动：它通过 `@upstash/redis` 走 HTTP，在 `config/cache.ts` 中用自己的 `url` / `token` 配置，不使用 `config/redis.ts`。Workers 上的队列使用 Cloudflare Queues，广播只在一个 isolate 内有效。

| | ioredis（`config/redis.ts`） | Upstash（`upstash` 缓存驱动） |
| --- | --- | --- |
| 协议 | TCP（RESP） | HTTP（REST） |
| 运行环境 | Node、Bun、Deno、Docker、Lambda | 另外支持 Workers、Vercel Edge、Netlify |
| 使用者 | 缓存、队列、WebSocket、广播、Socket.IO、微服务、门面 | 仅缓存存储 |
| pub/sub、阻塞命令 | 支持 | 不支持 |
