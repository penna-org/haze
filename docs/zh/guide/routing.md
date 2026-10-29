# 路由

hazejs 的路由集中定义在 `route/*.ts` 中。该目录下的文件会被自动发现，每个文件默认导出 `defineRoutes()`。路由定义本身是纯数据，启动时才编译，所以可以打印路由表、生成类型、按名字生成 URL。

```ts
// route/api.ts
import { defineRoutes } from '@hazejs/core'
import { GreetingController } from '~/app/controller/GreetingController'

export default defineRoutes((r) => {
  r.get('/', () => ({ message: 'Hello hazejs' }))
  r.get('/hello', [GreetingController, 'index']).name('hello')
})
```

## HTTP 方法

构造器 `r` 为每种请求方法提供了同名方法，参数都是路径和处理器，返回值是一个 `Route`，可以继续链式调用。

```ts
// route/api.ts
r.get('/posts', [PostController, 'index'])
r.post('/posts', [PostController, 'store'])
r.put('/posts/:id', [PostController, 'update'])
r.patch('/posts/:id', [PostController, 'update'])
r.delete('/posts/:id', [PostController, 'destroy'])
r.options('/posts', [PostController, 'options'])
r.any('/webhook', [WebhookController, 'handle']) // 匹配所有方法
```

## 处理器

处理器可以是函数，也可以是 `[Controller, 'method']` 元组。

```ts
// route/api.ts
// 闭包：参数为 HttpContext
r.get('/ping', ctx => ({ pong: true, path: ctx.path }))

// 控制器方法：可跳转、可重构，方法名受类型检查
r.get('/users/:id', [UserController, 'show'])
```

除了一两行就能写完的逻辑，建议都用控制器元组。方法名写错会直接报类型错误；处理器不合法时，应用启动阶段就会给出明确的报错。控制器在每个请求中从容器解析，因此可以使用 `inject()`，详见 [控制器](./controllers)。

## 路由参数

以 `:` 开头的路径段是参数，可以用 `ctx.param()` / `ctx.params()` 读取，也可以用 `.validate()` 校验并转换类型（见下文）。

```ts
// route/api.ts
r.get('/posts/:postId/comments/:id', (ctx) => {
  return { post: ctx.param('postId'), comment: ctx.param('id') }
})
```

参数值是已 URL 解码的字符串（`/files/%E6%96%87` 得到 `文`），需要数字时请用 Schema 转换。

## 路由分组

`r.group()` 让一组路由共享 URL 前缀、路由名前缀和中间件。分组可以嵌套，前缀与中间件逐层叠加。

```ts
// route/api.ts
r.group({ prefix: '/api', as: 'api.' }, (r) => {
  r.get('/hello', [GreetingController, 'index']).name('hello') // 路由名：api.hello

  r.group({ prefix: '/admin', as: 'admin.', middleware: ['auth', 'can:admin.access'] }, (r) => {
    r.get('/stats', [StatsController, 'index']).name('stats') // 路由名：api.admin.stats
  })
})

// 也可以不传选项
r.group((r) => {
  r.get('/a', handlerA)
})
```

| 选项 | 说明 |
|------|------|
| `prefix` | 拼接在每条路由前面的路径前缀 |
| `as` | 路由名前缀，例如 `'admin.'` |
| `middleware` | 作用于组内所有路由的中间件 |

::: info 按域名分发
分组没有 `domain` 选项。如果需要把一组路由放到独立域名或独立前缀下，并拥有自己的配置，请使用 [多应用](./multi-app)（`config/app.ts` 中的 `apps`）。
:::

## 资源路由

`r.resource()` 按 RESTful 约定为控制器注册一组路由：

| 方法 | 路径 | 动作 | 路由名 |
|------|------|------|--------|
| GET | `/users` | `index` | `users.index` |
| POST | `/users` | `store` | `users.store` |
| GET | `/users/:id` | `show` | `users.show` |
| PUT / PATCH | `/users/:id` | `update` | `users.update`（仅 PUT 命名） |
| DELETE | `/users/:id` | `destroy` | `users.destroy` |

```ts
// route/api.ts
r.resource('/users', UserController)
r.resource('/photos', PhotoController, { only: ['index', 'show'] })
r.resource('/posts', PostController, { except: ['destroy'], param: 'slug', name: 'articles' })
```

- 不传 `only` 时，只注册控制器上真正实现了的方法。
- `only` 中列出了控制器没有的方法时，应用启动失败。
- `param` 修改成员路由的参数名（默认 `id`）；`name` 指定路由名基础（默认取路径最后一段）。
- 外层分组的 `as` 前缀同样生效，例如 `api.users.show`。

`r.resource()` 返回 `ResourceRoutes`：`.middleware()` 为全部资源路由添加中间件，`.validateMember()` 只为带 `:id` 的成员路由（`show`、`update`、`destroy`）声明校验：

```ts
// route/api.ts
import { UserIdParams } from '~/app/validate/user'

r.resource('/users', UserController)
  .middleware('auth')
  .validateMember({ params: UserIdParams })
```

用下面的命令生成对应的资源控制器：

```bash
npx haze make:controller User --resource
```

## 路由选项

每个路由方法都返回 `Route`，支持以下链式调用：

```ts
// route/api.ts
r.post('/login', [AuthController, 'login'])
  .name('login')
  .middleware('throttle:10,60')
  .validate({ body: LoginSchema })

r.get('/legacy', [LegacyController, 'index']).meta({ envelope: false })
```

| 方法 | 说明 |
|------|------|
| `.name(name)` | 命名路由（会加上分组的 `as` 前缀） |
| `.middleware(...refs)` | 添加中间件：别名字符串（可带参数）、函数或类，详见 [中间件](./middleware) |
| `.validate({ body, query, params, headers })` | 在处理器执行前校验请求，结果写入 `ctx.validated`，详见 [请求与校验](./requests) |
| `.meta(meta)` | 附加元数据；`{ envelope: false }` 表示不包装统一响应格式，详见 [响应](./responses) |

## 命名路由与 URL 生成

用 `router.url()` 按路由名生成地址。缺少必填参数时直接抛错，第三个参数用于拼接查询字符串。

```ts
// app/controller/PostController.ts
import type { HttpContext } from '@hazejs/core'
import { inject, Router } from '@hazejs/core'

export class PostController {
  private router = inject(Router)

  async store(ctx: HttpContext) {
    const post = { id: 42 }
    ctx.setHeader('location', this.router.url('api.posts.show', { id: post.id }))
    return ctx.created(post)
  }

  index() {
    return { next: this.router.url('api.posts.index', {}, { page: 2 }) } // /api/posts?page=2
  }
}
```

不在容器中时，也可以使用 `useApp().router.url(...)`。路由名必须唯一，重名会导致启动失败。

### 路由名的类型

开发服务器每次重载后都会执行 `haze typegen`，把所有命名路由及其路径参数写入 `.haze/types/haze.d.ts`。之后 `router.url()` 只接受已定义的路由名，并按路径检查参数：

```ts
router.url('api.users.show', { id: 1 }) // 正确
router.url('api.users.show') // 类型错误：缺少 { id }
router.url('api.user.show', { id: 1 }) // 类型错误：路由名不存在
```

也可以手动执行 `pnpm typegen`（`haze typegen`），例如在 CI 里先生成类型再跑 `tsc`。

## 签名链接

签名链接带有一个对路径与查询参数计算的 HMAC-SHA256 签名（密钥为 `APP_KEY`），可以直接发给用户（比如放在邮件里），之后无需存储任何状态即可校验。常见用途有退订链接、邀请链接和下载链接。

```ts
import { inject, Router } from '@hazejs/core'

const router = inject(Router)

await router.signedUrl('unsubscribe', { id: user.id })
// https://example.com/unsubscribe/42?signature=...

await router.temporarySignedUrl('invitations.accept', '7d', { id: invitation.id })
await router.signedUrl('downloads.show', { file }, { expiresIn: '30m', query: { as: 'report.csv' } })
```

| 选项 | 说明 |
|------|------|
| `expiresIn` | 有效期（`'30m'`、`'7d'` 或秒数），会追加 `expires` 参数；不设置时永久有效 |
| `expiresAt` | 过期时间（`Date` 或时间戳），与 `expiresIn` 二选一 |
| `query` | 附加的查询参数，同样受签名保护 |
| `absolute` | 是否以 `app.url`（`APP_URL`）为前缀生成绝对链接；设置了 `APP_URL` 时默认为 `true` |

`temporarySignedUrl(name, expiresIn, params?, options?)` 与之相同，只是有效期为必填（时长或 `Date`）。签名前查询参数会排序，因此参数顺序不影响校验；`expires` 与 `signature` 为保留参数。

路由上加内置的 `signed` 中间件即可保护。被篡改、没有签名或已过期的链接返回 `403`（`InvalidSignatureException`，配置了[多语言](./localization)时消息会被翻译）：

```ts
r.get('/unsubscribe/:id', [NewsletterController, 'unsubscribe']).middleware('signed').name('unsubscribe')
// 忽略签名之后追加的参数，例如统计用的标记
r.get('/downloads/:file', [DownloadController, 'show']).middleware('signed:utm_source,utm_medium').name('downloads.show')
```

也可以手动调用 `await ctx.hasValidSignature()` 校验（同样支持 `{ ignore: [...] }`）。轮换 `APP_KEY` 后，用 `app.previousKeys` / `APP_PREVIOUS_KEYS` 中的旧密钥签发的链接仍然有效（见[加密](./security#加密)）。

## WebSocket 路由

`r.ws()` 注册 WebSocket 端点。升级请求和普通 GET 一样经过全局中间件与路由中间件，因此可以直接加上 `auth`：

```ts
// route/ws.ts
import { defineRoutes } from '@hazejs/core'

export default defineRoutes((r) => {
  r.ws('/api/chat', {
    open(peer) {
      peer.subscribe('chat')
    },
    message(peer, message) {
      peer.publish('chat', message.text())
    },
  }).middleware('auth')
})
```

广播、多实例部署和各平台的支持情况见 [WebSocket](./websocket)。

## 查看路由表

```bash
pnpm routes            # haze route:list
npx haze route:list --json
```

路由表包含方法、路径、路由名、处理器（`UserController@show` 或 `closure`）以及完全展开后的中间件列表（含控制器中间件）。多应用模式下还会显示所属应用与域名。

::: tip
中间件名不存在、路由重名都会让应用启动失败，所以 `route:list` 也很适合放在 CI 里做一次快速自检。
:::
