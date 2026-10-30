# 控制器

控制器把相关的请求处理逻辑组织成一个类，放在 `app/controller/` 下，在路由中以 `[Controller, 'method']` 元组引用。控制器的职责很简单：接收参数、调用服务、返回数据；统一响应格式和异常处理交给框架。

```ts
// app/controller/GreetingController.ts
import type { HttpContext } from '@hazejs/core'
import { inject } from '@hazejs/core'
import { GreetingService } from '~/app/service/GreetingService'

export class GreetingController {
  private greeting = inject(GreetingService)

  index(ctx: HttpContext) {
    return { message: this.greeting.greet(ctx.query('name') ?? 'hazejs') }
  }
}
```

```ts
// route/api.ts
r.get('/hello', [GreetingController, 'index'])
```

用命令行生成控制器：

```bash
npx haze make:controller Post            # app/controller/PostController.ts
npx haze make:controller Post --resource # 带 index/store/show/update/destroy
npx haze make:controller admin/User      # app/controller/admin/UserController.ts
```

## 方法签名

每个动作方法只有一个参数：当前请求的 `HttpContext`，可以是 `async` 方法。方法的返回值就是响应内容（见 [返回值](#返回值)）。

如果路由上声明了校验，把 Schema 作为泛型参数传给 `HttpContext`，`ctx.validated` 就有了准确的类型：

```ts
// app/controller/UserController.ts
import type { HttpContext } from '@hazejs/core'
import type { UserIdParams } from '~/app/validate/user'
import { User } from '~/app/model/User'

type WithId = HttpContext<{ params: typeof UserIdParams }>

export class UserController {
  show(ctx: WithId) {
    return User.findOrFail(ctx.validated.params.id) // 这里的 id 已是 number
  }
}
```

## 依赖注入

控制器由 [服务容器](./container) 创建，所以字段里可以直接调用 `inject()`。控制器默认是**请求作用域**：每个请求一个新实例，可以放心依赖其它请求级对象。确有需要时，可以用 `static scope` 覆盖：

```ts
// app/controller/HealthController.ts
import { Scope } from '@hazejs/core'

export class HealthController {
  static scope = Scope.Singleton

  index() {
    return { ok: true }
  }
}
```

## HttpContext

`HttpContext` 是对 h3 `H3Event` 的薄封装，常用成员如下：

| 成员 | 说明 |
|------|------|
| `ctx.param(name)` / `ctx.params()` | 路由参数（字符串） |
| `ctx.query(name)` / `ctx.query()` | 查询参数（单个值或整个对象） |
| `await ctx.body()` | 解析后的请求体：JSON、urlencoded 或 multipart |
| `await ctx.file(name)` / `await ctx.files(name)` | 上传的文件（`UploadedFile`） |
| `ctx.header(name)` | 请求头 |
| `ctx.cookie(name)` / `await ctx.signedCookie(name)` | Cookie |
| `ctx.validated` | 路由 `.validate()` 的校验结果 |
| `ctx.method`、`ctx.path`、`ctx.url`、`ctx.ip`、`ctx.req` | 请求信息 |
| `ctx.route` | 匹配到的路由：`method`、路径模式 `path`（`/api/users/:id`）、`name` 与 `.meta()` 写入的 `meta`；没有匹配到路由时为 `undefined`。路由中间件（操作日志、按路由的限制）据此读取路由的声明 |
| `ctx.status(code)`、`ctx.setHeader(name, value)` | 设置响应状态码与响应头 |
| `ctx.created(data)`、`ctx.noContent()`、`ctx.redirect(url, status?)` | 响应辅助方法 |
| `ctx.setCookie()`、`ctx.setSignedCookie()`、`ctx.deleteCookie()` | 写 Cookie |
| `ctx.auth` | 认证（`await ctx.auth.user()`） |
| `ctx.can()`、`ctx.cannot()`、`ctx.authorize()` | 授权检查 |
| `ctx.session` | 会话（需要 `session` 中间件） |
| `ctx.get(key)` / `ctx.set(key, value)` | 请求级状态，在中间件与处理器之间传递数据 |
| `ctx.make(key)` | 从请求容器解析依赖 |
| `ctx.logger`、`ctx.requestId`、`ctx.config` | 请求日志器、请求 ID、当前生效的配置 |
| `ctx.onResponse(hook)` | 在最终 `Response` 发出前处理 |
| `ctx.event` | 底层的 `H3Event`，可直接用于 h3 的各种工具函数 |

读取输入详见 [请求与校验](./requests)，响应相关的方法详见 [响应](./responses)。

### 认证与授权

```ts
// app/controller/PostController.ts
import type { HttpContext } from '@hazejs/core'
import { validate } from '@hazejs/core'
import { Post } from '~/app/model/Post'
import { UpdatePostSchema } from '~/app/validate/post'

export class PostController {
  async show(ctx: HttpContext) {
    const post = await Post.findOrFail(Number(ctx.param('id')))
    return { post, canEdit: await ctx.can('update', post) }
  }

  async update(ctx: HttpContext) {
    const post = await Post.findOrFail(Number(ctx.param('id')))
    await ctx.authorize('update', post) // 未登录 401，无权限 403
    post.fill(await validate(UpdatePostSchema, await ctx.body()))
    return post.save()
  }

  me(ctx: HttpContext) {
    return ctx.auth.user() // 需要强制登录时在路由上加 .middleware('auth')
  }
}
```

详见 [认证](./authentication) 与 [授权](./authorization)。

### 在其它地方获取上下文

在请求处理过程中，服务、仓储等更深层的代码可以直接调用 `useContext()`，不必层层传递 `ctx`：

```ts
// app/service/AuditService.ts
import { useContext } from '@hazejs/core'

export class AuditService {
  actor() {
    return useContext().header('x-user')
  }
}
```

## 控制器中间件

在控制器上用静态属性 `middleware` 声明中间件。数组元素可以是中间件引用，也可以是按方法名过滤的 `{ use, only, except }` 对象：

```ts
// app/controller/PostController.ts
import type { ControllerMiddleware, MiddlewareRef } from '@hazejs/core'

export class PostController {
  static middleware: Array<MiddlewareRef | ControllerMiddleware> = [
    'throttle:api',
    { use: 'auth', except: ['index', 'show'] },
    { use: ['can:create,Post'], only: ['store'] },
  ]

  // ...
}
```

控制器中间件在全局、分组、路由中间件之后执行。每条路由最终生效的中间件可以用 `haze route:list` 查看。

## 资源控制器

资源控制器实现 `index`、`store`、`show`、`update`、`destroy` 中的部分或全部方法，并通过 `r.resource()` 注册：

```ts
// app/controller/UserController.ts
import type { HttpContext } from '@hazejs/core'
import type { UserIdParams } from '~/app/validate/user'
import { validate } from '@hazejs/core'
import { User } from '~/app/model/User'
import { CreateUserSchema, UpdateUserSchema } from '~/app/validate/user'

type WithId = HttpContext<{ params: typeof UserIdParams }>

export class UserController {
  index(ctx: HttpContext) {
    return User.order('id', 'desc').paginate(Number(ctx.query('page') ?? 1), 20)
  }

  show(ctx: WithId) {
    return User.findOrFail(ctx.validated.params.id)
  }

  async store(ctx: HttpContext) {
    const input = await validate(CreateUserSchema, await ctx.body())
    return ctx.created(await User.create(input))
  }

  async update(ctx: WithId) {
    const user = await User.findOrFail(ctx.validated.params.id)
    await ctx.authorize('update', user)
    user.fill(await validate(UpdateUserSchema, await ctx.body()))
    return user.save()
  }

  async destroy(ctx: WithId) {
    const user = await User.findOrFail(ctx.validated.params.id)
    await ctx.authorize('delete', user)
    await user.delete()
    return ctx.noContent()
  }
}
```

```ts
// route/api.ts
r.resource('/users', UserController).validateMember({ params: UserIdParams })
```

只有类上真正存在的方法才会注册为路由，详见 [资源路由](./routing#资源路由)。

## 返回值

| 返回值 | 结果 |
|--------|------|
| 普通对象、数组、数字、布尔、`null` / `undefined`，或实现了 `toJSON()` 的对象（模型、`Date`） | 包装为 `{ code, message, data }` |
| `ctx.created(data)` | 同上，状态码 `201` |
| `ctx.noContent()` | 状态码 `204` |
| 字符串、流、二进制 | 原样输出 |
| `Response`（或 `ctx.redirect()`） | 原样输出 |
| `raw(value)` | 不包装，直接输出 `value` |

```ts
// app/controller/ExportController.ts
import { raw, Storage } from '@hazejs/core'

export class ExportController {
  csv() {
    return new Response('id,name\n1,Ada\n', { headers: { 'content-type': 'text/csv' } })
  }

  report() {
    return Storage.download('reports/2026.csv', 'report.csv')
  }

  legacy() {
    return raw({ ok: true }) // { "ok": true }
  }
}
```

需要返回错误时，直接抛出异常，例如 `new NotFoundException()`，框架会按同一套格式渲染错误响应。详见 [响应](./responses) 与 [异常与日志](./errors)。
