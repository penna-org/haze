# {{name}}

React 19 + think-h3 全栈项目：前后端同一个仓库、同一个端口、一次构建。

## 命令

```bash
pnpm dev        # Vite 开发服务器：前端 HMR，/api/** 由后端处理（改后端代码即时生效）
pnpm routes     # 查看后端路由表
pnpm typegen    # 生成配置键 / 路由名类型（dev 时自动执行）
pnpm test       # 后端测试（@think-h3/testing）
pnpm typecheck  # tsc 类型检查
pnpm build      # 构建 dist/client 与 dist/server
pnpm start      # 运行构建产物（同一进程托管前端页面与 API）
pnpm preview    # 按构建时的部署预设本地运行产物（等同 vite preview）
```

## 代码生成

```bash
npx think-h3 make:controller User --resource   # server/app/controller/UserController.ts
npx think-h3 make:service User
npx think-h3 make:validate User
npx think-h3 make:test user
```

开发时浏览器直接访问出错的 `/api/*` 地址，会看到带源码定位的错误页；前端 `fetch` 仍得到 JSON。

## 响应格式

- `server/app/response/Formatter.ts`：全局成功 / 失败响应结构（默认 `{ code, message, data }`）
- `server/app/interceptor/*.ts`：出站拦截器，拿到最终 Response 后可改头或替换（`think-h3 make:interceptor`）
- 单个路由跳过：`.meta({ envelope: false })` 或 `return raw(value)`

## 数据库

默认使用 SQLite（`server/config/database.ts`，文件位于 `data/app.db`），表结构在 `server/database/schema/*.ts`（drizzle），模型在 `server/app/model/`：

```bash
pnpm db:migrate                         # 执行迁移（首次运行前执行）
pnpm db:seed                            # 数据填充（server/database/seeders）
npx think-h3 make:model Post            # 生成模型 + 表结构
pnpm db:generate --name create_posts    # 表结构变化后生成迁移
```

```ts
const user = await User.findOrFail(1) // 404：User 1 不存在
await User.where('name', 'like', '%a%').order('id', 'desc').paginate(1, 20)
await Db.table(users).where('id', 1).update({ name: 'Ada' })
await Db.transaction(async () => { /* 内部的 Db / Model 操作自动加入事务 */ })
```

切换到 PostgreSQL / MySQL：安装 `postgres` 或 `mysql2`，修改 `driver` 与 `url`，表结构改用 `drizzle-orm/pg-core` / `mysql-core`。

MongoDB：安装 `mongodb`，连接配置 `{ driver: 'mongodb', url: 'mongodb://…/app' }`，模型使用 `@think-h3/orm/mongo` 的 `MongoModel`（`npx think-h3 make:model Article --dialect mongodb`），查询 API 与 SQL 一致。

## 多应用

在 `server/config/app.ts` 中声明应用，代码放在 `server/app/<name>/`（controller、route、config、middleware 配置、exception/Handler.ts、response/Formatter.ts）：

```ts
export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  apps: {
    admin: { prefix: '/admin' }, // /admin/** → server/app/admin
    api: { domain: 'api.example.com' }, // 按域名分发，支持 *.example.com
  },
}))
```

- 应用配置 `server/app/<name>/config/*.ts` 与全局配置深合并，请求内 `config()`、`ctx.config` 读取应用配置
- 路由名自动带应用前缀：`router.url('admin.users.index')`
- 生成代码：`npx think-h3 make:controller User --app admin`

## 认证与安全

模板自带 JWT 登录示例（`server/config/auth.ts`）：

```bash
curl -X POST localhost:5173/api/auth/register -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","password":"correct horse"}'
curl -X POST localhost:5173/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"ada@example.com","password":"correct horse"}'     # → { token, expiresIn, ... }
curl localhost:5173/api/auth/me -H 'authorization: Bearer <token>'
```

- `APP_KEY`（`.env`，创建项目时已生成）用于签名 Cookie、加密 Session 与 JWT；更换：`npx think-h3 key:generate --force`
- 路由保护：`.middleware('auth')`、`'auth:web,api'`（任一 Guard 通过）、`'guest'`；代码中 `await ctx.auth.user()`、`ctx.auth.jwt().login(user)`
- 浏览器同源场景可加 session Guard：`web: { driver: 'session', provider: 'users' }`，`ctx.auth.session('web').attempt(credentials)`
- 测试：`await t.actingAs(user)` 返回已登录的客户端
- 密码：`Hash.make(password)` / `Hash.verify(hash, password)`（scrypt）

授权（`server/app/policy/*.ts` 自动注册，`npx think-h3 make:policy Post` 生成）：

```ts
export default definePolicy(User, {
  before: (actor: User | undefined) => actor?.role === 'admin' || undefined, // 管理员全部放行
  update: (actor: User, user: User) => actor.id === user.id || deny('只能修改自己的资料'),
})
```

- 控制器：`await ctx.authorize('update', user)`（未登录 401，无权限 403），`await ctx.can('delete', user)` 返回 boolean
- 路由：`.middleware('can:admin.access')`、`'can:create,Post'`、`'can:update,Post,id'`（按路由参数加载模型，实例在 `ctx.get('post')`）
- 能力名由 typegen 生成类型，拼错会在类型检查时报错；与模型无关的能力用 `defineAbilities({ 'admin.access': user => ... })`
- CSRF：全局启用了 `csrf` 中间件（Laravel 方式的同步令牌）。后端下发 `XSRF-TOKEN` Cookie，`src/api.ts` 会自动在修改类请求中带上 `X-XSRF-TOKEN`；带 `Authorization: Bearer` 的请求与测试环境不校验

内置中间件（`server/config/middleware.ts` 中按名使用，配置文件放在 `server/config/` 下同名文件）：

| 名字 | 用途 | 配置 |
|------|------|------|
| `cors` | 跨域，需放在 global | `cors.ts`（`defineCorsConfig`） |
| `secureHeaders` | nosniff、frame-options、referrer-policy 等安全头，生产 https 下加 HSTS | `secureHeaders.ts` |
| `compress` | br / gzip / deflate 压缩响应 | `compress.ts` |
| `throttle:60,60` / `throttle:api` | 限流（默认按用户或 IP），返回 RateLimit-* 头与 429 | `throttle.ts`（命名规则、共享存储） |
| `bodyLimit:10mb` | 调整单个路由的请求体上限（默认 `app.bodyLimit`，1mb） | — |
| `session` | 启动会话：`ctx.session.get / set / flash / regenerate` | `session.ts`（cookie / memory / 自定义存储） |
| `auth` / `guest` | 认证 | `auth.ts` |
| `can:<ability>[,Model[,param]]` | 授权 | `app/policy/*.ts` |
| `csrf` | CSRF 同步令牌（419） | `csrf.ts`（except、cookie、testing） |
| `cacheResponse:60[,user]` | 缓存 GET 响应 | `cache.ts`（responseStore） |

文件上传：multipart 请求的 `await ctx.body()` 中文件字段为 `UploadedFile`（继承 File，可直接用 valibot 的 `v.file()`、`v.maxSize()`、`v.mimeType()` 校验），`await (await ctx.file('avatar'))?.store('storage/avatars')` 保存到本地。

## 缓存

`server/config/cache.ts`（默认内存；设置 `CACHE_STORE=redis` 与 `REDIS_URL` 切换到 Redis，需要 `pnpm add ioredis`）：

```ts
import { Cache } from '@think-h3/core'

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

- 多实例共享：`server/config/throttle.ts` 的 `store` 与 Session 的 `{ driver: 'cache', store: 'redis' }` 使用同一个缓存存储
- Workers 上的限流：限流规则配置 `binding: 'API_RATE_LIMITER'`，使用 Cloudflare Rate Limiting 绑定（原子、全局）
- 响应缓存：`.middleware('cacheResponse:60')` 缓存 GET 响应（`X-Cache: HIT / MISS`），`cacheResponse:60,user` 按用户区分

## 部署

```bash
npx think-h3 build --preset node        # 默认：node dist/server/index.mjs（依赖已打包或追踪进产物，可整体拷走）
npx think-h3 build --preset docker      # dist/ 即构建上下文：docker build -t app dist
npx think-h3 build --preset bun         # bun dist/server/index.mjs
npx think-h3 build --preset deno        # deno run -A dist/server/index.mjs
npx think-h3 build --preset vercel      # .vercel/output → vercel deploy --prebuilt
npx think-h3 build --preset netlify     # .netlify/v1/functions + netlify.toml
npx think-h3 build --preset aws-lambda  # 打包 dist/lambda，handler 为 index.handler
npx think-h3 build --preset cloudflare  # dist/wrangler.json → wrangler deploy -c dist/wrangler.json
```

也可在 `think.config.ts` 中设置 `preset`。构建会自动带上项目安装的数据库驱动。

依赖处理与 Nitro 一致：能打包的依赖都打进产物，数据库驱动、原生模块等保持 external，并按实际引用的文件追踪复制到产物的 `node_modules`（node / bun / deno / aws-lambda / vercel）。可在 `think.config.ts` 中调整：

```ts
export default defineThinkConfig({
  externals: {
    traceDeps: ['sharp', 'some-pkg*'], // 保持 external 并追踪（* 表示整包复制）
    inline: ['postgres'], // 强制打包
    // trace: false,                  // node / bun 退回依赖项目的 node_modules
  },
})
```

在 macOS / Windows 上构建 aws-lambda、vercel 产物时，如果追踪到了原生二进制，构建会给出警告：请在 Linux（CI / Docker）上构建。

`pnpm preview`（`think-h3 preview`，全栈项目也可直接 `vite preview`）按构建时的预设运行产物本身：node / bun / deno / docker 启动产物进程，aws-lambda / vercel / netlify 在进程内调用函数，cloudflare 用 Miniflare 运行 Worker（D1 迁移自动应用到本地预览库）。

### 生产迁移

迁移文件打包进产物，生产环境不需要源码与 drizzle-kit：

| 预设 | 执行迁移 |
|------|----------|
| node / bun / deno | `node dist/server/migrate.mjs`（`--connection <name>` / `--all`） |
| docker | `docker run --rm <镜像> node server/migrate.mjs` |
| aws-lambda | 同一份产物，handler 设为 `index.migrate` 调用一次（事件 `{ "connection"?, "all"? }`） |
| vercel / netlify | 在构建命令前执行 `npx think-h3 db:migrate`（使用生产库的 `DATABASE_URL`） |
| cloudflare（D1） | `npx wrangler d1 migrations apply <库名> --remote -c dist/wrangler.json` |
| cloudflare（Turso） | 在 CI 中执行 `npx think-h3 db:migrate` |

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
// think.config.ts —— 合并进 dist/wrangler.json；D1 默认使用产物中的 migrations/
export default defineThinkConfig({
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
src/            前端（React）
server/         后端（think-h3）
  app/          controller / service / validate / middleware / exception / provider
  config/       配置
  route/        路由（/api 前缀）
tests/          后端测试
think.config.ts 框架配置（srcDir、端口等）
vite.config.ts  Vite 配置（thinkH3() 插件）
```

`.env` 中 `VITE_` 开头的变量暴露给前端，其余仅后端可见。
