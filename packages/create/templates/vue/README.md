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
