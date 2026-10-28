# Middleware

Middleware wraps request handling in an onion: code before `await next()` runs on the way in, code after it runs on the way out. hazejs includes the common middleware out of the box. You can also write your own as functions or classes.

## Built-in middleware

Built-in middleware is available by name with no registration. Parameters follow a colon and are separated by commas.

| Name | Purpose | Config |
|------|---------|--------|
| `cors` | CORS headers and preflight. Must be global | `config/cors.ts` (`defineCorsConfig`) |
| `secureHeaders` | `nosniff`, frame options, referrer policy and more. Adds HSTS on production HTTPS | `config/secureHeaders.ts` |
| `compress` | br / gzip / deflate response compression | `config/compress.ts` |
| `throttle:max,seconds` / `throttle:name` | Rate limiting per user or IP. Sends `RateLimit-*` headers, 429 when exceeded | `config/throttle.ts` |
| `bodyLimit:size` | Request body limit for one route, e.g. `bodyLimit:10mb` (default `app.bodyLimit`, 1mb) | — |
| `session` | Starts the session (`ctx.session`) | `config/session.ts` |
| `csrf` | CSRF synchronizer token. 419 on mismatch | `config/csrf.ts` |
| `auth` / `auth:guard[,guard]` | Requires an authenticated user. Passes if any listed guard succeeds, otherwise 401 | `config/auth.ts` |
| `guest` / `guest:guard` | Rejects authenticated users with 403 (login, register) | `config/auth.ts` |
| `can:ability[,Model[,param]]` | Authorization check. With `param`, loads the model by route param (404 if missing) | `app/policy/*.ts` |
| `cacheResponse:ttl[,user]` | Caches successful GET responses. `user` caches per user | `config/cache.ts` |

```ts
// route/api.ts
r.post('/login', [AuthController, 'login']).middleware('guest', 'throttle:10,60')
r.post('/avatar', [AuthController, 'avatar']).middleware(['auth', 'bodyLimit:3mb'])
r.get('/stats', [StatsController, 'index']).middleware('cacheResponse:5m')
r.put('/posts/:id', [PostController, 'update']).middleware('auth', 'can:update,Post,id')
```

Details for each one live on its own page: [Security](./security) (cors, secureHeaders, session, csrf), [Authentication](./authentication) (auth, guest), [Authorization](./authorization) (can) and [Cache](./cache) (cacheResponse, shared throttle store).

### Throttle

`throttle:60,60` allows 60 requests per 60 seconds. The window also accepts durations such as `throttle:100,1m`. For reusable rules, name them in `config/throttle.ts` and reference them as `throttle:api`:

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

## Configuring middleware

`config/middleware.ts` declares global middleware, aliases and groups:

```ts
// config/middleware.ts
import { defineMiddlewareConfig } from '@hazejs/core'
import { EnsureJson } from '~/app/middleware/EnsureJson'
import { tenant } from '~/app/middleware/tenant'

export default defineMiddlewareConfig({
  // Runs in order for every request, including requests that match no route
  global: ['cors', 'secureHeaders', 'compress'],
  // Names you can reference from routes and controllers
  alias: {
    ensureJson: EnsureJson,
    tenant,
  },
  // A group expands to its members wherever its name is used
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

- An alias with the same name as a built-in replaces it, for example `alias: { auth: MyAuth }`.
- Groups may contain other groups. Circular groups are an error.
- Unknown names fail at boot with `Unknown middleware "..."`.
- Request IDs and access logging are built in. You don't need to register them.

## Writing middleware

### Function middleware

```ts
// app/middleware/tenant.ts
import { BadRequestException, defineMiddleware } from '@hazejs/core'

export const tenant = defineMiddleware(async (ctx, next) => {
  const id = ctx.header('x-tenant')
  if (!id)
    throw new BadRequestException('Missing x-tenant header')
  ctx.set('tenant', id)
  return next()
})
```

### Class middleware

Class middleware is resolved from the request container, so it can use `inject()`:

```ts
// app/middleware/EnsureJson.ts
import type { HttpContext, Middleware, Next } from '@hazejs/core'
import { BadRequestException, inject, Logger } from '@hazejs/core'

export class EnsureJson implements Middleware {
  private logger = inject(Logger)

  async handle(ctx: HttpContext, next: Next) {
    if (ctx.method !== 'GET' && !ctx.header('content-type')?.includes('application/json')) {
      this.logger.debug(`Rejected ${ctx.method} ${ctx.path}`)
      throw new BadRequestException('Expected a JSON body')
    }
    return next()
  }
}
```

Generate a class skeleton with:

```bash
npx haze make:middleware EnsureJson   # app/middleware/EnsureJson.ts
```

Then register it under `alias` in `config/middleware.ts`.

### Return values

- `return next()`, or return `undefined`: continue to the next middleware or the handler.
- `const result = await next()`: run code after the handler. `result` is the raw value the handler returned, before the response envelope is applied, so you can still change it.
- Return anything else, or throw: short-circuit. The value or exception becomes the response, and the handler does not run.

To change the final `Response` (headers, body), use `ctx.onResponse()` or an [interceptor](./responses#interceptors).

### Parameters

String references can carry parameters: `'name:a,b'` calls the middleware with `(ctx, next, 'a', 'b')`. Parameters are always strings.

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

### Using middleware without an alias

`.middleware()` also accepts functions and classes directly:

```ts
// route/api.ts
r.get('/reports', [ReportController, 'index']).middleware(tenant, EnsureJson)
```

## Order of execution

For a matched route, middleware runs in this order:

1. `global` from `config/middleware.ts`;
2. group middleware, outer groups first;
3. route middleware (`.middleware()`), in the order written;
4. controller middleware (`static middleware`, filtered by `only` / `except`).

After that, route validation and the handler run. On the way out, the order is reversed. Check the expanded list for any route with `haze route:list`.

::: tip
`cors` belongs in `global`. Preflight `OPTIONS` requests usually match no route, so route-level `cors` never sees them.
:::
