# Responses

Handlers return plain data. On the way out, hazejs wraps it in a consistent envelope, and errors use the same format. You can change the format globally, skip it per route, or step in at the final `Response`.

## The response envelope

By default, a successful response looks like this:

```json
{ "code": 0, "message": "ok", "data": { "id": 1, "name": "Ada" } }
```

and a failed one like this:

```json
{ "code": 404, "message": "User 9 not found", "data": null }
```

Only JSON-like values are wrapped: plain objects, arrays, numbers, booleans, `null` / `undefined`, and objects with `toJSON()` (models, `Date`). Strings, `Response` objects, streams and binary data are sent unchanged.

Formatting happens at the very end. Middleware that calls `await next()` gets the handler's raw return value and can still change it.

### Configuration

Envelope options live under `response` in `config/app.ts`:

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  response: {
    envelope: true, // false: send success data as-is
    successCode: 0,
    successMessage: 'ok',
  },
}))
```

With `envelope: false`, successful responses contain the data itself, and errors become `{ status, message, data, errors? }`.

## Customizing the format

`app/response/Formatter.ts` is the single place that defines the shape of both success and error bodies. Extend `ResponseFormatter` and override what you need:

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

| Method | Purpose |
|--------|---------|
| `success(data, ctx)` | Builds the success body |
| `error(error, ctx)` | Builds the error body from a `NormalizedError` (`status`, `code`, `message`, `data?`, `errors?`, `stack?`) |
| `shouldFormat(value, ctx)` | Decides whether a return value is wrapped at all |

The file is discovered automatically and hot-reloads in development. Inside the formatter, read settings from `ctx.config`, which reflects per-app config when you use [multiple apps](./multi-app). Each app can also have its own `app/<name>/response/Formatter.ts`.

## Skipping the envelope

For a single response, return `raw(value)`:

```ts
// app/controller/HealthController.ts
import { raw } from '@hazejs/core'

export class HealthController {
  index() {
    return raw({ status: 'up' }) // {"status":"up"}
  }
}
```

For a whole route, set `envelope: false` in its meta:

```ts
// route/api.ts
r.post('/webhooks/stripe', [WebhookController, 'stripe']).meta({ envelope: false })
```

::: info
`envelope: false` and `raw()` only affect successful responses. Errors thrown from these routes still go through `Formatter.error()`.
:::

## Status, headers and helpers

| Helper | Description |
|--------|-------------|
| `ctx.status(code, text?)` | Set the status code |
| `ctx.setHeader(name, value)` | Set a response header |
| `ctx.created(data)` | Status 201, returns `data` so you can `return ctx.created(...)` |
| `ctx.noContent()` | Status 204 |
| `ctx.redirect(location, status = 302)` | Redirect response |

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

### Returning a Response

Any Web `Response` is sent as-is. Use it for files, streams or custom content types:

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

For files on a storage disk, `Storage.download(path, name)` builds the response for you. See [File Storage](./storage).

## Cookies

```ts
// app/controller/PreferenceController.ts
import type { HttpContext } from '@hazejs/core'

export class PreferenceController {
  async update(ctx: HttpContext) {
    ctx.setCookie('theme', 'dark', { maxAge: 60 * 60 * 24 * 365 })
    await ctx.setSignedCookie('plan', 'pro') // readable, tamper-proof (signed with APP_KEY)
    ctx.deleteCookie('legacy')
    return { ok: true }
  }
}
```

Cookies default to `httpOnly`, `SameSite=Lax`, path `/`, and `Secure` outside debug mode. Override the defaults with `cookie` in `config/app.ts`. Sessions and CSRF are covered in [Sessions, CSRF & More](./security).

## Interceptors

An interceptor receives the final `Response`, after formatting and error rendering, for every request. It can modify headers or return a new `Response` to replace it. Returning nothing keeps the original.

Put interceptors in `app/interceptor/*.ts`. They are loaded automatically and run in file-name order:

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

Interceptors can also be registered from a service provider with `app.intercept()`:

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

### Per-request hooks

`ctx.onResponse(hook)` registers a hook for the current request only. This is useful in middleware. Hooks run after interceptors, and the most recently registered hook runs first, so the outermost middleware sees the response last.

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

## The outbound pipeline

1. The handler (or a short-circuiting middleware) returns a value, or something throws.
2. Values go through `Formatter.success()` unless they are `raw()`, the route has `envelope: false`, or `shouldFormat()` returns `false`. Exceptions go through `ExceptionHandler` and then `Formatter.error()`. See [Errors & Logging](./errors).
3. The result is converted to a `Response`.
4. Interceptors run in order, then `ctx.onResponse` hooks run in reverse order.
5. The access log line is written with the final status code.
