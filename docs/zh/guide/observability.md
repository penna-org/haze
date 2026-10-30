# 可观测性

hazejs 提供四项可观测性能力：

- **健康检查**：`/health`、`/health/ready` 与 `/health/live`，供负载均衡与容器编排探测；
- **OpenTelemetry**：HTTP 请求、数据库查询、队列任务、邮件与 AI 调用的链路和指标，支持 W3C 追踪上下文传播，需要安装可选依赖 `@opentelemetry/api`；
- **开发面板**：开发时访问 `/__haze`，查看请求、查询、任务、邮件、事件、缓存操作、日志、异常、AI 调用与出站 HTTP 请求的记录；
- **队列面板**：查看失败任务并重试或删除；它是开发面板的一个标签页，也可以挂在生产环境中，由你自己的中间件保护。

日志通道（文件、发送到 Loki / Datadog / Better Stack 等）见[异常与日志](./errors#channels)。

## 健康检查 {#health-checks}

健康检查默认开启，但没有配置任何检查项。在 `config/health.ts` 中添加：

```ts
// config/health.ts
import { cacheCheck, dbCheck, defineHealthConfig, queueCheck, redisCheck, storageCheck } from '@hazejs/core'
import { Db } from '@hazejs/orm'

export default defineHealthConfig({
  // path: '/health',
  timeout: 3000,
  checks: {
    db: dbCheck(Db),
    cache: cacheCheck(),
    redis: redisCheck(), // 对 config/redis.ts 的默认连接 PING
    storage: { check: storageCheck('s3'), critical: false },
    queue: queueCheck({ connection: 'redis', maxFailed: 100 }),
    payments: async ({ signal }) => {
      const response = await fetch('https://status.example.com/api', { signal })
      return response.ok || { status: 'degraded', message: `status page returned ${response.status}` }
    },
  },
})
```

| 路径 | 用途 | 响应 |
|------|------|------|
| `GET /health/live` | 存活检查：进程能处理请求 | 始终为 `200 { "status": "ok" }` |
| `GET /health`、`GET /health/ready` | 就绪检查：并行执行全部检查项 | `ok` 或 `degraded` 时为 `200`，`down` 时为 `503` |

就绪检查的响应：

```json
{
  "status": "degraded",
  "checks": {
    "db": { "status": "ok", "latencyMs": 1.42 },
    "storage": { "status": "down", "latencyMs": 3000.4, "message": "timed out after 3000ms" }
  }
}
```

- 检查函数没有返回值、返回 `true` 或字符串（作为 `message`）时为正常；返回 `false` 或抛错时为故障；也可以返回 `{ status: 'degraded', message }`。
- **关键**检查（默认）故障时整体状态为 `down`；非关键检查（`critical: false`）故障，或有检查返回 `degraded` 时，整体为 `degraded`。
- 每项检查都有超时（`timeout`，默认 5000 毫秒；单项用 `{ check, timeout }` 设置），超时后检查函数收到的 `signal` 会被中止。
- 非生产环境的响应中会显示错误原因。生产环境只写入日志，响应中为 `check failed`，避免泄露主机名、连接串等信息；需要时可设置 `verbose: true`。
- `cache: 5000` 在 5 秒内复用就绪检查的结果，避免探针频繁访问数据库。

这些路径在全局中间件之前处理：不受鉴权、CSRF、限流影响，也不套用统一响应格式。项目中定义了 `GET /health` 路由时以项目路由为准。`enabled: false` 关闭，`path` 修改路径。

内置检查：

| 检查 | 说明 |
|------|------|
| `dbCheck(Db, { connection?, query? })` | 经 `@hazejs/orm` 的 `Db` 执行 `select 1`（由你传入 Db，core 不依赖 ORM） |
| `cacheCheck(store?)` | 写入、读回并删除一个短期键 |
| `redisCheck(名字? \| 客户端)` | 对 [Redis 连接](./redis)发送 `PING`（默认为 `default` 连接）。名字不是连接名而是缓存存储名时，对该存储做读写检查（旧写法）。也可以传入 ioredis 等客户端，调用其 `ping()` |
| `storageCheck(disk?)` | 检查磁盘能否响应（只读） |
| `queueCheck({ connection?, maxFailed? })` | 返回等待 / 延迟 / 执行中 / 失败数量，失败数超过 `maxFailed` 时为 `degraded` |

Kubernetes 示例：

```yaml
livenessProbe:
  httpGet: { path: /health/live, port: 3000 }
readinessProbe:
  httpGet: { path: /health/ready, port: 3000 }
  periodSeconds: 10
```

::: tip 全栈项目
全栈模式下，开发服务器只把 `/api/*` 交给后端。如果负载均衡要经过同一个服务访问健康检查，请设置 `path: '/api/health'`。
:::

## OpenTelemetry

hazejs 只依赖 `@opentelemetry/api`（可选 peer 依赖）。SDK（导出器、采样、资源信息）由你自己安装并启动，数据发往哪里完全由你决定。

```bash
pnpm add @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-metrics-otlp-http @opentelemetry/sdk-metrics
```

```ts
// config/observability.ts
import { defineObservabilityConfig } from '@hazejs/core'

export default defineObservabilityConfig({
  otel: {
    enabled: true,
    // traces: { cache: true },      // 缓存 span 默认关闭
    // metrics: false,
    // ignorePaths: ['/health', '/__haze', /^\/assets\//],
  },
})
```

### 启动 SDK

SDK 必须在应用之前启动。写在一个普通的 `.mjs` 文件里，用 Node 的 `--import` 加载：

```js
// instrumentation.mjs
import process from 'node:process'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'

const sdk = new NodeSDK({
  serviceName: 'my-app',
  traceExporter: new OTLPTraceExporter(), // OTEL_EXPORTER_OTLP_ENDPOINT，默认 http://localhost:4318
  metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }),
})
sdk.start()
process.once('beforeExit', () => sdk.shutdown())
```

```bash
node --import ./instrumentation.mjs dist/index.mjs        # 生产环境
NODE_OPTIONS='--import ./instrumentation.mjs' haze dev    # 开发环境
node --import ./instrumentation.mjs dist/worker.mjs queue # 队列 worker
```

`NodeSDK` 会注册 hazejs 依赖的 AsyncLocalStorage 上下文管理器与 W3C 传播器。`app.serve()` 释放应用后会立即退出进程，如果要在关闭时写出剩余的 span，请在服务提供者的 `shutdown()` 钩子中调用 `sdk.shutdown()`。hazejs 已经为每个请求创建 HTTP 服务端 span，请不要对入站请求启用 `@opentelemetry/instrumentation-http`（或者移除它），以免重复；出站的 `http` / `undici` 自动埋点不受影响。

`otel.enabled` 为 false（默认）或没有安装该包时，所有埋点都是空操作，开销只有一次变量判断。开启了 `enabled` 却没有安装 `@opentelemetry/api` 时，hazejs 会输出警告并继续运行。

### 记录的 span

| Span | 类型 | 属性 |
|------|------|------|
| `GET /users/:id`（每个请求一个） | SERVER | `http.request.method`、`url.path`、`url.query`、`url.scheme`、`http.route`、`http.response.status_code`、`server.address`、`server.port`、`user_agent.original`、`error.type` |
| `SELECT`、`INSERT` 等（`@hazejs/orm` 的查询） | CLIENT | `db.system.name`、`db.query.text`、`db.operation.name`、`db.namespace`（连接名） |
| `send <队列>` / `process <队列>` | PRODUCER / CONSUMER | `messaging.system`、`messaging.operation.type`、`messaging.destination.name`、`messaging.message.id`、`haze.job.name`、`haze.job.attempt`、`haze.job.status` |
| `mail.send` | CLIENT | `haze.mail.mailer`、`haze.mail.driver`、`haze.mail.recipients` |
| `chat <模型>` / `embeddings <模型>`（`@hazejs/ai`） | CLIENT | `gen_ai.operation.name`、`gen_ai.provider.name`、`gen_ai.request.model`、`gen_ai.usage.input_tokens`、`gen_ai.usage.output_tokens`、`gen_ai.response.finish_reasons` |
| `cache.get`、`cache.set` 等（需开启） | CLIENT | `haze.cache.store`、`haze.cache.key`、`haze.cache.hit` |
| `GET`（`tracedFetch`、[`Http`](./http-client)） | CLIENT | `http.request.method`、`url.full`、`server.address`、`http.response.status_code` |

5xx 响应会把 span 标记为错误，异常处理器渲染的异常作为 span 事件记录。用 `traces: { db: false, ai: false, … }` 关闭某类 span。健康检查与开发面板的路径默认忽略。

你自己创建的 span 会自动挂在请求 span 之下：

```ts
import { trace } from '@opentelemetry/api'

const tracer = trace.getTracer('billing')
await tracer.startActiveSpan('charge', async (span) => {
  try {
    await gateway.charge(order)
  }
  finally {
    span.end()
  }
})
```

### 追踪上下文传播

- **入站**：请求头中的 `traceparent` / `tracestate` 会接续调用方的链路。
- **出站 HTTP**：经 [`Http` 客户端](./http-client)发出的请求都会创建 CLIENT span，并把 `traceparent` 传给下游；直接用 `fetch` 时可以改用 `tracedFetch()`，效果相同。未启用 OpenTelemetry 时两者都是普通的 `fetch`。
- **队列**：`dispatch()` 把追踪上下文写入任务消息（`message.context`），worker 执行时接续同一条链路，即使在另一个进程中或经过 Redis。
- **自定义传输**：`injectTraceContext(carrier)` 把当前上下文写入普通对象；`withTraceContext(carrier, fn)` 在从对象中恢复的上下文中执行 `fn`。

```ts
import { injectTraceContext, tracedFetch, withTraceContext } from '@hazejs/core'

const res = await tracedFetch('https://inventory.internal/api/stock', { method: 'POST', body })

await bus.publish('orders', { order, headers: injectTraceContext() })
bus.subscribe('orders', message => withTraceContext(message.headers, () => handle(message.order)))
```

没有注册传播器时，hazejs 会自己读写 W3C `traceparent`。

### 指标

| 指标 | 类型 | 属性 |
|------|------|------|
| `http.server.request.duration`（秒） | Histogram | 方法、协议、`http.route`、`http.response.status_code`、`error.type` |
| `http.server.active_requests` | UpDownCounter | 方法、协议 |
| `messaging.process.duration`（秒） | Histogram | 队列、`haze.job.name`、`error.type` |
| `haze.queue.job.failures` | Counter | 队列、`haze.job.name`（所有重试都失败的任务） |

### 日志

有活动的 span 时，JSON 日志（以及所有非 console 的[日志通道](./errors#channels)）会带上 `trace_id` 与 `span_id`，日志平台可以从日志跳转到对应的链路。

### Cloudflare Workers 与其它运行时

埋点只依赖 `@opentelemetry/api`，因此在 Bun、Deno 和 Workers 上都能运行，但 `NodeSDK` 只支持 Node。Workers 上需要兼容 Workers 的 TracerProvider（例如基于 OTLP 导出器的社区包），开启 `nodejs_compat` 以使用 AsyncLocalStorage，并用 `ctx.waitUntil()` 写出 span。Bun 与 Deno 能否使用常规的 SDK 包，取决于你选用的导出器是否支持该运行时。

## 开发面板 {#dev-dashboard}

开发时打开 `http://localhost:3000/__haze`（全栈项目为 Vite 开发服务器的端口）。面板在内存中记录：

- **请求**：方法、路径、路由模式、状态码、耗时、请求 ID、客户端 IP，以及请求头与响应头（`authorization`、`cookie`、`set-cookie`、`x-api-key` 与 CSRF 令牌已脱敏）；
- `@hazejs/orm` 的 **SQL 查询**，含绑定参数与耗时；
- 投递与执行的**任务**（状态、第几次执行、耗时、错误）；
- 发送的**邮件**，可在沙箱中预览渲染后的 HTML；
- **事件**、**缓存**命中 / 未命中 / 写入、**日志**、**异常**（5xx）、**AI 调用**（模型、token、延迟），以及经 [`Http`](./http-client) 发出的**出站请求**（方法、URL、状态码、耗时、大小，凭据已脱敏）。

所有记录都关联到引发它的请求，包括之后才执行的任务及任务中发送的邮件。点击请求即可在同一页看到它的查询、任务、邮件与日志。新记录通过 Server-Sent Events 实时推送。调试模式渲染开发错误页时，页面上有指向面板中该请求的链接。

面板是一个自包含的页面，不依赖 CDN，也不需要构建。它在全局中间件之前处理，并且**只在开发环境启用**：生产与测试环境中即使配置了 `enabled: true` 也不会安装。

```ts
// config/observability.ts
export default defineObservabilityConfig({
  dashboard: {
    // enabled: false,
    // path: '/__haze',
    limit: 1000, // 每类记录保留的条数（环形缓冲），默认 500
    redactHeaders: ['x-tenant-token'],
    ignorePaths: ['/api/poll'],
  },
})
```

数据也可以通过 JSON API 读取：

| 路径 | 说明 |
|------|------|
| `GET /__haze/api/entries?type=query&requestId=&limit=&after=` | 记录列表，最新的在前（`type`：`request`、`query`、`job`、`mail`、`event`、`cache`、`log`、`exception`、`ai`） |
| `GET /__haze/api/entries/:id` | 单条记录 |
| `GET /__haze/api/requests/:requestId` | 某个请求及其关联的全部记录 |
| `GET /__haze/api/stats` | 各类记录的数量 |
| `GET /__haze/api/stream` | Server-Sent Events：每条新记录对应一个 `event: entry` |
| `POST /__haze/api/clear` | 清空记录 |

### 记录方式

core 通过一个进程内的轻量遥测总线上报。没有监听者时（例如生产环境未开启 OpenTelemetry），每次上报只是一次 `Set.size` 判断。`@hazejs/orm` 与 `@hazejs/ai` 不需要为此导入 core，它们通过 `globalThis[Symbol.for('hazejs.telemetry')]` 找到总线。你自己的包也可以用同样的方式上报和监听：

```ts
import { onTelemetry, recordTelemetry } from '@hazejs/core'

const stop = onTelemetry((kind, data) => {
  if (kind === 'query' && data.duration > 500)
    console.warn('Slow query', data.sql)
})
```

## 队列面板

开发面板的 **Queues** 标签页按队列连接（`sync` 除外）显示等待 / 延迟 / 执行中 / 失败的数量，以及失败任务的错误与载荷。可以重试单个任务、全部重试、删除单个任务（forget）或清空全部失败任务，效果与 `haze queue:retry`、`queue:forget`、`queue:flush` 相同。

生产环境中可以在路由文件里挂载，由你自己的中间件保护：

```ts
// route/admin.ts
import { defineRoutes, queueDashboard } from '@hazejs/core'

export default defineRoutes((r) => {
  r.group({ middleware: ['auth', 'can:viewQueues'] }, (r) => {
    queueDashboard(r, { path: '/admin/queues' })
  })
})
```

```ts
// app/policy/abilities.ts
import type { User } from '~/app/model/User'
import { defineAbilities } from '@hazejs/core'

export default defineAbilities({
  viewQueues: (user: User) => user.role === 'admin',
})
```

这会注册 `GET /admin/queues`（页面）与 `/admin/queues/api`（JSON API），这些路由不会出现在 OpenAPI 文档中。重试、删除与清空要求带上 `x-haze-dashboard: 1` 请求头，页面发送请求时会带上它以及 `XSRF-TOKEN` Cookie 的值，因此可以和 CSRF 保护一起使用，也无法从其它站点发起。`path` 默认为 `/__haze/queues`；开发环境中开发面板会先处理这个路径。

只有 `memory` 与 `redis` 驱动提供数量统计。Cloudflare Queues 由 Worker 消费，失败任务进入 wrangler 中配置的死信队列。
