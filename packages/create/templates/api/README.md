# {{name}}

基于 think-h3 的 Node 服务端项目。

## 命令

```bash
pnpm dev        # 开发服务器，修改代码即时生效（进程不重启）
pnpm routes     # 查看路由表
pnpm typegen    # 生成配置键 / 路由名类型（dev 时自动执行）
pnpm test       # 运行测试
pnpm build      # 构建到 dist/
pnpm start      # 运行构建产物
```

## 代码生成

```bash
npx think-h3 make:controller User --resource   # app/controller/UserController.ts
npx think-h3 make:service User                 # app/service/UserService.ts
npx think-h3 make:middleware Authenticate      # app/middleware/Authenticate.ts
npx think-h3 make:validate User                # app/validate/user.ts
npx think-h3 make:test user                    # tests/user.test.ts
npx think-h3 stub:publish                      # 复制模板到 stubs/，按团队规范定制
```

其余：`make:repository`、`make:provider`、`make:config`、`make:route`。名称可带子目录，如 `admin/User`。

## 类型安全

开发服务器会把配置键与命名路由生成到 `.think/types/think.d.ts`：

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
- `app/interceptor/*.ts`：出站拦截器，拿到最终 Response 后可改头或替换（`think-h3 make:interceptor`）
- 单个路由跳过：`.meta({ envelope: false })` 或 `return raw(value)`

## 数据库

默认使用 SQLite（`config/database.ts`，文件位于 `data/app.db`），表结构在 `database/schema/*.ts`（drizzle），模型在 `app/model/`：

```bash
pnpm db:migrate                         # 执行迁移（首次运行前执行）
pnpm db:seed                            # 数据填充（database/seeders）
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
- 生成代码：`npx think-h3 make:controller User --app admin`

## 部署

```bash
npx think-h3 build --preset node        # 默认：node dist/index.mjs（依赖使用 node_modules）
npx think-h3 build --preset docker      # dist/ 即构建上下文：docker build -t app dist
npx think-h3 build --preset bun         # bun dist/index.mjs
npx think-h3 build --preset deno        # deno run -A dist/server/index.mjs
npx think-h3 build --preset vercel      # .vercel/output → vercel deploy --prebuilt
npx think-h3 build --preset netlify     # .netlify/v1/functions + netlify.toml
npx think-h3 build --preset aws-lambda  # 打包 dist/lambda，handler 为 index.handler
npx think-h3 build --preset cloudflare  # dist/wrangler.json → wrangler deploy -c dist/wrangler.json
```

也可在 `think.config.ts` 中设置 `preset`。数据库：Cloudflare Workers 上 SQL 驱动暂不可用（规划中：D1 / Turso HTTP），其余预设会自动带上 SQLite 等驱动。

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
tests/          测试（@think-h3/testing）
```
