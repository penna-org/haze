<h1 align="center">hazejs</h1>

<p align="center">
  开箱即用的 TypeScript 后端框架，运行在 Node.js、Bun、Deno 与 Edge 上。
</p>

<p align="center">
  <a href="https://github.com/penna-org/haze/actions/workflows/ci.yml"><img src="https://github.com/penna-org/haze/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-339933" alt="Node >= 22.12">
  <img src="https://img.shields.io/badge/status-pre--release-orange" alt="pre-release">
</p>

<p align="center">
  <a href="./README.md">English</a> · 简体中文
</p>

---

hazejs 把 Laravel / ThinkPHP 式的开发效率和现代 Vite 工具链放进同一个 TypeScript 框架。它基于 [h3 v2](https://h3.dev)，同一个应用可以运行在 Node、Bun、Deno、Docker、Cloudflare Workers、Vercel、Netlify 和 AWS Lambda 上，还能与 Vue / React 等任意 Vite 前端共用一个端口、一次构建。

> **状态：** 预发布（`0.x`），API 仍可能调整。包尚未发布到 npm，从源码体验见[贡献指南](./CONTRIBUTING.md)。
>
> 📖 **[阅读文档](https://penna-org.github.io/haze/zh/)**

## 亮点

- **功能齐全**：路由、IoC 容器、校验、ORM 与迁移、认证（JWT / Session）、授权（Gate / Policy）、CSRF、限流、缓存、队列、定时任务、事件、WebSocket、Socket.IO、文件存储、邮件和测试替身，统一的配置方式，无需自己拼装。
- **热更新不重启**：`haze dev` 原地替换控制器、服务、路由和配置；数据库连接池、Redis 连接和 Socket 在修改代码后保持不断。
- **Vite 全栈**：在任意 Vite 项目中加入 `haze()`：开发时 `/api/**` 交给后端，`vite build` 同时产出前端与服务端，`vite preview` 运行真实产物。
- **随处部署**：`haze build --preset node | bun | deno | docker | cloudflare | vercel | netlify | aws-lambda`。原生依赖按实际引用追踪进 `dist/node_modules`（参考 Nitro），产物可独立运行。
- **Edge 原生驱动**：Cloudflare 上的 D1、KV、R2、Queues、Cron Triggers 与 Durable Objects（WebSocket）；Turso / libSQL HTTP；Serverless 场景的 Upstash Redis。
- **端到端类型**：配置键、命名路由、授权能力自动生成类型；请求校验遵循 Standard Schema（valibot、zod、arktype 等）。
- **测试优先**：`useTestApp()`、`actingAs(user)`、`refreshDatabase()`，以及队列、事件、邮件、存储的 `fake()`。

## 快速开始

```bash
pnpm create hazejs my-app            # 交互选择模板
pnpm create hazejs my-app -t api     # 纯后端 API
pnpm create hazejs my-app -t vue     # Vue 3 全栈（同仓库、同端口、一次构建）
pnpm create hazejs my-app -t react   # React 19 全栈

cd my-app && pnpm dev
```

在已有的 Vite 项目（Vue / React / Svelte / Solid / 无框架均可）中使用：

```ts
// vite.config.ts
import { haze } from '@hazejs/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vue(),
    haze(),
  ],
})
```

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({ srcDir: 'server' })
```

## 示例

```ts
// route/api.ts
export default defineRoutes((r) => {
  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    r.resource('/posts', PostController).validateMember({ params: PostIdParams })
    r.post('/auth/login', [AuthController, 'login']).middleware('throttle:10,60')
    r.ws('/ws', ChatSocket)
  })
})

// app/controller/PostController.ts
export class PostController {
  static middleware = [
    {
      use: 'auth',
      except: ['index', 'show']
    }
  ]

  private posts = inject(PostService)

  async update(ctx: HttpContext<{ params: typeof PostIdParams }>) {
    const post = await Post.findOrFail(ctx.validated.params.id)
    await ctx.authorize('update', post) // app/policy/PostPolicy.ts
    return this.posts.update(post, await validate(PostSchema, await ctx.body()))
  }
}

// app/listener/SendWelcomeEmail.ts：在队列中执行，失败自动重试
export default defineListener(UserRegistered, async ({ userId }) => {
  const user = await User.findOrFail(userId)
  await Mail.to(user.email).send(WelcomeMail, { name: user.name })
}, {
  queue: { tries: 3 }
})
```

## 功能

| 领域 | 内容 |
| --- | --- |
| HTTP | 集中路由、分组、资源路由、命名路由、按域名 / 前缀的多应用、类与函数中间件、出站拦截器、统一响应格式、异常处理与开发错误页 |
| 校验 | Standard Schema（`validate()`、路由级 `.validate({ body, query, params })`），类型化的 `ctx.validated` |
| 容器 | `inject()`，Singleton / Request / Transient 作用域，服务提供者，跨热更新的持久资源 |
| 数据 | `@hazejs/orm`（基于 drizzle）：模型、查询构造器、软删除、迁移、数据填充，支持 MySQL、PostgreSQL、SQLite、Turso、D1，以及 MongoDB 适配器 |
| 安全 | JWT（jose）与 Session Guard、`Hash`（scrypt）、签名 / 加密 Cookie、Gate 与 Policy、CSRF、CORS、安全响应头、限流 |
| 基础设施 | 缓存（memory / Redis / Upstash / KV，原子锁，响应缓存）、队列（sync / memory / BullMQ / Cloudflare Queues）、定时任务（cron、时区、单实例执行）、事件与排队监听器 |
| 实时通信 | 基于 crossws 的 WebSocket（Redis 多实例广播，Workers 上使用 Durable Object）；`@hazejs/socket.io` 集成 Socket.IO（Node 与 Bun、Guard 鉴权、Redis 适配器） |
| 文件与邮件 | 磁盘：local / S3（AWS SDK v3、分片上传、预签名）/ R2 / memory，签名临时链接；邮件：SMTP / Resend / Postmark / Mailgun / SES，排队发送，布局辅助 |
| 工具 | `haze` 命令行：`dev`、`build`、`preview`、`start`、`test`、`route:list`、`typegen`、`make:*`（16 种生成器）、`db:*`、`queue:*`、`schedule:*`、`key:generate` |
| 部署 | node、bun、deno、docker、cloudflare、vercel、netlify、aws-lambda，提供迁移与 worker 入口 |

与其它 Node.js 框架的对比和后续规划见[路线图](https://penna-org.github.io/haze/zh/roadmap)。

## 包

| 包 | 说明 |
| --- | --- |
| [`@hazejs/core`](./packages/core) | 运行时：容器、路由、中间件、认证、缓存、队列、事件、WebSocket、存储、邮件 |
| [`@hazejs/vite`](./packages/vite) | Vite 插件、热更新开发服务器、构建预设与预览 |
| [`@hazejs/cli`](./packages/cli) | `haze` 命令行 |
| [`@hazejs/orm`](./packages/orm) | 基于 drizzle 的模型、查询构造器与迁移；MongoDB 适配器 |
| [`@hazejs/testing`](./packages/testing) | Vitest 集成与 HTTP 测试客户端 |
| [`@hazejs/socket.io`](./packages/socketio) | Socket.IO 服务端集成 |
| [`create-hazejs`](./packages/create) | 项目脚手架（api / vue / react 模板） |

## 文档

- **[文档站](https://penna-org.github.io/haze/zh/)**：每个模块的指南，中英双语
- [路线图与框架对比](https://penna-org.github.io/haze/zh/roadmap)
- [设计文档](./docs/design.md)（含每个里程碑的实施记录）

## 参与贡献

欢迎提交 Issue 和 Pull Request，请先阅读[贡献指南](./CONTRIBUTING.md)与[行为准则](./CODE_OF_CONDUCT.md)。安全问题请见 [SECURITY.md](./SECURITY.md)。

## 许可证

[MIT](./LICENSE)
