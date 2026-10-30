---
name: hazejs
description: Build backends and full-stack apps with hazejs (@hazejs/core, @hazejs/orm, @hazejs/vite, @hazejs/testing, the `haze` CLI) — a batteries-included TypeScript framework on h3 v2 in the style of Laravel / ThinkPHP. Use whenever the code imports `@hazejs/*`, the project has `haze.config.ts`, `route/*.ts`, `app/controller`, `config/*.ts` with hazejs helpers, or the user asks to add routes, controllers, middleware, validation, models, migrations, auth, policies, jobs, events, schedules, mail, notifications, broadcasting, WebSocket / Socket.IO, cache, storage, i18n, search, AI, GraphQL, microservices, providers / dependency injection, local modules, multi-app, OpenAPI, observability, tests, or to deploy a hazejs app — even if they do not name the framework. For porting an existing Fastify/Express/Nest backend use `hazejs-migration`; for changing the framework itself use `hazejs-contributing`.
---

# hazejs

hazejs is an ESM-only TypeScript backend framework. The request pipeline is h3 v2 (Web `Request` → `Response`), the dev server is Vite (hot reload without restarting the process), and every subsystem — container, routing, validation, auth, ORM, queues, cache, storage, mail, notifications, broadcasting, AI, OpenAPI, observability, deployment presets — is first-party and configured the same way.

Read the reference that matches the task before writing code:

| Task | Reference |
| --- | --- |
| Routes, controllers, middleware, validation, responses, resources, errors, OpenAPI, static files | [references/http.md](references/http.md) |
| Database: config, schemas, migrations, models, query builder, relations, transactions, factories, seeders | [references/database.md](references/database.md) |
| Authentication, guards, policies / gates, API tokens, email verification, password reset, 2FA, passkeys, OAuth | [references/auth.md](references/auth.md) |
| Queues, events, scheduling, mail, notifications, broadcasting, WebSocket, Socket.IO, console commands | [references/async-and-realtime.md](references/async-and-realtime.md) |
| Service container, providers & boot order, local / packaged modules, multi-app | [references/container-and-modules.md](references/container-and-modules.md) |
| Cache, Redis, storage, HTTP client, i18n, encryption, search, tenancy, TSX views, AI | [references/services.md](references/services.md) |
| GraphQL (`@hazejs/graphql`): schema-first / code-first, loaders, subscriptions | [references/graphql.md](references/graphql.md) |
| Microservices (`@hazejs/microservices`): message handlers, transports, clients | [references/microservices.md](references/microservices.md) |
| Tests: test app & client, fakes, database in tests | [references/testing.md](references/testing.md) |
| CLI, configuration & env, project layout, full-stack Vite, deployment presets, maintenance, health & observability | [references/operations.md](references/operations.md) |

The full documentation lives in the framework repo under `docs/guide/*.md` (English) and `docs/zh/guide/*.md` (Chinese).

## Packages

| Package | Purpose |
| --- | --- |
| `@hazejs/core` | Container, routing, middleware, validation, exceptions, auth, cache, queue, events, schedule, mail, notifications, broadcasting, WebSocket, storage, i18n, OpenAPI, observability, maintenance, TSX views |
| `@hazejs/orm` | Drizzle-based models, query builder, migrations, factories (MySQL, PostgreSQL, SQLite, PGlite, Turso, D1, MongoDB) |
| `@hazejs/vite` | Vite plugin: dev server with hot reload, full-stack integration, build presets (node, bun, deno, docker, aws-lambda, vercel, netlify, cloudflare) |
| `@hazejs/auto-import` | Optional, `autoImport: true` in `haze.config.ts`: compile-time imports for `app/<kind>/**` exports and curated `@hazejs/core`/`@hazejs/orm` APIs, types in `.haze/types/auto-imports.d.ts` (see operations.md) |
| `@hazejs/cli` | The `haze` command (`dev`, `build`, `start`, `test`, `make:*`, `db:*`, `queue:work`, …) |
| `@hazejs/testing` | Vitest integration, in-process HTTP client, fakes |
| `@hazejs/ai`, `@hazejs/oauth`, `@hazejs/search`, `@hazejs/socket.io`, `@hazejs/graphql`, `@hazejs/microservices` | Optional feature packages |
| `create-hazejs` | Scaffolder: `pnpm create hazejs my-app -t api|vue|react [--auto-import]` |

## Project layout (API template)

The backend source directory is the project root (`server/` in the vue / react templates, set by `srcDir` in `haze.config.ts`). `~/` is an alias for it.

```
app/controller   HTTP controllers            app/service      business services
app/model        ORM models                  app/resource     API resources
app/policy       policies (auto)             app/job          queue jobs (auto)
app/event        events (auto)               app/listener     listeners (auto)
app/notification notifications (auto)        app/channel      broadcast channel auth (auto)
app/command      console commands (auto)     app/provider     service providers (auto)
app/exception/Handler.ts (auto)              app/response/Formatter.ts (auto)
app/middleware, app/interceptor, app/validate, app/view (TSX)
config/*.ts      one file per config key (auto)      route/*.ts   routes (auto)
schedule/*.ts    scheduled tasks (auto)              lang/<locale>/  translations (auto)
database/{schema,migrations,factories,seeders}       modules/<name>/  local modules (auto)
tests/           Vitest                              .env, .env.test, haze.config.ts
```

"(auto)" folders are discovered at build time — create the file and it is registered. Prefer `npx haze make:<kind> Name` (controller, service, model, middleware, job, event, listener, mail, notification, policy, command, test, factory, config, module, view, …) so files land in the right place with the right shape.

## The core pattern

```ts
// app/service/PostService.ts — business logic, no HTTP
import { NotFoundException } from '@hazejs/core'

export class PostService {
  async find(id: number) {
    const post = await Post.find(id)
    if (!post)
      throw new NotFoundException(`Post ${id} not found`)
    return post
  }
}
```

```ts
// app/controller/PostController.ts — request in, data out
import type { HttpContext } from '@hazejs/core'
import { inject } from '@hazejs/core'
import { PostService } from '~/app/service/PostService'

export class PostController {
  private posts = inject(PostService)

  show(ctx: HttpContext) {
    return this.posts.find(Number(ctx.param('id')))
  }
}
```

```ts
// route/api.ts — routes are registered centrally, never discovered from controllers
import { defineRoutes } from '@hazejs/core'
import * as v from 'valibot'
import { PostController } from '~/app/controller/PostController'

export default defineRoutes((r) => {
  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    r.get('/posts/:id', [PostController, 'show']).name('posts.show')
    r.post('/posts', [PostController, 'store'])
      .middleware('auth')
      .validate({ body: v.object({ title: v.pipe(v.string(), v.minLength(1)) }) })
  })
})
```

- Dependencies come from `inject(Class | token)` in field initializers or constructors; no decorators. Classes are singletons unless they declare `static scope = Scope.Request | Scope.Transient`; controllers default to request scope. Non-class values use `createToken<T>('name')` and are bound in a provider (`defineProvider({ register(container) {...}, boot(app) {...}, shutdown(app) {...} })`). Module providers boot before the app's; `app.onBooted(cb)` runs after all of them (see operations.md).
- Handlers return plain data; the response formatter wraps it as `{ code: 0, message: 'ok', data }` unless `app.response.envelope` is `false`, the route has `.meta({ envelope: false })`, or the handler returns `raw(value)`, a string, or a `Response`.
- Validation uses any Standard Schema library (Valibot in the templates, Zod 4, ArkType). Failures are **422** with `errors: [{ target, path, message }]`. Validated data is on `ctx.validated`.
- Throw `HttpException` subclasses (`NotFoundException`, `ForbiddenException`, `BusinessException`, …) and let `app/exception/Handler.ts` (extends `ExceptionHandler`) render them.
- Config: `config/<key>.ts` exports `defineConfig(() => ({ … }))` (or a typed helper such as `defineAuthConfig`); read with `config('key.path')`, `ctx.config.get()` or `inject(Config)`. `env('NAME', default)` coerces to the default's type. `.env` → `.env.local` (not in test) → `.env.<mode>` → `.env.<mode>.local`.
- `haze typegen` (run automatically by `haze dev`) generates types for config keys, route names, abilities and translation keys into `.haze/types`.

## Working rules for agents

1. **Find the project's conventions first**: read `haze.config.ts` (srcDir, preset), `config/app.ts` (envelope, trustProxy), `config/middleware.ts` (global middleware, aliases, groups), `route/*.ts` and an existing controller/test before adding code.
2. **Put code where discovery expects it** and use `make:*` generators; do not register discovered things by hand.
3. **Keep layers**: controllers translate HTTP ↔ data; services hold rules and never touch `HttpContext` (pass the current user explicitly when practical); models/queries stay in the data layer.
4. **Every behaviour change gets a test** with `@hazejs/testing` (`useTestApp()`, fakes for queue/mail/events/storage/notifications/HTTP). Tests run in-process, no port.
5. **Verify before finishing**: `pnpm test` (or `haze test`), `pnpm typecheck`, `pnpm routes` (`haze route:list`) for new routes, and for schema changes `pnpm db:generate` + `pnpm db:migrate`.
6. Use only APIs documented in the references or the guide; if something seems missing, check `node_modules/@hazejs/core/dist/index.d.mts` before inventing it.

## Cross-cutting gotchas

- Validation is 422, not 400; the default success/error bodies are enveloped. Keep the API contract consistent with what the frontend expects.
- `inject()` throws outside construction, `container.call()` or a request (e.g. at module top level).
- A singleton must not depend on a request-scoped class (the container throws a `ScopeError`).
- `await ctx.body()` parses lazily and enforces `ctx.bodyLimit` (default `app.bodyLimit`, 1mb); use the `bodyLimit:10mb` middleware or set `ctx.bodyLimit` for bigger payloads.
- Route parameters are URL-decoded strings; convert types with a schema.
- `ctx.ip`, `ctx.origin` and `ctx.secure` trust `X-Forwarded-*` only when `app.trustProxy` is truthy (`true` = 1 trusted hop, `n` = n hops; `ctx.ip` = nth `X-Forwarded-For` entry from the right).
- `throttle:60,1m`-style limits share one bucket per user/IP across every route that uses the same spec; use named limiters for per-route buckets.
- Static frontend files are served after global middleware, so `secureHeaders` / `cors` apply to them; SPA fallback only answers `Accept: text/html` requests.
- OpenAPI docs (`/docs`) and the dev dashboard (`/__haze`) are off in production by default; `/health` is always on.
- In full-stack dev the Vite server forwards only the configured API prefixes and `/__haze` to the backend.
- `ctx.setCookie()` defaults to `Secure` outside debug — pass `secure: ctx.secure` for plain-http intranet deployments.
- Singletons are built on first use and controllers per request: a service whose constructor registers side effects must be created at boot (`app.onBooted(() => app.make(Service))`).
- Route middleware can read the matched route (`ctx.route.meta`, `ctx.route.path`); keep `auth` / `can:` as alias strings so OpenAPI documents 401/403.
- Gate denials throw `AuthorizationException` (403, `abilities`, `reason`); map it in the exception handler when the API has its own error codes.
- Event listener errors are logged, not thrown; an expression-bodied listener that returns `false` stops the remaining listeners.
- Dispatch jobs / emit events from inside a transaction with `afterCommit`; `runInServer` (queue, schedule) is for single-process setups only.
- `serve()` force-closes WebSockets/SSE after `app.shutdownTimeout` (10 s) on SIGTERM — keep the orchestrator grace period longer. `migrate.mjs` boots every provider, so providers must tolerate an unmigrated database.
