# 快速开始

本文带你创建一个 hazejs 项目并运行起来，然后亲手添加第一个路由和控制器。

::: warning 预发布阶段
hazejs 目前处于 `0.x` 版本，`@hazejs/*` 各包还没有发布到 npm。正式发布之前，请按照[贡献指南](https://github.com/penna-org/haze/blob/main/CONTRIBUTING.md)从源码运行模板。下面的命令是包发布之后的使用方式。
:::

## 环境要求

- **Node.js 22.12 及以上**（Vite 8 的要求）。
- 推荐使用 **pnpm**，npm 和 yarn 同样可用。

## 创建项目

::: code-group

```sh [pnpm]
pnpm create hazejs my-app
```

```sh [npm]
npm create hazejs@latest my-app
```

```sh [yarn]
yarn create hazejs my-app
```

:::

不带 `-t` 参数时会交互式地让你选择模板，也可以直接指定：

```sh
pnpm create hazejs my-app -t api     # 纯后端 API
pnpm create hazejs my-app -t vue     # Vue 3 全栈
pnpm create hazejs my-app -t react   # React 19 全栈
```

::: tip
使用 npm 时，参数需要用 `--` 与包名隔开：`npm create hazejs@latest my-app -- -t vue`。
:::

| 模板 | 内容 |
| --- | --- |
| `api` | 纯后端服务，代码直接位于项目根目录（`app/`、`config/`、`route/`） |
| `vue` | Vue 3 + hazejs：同一个仓库、同一个端口、一次构建，后端代码位于 `server/` |
| `react` | 同样的全栈结构，前端换成 React 19 |

在非交互环境中（CI、没有 TTY）默认使用 `api` 模板。目标目录非空时需要加 `--force`（会先清空该目录）。

脚手架会：

- 复制模板，并根据目录名设置 `package.json` 的 `name`；
- 在 `.env` 中写入一个随机生成的 `APP_KEY`，用于签名 Cookie、加密 Session，同时也是 JWT 的默认密钥；
- 生成 `pnpm-workspace.yaml`，声明依赖安装脚本的处理方式（pnpm 11 要求显式声明）；如果项目创建在已有的 pnpm workspace 内则跳过。

脚手架**不会**自动安装依赖，接下来手动安装：

```sh
cd my-app
pnpm install
```

## 模板里有什么

`api` 模板是一个完整可运行的示例，而不是空壳，包括：

- 带请求校验的 `GET /api/hello` 与 `POST /api/hello`；
- 基于 SQLite 和 `User` 模型的 `users` 资源接口；
- JWT 注册、登录和 `/api/auth/me`，以及“只能修改自己资料”的授权策略；
- 事件、监听器、队列任务、邮件和定时任务各一个示例；
- 位于 `/api/ws` 的 WebSocket 路由；
- 覆盖以上功能的测试。

全栈模板在此基础上增加了 `src/` 下的 Vue / React 前端和一个 Socket.IO 命名空间。每个目录的用途见[目录结构](./directory-structure)。

## 运行项目

模板默认使用 SQLite（`data/app.db`）。首次运行前先执行一次迁移建表，再启动开发服务器：

```sh
pnpm db:migrate
pnpm dev
```

`api` 模板监听 `http://localhost:3000`：

```sh
curl localhost:3000/api/hello
# {"code":0,"message":"ok","data":{"app":"my-app","message":"Hello, hazejs!"}}
```

全栈项目则由 Vite 启动，使用 Vite 的端口（默认 `http://localhost:5173`），页面和 `/api/**` 共用这一个端口，详见 [Vite 全栈](./fullstack)。

修改任意控制器、服务、路由或配置文件，下一个请求就会用上新代码。进程不会重启，终端只会打印一行 `reloaded`。

## 第一个路由和控制器

先生成一个服务和一个控制器：

```sh
npx haze make:service Post      # app/service/PostService.ts
npx haze make:controller Post   # app/controller/PostController.ts
```

服务负责业务逻辑，不感知 HTTP：

```ts
// app/service/PostService.ts
export class PostService {
  private posts = [
    { id: 1, title: 'Hello hazejs' },
    { id: 2, title: 'Second post' },
  ]

  all() {
    return this.posts
  }

  find(id: number) {
    return this.posts.find(post => post.id === id)
  }
}
```

控制器接收请求，通过 `inject()` 调用服务，直接返回数据即可：

```ts
// app/controller/PostController.ts
import type { HttpContext } from '@hazejs/core'
import { inject, NotFoundException } from '@hazejs/core'
import { PostService } from '~/app/service/PostService'

export class PostController {
  private posts = inject(PostService)

  index() {
    return this.posts.all()
  }

  show(ctx: HttpContext) {
    const post = this.posts.find(Number(ctx.param('id')))
    if (!post)
      throw new NotFoundException(`Post ${ctx.param('id')} not found`)
    return post
  }
}
```

`~` 是指向后端源码目录的别名，无论文件放在哪一层，导入路径都保持一致。路由不会从控制器自动推导，需要在 `route/api.ts` 已有的 `/api` 分组里注册：

```ts
// route/api.ts
import { PostController } from '~/app/controller/PostController'

export default defineRoutes((r) => {
  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    // ...已有的路由
    r.get('/posts', [PostController, 'index']).name('posts.index')
    r.get('/posts/:id', [PostController, 'show']).name('posts.show')
  })
})
```

保存后试一下：

```sh
curl localhost:3000/api/posts/1
# {"code":0,"message":"ok","data":{"id":1,"title":"Hello hazejs"}}

curl localhost:3000/api/posts/9
# 404，由异常处理器按同样的响应结构输出
```

运行 `pnpm routes` 可以在路由表中看到新增的两条。由于路由带了名字，生成类型之后（开发服务器会自动生成），`router.url('api.posts.show', { id: 1 })` 的路由名和参数都会经过类型检查。

### 加一个测试

```sh
npx haze make:test post   # tests/post.test.ts
```

```ts
// tests/post.test.ts
import { useTestApp } from '@hazejs/testing'
import { describe, expect, it } from 'vitest'

const t = useTestApp()

describe('posts', () => {
  it('shows a post', async () => {
    const res = await t.get('/api/posts/1')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ id: 1, title: 'Hello hazejs' })
  })
})
```

```sh
pnpm test
```

测试在进程内启动真实的应用，不监听端口。详见[测试](./testing)。

## 默认脚本

所有模板都自带以下脚本：

| 脚本 | 命令 | 作用 |
| --- | --- | --- |
| `dev` | `haze dev` | 开发服务器，原地热替换 |
| `build` | `haze build` | 构建生产产物（`dist/`） |
| `start` | `haze start` | 运行生产产物 |
| `preview` | `haze preview` | 按构建时的部署预设在本地运行产物 |
| `queue` | `haze queue:work` | 消费队列任务 |
| `schedule` | `haze schedule:work` | 常驻执行定时任务（每分钟检查） |
| `test` | `haze test` | 运行 Vitest |
| `routes` | `haze route:list` | 打印路由表 |
| `typecheck` | `tsc --noEmit` | 类型检查（全栈模板为 `vue-tsc --build` / `tsc --build`） |
| `typegen` | `haze typegen` | 生成配置键、路由名、授权能力的类型 |
| `db:generate` | `haze db:generate` | 根据表结构变化生成迁移 |
| `db:migrate` | `haze db:migrate` | 执行尚未运行的迁移 |
| `db:seed` | `haze db:seed` | 执行数据填充 |

额外的参数会原样传给命令，例如 `pnpm db:generate --name create_posts`。所有命令的说明见[命令行参考](./cli)。

## 下一步

- [目录结构](./directory-structure)：每个目录的用途
- [配置](./configuration)：`config/*.ts`、`.env` 与 `haze.config.ts`
- [路由](./routing)与[控制器](./controllers)：深入 HTTP 层
- [数据库](./database)：表结构、迁移与模型
- [部署](./deployment)：构建到 Node、Docker、Serverless 或 Edge
