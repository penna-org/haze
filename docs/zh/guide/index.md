# 什么是 hazejs

hazejs 是一个开箱即用的 TypeScript 后端框架。它把 Laravel、ThinkPHP 那种“约定优于配置”的开发效率——服务容器、集中路由、代码生成器，以及官方自带的队列、邮件、认证——搬到了以 [h3 v2](https://h3.dev) 和 [Vite](https://vite.dev) 为基础的现代工具链上。

同一份应用可以运行在 Node.js、Bun、Deno、Docker、Cloudflare Workers、Vercel、Netlify 和 AWS Lambda 上；还可以与 Vue、React 或任意 Vite 前端共用一个端口，一次构建同时产出前后端。

::: warning 预发布阶段
hazejs 目前处于 `0.x` 版本，1.0 之前 API 仍可能调整，各个包也还没有发布到 npm。想提前体验，请参考[贡献指南](https://github.com/penna-org/haze/blob/main/CONTRIBUTING.md)从源码运行。
:::

## 设计理念

**约定优于配置。** 控制器放在 `app/controller`，配置放在 `config/`，路由放在 `route/`，队列任务放在 `app/job`。大部分目录在编译期自动发现，不需要手写注册代码；文件本身也可以用 `haze make:*` 一键生成。详见[目录结构](./directory-structure)。

**底层是 Web 标准。** h3 v2 直接基于 Web 的 `Request` / `Response`。hazejs 在其之上补齐“应用层”：IoC 容器、服务提供者、中间件管线、异常处理器、统一响应格式和生命周期。整个内核最终只是一个 `fetch` 处理函数，因此同一份代码能跑在所有运行时上，测试时也不必监听端口。

**原生的 Vite 工具链。** `haze dev` 通过 Vite 的 ModuleRunner 直接运行 TypeScript。文件变化时重新构建应用，并原子替换 `fetch` 处理函数：进程不重启、端口不断开，数据库连接池、Redis 连接和 WebSocket 连接都不受影响。

**全部官方实现，风格统一。** 每个模块都用同一种方式配置（`config/<name>.ts`），用同一种方式测试（`fake()` 系列辅助函数），并且在开发服务器、测试环境以及它所支持的每个部署预设中表现一致。

## 先睹为快

```ts
// route/api.ts
import { defineRoutes } from '@hazejs/core'
import { PostController } from '~/app/controller/PostController'
import { PostIdParams } from '~/app/validate/post'

export default defineRoutes((r) => {
  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    r.resource('/posts', PostController).validateMember({ params: PostIdParams })
  })
})
```

```ts
// app/controller/PostController.ts
import type { HttpContext } from '@hazejs/core'
import type { PostIdParams } from '~/app/validate/post'
import { inject } from '@hazejs/core'
import { Post } from '~/app/model/Post'
import { PostService } from '~/app/service/PostService'

export class PostController {
  static middleware = [{ use: 'auth', except: ['index', 'show'] }]

  private posts = inject(PostService)

  index() {
    return Post.order('id', 'desc').paginate(1, 20)
  }

  async update(ctx: HttpContext<{ params: typeof PostIdParams }>) {
    const post = await Post.findOrFail(ctx.validated.params.id)
    await ctx.authorize('update', post) // app/policy/PostPolicy.ts
    return this.posts.update(post, await ctx.body())
  }
}
```

控制器返回什么，框架就把它包装成统一的响应结构（默认 `{ code: 0, message: 'ok', data }`）；出错时则统一交给异常处理器渲染。

## 功能一览

| 领域 | 功能 |
| --- | --- |
| HTTP | 集中式[路由](./routing)、分组、资源路由、命名路由、[控制器](./controllers)、[中间件](./middleware)、出站拦截器、统一[响应](./responses)格式、带开发错误页的[异常处理](./errors) |
| 容器 | `inject()`，singleton / request / transient 三种作用域，服务提供者，跨热重载保留的持久资源，见[服务容器](./container) |
| 校验 | Standard Schema（valibot、zod、arktype……），路由级 `.validate({ body, query, params })`，带类型的 `ctx.validated`，见[请求与校验](./requests) |
| 数据库 | 基于 drizzle 的 `@hazejs/orm`：[模型](./models)、查询构造器、软删除、迁移与数据填充，支持 SQLite、PostgreSQL、MySQL、Turso、D1，另有 MongoDB 适配，见[数据库](./database) |
| 安全 | [认证](./authentication)（JWT 与 Session Guard）、[授权](./authorization)（Gate 与 Policy）、[CSRF、Session、CORS、安全响应头与限流](./security) |
| 基础设施 | 支持原子锁的[缓存](./cache)、支持重试与延迟的[队列](./queues)、[定时任务](./scheduling)、支持排队监听器的[事件](./events) |
| 实时通信 | 基于 crossws 的 [WebSocket](./websocket)，以及 `@hazejs/socket.io` 提供的 [Socket.IO](./socket-io) |
| 文件与邮件 | 本地磁盘、S3、R2 [文件存储](./storage)；SMTP、Resend、Postmark、Mailgun、SES [邮件](./mail) |
| 工具链 | `haze` [命令行](./cli)：开发服务器、构建、预览、16 个 `make:*` 生成器、`db:*`、`queue:*`、`schedule:*`，以及为配置键、路由名、授权能力生成的类型 |
| 测试 | `useTestApp()`、`actingAs(user)`，以及队列、事件、邮件、存储的 fake，见[测试](./testing) |

## 运行时与部署

一套代码，一条构建命令：

```bash
haze build --preset node        # 另有 bun、deno、docker
haze build --preset cloudflare  # Workers，支持 D1 / KV / R2 / Queues / Durable Objects
haze build --preset vercel      # 另有 netlify、aws-lambda
```

无法打包的依赖（数据库驱动、原生模块）会被追踪复制到产物的 `node_modules` 中，`dist/` 可以整体拷走独立运行。`haze preview` 可以在本地按任意预设运行真实的构建产物。详见[部署](./deployment)。

## Vite 全栈

在 Vite 项目中加入 `haze()` 插件后，开发时 `/api/**` 会在同一个端口交给后端处理——不用配代理，也没有跨域问题。`vite build` 一次产出 `dist/client` 与 `dist/server`，生产环境由一个进程同时提供页面和接口。详见 [Vite 全栈](./fullstack)。

## 与其他框架对比

hazejs 介于 Express、Fastify、Hono 这类轻量路由库与 NestJS、AdonisJS 这类完整框架之间：功能完整度对标 Laravel，同时基于 Web 标准、可以部署到 Edge。逐项功能对比以及后续计划见[路线图](/zh/roadmap)。

## 适用场景

以下情况很适合使用 hazejs：

- 需要一个完整的后端——数据库、认证、队列、邮件、实时通信——又不想自己挑选、拼装十几个库；
- 想做前后端一体的项目：Vue / React 前端与 API 放在同一个仓库、共用一个端口、一次构建，而不必搭建 monorepo；
- 希望同一份代码既能部署到云服务器、容器，也能部署到 Serverless 函数或 Cloudflare Workers；
- 有 Laravel 或 ThinkPHP 背景，希望沿用熟悉的项目结构。

以下情况可能不太合适：只需要寥寥几个接口（轻量路由库更简单）；现在就需要稳定的 1.0 API；或者需要像 Express 那样庞大的第三方插件生态。

## 下一步

- [快速开始](./getting-started)：创建第一个项目
- [目录结构](./directory-structure)：各类代码放在哪里
- [配置](./configuration)：`config/*.ts`、`.env` 与 `haze.config.ts`
