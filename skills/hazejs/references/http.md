# HTTP layer: routing, controllers, middleware, requests, responses

Everything in this file is imported from `@hazejs/core`. Paths follow the API template: `route/*.ts`, `app/controller/*.ts`, `app/middleware/*.ts`, `app/validate/*.ts`, `config/*.ts`, and the `~/` alias for the project root (`~/app/...`). In full-stack templates the same tree lives under `server/`.

## Request lifecycle

1. **Request scope**: a child container, the `HttpContext` and AsyncLocalStorage are created. Interceptors and `ctx.onResponse` hooks run here, on the way out, after everything below.
2. **Exception boundary**: catches anything thrown below. It turns "no route" into a 404, formats success values (`Formatter.success`) and renders errors (`ExceptionHandler` → `Formatter.error`).
3. **Maintenance mode**, then built-in endpoints: storage signed links, OpenAPI (`/openapi.json`, `/docs`), `/health`, and tenancy resolution.
4. **Global middleware** (`config/middleware.ts` `global`) → **static files** (`createApplication({ static })`) → **multi-app dispatch** (by domain/prefix) → router.
5. **Route**: group → route → controller middleware, then `.validate()`, then the handler. The return value travels back out through steps 2 and 1.

## Routing

[Full guide](../../../docs/guide/routing.md). Every `route/*.ts` file is auto-discovered and default-exports `defineRoutes()`.

```ts
// route/api.ts
import { defineRoutes } from '@hazejs/core'
import { PostController } from '~/app/controller/PostController'
import { UserController } from '~/app/controller/UserController'
import { CreatePostSchema, PostIdParams } from '~/app/validate/post'
import { UserIdParams } from '~/app/validate/user'
import { WebhookController } from '~/app/controller/WebhookController'

export default defineRoutes((r) => {
  r.get('/ping', ctx => ({ pong: true, path: ctx.path })) // closure handler

  r.group({ prefix: '/api', as: 'api.', middleware: ['throttle:api'] }, (r) => {
    r.get('/posts', [PostController, 'index']).name('posts.index') // name: api.posts.index
    r.get('/posts/:id', [PostController, 'show'])
      .name('posts.show')
      .validate({ params: PostIdParams })
    r.post('/posts', [PostController, 'store'])
      .name('posts.store')
      .middleware('auth')
      .validate({ body: CreatePostSchema })
      .doc({ summary: 'Create a post', tags: ['Posts'], status: 201 })

    r.resource('/users', UserController, { except: ['destroy'] })
      .middleware('auth')
      .validateMember({ params: UserIdParams })
  })

  r.post('/webhooks/stripe', [WebhookController, 'stripe']).meta({ envelope: false })
})
```

- Verbs: `r.get/post/put/patch/delete/options/any`. Handler is a closure `(ctx) => value` or a `[Controller, 'method']` tuple (method name is type-checked; a bad handler fails at boot).
- Params: `:name` segments, read as **URL-decoded strings** (`/files/%E6%96%87` → `文`). Convert with a schema in `.validate({ params })`.
- `r.group(options?, cb)` options: `prefix`, `as` (name prefix), `middleware`. Nested groups accumulate. There is **no `domain` option**; use multi-app for domains.

| Route modifier | Effect |
|---|---|
| `.name(name)` | Named route, prefixed by group `as`. Duplicate names fail at boot |
| `.middleware(...refs)` | Alias strings (with `:params`), functions, classes, or arrays of them |
| `.validate({ body, query, params, headers })` | Validates before the handler; merges if called twice; output in `ctx.validated` |
| `.doc({...})` | OpenAPI metadata (see below); mergeable |
| `.meta({ envelope: false, ...})` | Route metadata; `envelope: false` skips the success envelope. Middleware reads it as `ctx.route.meta` |

**Resources** — `r.resource(path, Controller, { only?, except?, param?, name? })` registers `index` (GET /users), `store` (POST), `show` (GET /users/:id), `update` (PUT and PATCH), `destroy` (DELETE), named `users.index` etc. Without `only`, only methods that exist on the controller are registered; listing a missing action in `only` fails at boot. `param` renames `:id`, `name` changes the name base. The returned `ResourceRoutes` supports `.middleware()`, `.validateMember()` (show/update/destroy) and `.doc({ tags, deprecated, hidden })`.

**URL generation** — `inject(Router).url('api.posts.show', { id: 1 }, { page: 2 })`, or `useApp().router.url(...)`. Missing params throw. `haze typegen` (run by `haze dev`) types route names and params. Signed URLs: `await router.signedUrl(name, params, { expiresIn, expiresAt, query, absolute })` and `await router.temporarySignedUrl(name, '7d', params)`; protect with the `signed` middleware (403 `InvalidSignatureException`) or `await ctx.hasValidSignature()`.

**WebSockets** — `r.ws(path, { open(peer), message(peer, message), ... })` returns a `Route`. The upgrade request passes global and route middleware like a GET, so `.middleware('auth')` works. See [websocket guide](../../../docs/guide/websocket.md).

`haze route:list` (`--json`) prints method, path, name, handler and the fully expanded middleware list; use it to sanity-check. Middleware passed as a function or class is listed as `name()` (`anonymous()` for unnamed arrows), never as an alias; `--json` writes only JSON to stdout (boot logs go to stderr), so `haze route:list --json > routes.json` is safe.

## Controllers

[Full guide](../../../docs/guide/controllers.md). Generate: `npx haze make:controller Post [--resource]`.

```ts
// app/controller/PostController.ts
import type { ControllerMiddleware, HttpContext, MiddlewareRef } from '@hazejs/core'
import type { PostIdParams } from '~/app/validate/post'
import { inject, NotFoundException, validate } from '@hazejs/core'
import { PostService } from '~/app/service/PostService'
import { UpdatePostSchema } from '~/app/validate/post'

export class PostController {
  static middleware: Array<MiddlewareRef | ControllerMiddleware> = [
    { use: 'auth', except: ['index', 'show'] },
    { use: ['can:create,Post'], only: ['store'] },
  ]

  private posts = inject(PostService) // field initializer = injection context

  index(ctx: HttpContext) {
    return this.posts.paginate(Number(ctx.query('page') ?? 1))
  }

  async show(ctx: HttpContext<{ params: typeof PostIdParams }>) {
    const post = await this.posts.find(ctx.validated.params.id) // typed number
    if (!post)
      throw new NotFoundException(`Post ${ctx.validated.params.id} not found`)
    return post
  }

  async update(ctx: HttpContext<{ params: typeof PostIdParams }>) {
    const post = await this.posts.find(ctx.validated.params.id)
    await ctx.authorize('update', post) // 401 guest, 403 denied
    return this.posts.update(post, await validate(UpdatePostSchema, await ctx.body()))
  }
}
```

- An action receives only `ctx: HttpContext` and may be async. Type `ctx.validated` with `HttpContext<{ body: typeof Schema, params: typeof Schema }>`.
- Controllers are **request-scoped** by default (new instance per request). Override with `static scope = Scope.Singleton`.
- `inject()` works in field initializers/constructors of container-created classes, inside `container.call()`, and anywhere during a request. At module top level it throws `ContainerError`.
- Deep code can call `useContext()` to get the current `HttpContext` instead of threading `ctx` through.
- Controller middleware runs **after** global, group and route middleware.

## Middleware

[Full guide](../../../docs/guide/middleware.md), [security middleware](../../../docs/guide/security.md).

```ts
// config/middleware.ts
import { defineMiddlewareConfig } from '@hazejs/core'
import { EnsureJson } from '~/app/middleware/EnsureJson'
import { tenant } from '~/app/middleware/tenant'

export default defineMiddlewareConfig({
  global: ['cors', 'secureHeaders', 'compress'], // every request, even unmatched ones
  alias: { ensureJson: EnsureJson, tenant }, // same name as a built-in replaces it
  groups: { api: ['ensureJson', 'throttle:api'] }, // expands wherever "api" is used
})
```

```ts
// app/middleware/role.ts — function middleware; 'role:admin,editor' → (ctx, next, 'admin', 'editor')
import { defineMiddleware, ForbiddenException } from '@hazejs/core'

export const role = defineMiddleware(async (ctx, next, ...roles) => {
  const user = await ctx.auth.user() as { role: string } | undefined
  if (!user || !roles.includes(user.role))
    throw new ForbiddenException()
  return next()
})
```

```ts
// app/middleware/EnsureJson.ts — class middleware, resolved from the request container
import type { HttpContext, Middleware, Next } from '@hazejs/core'
import { BadRequestException, inject, Logger } from '@hazejs/core'

export class EnsureJson implements Middleware {
  private logger = inject(Logger)

  async handle(ctx: HttpContext, next: Next) {
    if (ctx.method !== 'GET' && !ctx.header('content-type')?.includes('application/json'))
      throw new BadRequestException('Expected a JSON body')
    const result = await next() // raw handler value, BEFORE the envelope; may be changed
    return result
  }
}
```

- Return `next()` / `undefined` to continue; return any other value or throw to short-circuit (the handler doesn't run).
- `await next()` yields the handler's **raw** value. To touch the final `Response` use `ctx.onResponse()` or an interceptor.
- Order: global → group (outer first) → route (as written) → controller (`only`/`except`) → validation → handler. Reversed on the way out.
- `ctx.set(key, value)` / `ctx.get(key)` pass request state; type keys via `declare module '@hazejs/core' { interface ContextState { ... } }`.
- Unknown middleware names fail at boot. `make:middleware Name` scaffolds a class.
- OpenAPI infers `401` / `403` only from the **alias strings** `auth` / `can:` / `guest`; a function you pass inline is shown as `fnName()` and adds nothing. Keep auth as aliases (`'auth'`, `` `can:${code}` ``) when you generate middleware lists.

**Meta-driven middleware** — declare per-route facts once with `.meta()` and let one alias middleware act on them (audit log text, body limit, response encoding, demo-mode allow-lists) instead of building a closure per route:

```ts
// app/middleware/audit.ts — registered as alias 'audit' in config/middleware.ts
export const audit: MiddlewareHandler = (ctx, next) => {
  if (ctx.method !== 'GET') {
    ctx.onResponse((response) => {
      const route = ctx.route // { method, path: '/api/users/:id', name, meta }
      logs.record({ route: route?.path ?? ctx.path, summary: String(route?.meta.summary ?? ''), status: response.status })
    })
  }
  return next()
}
export const bodyLimit: MiddlewareHandler = (ctx, next) => {
  if (typeof ctx.route?.meta.bodyLimit === 'number')
    ctx.bodyLimit = ctx.route.meta.bodyLimit
  return next()
}

// route/users.ts
r.post('/users', [UserController, 'store']).meta({ summary: 'Create user', bodyLimit: 2_097_152 }).middleware('audit', 'auth', 'can:user:create', 'bodyLimit')
```

A per-route throttle bucket without one named limiter per route: put the route pattern in the limiter key — ``perRoute: { max: 20, window: 60, key: ctx => `${ctx.method} ${ctx.route?.path}:${ctx.ip}` }`` in `config/throttle.ts`, then `throttle:perRoute` on each route.

### Built-in middleware

| Name | Behaviour | Config |
|---|---|---|
| `cors` | CORS + preflight. **Must be global** (preflights match no route) | `config/cors.ts` `defineCorsConfig`: `origin`, `methods`, `allowHeaders`, `exposeHeaders`, `credentials`, `maxAge` |
| `secureHeaders` | nosniff, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, CORP. COOP + `Origin-Agent-Cluster` **only on https**; HSTS only on https with `app.debug` off | `config/secureHeaders.ts` `defineSecureHeadersConfig`: `contentSecurityPolicy` (off by default), `strictTransportSecurity`, `frameOptions`, `referrerPolicy`, `crossOriginOpenerPolicy`, `crossOriginResourcePolicy`, `permissionsPolicy` (string or `false`), `headers` |
| `compress` | br/gzip/deflate for compressible types (not `text/event-stream`) | `config/compress.ts` `defineCompressConfig`: `threshold` (1kb), `encodings` |
| `throttle:max,window` / `throttle:name` | Fixed-window rate limit; `RateLimit-Limit/Remaining/Reset`; 429 + `Retry-After` | `config/throttle.ts` |
| `bodyLimit:size` | Per-route body cap, e.g. `bodyLimit:10mb` (sets `ctx.bodyLimit`) | default `app.bodyLimit` = `1mb` |
| `session` | Starts `ctx.session` | `config/session.ts` |
| `csrf` | Synchronizer token, 419 on mismatch | `config/csrf.ts` `defineCsrfConfig`: `except`, `cookie`, `testing` |
| `auth` / `auth:api,web` | 401 unless any listed guard authenticates | `config/auth.ts` |
| `guest` / `guest:guard` | 403 for authenticated users | `config/auth.ts` |
| `can:ability[,Model[,param]]` | Gate check; with `param` loads the model by route param (404 if missing) | `app/policy/*.ts` |
| `verified`, `abilities:a,b`, `ability:a,b` | Verified email; API token has all / any abilities | see auth guides |
| `cacheResponse:ttl[,user]` | Caches 200 GET/HEAD responses by URL (`user` = per user); `X-Cache: HIT/MISS`; skips `no-store`/`private` and `text/event-stream` | `config/cache.ts` `responseStore` |
| `signed` / `signed:utm_source,...` | Verifies a signed URL (listed query params ignored); 403 otherwise | `APP_KEY` |

### Throttle and bucket keys

```ts
// config/throttle.ts
import { defineThrottleConfig, env } from '@hazejs/core'

export default defineThrottleConfig(() => ({
  store: env('CACHE_STORE', 'memory'), // a config/cache.ts store name, or a RateLimitStore; use redis for >1 instance
  limiters: {
    api: { max: 60, window: '1m' },
    login: { max: 5, window: '1m', key: ctx => `login:ip:${ctx.ip}` },
    uploads: { max: 10, window: '1h', key: ctx => `ip:${ctx.ip}` },
    // Cloudflare Workers: binding: 'API_RATE_LIMITER' (limits in wrangler.json)
  },
}))
```

The bucket key is `throttle:<spec>:<key>`, where `<spec>` is the argument string (`10,60` or `api`) and `<key>` is the limiter's `key(ctx)` or by default `user:<id>` when logged in, else `ip:<ip>`. So **every route using `throttle:10,60` shares one bucket per user/IP**, and so does every route using `throttle:api`. For an independent per-route budget, define a named limiter per route (or give it a distinct `key`), e.g. `.middleware('throttle:login')`.

### CSRF, session, cookies in one line each

- `csrf`: token in session + readable `XSRF-TOKEN` cookie; unsafe methods must send `X-XSRF-TOKEN`/`X-CSRF-TOKEN` or a `_token` form field. Skipped for safe methods, `Authorization: Bearer` requests, `except` paths, and in tests (unless `testing: true`). Server-rendered forms: `await ctx.csrfToken()`.
- `ctx.session`: `get/has/all/set/forget/pull/flash/flush/regenerate/invalidate`; or `await ctx.startSession()` without the middleware.
- Cookies default to `httpOnly`, `SameSite=Lax`, path `/`, `Secure` when `app.debug` is off; override via `cookie` in `config/app.ts`.

## Requests and validation

[Full guide](../../../docs/guide/requests.md).

| Member | Returns |
|---|---|
| `ctx.param(name)` / `ctx.params()` | URL-decoded route params (strings) |
| `ctx.query(name)` / `ctx.query()` | First value / `{ [k]: string \| string[] }` |
| `await ctx.body<T>()` | Parsed JSON / urlencoded / multipart (files as `UploadedFile`). Read once, cached. `<T>` is a cast only |
| `await ctx.file(name)` / `await ctx.files(name)` | First / all `UploadedFile`s of a field; empty inputs ignored |
| `ctx.header(name)` | Header or `undefined` |
| `ctx.cookie(name)` / `await ctx.signedCookie(name)` | Cookie; signed returns `undefined` if tampered |
| `ctx.ip` | Client IP; with `app.trustProxy: true` the rightmost `X-Forwarded-For` entry (`n` → nth from the right). Workers/Lambda entries pass the platform client IP without it |
| `ctx.origin` / `ctx.secure` | e.g. `https://admin.example.com` / is https; `X-Forwarded-Proto`/`-Host` only when `app.trustProxy` |
| `ctx.method`, `ctx.path`, `ctx.url` (URL), `ctx.req` (Web Request), `ctx.event` (H3Event) | Request info |
| `ctx.route` | Matched route: `{ method, path, name, meta }` (`path` is the pattern, `/api/users/:id`); `undefined` when no route matched. Use it in route middleware |
| `ctx.validated` | Output of route `.validate()` |
| `ctx.requestId`, `ctx.logger`, `ctx.config`, `ctx.startedAt`, `ctx.make(key)` | Request utilities |

Bodies over `ctx.bodyLimit` (default `app.bodyLimit`, `1mb`) → **413**. Raise globally with `bodyLimit: '2mb'` in `config/app.ts` or per route with `bodyLimit:20mb`.

**Uploads** — `UploadedFile` extends `File` and adds `field`, `extension` (lowercase, no dot), `store(dir, disk?)` (random name, returns path) and `storeAs(dir, name, disk?)` (base name only). The second argument may be `{ disk, ... }`.

```ts
// app/controller/AvatarController.ts
import type { HttpContext } from '@hazejs/core'
import { BadRequestException, Storage } from '@hazejs/core'

export class AvatarController {
  async store(ctx: HttpContext) {
    const avatar = await ctx.file('avatar')
    if (!avatar)
      throw new BadRequestException('Please choose a file')
    const path = await avatar.store('avatars', 'public')
    return ctx.created({ path, url: Storage.disk('public').url(path) })
  }
}
```

**Validation** — any Standard Schema library (templates use valibot; zod, arktype work). `validate(schema, value)` returns typed output or throws `ValidationException` (422). Route `.validate()` checks all targets and reports every issue in one 422.

```ts
// app/validate/post.ts
import * as v from 'valibot'

export const CreatePostSchema = v.object({
  title: v.pipe(v.string(), v.trim(), v.minLength(1, 'Title is required')),
  cover: v.optional(v.pipe(v.file(), v.mimeType(['image/png', 'image/jpeg']), v.maxSize(2 * 1024 * 1024))),
})
export const PostIdParams = v.object({ id: v.pipe(v.string(), v.transform(Number), v.integer()) })
```

```json
{ "code": 422, "message": "Validation Failed", "data": null,
  "errors": [{ "target": "body", "path": "title", "message": "Title is required" }] }
```

`target` is omitted when you call `validate()` yourself. Throw your own: `new ValidationException([{ path: 'email', message: 'Already taken' }])`.

## Responses

[Full guide](../../../docs/guide/responses.md).

| Handler returns | Result |
|---|---|
| Object, array, number, boolean, `null`/`undefined`, `toJSON()` objects (models, Date) | `{ code: 0, message: 'ok', data }` |
| `ctx.created(data)` / `ctx.noContent()` | Same with 201 / empty 204 |
| String, stream, binary, `Response`, `ctx.redirect(url, status = 302)` | Sent as-is |
| `raw(value)` | `value` without envelope |
| JSX node / `ctx.view(...)` | `text/html`, no envelope |
| `ctx.sse(source, options?)` | `text/event-stream`, no envelope |

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  response: { envelope: true, successCode: 0, successMessage: 'ok' }, // envelope:false → data as-is, errors { status, message, data, errors? }
  bodyLimit: '1mb',
  trustProxy: false,
}))
```

Skip the envelope per value with `raw()` or per route with `.meta({ envelope: false })` — both affect **success only**; errors still go through `Formatter.error()`.

```ts
// app/controller/ExportController.ts
import type { HttpContext } from '@hazejs/core'
import { raw, Storage } from '@hazejs/core'

export class ExportController {
  accepted(ctx: HttpContext) {
    ctx.status(202).setHeader('x-job', 'queued')
    return { queued: true }
  }

  csv() {
    return new Response('id,name\n1,Ada\n', { headers: { 'content-type': 'text/csv' } })
  }

  download() {
    return Storage.download('reports/2026.csv', 'report.csv')
  }

  health() {
    return raw({ status: 'up' })
  }

  async prefs(ctx: HttpContext) {
    ctx.setCookie('theme', 'dark', { maxAge: 60 * 60 * 24 * 365 })
    await ctx.setSignedCookie('plan', 'pro')
    ctx.deleteCookie('legacy')
    return ctx.redirect('/settings') // must be returned
  }

  events(ctx: HttpContext) { // SSE: async iterable → one event per item, closes when it ends
    return ctx.sse(async function* () {
      yield { event: 'progress', id: 1, data: { percent: 50 } } // { event?, data?, id?, retry? }; non-string data is JSON
    }())
  }

  live(ctx: HttpContext) { // function → stays open until stream.close() or client disconnect
    return ctx.sse((stream) => {
      const off = orders.subscribe(order => stream.send({ event: 'order', data: order }))
      stream.onClose(off) // runs on disconnect / close() / source error
    }, { heartbeat: '30s' }) // options: heartbeat (15s, false = off), status, headers, signal, onError
  }
}
```

**Custom format** — `app/response/Formatter.ts` (auto-discovered, per app in `app/<name>/response/`) extends `ResponseFormatter`: `success(data, ctx)`, `error(error: NormalizedError, ctx)` (`status`, `code`, `message`, `data?`, `errors?`, `stack?`), `shouldFormat(value, ctx)`. Change the error shape here, not in the exception handler.

```ts
// app/response/Formatter.ts
import type { HttpContext, NormalizedError } from '@hazejs/core'
import { ResponseFormatter } from '@hazejs/core'

export default class Formatter extends ResponseFormatter {
  override success(data: unknown, ctx: HttpContext) {
    return { success: true, result: data, requestId: ctx.requestId }
  }

  override error(error: NormalizedError, ctx: HttpContext) {
    return { success: false, errorCode: error.code, errorMessage: error.message, ...(error.errors && { fields: error.errors }), requestId: ctx.requestId }
  }
}
```

**Interceptors and hooks** — run on the final `Response` (after formatting and error rendering), may mutate headers or return a replacement.

```ts
// app/interceptor/response-time.ts — auto-loaded, file-name order (or app.intercept(fn) in a provider)
import { defineInterceptor } from '@hazejs/core'

export default defineInterceptor((response, ctx) => {
  response.headers.set('x-response-time', `${Math.round(performance.now() - ctx.startedAt)}ms`)
})
```

`ctx.onResponse(hook)` is per request; hooks run **after** interceptors, last-registered first (outermost middleware sees the response last).

## API resources

[Full guide](../../../docs/guide/resources.md). `make:resource User`.

```ts
// app/resource/UserResource.ts
import type { User } from '~/app/model/User'
import { defineResource, merge, when, whenLoaded } from '@hazejs/core'
import { PostResource } from '~/app/resource/PostResource'

export const UserResource = defineResource((user: User, ctx) => ({
  id: user.id,
  name: user.name,
  email: when(ctx.can('update', user), user.email), // removed when false
  posts: whenLoaded('posts', PostResource), // only if eager-loaded
  ...merge(user.role === 'admin', () => ({ permissions: user.permissions })),
}))
```

`UserResource.make(user)` → object (`null` for nullish); `.collection(array)` → array; `.collection(paginator)` → `{ data, meta, links }`; `.additional({...})` adds top-level keys. Results go through the envelope. `whenNotNull(v)` is also available. Call `whenLoaded('rel')` before the first `await` in an async transform, or use `whenLoaded(item, 'rel', Res)`. Give OpenAPI a schema with `defineResource(fn, { schema })` and `.doc({ response: UserResource.schema })`.

## Exceptions

[Full guide](../../../docs/guide/errors.md). All extend `HttpException` (extends h3 `HTTPError`).

| Class | Status |
|---|---|
| `BadRequestException` / `UnauthorizedException` / `ForbiddenException` / `NotFoundException` | 400 / 401 / 403 / 404 |
| `MethodNotAllowedException` / `ConflictException` | 405 / 409 |
| `CsrfTokenMismatchException` / `ValidationException` / `TooManyRequestsException` | 419 / 422 / 429 |
| `InternalServerErrorException` / `InvalidSignatureException` | 500 / 403 |
| `BusinessException(code, message, { status? })` | 200 by default, `code` in body |

```ts
throw new ConflictException('Email already registered', { code: 40901, data: { field: 'email' } })
throw new TooManyRequestsException('Slow down', { headers: { 'retry-after': '60' } })
throw new HttpException('Payment required', { status: 402, cause: error })
```

Non-`HTTPError` errors become 500; outside debug the message is replaced with `Internal Server Error`. In debug, JSON includes `stack`, and `Accept: text/html` requests get an error page.

```ts
// app/exception/Handler.ts
import type { HttpContext } from '@hazejs/core'
import { BusinessException, ExceptionHandler } from '@hazejs/core'
import { PaymentGatewayError } from '~/app/service/payment'

export default class Handler extends ExceptionHandler {
  protected override dontReport = [PaymentGatewayError]

  override async report(error: unknown, ctx: HttpContext) {
    await super.report(error, ctx) // logs via ctx.logger; 4xx HTTPErrors are not reported (shouldReport)
  }

  override render(error: unknown, ctx: HttpContext) {
    if (error instanceof BusinessException)
      ctx.setHeader('x-business-code', String(error.code))
    return super.render(error, ctx)
  }
}
```

## OpenAPI

[Full guide](../../../docs/guide/openapi.md). OpenAPI 3.1 is generated from routes + `.validate()` schemas and served at `/openapi.json` and `/docs` (Scalar) in every mode except production. Valibot needs `@valibot/to-json-schema` installed; otherwise schemas show as "any". Auto-added responses: 422 for `.validate()`, 401 for `auth`, 403 for `can:`/`guest`; `auth` adds security requirements per guard.

```ts
r.delete('/users/:id', [UserController, 'destroy'])
  .name('users.destroy')
  .validate({ params: UserIdParams })
  .doc({
    summary: 'Delete a user',
    tags: ['Users'],
    status: 204,
    responses: { 404: { description: 'User not found' } },
    security: [{ api: [] }], // [] = no auth
    extensions: { 'x-permission': ['user:delete'] }, // keys must start with x-
  })
```

`.doc()` fields: `summary`, `description`, `tags`, `deprecated`, `operationId`, `hidden`, `response` (schema of `data`, wrapped in the envelope), `status`, `responses` (`{ [status]: { description, schema?, contentType? } }`, not wrapped), `contentType`, `security`, `extensions`.

```ts
// config/openapi.ts
import { defineOpenAPIConfig } from '@hazejs/core'

export default defineOpenAPIConfig({
  info: { version: '1.2.0', description: 'Blog API' },
  servers: [{ url: 'https://api.example.com' }],
  ui: 'scalar', // or 'swagger'
  // enabled, path, docsPath (false = JSON only), uiOptions, tags, envelope (bool | fn), securitySchemes, include: route => boolean
})
```

Export: `npx haze openapi --output openapi.json`, or in code `await generateOpenAPI(app, { info: { version: '2.0.0' } })` after boot. `haze typegen` also builds a typed client (`createClient` from `@hazejs/core/client`) for **named** routes.

## Static files, multi-app, modules

```ts
await createApplication({
  static: { dir: '/srv/web', spaFallback: true, exclude: ['/api'], precompressed: true },
})
```

| Option | Meaning |
|---|---|
| `dir` | Absolute directory to serve (GET/HEAD only) |
| `spaFallback` | Unmatched requests with `Accept: text/html` get `index.html` |
| `exclude` | Path prefixes never served or falling back (`['/api']`) |
| `immutablePrefix` | Long-lived immutable cache prefix, default `/assets/` |
| `precompressed` | `true` = serve `.br`/`.gz` copies per `Accept-Encoding` (br preferred); or `{ encoding: ext }` |

Static serving runs **after** global middleware (so `secureHeaders`/`cors` apply to pages and assets) and before routes. HTML responses and the SPA fallback get `Cache-Control: no-cache`. Keep `auth`-style middleware on route groups, not global. See [full-stack guide](../../../docs/guide/fullstack.md).

**Multi-app** (per-prefix/domain apps in `app/<name>/`) and **modules** (`modules/<name>/`, `config/modules.ts`): see [container-and-modules.md](container-and-modules.md).

## Gotchas

- Validation failures are **422**, not 400, with an `errors[]` array (`target`, `path`, `message`). CSRF mismatch is **419**, oversized body **413**, throttle **429**.
- The `{ code, message, data }` envelope is **on by default**; success `code` is `0`, not the HTTP status. Clients must unwrap `data`. `raw()` / `envelope: false` do not change the error shape.
- Strings, `Response`s and streams bypass the envelope — returning `JSON.stringify(x)` sends a string, not an enveloped object.
- `ctx.redirect()` must be **returned**; calling it alone does nothing.
- Use `ctx.sse()` instead of a hand-built `ReadableStream`: it sends heartbeats, closes and runs `onClose` on disconnect, and sets the anti-buffering headers. A generator source sees `return()` only after its current `await` settles, so pass `stream.signal` to long upstream calls.
- Middleware `await next()` sees the raw handler value, not a `Response`. Use `ctx.onResponse`/interceptors for headers on the final response.
- Controllers are request-scoped, but services are **singletons** by default — never store per-request data (user, ctx) on a service field; use `useContext()` or pass it.
- `inject()` only works during construction of container-built classes, inside `container.call()`, or during a request. Top-level calls throw.
- `HttpContext` belongs to one request; don't cache it in module scope or singletons.
- The body is parsed lazily: always `await ctx.body()` (and `await ctx.file()`). `ctx.body<T>()` does not validate. Default limit is `1mb` (`ctx.bodyLimit`), raise with `bodyLimit:Nmb`.
- Route params and query values are **strings** (URL-decoded). Use `v.transform(Number)` in `.validate({ params })` and read `ctx.validated.params`.
- `throttle:10,60` on two routes shares **one** bucket per user/IP (key = spec + user/IP). Use distinct named limiters (optionally with `key`) for per-route budgets. Memory store is per process; use a shared store with multiple instances.
- `cors` must be global; route-level `cors` never sees preflights.
- `ctx.ip`, `ctx.origin`, `ctx.secure` and HSTS/COOP ignore `X-Forwarded-*` unless `app.trustProxy` is truthy (`true` = 1 trusted hop, `n` = n hops; `ctx.ip` is read from the right of `X-Forwarded-For`, never the leftmost). Only enable it behind a trusted proxy: Vercel/Netlify → `true`; Cloudflare Workers / AWS Lambda not needed (the entry passes `cf-connecting-ip` / `sourceIp`; custom entries call `setClientAddress(request, ip)` from `@hazejs/core`).
- `secureHeaders` never sends COOP/`Origin-Agent-Cluster` over plain http, and HSTS only on https with debug off — don't expect them in local http tests.
- SPA fallback only triggers for `Accept: text/html` and unmatched GET/HEAD; `fetch` calls to unknown paths still get JSON 404. Put the API prefix in `exclude`.
- OpenAPI/docs endpoints run before global middleware (no auth/CSP) and are off in production unless `enabled: true`.
- Groups have no `domain` option; use multi-app. Duplicate route names, unknown middleware and missing `only` actions fail at boot.
- Controller middleware runs after route middleware, and validation runs after all middleware — `auth` rejects before a 422 can happen.
- Error `message` of unexpected (non-HTTP) errors is hidden outside debug; throw an `HttpException` subclass for client-visible messages.
