# 配置

hazejs 的配置分为两类：

- **应用配置**：位于 `config/*.ts`，运行时通过 `config('app.name')` 读取。框架各模块（认证、缓存、队列等）以及业务自己的配置都放在这里。
- **工具链配置**：位于 `haze.config.ts`，由命令行和 Vite 插件读取，决定源码目录、开发端口、部署预设等。

## 配置文件

`config/` 下的每个文件都会被自动加载，**文件名就是配置键**：

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
}))
```

```ts
config('app.name') // 'my-app'
```

每个文件都会与框架的默认配置深合并，只需要写出要改的部分。新增业务配置时直接建文件即可，也可以用命令生成：

```sh
npx haze make:config payment   # config/payment.ts → config('payment.enabled')
```

### 辅助函数

`defineConfig()` 适用于任意配置文件。框架各模块还提供了带类型的辅助函数，编写时可以获得选项补全：

| 文件 | 辅助函数 | 所在包 |
| --- | --- | --- |
| `config/app.ts`、`config/logger.ts`、业务自定义配置 | `defineConfig` | `@hazejs/core` |
| `config/auth.ts` | `defineAuthConfig` | `@hazejs/core` |
| `config/cache.ts` | `defineCacheConfig` | `@hazejs/core` |
| `config/compress.ts` | `defineCompressConfig` | `@hazejs/core` |
| `config/cors.ts` | `defineCorsConfig` | `@hazejs/core` |
| `config/csrf.ts` | `defineCsrfConfig` | `@hazejs/core` |
| `config/filesystem.ts` | `defineFilesystemConfig` | `@hazejs/core` |
| `config/mail.ts` | `defineMailConfig` | `@hazejs/core` |
| `config/middleware.ts` | `defineMiddlewareConfig` | `@hazejs/core` |
| `config/queue.ts` | `defineQueueConfig` | `@hazejs/core` |
| `config/schedule.ts` | `defineScheduleConfig` | `@hazejs/core` |
| `config/secureHeaders.ts` | `defineSecureHeadersConfig` | `@hazejs/core` |
| `config/session.ts` | `defineSessionConfig` | `@hazejs/core` |
| `config/throttle.ts` | `defineThrottleConfig` | `@hazejs/core` |
| `config/websocket.ts` | `defineWebSocketConfig` | `@hazejs/core` |
| `config/database.ts` | `defineDatabaseConfig` | `@hazejs/orm` |
| `config/socketio.ts` | `defineSocketIOConfig` | `@hazejs/socket.io` |

各文件的具体选项见对应模块的文档页。

### 对象形式与函数形式

所有辅助函数既可以接收对象，也可以接收一个返回对象的函数。**只要读取了环境变量，就请使用函数形式**：

```ts
// config/queue.ts
import { defineQueueConfig, env } from '@hazejs/core'

export default defineQueueConfig(() => ({
  default: env('QUEUE_CONNECTION', 'memory'),
  connections: {
    memory: { driver: 'memory', concurrency: 2 },
    redis: { driver: 'redis', url: env('REDIS_URL', 'redis://127.0.0.1:6379') },
  },
}))
```

配置模块在应用启动之前就已经被导入，而函数会在启动过程中、`.env` 加载完成之后才执行。如果写成对象字面量，求值时机过早，就读不到 `.env` 中的值。

## 环境变量

### `env()`

`env(key, default)` 读取 `process.env`，并按默认值的类型转换：

```ts
env('APP_NAME', 'my-app')   // string
env('PORT', 3000)           // number，值不是数字时回退到 3000
env('DB_LOGGING', false)    // boolean
env('APP_URL')              // string | undefined
```

布尔值接受 `true`、`1`、`yes`、`on`，以及 `false`、`0`、`no`、`off` 或空字符串（不区分大小写），其他值回退到默认值。

### `.env` 文件

从项目根目录（生产环境为进程的工作目录，`haze start` 会切换到项目根目录）按以下顺序加载，后加载的覆盖先加载的：

1. `.env`
2. `.env.local`：`test` 模式下跳过，保证测试结果可复现
3. `.env.[mode]`：`.env.development`、`.env.production` 或 `.env.test`
4. `.env.[mode].local`

运行模式取自 `NODE_ENV`：`production` 和 `test` 原样使用，其余都视为 `development`。`haze test` 以 `test` 模式运行，所以模板中的 `.env.test`（`DATABASE_URL=:memory:`）会让测试使用内存数据库。

真实的环境变量始终优先于 `.env` 文件。模板的 `.gitignore` 已忽略 `.env.local` 与 `.env.*.local`，适合存放本机专用的密钥。

::: tip
开发时修改 `.env` 或 `config/` 下的任意文件，应用会像修改其他源码一样原地重载。
:::

## 读取配置

```ts
import { config } from '@hazejs/core'

config('app.name')               // 带类型的值
config('payment.retries', 3)     // 带默认值
```

请求内也可以通过上下文读取，类中则可以注入 `Config`：

```ts
// app/controller/GreetingController.ts
import type { HttpContext } from '@hazejs/core'
import { Config, inject } from '@hazejs/core'

export class GreetingController {
  private config = inject(Config)

  index(ctx: HttpContext) {
    return {
      app: this.config.get('app.name'),
      debug: ctx.config.get('app.debug'),
    }
  }
}
```

`Config` 还提供 `has(key)`、`set(key, value)` 与 `all()`。启用[多应用](./multi-app)时，请求内的 `config()` 与 `ctx.config` 返回的是该应用的配置，即 `app/<name>/config/*.ts` 与全局配置深合并后的结果。

### 配置键的类型

开发服务器（以及 `haze typegen`）会生成 `.haze/types/haze.d.ts`，推导出 `config/` 下每个文件的类型。配置键可以自动补全，返回值带类型，拼错会在类型检查时报错：

```ts
config('app.name')   // string
config('app.nmae')   // 类型错误
```

生成类型之后，`config()` 只接受已知的配置键；读取未知的键必须传默认值。请确认 `tsconfig.json` 的 `include` 包含 `.haze/types/**/*.d.ts`（模板已配置）。

## `config/app.ts`

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `name` | `'hazejs'` | 应用名称 |
| `debug` | 开发环境为 `true` | 错误响应携带堆栈，并显示开发错误页 |
| `url` | — | 应用的外部访问地址，用于生成绝对链接，例如存储的签名临时链接 |
| `key` | `APP_KEY` | 应用密钥，见下文 |
| `bodyLimit` | `'1mb'` | 请求体上限；单个路由可以用 `bodyLimit:10mb` 中间件调整 |
| `trustProxy` | `false` | 从 `X-Forwarded-For` / `X-Forwarded-Proto` 读取客户端 IP 与协议 |
| `cookie` | — | 默认 Cookie 选项（默认 httpOnly、`SameSite=Lax`，非 debug 时加 `Secure`） |
| `requestIdHeader` | `'x-request-id'` | 读取与回写请求 ID 的请求头，`false` 关闭 |
| `response` | `{ envelope: true, successCode: 0, successMessage: 'ok' }` | 成功响应的包装结构 |
| `apps` | — | 按前缀或域名划分的[多应用](./multi-app) |

`app.mode` 为只读，反映当前运行模式。日志在 `config/logger.ts` 中配置：`level`（`'silent'` 到 `'trace'`）、`format`（`'pretty'` 或 `'json'`，生产环境默认 JSON）以及 `requests`（访问日志）。

### `APP_KEY`

`APP_KEY` 用于签名 Cookie、加密 Session，同时也是 JWT 的默认密钥，长度至少 32 个字符。`create-hazejs` 创建项目时已写入 `.env`，需要重新生成时：

```sh
npx haze key:generate           # 写入 .env 的 APP_KEY（已存在时拒绝覆盖）
npx haze key:generate --force   # 强制替换：已签发的 Cookie、Session 和令牌都会失效
npx haze key:generate --show    # 只输出新密钥，不写入文件
```

生产环境请通过真实的环境变量设置 `APP_KEY`。在 `config/app.ts` 中设置 `key` 会覆盖它。

### `APP_URL`

框架不会自动读取 `APP_URL`，需要把它接到 `url` 上，绝对链接（例如本地磁盘的 `Storage.temporaryUrl()`）才会使用对外地址：

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  url: env('APP_URL'),
}))
```

不设置时，这些链接是站内相对路径。

## `haze.config.ts` {#haze-config-ts}

工具链选项写在项目根目录的 `haze.config.ts` 中，全部可选：

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  srcDir: 'server',
  port: 3000,
  preset: 'node',
})
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `srcDir` | `'.'` | 后端源码目录，相对项目根目录；全栈模板为 `'server'` |
| `port` | `3000` | 纯后端项目的开发端口，同时是生产入口的默认端口；`PORT` 环境变量优先 |
| `host` | 开发为 `localhost`，生产为 `0.0.0.0` | 监听地址；生产环境 `HOST` 环境变量优先 |
| `outDir` | `'dist'` | 构建输出目录 |
| `typegen` | `true` | `haze dev` 运行时自动生成 `.haze/types` |
| `preset` | `'node'` | 部署预设：`node`、`bun`、`deno`、`docker`、`cloudflare`、`vercel`、`netlify`、`aws-lambda`；`haze build --preset` 可覆盖 |
| `cloudflare` | — | `wrangler`（合并进生成的 `wrangler.json`：绑定、vars、routes 等）与 `websocket`（生成 WebSocket 的 Durable Object，路由中使用了 `r.ws()` 时默认开启） |
| `vercel` | — | `cron`：触发定时任务的 Vercel Cron 表达式（默认每分钟） |
| `externals` | — | 依赖处理：`trace`（把 external 依赖追踪复制进产物，默认 `true`）、`traceDeps`（额外保持 external 并追踪的包，`pkg*` 表示整包复制）、`inline`（强制打包的包） |
| `vite` | — | 纯后端项目透传给 Vite 的配置（插件、别名等）；全栈项目请直接写在 `vite.config.ts` 中 |

全栈项目的开发服务器使用 Vite 的端口，`port` 只决定生产环境的默认端口。与部署预设相关的选项见 [Vite 全栈](./fullstack)与[部署](./deployment)。
