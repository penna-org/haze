# think-h3

基于 [h3 v2](https://h3.dev) 的 Node 服务端框架：IoC 容器、集中路由、分层中间件、统一异常处理，设计参考 ThinkPHP。完整设计见 [docs/design.md](docs/design.md)。

> 当前进度：M0（monorepo）、M1（运行时内核）、M2（Vite 插件 + 热更新 + CLI）、M3（Vue 全栈集成、脚手架、测试工具）、M4（代码生成、类型生成、日志、开发错误页）。

## 环境

- Node `>=22.12`（仓库 `.nvmrc` 为 22.18.0，执行 `nvm use`）
- pnpm 11

## 创建项目

```bash
pnpm create think-h3 my-app            # 交互选择模板
pnpm create think-h3 my-app -t api     # 纯后端 API
pnpm create think-h3 my-app -t vue     # Vue 3 全栈（同仓库、同端口、一次构建）
pnpm create think-h3 my-app -t react   # React 19 全栈
```

> 包尚未发布到 npm，仓库内可用 `node packages/create/bin/create-think-h3.mjs <dir> -t vue` 体验。

在已有的 Vite 项目（Vue / React / Svelte / Solid / 无框架均可）中使用：

```ts
// vite.config.ts
export default defineConfig({
  plugins: [
    vue(),
    thinkH3()
  ], // 开发时 /api/** 交给 server/ 下的后端；vite build 产出 dist/client + dist/server；vite preview 运行产物
})

// think.config.ts
export default defineThinkConfig({ srcDir: 'server' })
```

## 认证与安全

内置中间件按名使用：`cors`、`secureHeaders`、`compress`、`throttle:60,60`、`bodyLimit:10mb`、`session`、`csrf`、`auth` / `auth:web,api`、`guest`、`can:<ability>`、`cacheResponse:60`。认证参考 Laravel 的 Guard / Provider：`config/auth.ts` 中配置 jwt（jose，HS / RS / ES / EdDSA）与 session 两种 Guard，`modelUserProvider(() => User)` 基于 ORM 模型提供用户。Cookie 签名、Session 加密（AES-GCM）与 JWT 默认密钥均来自 `APP_KEY`（`think-h3 key:generate`）；密码哈希用 `Hash.make()`（scrypt）。multipart 上传解析为 `UploadedFile`（继承 File，可用 valibot 校验，`store()` 保存到本地）。

授权参考 Laravel 的 Gate / Policy：`app/policy/*.ts` 中 `definePolicy(Model, {...})` / `defineAbilities({...})` 自动注册，`ctx.can()` / `ctx.authorize()` 与 `can:update,Post,id` 中间件检查，能力名由 typegen 生成类型。`csrf` 中间件为 Laravel 方式的同步令牌（XSRF-TOKEN Cookie + X-XSRF-TOKEN 头 / `_token` 字段，失败 419）。

## 缓存

`Cache.remember / get / set / increment / lock`，驱动：memory、redis（ioredis）、upstash（HTTP，Edge 可用）、kv（Cloudflare KV）。限流与 Session 可直接引用缓存存储实现多实例共享（`throttle: { store: 'redis' }`、`session: { driver: 'cache', store: 'redis' }`）；Workers 上限流可用 Cloudflare Rate Limiting 绑定；`cacheResponse:60` 中间件缓存 GET 响应。

## 队列与定时任务

`app/job/*.ts` 中 `defineJob({ tries, backoff, timeout, handle, failed })`，`Job.dispatch(payload, { delay })` 投递；驱动 sync / memory / redis（BullMQ）/ cloudflare（Queues）。`schedule/*.ts` 中 `defineSchedule(s => s.call(...).dailyAt('03:00').onOneServer())`（croner 解析 cron、支持时区，锁基于 `Cache.lock`）。命令：`queue:work`、`queue:failed / retry / forget / flush`、`schedule:list / run / work`；构建产物输出 `worker.mjs`，Cloudflare 自动接入 Queues 消费与 Cron Triggers，Lambda 导出 `index.schedule`，Vercel 配置 Cron。

## 文件存储与邮件

`Storage.disk(name).put / get / stream / files / url / temporaryUrl / response`，磁盘驱动：local（`serve: true` 时由框架在 url 下提供文件）、s3（AWS SDK v3，S3 兼容服务、分片上传、预签名）、r2（Workers 绑定）、memory。上传文件 `await file.store('avatars', 'public')`；非 S3 磁盘的临时链接由 APP_KEY 签名。邮件：`app/mail/*.ts` 中 `defineMail(payload => ({ subject, html }))`，`Mail.to(addr).send / queue / later(...)`，驱动：smtp（nodemailer）、resend、postmark、mailgun、ses（`@aws-sdk/client-sesv2`）、log、array；`html` 模板自动转义，`mailLayout()` / `button()` 生成邮件布局，纯文本自动生成。测试用 `Storage.fake()` / `Mail.fake()`。

## 事件与 WebSocket

`app/event/*.ts` 中 `defineEvent<Payload>()`，`app/listener/*.ts` 中 `defineListener(Event, handler, { queue? })`，`Event.emit(payload)` 触发；排队监听器复用队列。WebSocket 基于 crossws：路由中 `r.ws(path, { open, message, close })`，升级请求经过中间件；`Socket.publish(topic, data)` 服务端推送，多实例经 Redis 广播；开发服务器（含 Vite 全栈）、node / bun / deno / docker 产物与预览直接可用，Cloudflare 自动使用 Durable Object。

## Socket.IO

`@think-h3/socket.io` 集成官方 socket.io 服务端，兼容 socket.io-client：`app/socket/*.ts` 中 `defineNamespace({ middleware, connection })` 自动注册，`authenticate()` 用框架的 Guard 鉴权握手，`SocketIO.to(room).emit()` 服务端推送，多实例使用 `@socket.io/redis-adapter`。与 HTTP 共用端口，开发服务器（含 Vite 全栈）、node / docker 与 Bun（`@socket.io/bun-engine`）产物、预览均可用。

## 部署

```bash
npx think-h3 build --preset <node|bun|deno|docker|cloudflare|vercel|netlify|aws-lambda>
```

也可在 `think.config.ts` 中设置 `preset`。纯后端与 Vue / React 等任意 Vite 全栈项目均支持，构建结束会提示运行 / 部署方式。

依赖处理参考 Nitro：能打包的都打进产物，数据库驱动与原生模块保持 external，并用 nf3（@vercel/nft）按实际引用的文件追踪复制到产物的 `node_modules`，产物可整体拷走运行（`think.config.ts` 的 `externals` 可调整）。

`think-h3 preview`（全栈项目也可直接 `vite preview`）按构建时的预设运行产物本身：node / bun / deno / docker 启动产物进程，aws-lambda / vercel / netlify 在进程内调用函数，cloudflare 用 Miniflare 运行 Worker。

使用 `@think-h3/orm` 时，迁移文件随产物打包：常驻进程型预设输出 `migrate.mjs`（`node dist/server/migrate.mjs`），AWS Lambda 导出 `index.migrate`，Cloudflare D1 生成 `wrangler d1 migrations apply` 所需的 `migrations_dir`。

## 常用命令

```bash
pnpm install
pnpm build       # tsdown 构建 packages/*
pnpm test        # 先构建，再跑 vitest（core / vite / playground）
pnpm typecheck
pnpm lint
```

在 playground 中体验框架命令：

```bash
cd playground
pnpm dev          # think-h3 dev：修改代码即时生效，进程不重启
pnpm routes       # think-h3 route:list
pnpm build        # think-h3 build → dist/index.mjs
pnpm start        # think-h3 start
pnpm test         # think-h3 test（vitest）
npx think-h3 typegen                         # 配置键 / 路由名类型（dev 时自动生成）
npx think-h3 make:controller Order --resource # make:service / repository / middleware / provider / validate / test / config / route
npx think-h3 stub:publish                    # 导出 stub 到 stubs/ 以定制生成代码
```

## 目录

```
packages/socketio/ @think-h3/socket.io  官方 socket.io 服务端集成（命名空间、Guard 鉴权、Redis 适配器、Node / Bun）
packages/orm/    @think-h3/orm  基于 drizzle 的 Db 查询构造器 + Model（MySQL / PostgreSQL / SQLite / Turso / Cloudflare D1）；
                 @think-h3/orm/mongo 为同形态的 MongoDB 适配器（Mongo / MongoModel）
packages/create/ create-think-h3 脚手架与 api / vue / react 模板
packages/testing/ @think-h3/testing  useTestApp / createTestApp / defineThinkTestConfig
packages/cli/    @think-h3/cli  命令行 think-h3（dev / build / start / preview / test / route:list / typegen / make:* / db:* / queue:* / schedule:* / key:generate）
packages/vite/   @think-h3/vite Vite 插件（virtual:think/*）、热替换开发服务器、生产构建
packages/core/   @think-h3/core 运行时内核
  src/container/   依赖注入（inject()、Singleton / Request / Transient 作用域）
  src/config/      配置仓库、.env 加载、env() 类型转换
  src/routing/     defineRoutes / group / resource / 命名路由 → 编译为 h3 路由
  src/middleware/  别名、分组、参数化中间件，类中间件支持注入
  src/exception/   HttpException 体系 + ExceptionHandler（report / render）
  src/http/        HttpContext、统一响应格式、Standard Schema 校验
  src/application.ts  生命周期：env → config → providers → h3
playground/      ThinkPHP 风格的示例项目（用户 CRUD），也是集成测试
```

## 快速示例

```ts
// route/api.ts
export default defineRoutes((r) => {
  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    r.resource('/users', UserController).validateMember({ params: UserIdParams })
  })
})

// app/controller/UserController.ts
export class UserController {
  static middleware = [
    {
      use: 'auth',
      except: ['index', 'show']
    }
  ]

  private users = inject(UserService)

  show(ctx: HttpContext<{ params: typeof UserIdParams }>) {
    return this.users.find(ctx.validated.params.id) // → { code: 0, message: 'ok', data: {...} }
  }
}
```

更多用法参见 `playground/` 与 `packages/core/test/`。
