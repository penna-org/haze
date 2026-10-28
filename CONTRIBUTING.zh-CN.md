# 参与 hazejs 开发

[English](./CONTRIBUTING.md) · 简体中文

欢迎提交 Bug、文档修正、新驱动和新功能。较大的改动请先开 Issue 或 Discussion 讨论设计。

## 环境

- Node.js `>=22.12`（仓库 `.nvmrc` 为 22.18，执行 `nvm use`）
- pnpm 11（`corepack enable`）

```bash
git clone https://github.com/penna-org/haze.git
cd haze
pnpm install
pnpm build       # 用 tsdown 构建 packages/*
pnpm test        # 先构建，再运行全部 Vitest 项目
pnpm lint
pnpm typecheck
```

## 目录

```
packages/core/      @hazejs/core      运行时（容器、路由、中间件、认证、缓存、队列、事件、WebSocket、存储、邮件）
packages/vite/      @hazejs/vite      Vite 插件、热更新开发服务器、构建预设、预览
packages/cli/       @hazejs/cli       haze 命令行
packages/orm/       @hazejs/orm       基于 drizzle 的模型、查询构造器、迁移；MongoDB 适配器
packages/testing/   @hazejs/testing   Vitest 集成与 HTTP 测试客户端
packages/socketio/  @hazejs/socket.io Socket.IO 集成
packages/create/    create-hazejs     脚手架与 api / vue / react 模板
playground/         示例项目（用户 CRUD），也作为集成测试
docs/               设计文档（docs/design.md）与路线图
```

在 playground 中体验：`cd playground && pnpm dev`（`haze dev`，修改代码即时生效）、`pnpm routes`、`npx haze make:controller Order --resource`。也可以从源码创建项目：`node packages/create/bin/create-hazejs.mjs my-app -t vue`。

## 需要真实服务的测试

依赖外部服务的测试只在设置了对应环境变量时运行，CI 中全部运行；本地只需启动改动涉及的服务。变量与示例见[英文版](./CONTRIBUTING.md#tests-with-real-services)的表格：`HAZE_TEST_REDIS_URL`、`HAZE_TEST_UPSTASH_URL` / `HAZE_TEST_UPSTASH_TOKEN`、`HAZE_TEST_MYSQL_URL`、`HAZE_TEST_TURSO_URL`、`HAZE_TEST_S3_ENDPOINT`、`HAZE_TEST_SMTP_URL` / `HAZE_TEST_MAILPIT_API`。Cloudflare 的 D1、KV、R2、Queues、Durable Objects 在 Miniflare 中运行，无需准备；PATH 中有 `bun` 时运行 Bun 相关测试。

## 提交 Pull Request

1. Fork 后从 `main` 创建分支。
2. 行为变化需要补测试（各模块的测试在 `packages/*/test`）。
3. 运行 `pnpm lint`、`pnpm typecheck`、`pnpm test`。
4. 修改已发布的包时添加 changeset：`pnpm changeset`。
5. 行为变化时同步文档：根 README、模板 README（`packages/create/templates/*/README.md`），设计决策写入 `docs/design.md`。

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org)（`feat:`、`fix:`、`docs:`、`chore:` 等）。

## 约定

- 只用 ESM，TypeScript 严格模式。
- 可选驱动作为可选 peer 依赖，用动态 `import()` 加载；新驱动需要加入 `packages/vite/src/presets/deps.ts` 的 `DRIVER_PACKAGES`（不能在 Workers 上运行时同时加入 `EDGE_UNSUPPORTED_DRIVERS`）。
- 每个功能都要能在开发服务器（热更新）、测试（必要时提供 `fake()`）和声明支持的部署预设中工作。
- 现有代码注释以中文为主，新代码中英文均可。

## 发版

使用 Changesets 自动发版：changeset 合入 `main` 后会自动开 "Version Packages" PR，合并即发布到 npm（带 provenance）。所有 `@hazejs/*` 包使用同一个版本号。

提交贡献即表示同意以 [MIT 许可证](./LICENSE)授权你的贡献。
