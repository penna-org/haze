# {{name}}

基于 hazejs 的 Node 服务端项目。

## 命令

```bash
pnpm dev        # 开发服务器，修改代码即时生效（进程不重启）
pnpm routes     # 查看路由表
pnpm typegen    # 生成配置键 / 路由名类型（dev 时自动执行）
pnpm test       # 运行测试
pnpm build      # 构建到 dist/
pnpm start      # 运行构建产物（产物自带依赖，dist/ 可整体拷走）
pnpm preview    # 按构建时的部署预设本地运行产物（Lambda / Vercel / Workers 等也可预览）
```

## 代码生成

```bash
npx haze make:controller User --resource   # app/controller/UserController.ts
npx haze make:service User                 # app/service/UserService.ts
npx haze make:middleware Authenticate      # app/middleware/Authenticate.ts
npx haze make:validate User                # app/validate/user.ts
npx haze make:test user                    # tests/user.test.ts
npx haze stub:publish                      # 复制模板到 stubs/，按团队规范定制
```

其余：`make:repository`、`make:provider`、`make:config`、`make:route`。名称可带子目录，如 `admin/User`。

## 类型安全

开发服务器会把配置键与命名路由生成到 `.haze/types/haze.d.ts`：

```ts
config('app.name') // string
router.url('api.hello') // 路由名有补全，参数按路径检查
```

## 日志

- 开发环境：彩色输出，自动记录访问日志 `GET /api/hello 200 3ms`
- 生产环境：JSON 行日志（含 requestId），便于日志平台采集
- 请求内使用 `ctx.logger.info(...)`，自动带上请求 ID

## 响应格式

- `app/response/Formatter.ts`：全局成功 / 失败响应结构（默认 `{ code, message, data }`）
- `app/interceptor/*.ts`：出站拦截器，拿到最终 Response 后可改头或替换（`haze make:interceptor`）
- 单个路由跳过：`.meta({ envelope: false })` 或 `return raw(value)`

## 数据库

默认使用 SQLite（`config/database.ts`，文件位于 `data/app.db`），表结构在 `database/schema/*.ts`（drizzle），模型在 `app/model/`：

```bash
pnpm db:migrate                         # 执行迁移（首次运行前执行）
pnpm db:seed                            # 数据填充（database/seeders）
npx haze make:model Post            # 生成模型 + 表结构
pnpm db:generate --name create_posts    # 表结构变化后生成迁移
```

```ts
const user = await User.findOrFail(1) // 404：User 1 不存在
await User.where('name', 'like', '%a%').order('id', 'desc').paginate(1, 20)
await Db.table(users).where('id', 1).update({ name: 'Ada' })
await Db.transaction(async () => { /* 内部的 Db / Model 操作自动加入事务 */ })
```

切换到 PostgreSQL / MySQL：安装 `postgres` 或 `mysql2`，修改 `driver` 与 `url`，表结构改用 `drizzle-orm/pg-core` / `mysql-core`。

MongoDB：安装 `mongodb`，连接配置 `{ driver: 'mongodb', url: 'mongodb://…/app' }`，模型使用 `@hazejs/orm/mongo` 的 `MongoModel`（`npx haze make:model Article --dialect mongodb`），查询 API 与 SQL 一致。

## 多应用

在 `config/app.ts` 中声明应用，代码放在 `app/<name>/`（controller、route、config、middleware 配置、exception/Handler.ts、response/Formatter.ts）：

```ts
export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  apps: {
    admin: { prefix: '/admin' }, // /admin/** → app/admin
    api: { domain: 'api.example.com' }, // 按域名分发，支持 *.example.com
  },
}))
```

- 应用配置 `app/<name>/config/*.ts` 与全局配置深合并，请求内 `config()`、`ctx.config` 读取应用配置
- 路由名自动带应用前缀：`router.url('admin.users.index')`
- 生成代码：`npx haze make:controller User --app admin`

## 认证与安全

模板自带 JWT 登录示例（`config/auth.ts`）：

```bash
curl -X POST localhost:3000/api/auth/register -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","password":"correct horse"}'
curl -X POST localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct horse"}'     # → { token, expiresIn, ... }
curl localhost:3000/api/auth/me -H 'authorization: Bearer <token>'
```

- `APP_KEY`（`.env`，创建项目时已生成）用于签名 Cookie、加密 Session 与 JWT；更换：`npx haze key:generate --force`
- 路由保护：`.middleware('auth')`、`'auth:web,api'`（任一 Guard 通过）、`'guest'`；代码中 `await ctx.auth.user()`、`ctx.auth.jwt().login(user)`
- 浏览器同源场景可加 session Guard：`web: { driver: 'session', provider: 'users' }`，`ctx.auth.session('web').attempt(credentials)`
- 测试：`await t.actingAs(user)` 返回已登录的客户端
- 密码：`Hash.make(password)` / `Hash.verify(hash, password)`（scrypt）

账号相关接口（控制器在 `app/controller`，表结构在 `database/schema/auth.ts`，迁移 `0003_add_auth_tables`）：

- 个人访问令牌：`POST /api/auth/tokens`（`{ "name": "cli", "abilities": ["users:read"] }`，明文只返回一次）、`GET /api/auth/tokens`、`DELETE /api/auth/tokens/:id`；带上 `Authorization: Bearer <id|secret>` 访问 `auth:api,token` 保护的接口，`'abilities:users:write'` / `'ability:a,b'` 中间件检查能力
- 邮箱验证：注册后自动发送签名链接（`GET /api/auth/email/verify/:id/:hash`），`POST /api/auth/email/verification-notification` 重新发送；需要已验证邮箱的接口加 `'verified'` 中间件
- 找回密码：`POST /api/auth/forgot-password` 发送链接（指向前端页面 `/reset-password?token=...&email=...`，`config/auth.ts` 的 `passwords.path`），页面提交到 `POST /api/auth/reset-password`
- 邮件中的链接默认是站内路径，在 `.env` 中设置 `APP_URL=https://example.com` 后为绝对链接
- GitHub 登录：在 `.env` 中填写 `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` 后访问 `/api/auth/github`（未配置时返回 404，`config/oauth.ts`）
- 两步验证（TOTP）与通行密钥（WebAuthn）见文档；`npx haze make:auth-tables` 生成全部认证表结构

授权（`app/policy/*.ts` 自动注册，`npx haze make:policy Post` 生成）：

```ts
export default definePolicy(User, {
  before: (actor: User | undefined) => actor?.role === 'admin' || undefined, // 管理员全部放行
  update: (actor: User, user: User) => actor.id === user.id || deny('只能修改自己的资料'),
})
```

- 控制器：`await ctx.authorize('update', user)`（未登录 401，无权限 403），`await ctx.can('delete', user)` 返回 boolean
- 路由：`.middleware('can:admin.access')`、`'can:create,Post'`、`'can:update,Post,id'`（按路由参数加载模型，实例在 `ctx.get('post')`）
- 能力名由 typegen 生成类型，拼错会在类型检查时报错；与模型无关的能力用 `defineAbilities({ 'admin.access': user => ... })`
- CSRF：使用 Session Guard 等 Cookie 认证时，在中间件中加入 `csrf`。前端回传 `XSRF-TOKEN` Cookie 的值（`X-XSRF-TOKEN` 头或表单 `_token` 字段），否则返回 419

内置中间件（`config/middleware.ts` 中按名使用，配置文件放在 `config/` 下同名文件）：

| 名字 | 用途 | 配置 |
|------|------|------|
| `cors` | 跨域，需放在 global | `cors.ts`（`defineCorsConfig`） |
| `secureHeaders` | nosniff、frame-options、referrer-policy 等安全头，生产 https 下加 HSTS | `secureHeaders.ts` |
| `compress` | br / gzip / deflate 压缩响应 | `compress.ts` |
| `throttle:60,60` / `throttle:api` | 限流（默认按用户或 IP），返回 RateLimit-* 头与 429 | `throttle.ts`（命名规则、共享存储） |
| `bodyLimit:10mb` | 调整单个路由的请求体上限（默认 `app.bodyLimit`，1mb） | — |
| `session` | 启动会话：`ctx.session.get / set / flash / regenerate` | `session.ts`（cookie / memory / 自定义存储） |
| `auth` / `guest` | 认证 | `auth.ts` |
| `verified` / `abilities:a,b` / `ability:a,b` | 已验证邮箱 / 令牌须具备全部 / 任一能力 | `auth.ts` |
| `can:<ability>[,Model[,param]]` | 授权 | `app/policy/*.ts` |
| `csrf` | CSRF 同步令牌（419） | `csrf.ts`（except、cookie、testing） |
| `cacheResponse:60[,user]` | 缓存 GET 响应 | `cache.ts`（responseStore） |

文件上传：multipart 请求的 `await ctx.body()` 中文件字段为 `UploadedFile`（继承 File，可直接用 valibot 的 `v.file()`、`v.maxSize()`、`v.mimeType()` 校验），`await (await ctx.file('avatar'))?.store('avatars', 'public')` 保存到存储磁盘（见下方“文件存储与邮件”）。

## 缓存

`config/cache.ts`（默认内存；设置 `CACHE_STORE=redis` 与 `REDIS_URL` 切换到 Redis，需要 `pnpm add ioredis`）：

```ts
import { Cache } from '@hazejs/core'

const stats = await Cache.remember('stats', '10m', () => computeStats())
await Cache.increment('views') // 原子自增
await Cache.lock('report', '30s').run(() => generateReport()) // 原子锁（拿不到时抛 LockTimeoutException）
await Cache.store('redis').get('key') // 指定存储
```

| 驱动 | 适用 | 说明 |
|------|------|------|
| `memory` | 开发、单实例 | 进程内 |
| `redis` | 多实例 Node / Docker / Lambda | ioredis，原子自增与锁 |
| `upstash` | Vercel / Netlify / Workers | HTTP，需要 `@upstash/redis` |
| `kv` | Cloudflare Workers | 最终一致、非原子：适合缓存与 Session，不支持锁 |

- 多实例共享：`config/throttle.ts` 的 `store` 与 Session 的 `{ driver: 'cache', store: 'redis' }` 使用同一个缓存存储
- Workers 上的限流：限流规则配置 `binding: 'API_RATE_LIMITER'`，使用 Cloudflare Rate Limiting 绑定（原子、全局）
- 响应缓存：`.middleware('cacheResponse:60')` 缓存 GET 响应（`X-Cache: HIT / MISS`），`cacheResponse:60,user` 按用户区分

## 队列与定时任务

任务放在 `app/job/*.ts`（`npx haze make:job SendInvoice` 生成），配置在 `config/queue.ts`：

```ts
await SendWelcomeEmail.dispatch({ userId: 1 }) // 默认 memory：在本进程消费
await SendWelcomeEmail.dispatch({ userId: 1 }, { delay: '10m' }) // 延迟
```

- 重试：`defineJob({ tries: 3, backoff: [10, 60], timeout: '30s', failed(payload, error) { ... } })`
- 多实例：设置 `QUEUE_CONNECTION=redis`（需要 `pnpm add bullmq ioredis`），单独运行消费进程 `pnpm queue`（`haze queue:work`，构建后为 `node dist/worker.mjs queue`）
- 失败任务：`haze queue:failed` / `queue:retry [id]` / `queue:forget <id>` / `queue:flush`
- 测试：`const fake = Queue.fake()` 后 `fake.assertDispatched(SendWelcomeEmail, p => p.userId === 1)`

定时任务在 `schedule/*.ts`：

```ts
export default defineSchedule((s) => {
  s.call('report', () => sendReport()).weekdays().at('09:00').timezone('Asia/Shanghai')
  s.job(PruneTokens, { days: 30 }).daily().onOneServer() // 多实例时只执行一次
  s.cron('*/5 * * * *', 'sync', () => sync()).withoutOverlapping() // 上次未结束则跳过
})
```

| 环境 | 运行方式 |
|------|----------|
| 开发 | `pnpm schedule`（`haze schedule:work`），`haze schedule:list` 查看下次执行时间 |
| node / bun / deno / docker | `node dist/worker.mjs schedule`（常驻），或系统 cron 每分钟执行 `node dist/worker.mjs schedule:run` |
| cloudflare | 自动生成 Cron Triggers（每分钟）；队列用 Cloudflare Queues（`driver: 'cloudflare'`，Worker 导出 queue()） |
| aws-lambda | 同一份产物，handler 设为 `index.schedule`，EventBridge `rate(1 minute)` 触发 |
| vercel | 自动配置 Vercel Cron 调用 `/__haze/schedule`（需要设置 `CRON_SECRET`；Hobby 计划只允许每天一次，用 `haze.config.ts` 的 `vercel.cron` 调整） |

## 文件存储与邮件

磁盘配置在 `config/filesystem.ts`（默认 `local` 与 `public`；`s3` 需要 `pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner`，Workers 上用 `r2` 绑定）：

```ts
import { Storage } from '@hazejs/core'

const path = await file.store('avatars', 'public') // 上传文件，随机文件名
Storage.disk('public').url(path) // /storage/avatars/xxx.png（public 磁盘由框架直接提供）
await Storage.put('reports/2026.csv', csv)
await Storage.disk('s3').temporaryUrl('reports/2026.csv', '10m') // S3 预签名；local / r2 为 APP_KEY 签名的链接
return Storage.download('reports/2026.csv', '报表.csv') // 控制器中直接返回文件响应
```

邮件定义在 `app/mail/*.ts`，配置在 `config/mail.ts`（默认 `log`，只写日志）：

```ts
export default defineMail((payload: { name: string }) => ({
  subject: `欢迎，${payload.name}`,
  html: mailLayout({ body: html`<p>你好，${payload.name}</p>${button('开始使用', url)}` }), // 插值自动转义，纯文本自动生成
}))

await Mail.to(user.email).send(WelcomeMail, { name: user.name })
await Mail.to(user.email).queue(WelcomeMail, { name: user.name }) // 排队（任务 mail:send，失败重试）
await Mail.to(user.email).later('10m', WelcomeMail, { name: user.name })
```

| 驱动 | 说明 |
|------|------|
| `log` / `array` | 只写日志 / 保存在内存中 |
| `smtp` | nodemailer（`pnpm add nodemailer`），不支持 Workers |
| `resend` / `postmark` / `mailgun` | HTTP 接口，可在 Workers 上运行 |
| `ses` | Amazon SES（`pnpm add @aws-sdk/client-sesv2`） |

- 本地查看邮件：运行 [Mailpit](https://mailpit.axllent.org)（`docker run -p 1025:1025 -p 8025:8025 axllent/mailpit`），设置 `MAIL_MAILER=smtp`（并 `pnpm add nodemailer`），打开 http://localhost:8025
- 附件：`attachments: [{ filename: 'a.pdf', content: bytes }]`，或 `{ filename, disk: 's3', path }` 发送时从磁盘读取
- 测试：`const mail = Mail.fake()` 后 `mail.assertSent(WelcomeMail, m => MailFake.hasRecipient(m, 'ada@example.com'))`；`const disk = Storage.fake('public')` 后 `await disk.assertExists(path)`

## 事件与 WebSocket

事件放在 `app/event/*.ts`，监听器在 `app/listener/*.ts`（`npx haze make:event OrderPaid` / `make:listener SendReceipt`），都会自动注册：

```ts
export default defineEvent<{ userId: number, email: string }>() // app/event/UserRegistered.ts
export default defineListener(UserRegistered, ({ userId }) => SendWelcomeEmail.dispatch({ userId }))
export default defineListener(UserRegistered, handler, {
  queue: { tries: 3 }
}) // 排队异步执行
await UserRegistered.emit({ userId: user.id, email: user.email })
```

- 同步监听器按文件名顺序执行，返回 `false` 时不再执行后续监听器；排队监听器作为队列任务执行（payload 以 JSON 传递）
- 测试：`const events = Events.fake([UserRegistered])` 后 `events.assertEmitted(UserRegistered, p => p.userId === 1)`

WebSocket 在路由中定义（示例：`route/ws.ts`，`ws://<host>/api/ws`）：

```ts
r.ws('/api/chat', {
  open(peer, ctx) { peer.subscribe('chat') },
  message(peer, message) { peer.publish('chat', message.text()) },
}).middleware('auth') // 升级请求同样经过中间件

Socket.publish('users', { type: 'user.registered' }) // 在接口、任务、监听器中推送
```

- 开发：`pnpm dev` 中直接可用，修改后新连接使用新代码；产物：node / bun / deno / docker 直接支持，`pnpm preview` 也可连接
- 多实例：设置 `WS_BROADCAST=redis`（`config/websocket.ts`），广播经 Redis 到达所有实例
- Cloudflare：自动生成 Durable Object（`HazeWebSocket`），所有连接在同一个 DO 中，`Socket.publish` 经 RPC 转发
- Vercel / Netlify / AWS Lambda：平台不支持 WebSocket（升级请求返回 426）

## 通知与广播

通知放在 `app/notification/*.ts`（`npx haze make:notification InvoicePaid`），一次定义、多个渠道发送：

```ts
await notify(user, WelcomeNotification({ url: 'https://example.com' })) // 示例：app/notification/WelcomeNotification.ts
await Notification.route('dingtalk', process.env.DINGTALK_WEBHOOK).notify(Alert({ text: '磁盘已满' })) // 按需发送
```

- 渠道：`mail`、`database`（`npx haze make:notifications-table` 生成表结构）、`broadcast`、`slack`、`webhook`、`wecom`、`dingtalk`、`feishu`，也可以自定义
- 设置 `queue: true` 后经队列发送；测试：`const fake = Notification.fake()` 后 `fake.assertSentTo(user, WelcomeNotification)`

广播把服务端事件推送到前端。频道授权在 `app/channel/*.ts`（示例：`app/channel/user.ts`），内置接口位于 `/broadcasting`（WebSocket、SSE、授权）：

```ts
await broadcast({
  channel: privateChannel(`User.${id}`),
  event: 'OrderShipped',
  data
}) // 服务端
const echo = createEcho({ transport: 'ws' }) // 前端：import { createEcho } from '@hazejs/core/echo'
echo.private(`User.${id}`).listen('OrderShipped', (order) => {}).notification((data) => {})
```

## Socket.IO

需要兼容 socket.io-client 时安装 `pnpm add @hazejs/socket.io socket.io`，并：

```ts
// app/provider/SocketProvider.ts
export default socketIoProvider()

// app/socket/chat.ts —— 命名空间 /chat
export default defineNamespace({
  middleware: [
    authenticate()
  ],
  connection(socket, io, chat) {
    socket.on('chat:send', (text, ack) => {
      chat.emit('chat:message', text)
      ack?.('ok')
    })
  },
})
```

与 HTTP 共用端口（`/socket.io/`），`SocketIO.to(room).emit()` 在任意位置推送；多实例在 `config/socketio.ts` 配置 `adapter: { driver: 'redis' }`（`@socket.io/redis-adapter`）。支持 Node（开发、node / docker 产物）与 Bun，Deno / Workers / Serverless 不支持。

## 部署

```bash
npx haze build --preset node        # 默认：node dist/index.mjs（依赖已打包或追踪进产物，可整体拷走）
npx haze build --preset docker      # dist/ 即构建上下文：docker build -t app dist
npx haze build --preset bun         # bun dist/index.mjs
npx haze build --preset deno        # deno run -A dist/server/index.mjs
npx haze build --preset vercel      # .vercel/output → vercel deploy --prebuilt
npx haze build --preset netlify     # .netlify/v1/functions + netlify.toml
npx haze build --preset aws-lambda  # 打包 dist/lambda，handler 为 index.handler
npx haze build --preset cloudflare  # dist/wrangler.json → wrangler deploy -c dist/wrangler.json
```

也可在 `haze.config.ts` 中设置 `preset`。构建会自动带上项目安装的数据库驱动。

依赖处理与 Nitro 一致：能打包的依赖都打进产物，数据库驱动、原生模块等保持 external，并按实际引用的文件追踪复制到产物的 `node_modules`（node / bun / deno / aws-lambda / vercel）。可在 `haze.config.ts` 中调整：

```ts
export default defineHazeConfig({
  externals: {
    traceDeps: ['sharp', 'some-pkg*'], // 保持 external 并追踪（* 表示整包复制）
    inline: ['postgres'], // 强制打包
    // trace: false,                  // node / bun 退回依赖项目的 node_modules
  },
})
```

在 macOS / Windows 上构建 aws-lambda、vercel 产物时，如果追踪到了原生二进制，构建会给出警告：请在 Linux（CI / Docker）上构建。

`pnpm preview`（`haze preview`，全栈项目也可直接 `vite preview`）按构建时的预设运行产物本身：node / bun / deno / docker 启动产物进程，aws-lambda / vercel / netlify 在进程内调用函数，cloudflare 用 Miniflare 运行 Worker（D1 迁移自动应用到本地预览库）。

### 生产迁移

迁移文件打包进产物，生产环境不需要源码与 drizzle-kit：

| 预设 | 执行迁移 |
|------|----------|
| node / bun / deno | `node dist/migrate.mjs`（deno 预设为 `dist/server/migrate.mjs`；`--connection <name>` / `--all`） |
| docker | `docker run --rm <镜像> node server/migrate.mjs` |
| aws-lambda | 同一份产物，handler 设为 `index.migrate` 调用一次（事件 `{ "connection"?, "all"? }`） |
| vercel / netlify | 在构建命令前执行 `npx haze db:migrate`（使用生产库的 `DATABASE_URL`） |
| cloudflare（D1） | `npx wrangler d1 migrations apply <库名> --remote -c dist/wrangler.json` |
| cloudflare（Turso） | 在 CI 中执行 `npx haze db:migrate` |

### Cloudflare：D1 / Turso

Workers 上可用 `d1`（绑定）与 `turso`（纯 HTTP 的 libsql 客户端）两种驱动，二者与 `sqlite` 共用同一套表结构与迁移：

```ts
// config/database.ts —— 本地用 SQLite 文件，部署到 Workers 时切换为 D1
export default defineDatabaseConfig(() => ({
  default: 'main',
  connections: {
    main: env('DB_DRIVER', 'sqlite') === 'd1'
      ? { driver: 'd1', binding: 'DB' }
      : {
          driver: 'sqlite',
          url: env('DATABASE_URL', 'file:./data/app.db')
        },
    // Turso：{ driver: 'turso', url: env('DATABASE_URL'), authToken: env('DATABASE_AUTH_TOKEN') }
  },
}))
```

```ts
// haze.config.ts —— 合并进 dist/wrangler.json；D1 默认使用产物中的 migrations/
export default defineHazeConfig({
  cloudflare: {
    wrangler: {
      vars: { DB_DRIVER: 'd1' },
      d1_databases: [
        { binding: 'DB', database_name: 'my-db', database_id: '<id>' }
      ],
    },
  },
})
```

D1 不支持交互式事务（`Db.transaction()` 会报错并提示），原子写入请用 `(await Db.drizzle()).batch([...])`。

## 目录

```
app/
  controller/   控制器：接收参数、调用服务、返回数据
  service/      业务服务（默认单例，通过 inject() 注入）
  validate/     请求校验（valibot，任何 Standard Schema 库均可）
  middleware/   中间件
  exception/    全局异常处理 Handler.ts
  provider/     服务提供者：注册绑定、启动逻辑
config/         配置（文件名即配置键，如 config/app.ts → config('app.name')）
route/          路由（集中定义）
tests/          测试（@hazejs/testing）
```
