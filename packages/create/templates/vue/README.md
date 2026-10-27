# {{name}}

Vue 3 + think-h3 全栈项目：前后端同一个仓库、同一个端口、一次构建。

## 命令

```bash
pnpm dev        # Vite 开发服务器：前端 HMR，/api/** 由后端处理（改后端代码即时生效）
pnpm routes     # 查看后端路由表
pnpm test       # 后端测试（@think-h3/testing）
pnpm typecheck  # vue-tsc 类型检查
pnpm build      # 构建 dist/client 与 dist/server
pnpm start      # 运行构建产物（同一进程托管前端页面与 API）
```

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
