# Routing

Routes in hazejs are defined centrally in `route/*.ts`. Every file in that directory is discovered automatically; each one default-exports `defineRoutes()`. Because route definitions are plain data compiled at boot, they can be listed, typed and turned into URLs.

```ts
// route/api.ts
import { defineRoutes } from '@hazejs/core'
import { GreetingController } from '~/app/controller/GreetingController'

export default defineRoutes((r) => {
  r.get('/', () => ({ message: 'Hello hazejs' }))
  r.get('/hello', [GreetingController, 'index']).name('hello')
})
```

## HTTP methods

The builder `r` has a method for each verb. All of them take a path and a handler and return a `Route` you can chain on.

```ts
// route/api.ts
r.get('/posts', [PostController, 'index'])
r.post('/posts', [PostController, 'store'])
r.put('/posts/:id', [PostController, 'update'])
r.patch('/posts/:id', [PostController, 'update'])
r.delete('/posts/:id', [PostController, 'destroy'])
r.options('/posts', [PostController, 'options'])
r.any('/webhook', [WebhookController, 'handle']) // any HTTP method
```

## Handlers

A handler is either a function or a `[Controller, 'method']` tuple.

```ts
// route/api.ts
// Closure: receives the HttpContext
r.get('/ping', ctx => ({ pong: true, path: ctx.path }))

// Controller action: jump-to-definition works, and the method name is type-checked
r.get('/users/:id', [UserController, 'show'])
```

Prefer controller tuples for anything beyond a one-liner. A misspelled method name is a type error, and an invalid handler fails at boot with a clear message. Controllers are resolved from the container for each request, so they can use `inject()`. See [Controllers](./controllers).

## Route parameters

Path segments starting with `:` are parameters. Read them with `ctx.param()` / `ctx.params()`, or validate and convert them with `.validate()` (see below).

```ts
// route/api.ts
r.get('/posts/:postId/comments/:id', (ctx) => {
  return { post: ctx.param('postId'), comment: ctx.param('id') }
})
```

Raw parameter values are always strings. Use a schema to turn them into numbers.

## Groups

`r.group()` shares a URL prefix, a route-name prefix and middleware across routes. Groups can be nested; prefixes and middleware accumulate.

```ts
// route/api.ts
r.group({ prefix: '/api', as: 'api.' }, (r) => {
  r.get('/hello', [GreetingController, 'index']).name('hello') // name: api.hello

  r.group({ prefix: '/admin', as: 'admin.', middleware: ['auth', 'can:admin.access'] }, (r) => {
    r.get('/stats', [StatsController, 'index']).name('stats') // name: api.admin.stats
  })
})

// Options are optional
r.group((r) => {
  r.get('/a', handlerA)
})
```

| Option | Description |
|--------|-------------|
| `prefix` | Path prefix joined in front of every route |
| `as` | Name prefix, e.g. `'admin.'` |
| `middleware` | Middleware applied to every route in the group |

::: info Domains
Groups have no `domain` option. To serve routes on a different domain or under a separate prefix with its own config, use [multiple apps](./multi-app) (`apps` in `config/app.ts`).
:::

## Resource routes

`r.resource()` registers the conventional RESTful routes for a controller:

| Method | Path | Action | Name |
|--------|------|--------|------|
| GET | `/users` | `index` | `users.index` |
| POST | `/users` | `store` | `users.store` |
| GET | `/users/:id` | `show` | `users.show` |
| PUT / PATCH | `/users/:id` | `update` | `users.update` (PUT only) |
| DELETE | `/users/:id` | `destroy` | `users.destroy` |

```ts
// route/api.ts
r.resource('/users', UserController)
r.resource('/photos', PhotoController, { only: ['index', 'show'] })
r.resource('/posts', PostController, { except: ['destroy'], param: 'slug', name: 'articles' })
```

- Without `only`, only the actions the controller actually implements are registered.
- If `only` lists an action that the controller does not have, boot fails.
- `param` renames the member parameter (default `id`). `name` sets the name base (default: the last path segment).
- Group `as` prefixes still apply, e.g. `api.users.show`.

`r.resource()` returns a `ResourceRoutes` object. Call `.middleware()` to add middleware to every resource route, or `.validateMember()` to validate the routes that have an `:id` (`show`, `update`, `destroy`):

```ts
// route/api.ts
import { UserIdParams } from '~/app/validate/user'

r.resource('/users', UserController)
  .middleware('auth')
  .validateMember({ params: UserIdParams })
```

Generate a matching controller with:

```bash
npx haze make:controller User --resource
```

## Route options

Each route method returns a `Route` with chainable modifiers:

```ts
// route/api.ts
r.post('/login', [AuthController, 'login'])
  .name('login')
  .middleware('throttle:10,60')
  .validate({ body: LoginSchema })

r.get('/legacy', [LegacyController, 'index']).meta({ envelope: false })
```

| Method | Description |
|--------|-------------|
| `.name(name)` | Names the route (prefixed by the group's `as`) |
| `.middleware(...refs)` | Adds middleware: alias strings (with parameters), functions or classes. See [Middleware](./middleware) |
| `.validate({ body, query, params, headers })` | Validates the request before the handler runs; results land in `ctx.validated`. See [Requests & Validation](./requests) |
| `.meta(meta)` | Attaches metadata. `{ envelope: false }` skips the response envelope. See [Responses](./responses) |

## Named routes and URL generation

Generate URLs from route names with `router.url()`. Missing parameters throw; a third argument adds a query string.

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

Outside the container you can use `useApp().router.url(...)`. Route names must be unique; duplicates fail at boot.

### Typed route names

The dev server runs `haze typegen` after each reload. It writes `.haze/types/haze.d.ts`, which declares every named route and its path parameters. After that, `router.url()` only accepts known names and requires the right params:

```ts
router.url('api.users.show', { id: 1 }) // ok
router.url('api.users.show') // type error: missing { id }
router.url('api.user.show', { id: 1 }) // type error: unknown route name
```

Run `pnpm typegen` (`haze typegen`) to regenerate the types manually, for example in CI before `tsc`.

## Signed URLs

A signed URL carries an HMAC-SHA256 signature (keyed with `APP_KEY`) over its path and query string, so it can be handed out — in an email, say — and verified later without storing anything. Typical uses are unsubscribe links, invitations and downloads.

```ts
import { inject, Router } from '@hazejs/core'

const router = inject(Router)

await router.signedUrl('unsubscribe', { id: user.id })
// https://example.com/unsubscribe/42?signature=...

await router.temporarySignedUrl('invitations.accept', '7d', { id: invitation.id })
await router.signedUrl('downloads.show', { file }, { expiresIn: '30m', query: { as: 'report.csv' } })
```

| Option | Description |
|--------|-------------|
| `expiresIn` | Lifetime (`'30m'`, `'7d'` or seconds); adds an `expires` parameter. Without it the link never expires |
| `expiresAt` | Expiry as a `Date` or timestamp, instead of `expiresIn` |
| `query` | Extra query parameters, covered by the signature |
| `absolute` | Prefix with `app.url` (`APP_URL`); defaults to `true` when `APP_URL` is set |

`temporarySignedUrl(name, expiresIn, params?, options?)` is the same with a required lifetime (a duration or a `Date`). The query parameters are sorted before signing, so their order doesn't matter; `expires` and `signature` are reserved.

Protect the route with the built-in `signed` middleware. Tampered, unsigned and expired links get a `403` (`InvalidSignatureException`, message translated when [localization](./localization) is configured):

```ts
r.get('/unsubscribe/:id', [NewsletterController, 'unsubscribe']).middleware('signed').name('unsubscribe')
// ignore parameters added after signing, such as tracking tags
r.get('/downloads/:file', [DownloadController, 'show']).middleware('signed:utm_source,utm_medium').name('downloads.show')
```

Or check by hand with `await ctx.hasValidSignature()` (`{ ignore: [...] }` works there too). Links signed with a key listed in `app.previousKeys` / `APP_PREVIOUS_KEYS` stay valid after you rotate `APP_KEY` (see [Encryption](./security#encryption)).

## WebSocket routes

`r.ws()` registers a WebSocket endpoint. The upgrade request goes through global and route middleware like a normal GET, so you can protect it with `auth`:

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

See [WebSocket](./websocket) for broadcasting, multi-instance setups and platform support.

## Listing routes

```bash
pnpm routes            # haze route:list
npx haze route:list --json
```

The table shows method, path, name, handler (`UserController@show` or `closure`) and the fully expanded middleware list, including controller middleware. With multiple apps, it also shows the app and domain columns.

::: tip
Unknown middleware names and duplicate route names make the app fail at boot, so `route:list` doubles as a quick sanity check in CI.
:::
