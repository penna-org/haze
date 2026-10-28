# 中间件

中间件以洋葱模型包裹请求处理：`await next()` 之前的代码在请求进入时执行，之后的代码在响应返回时执行。hazejs 内置了常用的中间件，你也可以用函数或类编写自己的中间件。

## 内置中间件

内置中间件无需注册，直接按名字使用。参数写在冒号之后，多个参数用逗号分隔。

| 名字 | 用途 | 配置 |
|------|------|------|
| `cors` | 跨域响应头与预检请求，需放在 global | `config/cors.ts`（`defineCorsConfig`） |
| `secureHeaders` | nosniff、frame-options、referrer-policy 等安全头，生产环境 https 下加 HSTS | `config/secureHeaders.ts` |
| `compress` | br / gzip / deflate 压缩响应 | `config/compress.ts` |
| `throttle:max,seconds` / `throttle:name` | 限流（默认按用户或 IP），返回 `RateLimit-*` 头，超限返回 429 | `config/throttle.ts` |
| `bodyLimit:size` | 调整单个路由的请求体上限，如 `bodyLimit:10mb`（默认 `app.bodyLimit`，1mb） | — |
| `session` | 启动会话（`ctx.session`） | `config/session.ts` |
| `csrf` | CSRF 同步令牌，不匹配时返回 419 | `config/csrf.ts` |
| `auth` / `auth:guard[,guard]` | 要求已登录，列出的 Guard 任一通过即放行，否则 401 | `config/auth.ts` |
| `guest` / `guest:guard` | 已登录时返回 403（用于登录、注册接口） | `config/auth.ts` |
| `can:ability[,Model[,param]]` | 授权检查；带 `param` 时按路由参数加载模型（不存在时 404） | `app/policy/*.ts` |
| `cacheResponse:ttl[,user]` | 缓存 GET 成功响应，`user` 表示按用户区分 | `config/cache.ts` |

```ts
// route/api.ts
r.post('/login', [AuthController, 'login']).middleware('guest', 'throttle:10,60')
r.post('/avatar', [AuthController, 'avatar']).middleware(['auth', 'bodyLimit:3mb'])
r.get('/stats', [StatsController, 'index']).middleware('cacheResponse:5m')
r.put('/posts/:id', [PostController, 'update']).middleware('auth', 'can:update,Post,id')
```

各中间件的详细说明见对应页面：[Session、CSRF 等](./security)（cors、secureHeaders、session、csrf）、[认证](./authentication)（auth、guest）、[授权](./authorization)（can）、[缓存](./cache)（cacheResponse、限流共享存储）。

### 限流

`throttle:60,60` 表示 60 秒内最多 60 次，窗口也可以写成时长，例如 `throttle:100,1m`。需要复用的规则可以在 `config/throttle.ts` 中命名，再用 `throttle:api` 引用：

```ts
// config/throttle.ts
import { defineThrottleConfig, env } from '@hazejs/core'

export default defineThrottleConfig(() => ({
  store: env('CACHE_STORE', 'memory'),
  limiters: {
    api: { max: 60, window: '1m' },
    uploads: { max: 10, window: '1h', key: ctx => `ip:${ctx.ip}` },
  },
}))
```

## 配置中间件

`config/middleware.ts` 声明全局中间件、别名和中间件组：

```ts
// config/middleware.ts
import { defineMiddlewareConfig } from '@hazejs/core'
import { EnsureJson } from '~/app/middleware/EnsureJson'
import { tenant } from '~/app/middleware/tenant'

export default defineMiddlewareConfig({
  // 按顺序作用于所有请求（包括没有匹配到路由的请求）
  global: ['cors', 'secureHeaders', 'compress'],
  // 别名：在路由和控制器中按名引用
  alias: {
    ensureJson: EnsureJson,
    tenant,
  },
  // 中间件组：引用组名时展开为其中的全部中间件
  groups: {
    api: ['ensureJson', 'throttle:api'],
  },
})
```

```ts
// route/api.ts
r.group({ prefix: '/api', middleware: ['api'] }, (r) => {
  r.get('/me', [AuthController, 'me']).middleware('auth')
})
```

- 与内置中间件同名的别名会覆盖内置实现，例如 `alias: { auth: MyAuth }`。
- 中间件组可以引用其它组，循环引用会报错。
- 引用不存在的名字时，应用启动失败并提示 `Unknown middleware "..."`。
- 请求 ID 与访问日志由框架内置，无需注册。

## 编写中间件

### 函数中间件

```ts
// app/middleware/tenant.ts
import { BadRequestException, defineMiddleware } from '@hazejs/core'

export const tenant = defineMiddleware(async (ctx, next) => {
  const id = ctx.header('x-tenant')
  if (!id)
    throw new BadRequestException('缺少 x-tenant 请求头')
  ctx.set('tenant', id)
  return next()
})
```

### 类中间件

类中间件从请求容器中解析，因此可以使用 `inject()`：

```ts
// app/middleware/EnsureJson.ts
import type { HttpContext, Middleware, Next } from '@hazejs/core'
import { BadRequestException, inject, Logger } from '@hazejs/core'

export class EnsureJson implements Middleware {
  private logger = inject(Logger)

  async handle(ctx: HttpContext, next: Next) {
    if (ctx.method !== 'GET' && !ctx.header('content-type')?.includes('application/json')) {
      this.logger.debug(`Rejected ${ctx.method} ${ctx.path}`)
      throw new BadRequestException('请求体必须是 JSON')
    }
    return next()
  }
}
```

用命令生成类中间件骨架：

```bash
npx haze make:middleware EnsureJson   # app/middleware/EnsureJson.ts
```

然后在 `config/middleware.ts` 的 `alias` 中注册。

### 返回值

- `return next()` 或返回 `undefined`：继续执行后续中间件或处理器。
- `const result = await next()`：在处理器之后执行逻辑。`result` 是处理器返回的原始值（尚未包装统一响应格式），仍然可以加工。
- 返回其它值或抛出异常：短路，该值或异常直接作为响应，处理器不再执行。

需要修改最终的 `Response`（响应头、响应体）时，使用 `ctx.onResponse()` 或 [出站拦截器](./responses#出站拦截器)。

### 中间件参数

字符串引用可以带参数：`'name:a,b'` 会以 `(ctx, next, 'a', 'b')` 调用中间件，参数始终是字符串。

```ts
// app/middleware/role.ts
import { defineMiddleware, ForbiddenException } from '@hazejs/core'

export const role = defineMiddleware(async (ctx, next, ...roles) => {
  const user = await ctx.auth.user() as { role: string } | undefined
  if (!user || !roles.includes(user.role))
    throw new ForbiddenException()
  return next()
})
```

```ts
// route/api.ts
r.delete('/posts/:id', [PostController, 'destroy']).middleware('auth', 'role:admin,editor')
```

### 不注册别名直接使用

`.middleware()` 也可以直接接收函数或类：

```ts
// route/api.ts
r.get('/reports', [ReportController, 'index']).middleware(tenant, EnsureJson)
```

## 执行顺序

对于匹配到的路由，中间件按以下顺序执行：

1. `config/middleware.ts` 中的 `global`；
2. 分组中间件，外层分组在前；
3. 路由中间件（`.middleware()`），按书写顺序；
4. 控制器中间件（`static middleware`，按 `only` / `except` 过滤）。

之后执行路由校验和处理器，返回时按相反顺序退出。任一路由最终展开的中间件列表都可以用 `haze route:list` 查看。

::: tip
`cors` 应放在 `global` 中：预检请求 `OPTIONS` 通常匹配不到任何路由，挂在路由上的 `cors` 根本不会执行。
:::
