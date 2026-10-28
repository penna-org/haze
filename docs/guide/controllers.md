# Controllers

Controllers group related request handlers into a class. They live in `app/controller/` and are referenced from routes as `[Controller, 'method']` tuples. A controller's job is small: read input, call a service, return data. The framework handles the response envelope and errors.

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

Generate a controller with the CLI:

```bash
npx haze make:controller Post            # app/controller/PostController.ts
npx haze make:controller Post --resource # with index/store/show/update/destroy
npx haze make:controller admin/User      # app/controller/admin/UserController.ts
```

## Action signature

Every action receives the request's `HttpContext` as its only argument and may be `async`. Whatever it returns becomes the response (see [Returning values](#returning-values)).

To get types for data validated on the route, pass the schemas as the generic parameter:

```ts
// app/controller/UserController.ts
import type { HttpContext } from '@hazejs/core'
import type { UserIdParams } from '~/app/validate/user'
import { User } from '~/app/model/User'

type WithId = HttpContext<{ params: typeof UserIdParams }>

export class UserController {
  show(ctx: WithId) {
    return User.findOrFail(ctx.validated.params.id) // id is a number here
  }
}
```

## Dependency injection

Controllers are created by the [service container](./container), so fields can call `inject()`. By default a controller is **request-scoped**: each request gets a new instance, which can safely depend on other request-scoped objects. Override this with `static scope` if you need to:

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

## The HttpContext

`HttpContext` is a thin wrapper around h3's `H3Event`. The most useful members:

| Member | Description |
|--------|-------------|
| `ctx.param(name)` / `ctx.params()` | Route parameters (strings) |
| `ctx.query(name)` / `ctx.query()` | Query string (single value or the whole object) |
| `await ctx.body()` | Parsed body: JSON, urlencoded or multipart |
| `await ctx.file(name)` / `await ctx.files(name)` | Uploaded files (`UploadedFile`) |
| `ctx.header(name)` | Request header |
| `ctx.cookie(name)` / `await ctx.signedCookie(name)` | Cookies |
| `ctx.validated` | Output of route-level `.validate()` |
| `ctx.method`, `ctx.path`, `ctx.url`, `ctx.ip`, `ctx.req` | Request info |
| `ctx.status(code)`, `ctx.setHeader(name, value)` | Response status and headers |
| `ctx.created(data)`, `ctx.noContent()`, `ctx.redirect(url, status?)` | Response helpers |
| `ctx.setCookie()`, `ctx.setSignedCookie()`, `ctx.deleteCookie()` | Write cookies |
| `ctx.auth` | Authentication (`await ctx.auth.user()`) |
| `ctx.can()`, `ctx.cannot()`, `ctx.authorize()` | Authorization checks |
| `ctx.session` | Session (requires the `session` middleware) |
| `ctx.get(key)` / `ctx.set(key, value)` | Request-scoped state shared between middleware and handlers |
| `ctx.make(key)` | Resolve from the request container |
| `ctx.logger`, `ctx.requestId`, `ctx.config` | Request logger, request ID, effective config |
| `ctx.onResponse(hook)` | Hook into the final `Response` |
| `ctx.event` | The underlying `H3Event`, for any h3 utility |

Reading input is covered in [Requests & Validation](./requests), response helpers in [Responses](./responses).

### Authentication and authorization

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
    await ctx.authorize('update', post) // 401 for guests, 403 when denied
    post.fill(await validate(UpdatePostSchema, await ctx.body()))
    return post.save()
  }

  me(ctx: HttpContext) {
    return ctx.auth.user() // pair with .middleware('auth') to require a login
  }
}
```

See [Authentication](./authentication) and [Authorization](./authorization).

### Getting the context elsewhere

Inside a request, deeper code (services, repositories) can call `useContext()` instead of passing `ctx` around:

```ts
// app/service/AuditService.ts
import { useContext } from '@hazejs/core'

export class AuditService {
  actor() {
    return useContext().header('x-user')
  }
}
```

## Controller middleware

Declare middleware on the controller with a static `middleware` array. Entries are middleware references or `{ use, only, except }` objects filtered by action name:

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

Controller middleware runs after global, group and route middleware. `haze route:list` shows the final list for each route.

## Resource controllers

A resource controller implements some or all of `index`, `store`, `show`, `update` and `destroy`, and is registered with `r.resource()`:

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

Only the methods that exist on the class are registered. See [Resource routes](./routing#resource-routes).

## Returning values

| Return value | Result |
|--------------|--------|
| Plain object, array, number, boolean, `null` / `undefined`, or an object with `toJSON()` (models, `Date`) | Wrapped in `{ code, message, data }` |
| `ctx.created(data)` | Same, with status `201` |
| `ctx.noContent()` | Status `204` |
| String, stream, binary | Sent as-is |
| `Response` (or `ctx.redirect()`) | Sent as-is |
| `raw(value)` | `value` without the envelope |

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

To fail, throw an exception such as `new NotFoundException()`; it becomes an error response in the same format. See [Responses](./responses) and [Errors & Logging](./errors).
