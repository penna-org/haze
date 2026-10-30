# What is hazejs?

hazejs is a batteries-included TypeScript backend framework. It brings the productivity of Laravel and ThinkPHP — conventions, a service container, centralized routes, generators, and first-party queues, mail and auth — to a modern toolchain built on [h3 v2](https://h3.dev) and [Vite](https://vite.dev).

The same application runs on Node.js, Bun, Deno, Docker, Cloudflare Workers, Vercel, Netlify and AWS Lambda, and can serve a Vue, React or any other Vite frontend from the same port with a single build.

## Philosophy

**Convention over configuration.** Controllers live in `app/controller`, config in `config/`, routes in `route/`, jobs in `app/job`. Most directories are discovered at build time, so there is no registration boilerplate — and `haze make:*` generates the files for you. See [Directory Structure](./directory-structure).

**Web standards underneath.** h3 v2 works on the Web `Request` / `Response` API. hazejs adds the application layer on top: an IoC container, providers, middleware pipeline, exception handler, response envelope and lifecycle. Because the core is just a `fetch` handler, the same code runs on every runtime and can be tested without opening a port.

**A Vite-native toolchain.** `haze dev` runs your TypeScript through Vite's module runner. When a file changes, the application is rebuilt and the `fetch` handler is swapped atomically: the process keeps running, the port stays open, and database pools, Redis connections and sockets survive the edit.

**Everything first-party, one style.** Every module is configured the same way (`config/<name>.ts`), tested the same way (`fake()` helpers), and works in the dev server, in tests and in every deployment preset it supports.

## A quick look

```ts
// route/api.ts
import { defineRoutes } from '@hazejs/core'
import { PostController } from '~/app/controller/PostController'
import { PostIdParams } from '~/app/validate/post'

export default defineRoutes((r) => {
  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    r.resource('/posts', PostController).validateMember({ params: PostIdParams })
  })
})
```

```ts
// app/controller/PostController.ts
import type { HttpContext } from '@hazejs/core'
import type { PostIdParams } from '~/app/validate/post'
import { inject } from '@hazejs/core'
import { Post } from '~/app/model/Post'
import { PostService } from '~/app/service/PostService'

export class PostController {
  static middleware = [{ use: 'auth', except: ['index', 'show'] }]

  private posts = inject(PostService)

  index() {
    return Post.order('id', 'desc').paginate(1, 20)
  }

  async update(ctx: HttpContext<{ params: typeof PostIdParams }>) {
    const post = await Post.findOrFail(ctx.validated.params.id)
    await ctx.authorize('update', post) // app/policy/PostPolicy.ts
    return this.posts.update(post, await ctx.body())
  }
}
```

Whatever a controller returns is wrapped in a uniform envelope — `{ code: 0, message: 'ok', data }` by default — and errors are rendered by a single exception handler.

## What's in the box

| Area | Features |
| --- | --- |
| HTTP | Centralized [routes](./routing), groups, resources, named routes, [controllers](./controllers), [middleware](./middleware), interceptors, a uniform [response](./responses) envelope, [API resources](./resources), an [exception handler](./errors) with a dev error page |
| API docs | An [OpenAPI](./openapi) 3.1 document generated from routes and validation schemas, a `/docs` page, and a typed `fetch` client for the frontend |
| Container | `inject()`, singleton / request / transient scopes, service providers, resources that persist across hot reloads — see [Service Container](./container) |
| Validation | Standard Schema (valibot, zod, arktype, …), per-route `.validate({ body, query, params })`, typed `ctx.validated` — see [Requests & Validation](./requests) |
| Database | `@hazejs/orm` on drizzle: [models](./models), query builder, soft deletes, migrations and seeders for SQLite, PostgreSQL, MySQL, Turso and D1, plus a MongoDB adapter — see [Database](./database). [Full-text search](./search) with `@hazejs/search` on the database, Meilisearch, Typesense or Elasticsearch / OpenSearch |
| Security | [Authentication](./authentication) (JWT, session and [API token](./api-tokens) guards, email verification, password reset), [two-factor and passkeys](./two-factor), [OAuth social login](./oauth) with `@hazejs/oauth`, [authorization](./authorization) (gates and policies), [CSRF, sessions, CORS, secure headers, rate limiting and encryption](./security) |
| Infrastructure | [Cache](./cache) with tags, Redis data structures and atomic locks, [queues](./queues) with retries and delays, a [task scheduler](./scheduling), [events](./events) with queued listeners, [console commands](./console) and a REPL |
| Messaging | [Notifications](./notifications) over mail, database, broadcast, Slack, webhooks, WeCom, DingTalk and Feishu; [mail](./mail) over SMTP, Resend, Postmark, Mailgun and SES |
| Realtime | [WebSocket](./websocket) via crossws, [Socket.IO](./socket-io) via `@hazejs/socket.io`, and [broadcasting](./broadcasting) with private and presence channels and the `@hazejs/core/echo` client |
| Files | [File storage](./storage) on local disks, S3 and R2 |
| Localization | [Translation files](./localization) in `lang/`, per-request locale detection, translated validation and framework messages, typed keys |
| Observability | [Health checks](./observability#health-checks), OpenTelemetry traces and metrics, and a dev dashboard at `/__haze` with a queue tab — see [Observability](./observability). [DevTools](./devtools) add a module graph, request waterfalls, AI and task panels, and an MCP endpoint for coding agents |
| Architecture | Reusable [modules](./modules) (local `modules/<name>/` folders or npm packages with routes, config and migrations), [multiple apps](./multi-app) in one project, [multi-tenancy](./tenancy) (database per tenant or a tenant column, isolated cache and storage), [microservices](./microservices) over Redis, NATS or gRPC with `@hazejs/microservices` |
| Integrations | [AI](./ai) with `@hazejs/ai` (text, streaming, tools, embeddings, MCP) and [GraphQL](./graphql) with `@hazejs/graphql` |
| Tooling | The `haze` [CLI](./cli): dev server, build, preview, 23 `make:*` generators, `db:*`, `queue:*`, `schedule:*`, `search:*`, `openapi`, `repl`, your own commands, and generated types for config keys, routes, policy abilities and translation keys |
| Testing | `useTestApp()`, `actingAs(user)`, and fakes for queues, events, mail, storage, notifications, broadcasts, search and AI — see [Testing](./testing) |

## Runtimes and deployment

One codebase, one build command:

```bash
haze build --preset node        # also: bun, deno, docker
haze build --preset cloudflare  # Workers, with D1 / KV / R2 / Queues / Durable Objects
haze build --preset vercel      # also: netlify, aws-lambda
```

Dependencies that cannot be bundled (database drivers, native modules) are traced into the output's `node_modules`, so `dist/` runs on its own. `haze preview` runs the real build output for any preset locally. See [Deployment](./deployment).

## Full-stack with Vite

Add the `haze()` plugin to a Vite project and `/api/**` is handled by your backend on the same dev port — no proxy, no CORS. `vite build` produces `dist/client` and `dist/server`, and a single production process serves both. See [Full-stack with Vite](./fullstack).

## How it compares

hazejs sits between minimal routers (Express, Fastify, Hono) and full frameworks like NestJS and AdonisJS: it is as complete as Laravel, but runs on Web standards and deploys to the edge. The [roadmap](/roadmap) has a feature-by-feature comparison and the list of what's planned next.

## When to use hazejs

hazejs is a good fit when you want:

- a full backend — database, auth, queues, mail, realtime — without assembling and wiring a dozen libraries;
- a monorepo-free full-stack app where the Vue / React frontend and the API share one repository, one port and one build;
- the freedom to deploy the same code to a VPS, a container, serverless functions or Cloudflare Workers;
- a familiar structure if you come from Laravel or ThinkPHP.

It is probably not the right choice if you only need a handful of endpoints (a micro-router is lighter), or if you need an ecosystem of third-party plugins as large as Express's.

## Next steps

- [Getting Started](./getting-started) — create your first project
- [Directory Structure](./directory-structure) — where everything lives
- [Configuration](./configuration) — `config/*.ts`, `.env` and `haze.config.ts`
