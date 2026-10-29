# 响应

处理器只需返回普通数据，hazejs 会在出站时把它包装成统一的响应结构，错误响应也使用同一套格式。你可以全局修改格式、按路由跳过包装，或者在最终的 `Response` 上做处理。

## 统一响应格式

默认情况下，成功响应是：

```json
{ "code": 0, "message": "ok", "data": { "id": 1, "name": "Ada" } }
```

失败响应是：

```json
{ "code": 404, "message": "用户 9 不存在", "data": null }
```

只有类 JSON 的值会被包装：普通对象、数组、数字、布尔、`null` / `undefined`，以及实现了 `toJSON()` 的对象（模型、`Date`）。字符串、`Response`、流和二进制数据都原样输出。

包装发生在最后一步。中间件中 `await next()` 拿到的是处理器返回的原始值，仍然可以继续加工。

### 配置

包装相关的选项位于 `config/app.ts` 的 `response`：

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  response: {
    envelope: true, // false：成功时直接输出数据
    successCode: 0,
    successMessage: 'ok',
  },
}))
```

设置 `envelope: false` 后，成功响应直接输出数据本身，错误响应变为 `{ status, message, data, errors? }`。

## 自定义格式

`app/response/Formatter.ts` 是定义成功与失败响应结构的唯一入口。继承 `ResponseFormatter`，按需覆盖即可：

```ts
// app/response/Formatter.ts
import type { HttpContext, NormalizedError } from '@hazejs/core'
import { ResponseFormatter } from '@hazejs/core'

export default class Formatter extends ResponseFormatter {
  override success(data: unknown, ctx: HttpContext) {
    return { success: true, result: data, requestId: ctx.requestId }
  }

  override error(error: NormalizedError, ctx: HttpContext) {
    return {
      success: false,
      errorCode: error.code,
      errorMessage: error.message,
      ...(error.errors && { fields: error.errors }),
      requestId: ctx.requestId,
    }
  }
}
```

| 方法 | 作用 |
|------|------|
| `success(data, ctx)` | 生成成功响应体 |
| `error(error, ctx)` | 根据 `NormalizedError`（`status`、`code`、`message`、`data?`、`errors?`、`stack?`）生成错误响应体 |
| `shouldFormat(value, ctx)` | 决定某个返回值是否需要包装 |

该文件会被自动发现，开发时修改即时生效。在格式化器中读取配置请用 `ctx.config`，使用 [多应用](./multi-app) 时它就是应用级配置；每个应用也可以有自己的 `app/<name>/response/Formatter.ts`。

## 跳过包装

单个响应跳过包装，返回 `raw(value)`：

```ts
// app/controller/HealthController.ts
import { raw } from '@hazejs/core'

export class HealthController {
  index() {
    return raw({ status: 'up' }) // {"status":"up"}
  }
}
```

整个路由跳过包装，在 meta 中设置 `envelope: false`：

```ts
// route/api.ts
r.post('/webhooks/stripe', [WebhookController, 'stripe']).meta({ envelope: false })
```

::: info
`envelope: false` 和 `raw()` 只影响成功响应。这些路由中抛出的异常仍然会经过 `Formatter.error()`。
:::

## 状态码、响应头与辅助方法

| 方法 | 说明 |
|------|------|
| `ctx.status(code, text?)` | 设置状态码 |
| `ctx.setHeader(name, value)` | 设置响应头 |
| `ctx.created(data)` | 状态码 201，并原样返回 `data`，可以直接 `return ctx.created(...)` |
| `ctx.noContent()` | 状态码 204 |
| `ctx.redirect(location, status = 302)` | 重定向 |

```ts
// app/controller/PostController.ts
import type { HttpContext } from '@hazejs/core'

export class PostController {
  async store(ctx: HttpContext) {
    const post = { id: 1 }
    ctx.setHeader('location', `/api/posts/${post.id}`)
    return ctx.created(post)
  }

  legacy(ctx: HttpContext) {
    return ctx.redirect('/api/posts', 301)
  }

  accepted(ctx: HttpContext) {
    ctx.status(202)
    return { queued: true }
  }
}
```

### 返回 Response

任何 Web `Response` 都会原样发出，适合文件、流或自定义的内容类型：

```ts
// app/controller/FeedController.ts
export class FeedController {
  rss() {
    return new Response('<rss version="2.0"></rss>', {
      headers: { 'content-type': 'application/rss+xml' },
    })
  }
}
```

存储磁盘上的文件可以用 `Storage.download(path, name)` 直接生成下载响应，详见 [文件存储](./storage)。

### HTML 视图

`ctx.view()` 把 [TSX 视图](./views) 渲染为 `text/html` 响应，不经过统一格式。处理器直接返回 JSX 节点也一样：

```tsx
// app/controller/HomeController.tsx
import type { HttpContext } from '@hazejs/core'
import Home from '~/app/view/Home'

export class HomeController {
  index(ctx: HttpContext) {
    return ctx.view(<Home name="Ada" />, { status: 200, headers: { 'cache-control': 'no-store' } })
  }

  about() {
    return <p>关于我们</p> // 同样渲染为 HTML
  }
}
```

在普通的 `.ts` 路由文件中可以使用 `ctx.view(Home, props)` 与 `ctx.view('admin/Dashboard', props)`（`app/view` 下的文件）。详见 [视图](./views)。

## Cookie

```ts
// app/controller/PreferenceController.ts
import type { HttpContext } from '@hazejs/core'

export class PreferenceController {
  async update(ctx: HttpContext) {
    ctx.setCookie('theme', 'dark', { maxAge: 60 * 60 * 24 * 365 })
    await ctx.setSignedCookie('plan', 'pro') // 客户端可读但无法篡改（用 APP_KEY 签名）
    ctx.deleteCookie('legacy')
    return { ok: true }
  }
}
```

Cookie 默认 `httpOnly`、`SameSite=Lax`、路径 `/`，非调试模式下加 `Secure`；可在 `config/app.ts` 的 `cookie` 中覆盖默认值。Session 与 CSRF 见 [Session、CSRF 等](./security)。

## 出站拦截器

出站拦截器作用于每个请求，拿到的是统一格式化、异常渲染之后的最终 `Response`。它可以修改响应头，也可以返回一个新的 `Response` 替换原响应；不返回任何值则保留原响应。

拦截器放在 `app/interceptor/*.ts`，自动加载，按文件名顺序执行：

```ts
// app/interceptor/response-time.ts
import { defineInterceptor } from '@hazejs/core'

export default defineInterceptor((response, ctx) => {
  response.headers.set('x-response-time', `${Math.round(performance.now() - ctx.startedAt)}ms`)
})
```

```bash
npx haze make:interceptor ResponseTime   # app/interceptor/response-time.ts
```

也可以在服务提供者中用 `app.intercept()` 注册：

```ts
// app/provider/AppProvider.ts
import { defineProvider } from '@hazejs/core'

export default defineProvider({
  boot(app) {
    app.intercept((response) => {
      if (response.status >= 500)
        response.headers.set('cache-control', 'no-store')
    })
  },
})
```

### 请求级钩子

`ctx.onResponse(hook)` 只对当前请求生效，常在中间件中使用。它在拦截器之后执行，后注册的先执行，因此最外层中间件注册的钩子最后看到响应。

```ts
// app/middleware/timing.ts
import { defineMiddleware } from '@hazejs/core'

export const timing = defineMiddleware((ctx, next) => {
  ctx.onResponse((response) => {
    response.headers.set('server-timing', `app;dur=${performance.now() - ctx.startedAt}`)
  })
  return next()
})
```

## 出站流程

1. 处理器（或短路的中间件）返回一个值，或者抛出异常；
2. 返回值交给 `Formatter.success()`，除非它是 `raw()`、路由设置了 `envelope: false` 或 `shouldFormat()` 返回 `false`；异常交给 `ExceptionHandler`，再由 `Formatter.error()` 生成响应体，详见 [异常与日志](./errors)；
3. 结果转换为 `Response`；
4. 依次执行出站拦截器，再按逆序执行 `ctx.onResponse` 钩子；
5. 以最终状态码记录访问日志。
