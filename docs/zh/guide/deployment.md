# 部署

`haze build` 按目标平台生成生产产物。同一个项目（纯后端或[全栈](./fullstack)）只需切换部署预设，就能部署到常驻服务器、容器、Serverless 函数或 Cloudflare Workers。

## 构建

```bash
haze build                     # node 预设（默认）
haze build --preset docker     # 或 -p docker
haze build --preset cloudflare --minify
```

也可以在 `haze.config.ts` 中设置预设，命令行的 `--preset` 优先：

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  preset: 'cloudflare',
})
```

全栈项目中，`haze build` 会按 `vite.config.ts` 执行 `vite build`，一次产出 `dist/client` 与服务端产物。直接运行 `vite build` 时，预设取自 `haze.config.ts` 或环境变量 `HAZE_PRESET`。

其它构建参数：`--minify`（默认不压缩）与 `--outDir`（仅纯后端项目；全栈项目请在 `haze.config.ts` 中设置 `outDir`）。纯后端项目每次构建前会清空输出目录（仅当它位于项目目录之内），上次构建或其它预设留下的文件不会进入 Docker 构建上下文。

## 部署预设

| 预设 | 产物 | 运行 / 部署 |
|------|------|-------------|
| `node` | `dist/index.mjs`（全栈：`dist/server/index.mjs` + `dist/client`） | `node dist/index.mjs` 或 `haze start` |
| `bun` | 与 `node` 相同 | `bun dist/index.mjs` |
| `deno` | `dist/server/index.mjs` | `deno run -A dist/server/index.mjs` |
| `docker` | `dist/` 即构建上下文：`server/`、`Dockerfile`、运行时 `package.json` | `docker build -t app dist` |
| `aws-lambda` | `dist/lambda/`（全栈时前端产物也在其中） | 打包 `dist/lambda` 为 zip，handler 为 `index.handler` |
| `vercel` | `.vercel/output/`（Build Output API） | `vercel deploy --prebuilt` |
| `netlify` | `dist/server/`、`.netlify/v1/functions/haze-server.mjs`、`netlify.toml` | `netlify deploy --build` |
| `cloudflare` | `dist/index.mjs`（单文件 Worker）+ `dist/wrangler.json` | `npx wrangler deploy -c dist/wrangler.json` |

每次构建结束，命令行都会打印当前项目实际可用的命令，包括迁移与 worker 的命令。

全栈项目中，`node`、`bun`、`deno`、`docker` 与 `aws-lambda` 由同一进程托管 `dist/client`（非 API 路径回退到 SPA 入口）；`vercel`、`netlify` 与 `cloudflare` 的静态文件由平台 CDN 提供，只有后端前缀下的请求才会进入函数。

## 环境变量与 APP_KEY

`APP_KEY` 用于签名 Cookie、加密 Session、签发 JWT 与存储签名链接，生产环境必须设置。用 `haze key:generate` 生成，并妥善保管。

| 预设 | 提供方式 |
|------|----------|
| node / bun / deno | 启动时从工作目录加载 `.env` 与 `.env.production`（`haze start` 在项目根目录运行），真实环境变量始终优先 |
| docker | `docker run -e APP_KEY=<key> …`（或编排平台的密钥管理）；`.env` 不会进入镜像 |
| aws-lambda | Lambda 的环境变量 |
| vercel | `vercel env add APP_KEY` |
| netlify | `netlify env:set APP_KEY <key>` |
| cloudflare | `npx wrangler secret put APP_KEY -c dist/wrangler.json`；普通变量写在 `vars` 中 |

常驻进程型预设监听 `PORT`（默认取 `haze.config.ts` 的 `port`，否则为 3000）与 `HOST`（默认 `0.0.0.0`）。

## 依赖处理

与 Nitro 一样，hazejs 会把能打包的依赖全部打进产物。数据库驱动、原生模块以及少数无法打包的包保持 external，构建后用 nf3（Nitro 使用的依赖追踪工具）追踪实际引用的文件，复制到产物的 `node_modules` 中。产物因此是自包含的：把 `dist/` 拷到服务器上，不需要 `pnpm install` 就能运行。

| 预设 | 打包 | external 的包 |
|------|------|---------------|
| node / bun / deno | 除驱动外全部打包 | 追踪复制到入口旁的 `node_modules` |
| aws-lambda / vercel | 除驱动外全部打包 | 始终追踪 |
| docker | 除驱动外全部打包 | 在镜像内 `npm install`，保证得到 Linux 平台的原生二进制 |
| netlify | 除驱动外全部打包 | 由 Netlify 在部署时打包 |
| cloudflare | 全部打包 | 不支持的驱动替换为空模块 |

只有项目实际安装的驱动才会被带上。可以在 `haze.config.ts` 中调整：

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  externals: {
    traceDeps: ['sharp', 'some-pkg*'], // 保持 external 并追踪（末尾的 * 表示整包复制）
    inline: ['postgres'], // 强制打包
    // trace: false,                    // node / bun：依赖全部 external，运行时使用项目的 node_modules
  },
})
```

::: warning 请在 Linux 上构建 Lambda 与 Vercel 产物
`aws-lambda` 与 `vercel` 运行在 Linux 上。在 macOS / Windows 上构建时，如果追踪到了特定平台的原生二进制，构建会给出警告。请在 CI 或 Docker 中构建这两个预设，确保复制的是正确的二进制。
:::

## 生产迁移

迁移文件已打包进产物，生产环境既不需要源码，也不需要 drizzle-kit。

| 预设 | 执行迁移 |
|------|----------|
| node / bun | `node dist/migrate.mjs`（`bun dist/migrate.mjs`），全栈为 `dist/server/migrate.mjs`；参数 `--connection <name>`、`--all` |
| deno | `deno run -A dist/server/migrate.mjs` |
| docker | `docker run --rm <镜像> node server/migrate.mjs` |
| aws-lambda | 同一份产物，handler 设为 `index.migrate` 调用一次（事件 `{ "connection"?, "all"? }`） |
| vercel / netlify | 在构建命令前执行 `npx haze db:migrate`（使用生产库的 `DATABASE_URL`） |
| cloudflare（D1） | `npx wrangler d1 migrations apply <库名> --remote -c dist/wrangler.json` |
| cloudflare（Turso） | 在 CI 中执行 `npx haze db:migrate` |

只有项目使用 `@hazejs/orm` 时才会生成 `migrate.mjs`。详见[数据库](./database)。

## 队列 worker、定时任务与命令

`node`、`bun`、`deno` 与 `docker` 预设还会输出 `worker.mjs`：

```bash
node dist/worker.mjs queue                     # 消费任务（默认队列 default）
node dist/worker.mjs queue --queue emails,default --concurrency 5 --connection redis
node dist/worker.mjs schedule                  # 常驻的定时任务调度器
node dist/worker.mjs schedule:run              # 执行一次到期任务（由系统 cron 每分钟调用）
node dist/worker.mjs command                   # 列出自定义命令（app/command）
node dist/worker.mjs command inspire --all     # 运行其中一个，退出码与命令一致
```

worker 收到 `SIGTERM` / `SIGINT` 后会等执行中的任务完成再退出。全栈项目（以及 `deno` 预设）的路径为 `dist/server/worker.mjs`；Docker 中为 `docker run <镜像> node server/worker.mjs queue`。

`--connection` 是 `config/queue.ts` 中的队列连接。worker 与 Web 进程读取同一个 `REDIS_URL`（或 `config/redis.ts`），每个环境只需设置一次 [Redis](./redis) 连接。

`worker.mjs command` 不依赖命令行工具和源码，直接运行 `app/command` 下的[自定义命令](./console)，生产环境中的一次性维护操作和由 cron 触发的脚本都可以放在这里。Serverless 与 Edge 预设没有命令入口。

其它平台的定时任务由平台触发：Cloudflare 用 Cron Triggers，Lambda 用 EventBridge 规则，Vercel 用 Vercel Cron。详见[队列](./queues)与[定时任务](./scheduling)。

### 微服务监听进程 {#microservice-listeners}

`app/message` 下的[微服务](./microservices)处理器只有在监听进程运行时才会收到消息。`haze microservice:listen` 是开发命令，依赖命令行工具和源码。生产环境中，可以在 `config/microservices.ts` 中设置 `autoListen: true`，让每个 Web 实例同时监听；也可以单独运行一个进程。构建产物没有专门的微服务入口，写一个常驻的命令即可：

```ts
// app/command/ListenMessages.ts —— node dist/worker.mjs command listen:messages
import process from 'node:process'
import { defineCommand } from '@hazejs/core'
import { listenMicroservices } from '@hazejs/microservices'

export default defineCommand({
  description: '监听微服务消息',
  async run(_args, { app }) {
    const listener = await listenMicroservices(app)
    await new Promise((resolve) => {
      process.once('SIGTERM', resolve)
      process.once('SIGINT', resolve)
    })
    await listener.close() // 停止接收新消息，等执行中的处理器完成
  },
})
```

与队列 worker 一样，监听进程需要常驻运行，因此 Serverless 与 Edge 预设不支持。

## 维护模式 {#maintenance-mode}

部署、迁移或修复数据期间可以让应用进入维护模式。常驻进程型预设的产物内置了这些命令：

```bash
node dist/worker.mjs down --secret=deploy-2026 --retry=60   # 除访问过 /deploy-2026 的浏览器外，所有请求返回 503
node dist/migrate.mjs
# ……重启 Web 进程……
node dist/worker.mjs up
```

各实例从缓存存储（`config/maintenance.ts`）读取状态，因此使用 Redis 等共享存储时，一条命令即可让所有实例进入维护，`up` 在两秒内到达每个实例。使用默认的进程内 `memory` 存储时，状态保存在 `storage/framework/down`，只影响这台机器。健康检查仍返回 200，负载均衡不会摘除实例；队列 worker 在任务之间暂停，定时任务被跳过。

旧实例在新实例就绪前继续服务的滚动部署通常不需要维护模式；旧代码无法在新表结构上运行的迁移才需要它。Workers、Vercel、Netlify 与 Lambda 没有 `worker.mjs`：请使用共享存储（KV、Upstash），在 CI 中设置状态键。详见 [维护模式](./maintenance#serverless-与边缘)。

## 健康检查

产物默认提供 `/health/live`（存活检查，始终返回 200）与 `/health` / `/health/ready`（就绪检查：执行 `config/health.ts` 中的检查项，关键检查故障时返回 503）。它们不经过全局中间件，负载均衡探测无需凭据：

```ts
// config/health.ts
import { cacheCheck, dbCheck, defineHealthConfig } from '@hazejs/core'
import { Db } from '@hazejs/orm'

export default defineHealthConfig({
  checks: { db: dbCheck(Db), cache: cacheCheck() },
})
```

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/health/ready || exit 1
```

Kubernetes 中把 `livenessProbe` 指向 `/health/live`，`readinessProbe` 指向 `/health/ready`。生产环境中故障原因只写入日志，不出现在响应里。内置检查与 OpenTelemetry 的配置见[可观测性](./observability#health-checks)。

## 预览产物

```bash
haze build --preset vercel
haze preview          # 或 pnpm preview；全栈项目也可以直接 vite preview
```

`haze preview` 按构建时的预设（记录在 `.haze/build.json` 中）运行**构建产物**本身，默认端口 4173（支持 `--port`、`--host`、`--open`）：

| 预设 | 运行方式 |
|------|----------|
| node / docker | 启动产物进程并把请求转发给它（从项目根目录加载 `.env`） |
| bun / deno | 同上，使用 Bun 或 Deno 运行（Deno 也可以来自 npm 的 `deno` 包） |
| aws-lambda / vercel / netlify | 在进程内调用函数 handler |
| cloudflare | 用 Miniflare 运行 Worker（`pnpm add -D miniflare`） |

`cloudflare` 预览时，`vars`、D1、KV 与 Durable Object 绑定读取自 `dist/wrangler.json`，`.env` / `.env.production` 中的值作为绑定传入，本地数据持久化在 `.haze/preview`，D1 迁移会自动应用。没有安装 Miniflare 时，也可以改用 `npx wrangler dev -c dist/wrangler.json`。

## Docker

```bash
haze build --preset docker
docker build -t my-app dist
docker run -p 3000:3000 -e APP_KEY=<key> my-app
```

生成的 `dist/Dockerfile` 基于 `node:22-slim`。业务代码与纯 JS 依赖已经打包，运行时 `package.json` 只列出 external 的驱动，它们在镜像内以 `npm install --omit=dev` 安装，原生二进制因此是 Linux 版本。同时还会生成 `.dockerignore`，镜像带有访问 `/health/live` 的 `HEALTHCHECK`（在 `config/health.ts` 中修改了健康检查路径时请同步调整）。

纯后端项目也可以托管另外构建的前端：把前端构建产物复制进镜像，在 `config/static.ts` 中指向它（相对路径按项目根目录解析；`dir` 未设置时不托管）：

```ts
// config/static.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  dir: env('WEB_DIST_DIR'),
  spaFallback: true,
  precompressed: true,
  exclude: ['/api', '/socket.io'],
}))
```

## AWS Lambda

`dist/lambda` 中包含 `index.mjs`、追踪得到的 `node_modules`，以及（全栈项目的）前端产物。把目录打包为 zip，创建运行时为 `nodejs22.x` 的函数：

| Handler | 用途 |
|---------|------|
| `index.handler` | HTTP：API Gateway（HTTP API 与 REST API）、ALB、Function URL 事件 |
| `index.schedule` | 定时任务，由 EventBridge 规则 `rate(1 minute)` 触发 |
| `index.migrate` | 生产迁移（仅在使用 `@hazejs/orm` 时） |

三者使用同一份产物。Lambda 上不支持 WebSocket 与 Socket.IO。

## Vercel

`vercel` 预设按 [Build Output API](https://vercel.com/docs/build-output-api) 的结构输出到 `.vercel/output`：静态文件在 `static/`，服务端在 `functions/__server.func`（Node.js 22），路由规则在 `config.json`。用 `vercel deploy --prebuilt` 部署。

项目中有定时任务时，会自动配置 Vercel Cron 每分钟调用 `/__haze/schedule`。请设置 `CRON_SECRET`（`vercel env add CRON_SECRET`），没有携带 `Authorization: Bearer $CRON_SECRET` 的请求会得到 401。Hobby 计划只允许每天执行一次，需要调整表达式：

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  preset: 'vercel',
  vercel: { cron: '0 3 * * *' },
})
```

## Netlify

`netlify` 预设把服务端构建到 `dist/server`，并在 `.netlify/v1/functions/haze-server.mjs` 生成 Netlify Functions（v2）入口。项目中没有 `netlify.toml` 时会自动生成一份，包含构建命令与发布目录；全栈项目还会生成用于 SPA 回退的 `_redirects`。用 `netlify deploy --build` 部署。

## Cloudflare

`cloudflare` 预设把全部代码打包为单个 `dist/index.mjs`，并生成开启了 `nodejs_compat` 的 `dist/wrangler.json`。全栈项目的 `dist/client` 由 Workers Assets 托管（带 SPA 回退），后端前缀下的请求优先交给 Worker。

```bash
haze build --preset cloudflare
npx wrangler secret put APP_KEY -c dist/wrangler.json
npx wrangler d1 migrations apply my-db --remote -c dist/wrangler.json   # 使用 D1 时
npx wrangler deploy -c dist/wrangler.json
```

### 绑定

`cloudflare.wrangler` 中的内容会合并进生成的 `wrangler.json`，D1、KV、R2、Queues、vars、routes 等都写在这里：

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  preset: 'cloudflare',
  cloudflare: {
    wrangler: {
      vars: { DB_DRIVER: 'd1', CACHE_STORE: 'kv', QUEUE_CONNECTION: 'cloudflare' },
      d1_databases: [
        { binding: 'DB', database_name: 'my-db', database_id: '<id>' },
      ],
      kv_namespaces: [
        { binding: 'CACHE', id: '<id>' },
      ],
      r2_buckets: [
        { binding: 'BUCKET', bucket_name: 'my-bucket' },
      ],
      queues: {
        producers: [{ binding: 'QUEUE', queue: 'jobs' }],
        consumers: [{ queue: 'jobs' }],
      },
    },
  },
})
```

各驱动按名称读取绑定：

| 功能 | 配置 | 默认绑定名 |
|------|------|------------|
| 数据库 | `config/database.ts` 中 `{ driver: 'd1', binding: 'DB' }`，或经 HTTP 连接的 `turso` | `DB` |
| 缓存 | `config/cache.ts` 中 `{ driver: 'kv', binding: 'CACHE' }` | `CACHE` |
| 存储 | `config/filesystem.ts` 中 `{ driver: 'r2', binding: 'BUCKET' }` | `BUCKET` |
| 队列 | `config/queue.ts` 中 `{ driver: 'cloudflare', binding: 'QUEUE' }` | `QUEUE` |

项目模板中已经以注释的形式给出了 `kv` 缓存存储与 `cloudflare` 队列连接，切换 `CACHE_STORE` / `QUEUE_CONNECTION` 前请先取消注释。上面的 `vars` 只有在配置文件读取它们时才生效。数据库的常见做法是本地用 SQLite、Workers 上用 D1：

```ts
// config/database.ts
import { env } from '@hazejs/core'
import { defineDatabaseConfig } from '@hazejs/orm'

export default defineDatabaseConfig(() => ({
  default: 'main',
  connections: {
    main: env('DB_DRIVER', 'sqlite') === 'd1'
      ? { driver: 'd1', binding: 'DB' }
      : { driver: 'sqlite', url: env('DATABASE_URL', 'file:./data/app.db') },
    // Turso：{ driver: 'turso', url: env('DATABASE_URL'), authToken: env('DATABASE_AUTH_TOKEN') }
  },
}))
```

未设置 `migrations_dir` 的 D1 数据库使用复制到 `dist/` 中的 `migrations/` 目录。D1 不支持交互式事务，原子写入请用 `(await Db.drizzle()).batch([...])`。

生成的 Worker 还接入了平台的其它能力：

- **Queues**：Worker 导出 `queue()`，消费 Cloudflare Queues 的消息批次；任务失败时通过 `message.retry({ delaySeconds })` 重试。
- **Cron Triggers**：项目中有定时任务时，`triggers.crons` 设为每分钟一次（自己设置了 `triggers` 时不覆盖），由 `scheduled()` 执行到期的任务。
- **Durable Objects**：路由中使用了 `r.ws()`（或设置 `cloudflare.websocket: true`）时，自动添加 `HazeWebSocket` Durable Object 及其迁移；所有 WebSocket 连接都在这个 DO 中，`Socket.publish` 因此能送达所有连接。详见 [WebSocket](./websocket)。

### 环境变量与平台绑定

Workers 上没有 `.env`。入口在处理每个请求前调用 `setPlatformBindings(env)`，驱动据此查找绑定；首次请求时还会把字符串类型的绑定（vars 与 secret）复制到 `process.env`，因此 `env('APP_KEY')` 照常可用。在自己的代码中用 `usePlatformBinding()` 读取绑定（`setPlatformBindings()` 同样已导出，可用于自定义入口与测试）：

```ts
// app/service/ImageService.ts
import { usePlatformBinding } from '@hazejs/core'

export class ImageService {
  images() {
    return usePlatformBinding<{ fetch: typeof fetch }>('IMAGES')
  }
}
```

### 不支持的驱动

需要 TCP 连接或原生代码的包无法在 Workers 上运行，构建时会被替换为调用即报错的空模块：`ioredis`、`bullmq`、`mysql2`、`mongodb`、`libsql`、`@electric-sql/pglite`、`nodemailer`、`socket.io`、`@socket.io/bun-engine` 与 `@socket.io/redis-adapter`。请改用适合 Edge 的方案：数据库用 D1 或 Turso，缓存用 KV 或 Upstash，队列用 Cloudflare Queues，[邮件](./mail)用 HTTP 接口的驱动，[存储](./storage)用 R2，实时通信用 `r.ws()` 代替 Socket.IO。
