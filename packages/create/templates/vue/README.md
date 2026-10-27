# {{name}}

Vue 3 + think-h3 全栈项目：前后端同一个仓库、同一个端口、一次构建。

## 命令

```bash
pnpm dev        # Vite 开发服务器：前端 HMR，/api/** 由后端处理（改后端代码即时生效）
pnpm routes     # 查看后端路由表
pnpm typegen    # 生成配置键 / 路由名类型（dev 时自动执行）
pnpm test       # 后端测试（@think-h3/testing）
pnpm typecheck  # vue-tsc 类型检查
pnpm build      # 构建 dist/client 与 dist/server
pnpm start      # 运行构建产物（同一进程托管前端页面与 API）
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

## 部署

```bash
npx think-h3 build --preset node        # 默认：node dist/server/index.mjs（依赖使用 node_modules）
npx think-h3 build --preset docker      # dist/ 即构建上下文：docker build -t app dist
npx think-h3 build --preset bun         # bun dist/server/index.mjs
npx think-h3 build --preset deno        # deno run -A dist/server/index.mjs
npx think-h3 build --preset vercel      # .vercel/output → vercel deploy --prebuilt
npx think-h3 build --preset netlify     # .netlify/v1/functions + netlify.toml
npx think-h3 build --preset aws-lambda  # 打包 dist/lambda，handler 为 index.handler
npx think-h3 build --preset cloudflare  # dist/wrangler.json → wrangler deploy -c dist/wrangler.json
```

也可在 `think.config.ts` 中设置 `preset`。数据库：Cloudflare Workers 上 SQL 驱动暂不可用（规划中：D1 / Turso HTTP），其余预设会自动带上 SQLite 等驱动。

## 目录

```
src/            前端（Vue）
server/         后端（think-h3）
  app/          controller / service / validate / middleware / exception / provider
  config/       配置
  route/        路由（/api 前缀）
tests/          后端测试
think.config.ts 框架配置（srcDir、端口等）
vite.config.ts  Vite 配置（thinkH3() 插件）
```

`.env` 中 `VITE_` 开头的变量暴露给前端，其余仅后端可见。
