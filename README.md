<p align="center">
  <img src="./docs/public/logo.svg" alt="hazejs logo" width="120" height="120">
</p>

<h1 align="center">hazejs</h1>

<p align="center">
  A batteries-included TypeScript backend framework for Node.js, Bun, Deno and the edge.
</p>

<p align="center">
  <a href="https://github.com/penna-org/haze/actions/workflows/ci.yml"><img src="https://github.com/penna-org/haze/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="MIT License"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22.12-339933" alt="Node >= 22.12">
  <img src="https://img.shields.io/badge/status-pre--release-orange" alt="pre-release">
</p>

<p align="center">
  English · <a href="./README.zh-CN.md">简体中文</a>
</p>

---

hazejs gives you the productivity of Laravel / ThinkPHP and the ergonomics of a modern Vite toolchain in one coherent TypeScript framework. It is built on [h3 v2](https://h3.dev), so the same app runs on Node, Bun, Deno, Docker, Cloudflare Workers, Vercel, Netlify and AWS Lambda — and it can serve your Vue / React / any-Vite frontend from the same port, with one build.

> **Status:** pre-release (`0.x`). APIs may still change. Packages are not on npm yet — see [Contributing](./CONTRIBUTING.md) to try it from source.
>
> 📖 **[Read the documentation](https://penna-org.github.io/haze/)**

## Highlights

- **Everything in the box** — routing, IoC container, validation, ORM + migrations, auth (JWT / session), authorization (gates & policies), CSRF, rate limiting, cache, queues, scheduler, events, WebSocket, Socket.IO, file storage, mail, AI and test fakes. No glue code, one config style.
- **Hot reload without restarts** — `haze dev` swaps controllers, services, routes and config in place; database pools, Redis connections and sockets survive edits.
- **Full-stack with Vite** — add `haze()` to any Vite project: `/api/**` goes to your backend in dev, `vite build` emits client + server, `vite preview` runs the real build output.
- **Deploy anywhere** — `haze build --preset node | bun | deno | docker | cloudflare | vercel | netlify | aws-lambda`. Native dependencies are traced into `dist/node_modules` (like Nitro), so the output runs on its own.
- **Edge-native drivers** — D1, KV, R2, Queues, Cron Triggers and Durable Objects (WebSocket) on Cloudflare; Turso / libSQL over HTTP; Upstash for serverless Redis.
- **Typed end to end** — config keys, named routes and policy abilities are generated as types; request validation is Standard Schema (valibot, zod, arktype, …).
- **Testing first** — `useTestApp()`, `actingAs(user)`, `refreshDatabase()`, and `fake()` for queues, events, mail and storage.

## Quick start

```bash
pnpm create hazejs my-app            # pick a template interactively
pnpm create hazejs my-app -t api     # backend-only API
pnpm create hazejs my-app -t vue     # Vue 3 full-stack (one repo, one port, one build)
pnpm create hazejs my-app -t react   # React 19 full-stack

cd my-app && pnpm dev
```

Use it in an existing Vite project (Vue, React, Svelte, Solid or plain):

```ts
// vite.config.ts
import { haze } from '@hazejs/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vue(),
    haze(),
  ],
})
```

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({ srcDir: 'server' })
```

## A taste

```ts
// route/api.ts
export default defineRoutes((r) => {
  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    r.resource('/posts', PostController).validateMember({ params: PostIdParams })
    r.post('/auth/login', [AuthController, 'login']).middleware('throttle:10,60')
    r.ws('/ws', ChatSocket)
  })
})

// app/controller/PostController.ts
export class PostController {
  static middleware = [
    {
      use: 'auth',
      except: ['index', 'show']
    }
  ]

  private posts = inject(PostService)

  async update(ctx: HttpContext<{ params: typeof PostIdParams }>) {
    const post = await Post.findOrFail(ctx.validated.params.id)
    await ctx.authorize('update', post) // app/policy/PostPolicy.ts
    return this.posts.update(post, await validate(PostSchema, await ctx.body()))
  }
}

// app/listener/SendWelcomeEmail.ts — runs on the queue, retried on failure
export default defineListener(UserRegistered, async ({ userId }) => {
  const user = await User.findOrFail(userId)
  await Mail.to(user.email).send(WelcomeMail, { name: user.name })
}, {
  queue: { tries: 3 }
})
```

## Features

| Area | What you get |
| --- | --- |
| HTTP | Centralized routes, groups, resources, named routes, domain / prefix sub-apps, reusable modules (local `modules/<name>/` or npm packages with routes, config and migrations), class & function middleware, interceptors, unified response envelope, exception handler with dev error page |
| Validation | Standard Schema (`validate()`, per-route `.validate({ body, query, params })`), typed `ctx.validated`, translated error messages |
| API | OpenAPI 3.1 with Scalar / Swagger UI, typed HTTP client from typegen, API resources, signed URLs; GraphQL via `@hazejs/graphql` |
| Container | `inject()`, singleton / request / transient scopes, service providers, HMR-persistent resources |
| Data | `@hazejs/orm` on drizzle: models, relations, query builder, transactions, soft deletes, migrations, seeders — MySQL, PostgreSQL, SQLite, Turso, D1; MongoDB adapter; full-text search via `@hazejs/search` (database, Meilisearch, Typesense, Elasticsearch / OpenSearch) |
| Security | JWT (jose), session and API token guards, `Hash` (scrypt), `Crypt` (AES-GCM), signed / encrypted cookies, gates & policies, CSRF, CORS, secure headers, rate limiting, email verification, password reset, TOTP 2FA, passkeys, OAuth social login via `@hazejs/oauth` (incl. WeChat, QQ, DingTalk, Feishu, WeCom, Alipay, OIDC) |
| Infrastructure | Cache (memory / Redis / Upstash / KV, atomic locks, response cache), queues (sync / memory / BullMQ / Cloudflare Queues), scheduler (cron, timezones, single-server), events & queued listeners, notifications (mail, database, Slack, webhooks, WeCom / DingTalk / Feishu bots), multi-tenancy, i18n |
| Realtime | WebSocket via crossws (Redis fan-out, Durable Objects on Workers), Socket.IO via `@hazejs/socket.io` (Node & Bun, guard auth, Redis adapter), broadcasting with private / presence channels over WS / SSE / Socket.IO; service-to-service messaging via `@hazejs/microservices` (Redis, NATS, gRPC) |
| Files & mail | Disks: local / S3 (AWS SDK v3, multipart, presigned) / R2 / memory with signed URLs; mail: SMTP / Resend / Postmark / Mailgun / SES, queued sending, layout helpers |
| AI | `@hazejs/ai`: OpenAI, Anthropic, Gemini, Azure, Bedrock, Workers AI and 11 OpenAI-compatible providers with no SDK dependencies — streaming, tool loops, structured output, embeddings & RAG, agents with memory, images, speech, MCP client/server, `useChat` for Vue/React, `AI.fake()` |
| Tooling | `haze` CLI: `dev`, `build`, `preview`, `start`, `test`, `route:list`, `module:list`, `typegen`, `make:*`, `db:*`, `queue:*`, `schedule:*`, `openapi`, `repl`, `key:generate`, and your own commands in `app/command` |
| Observability | Health checks, OpenTelemetry traces and metrics, log channels (file, HTTP, JSON), dev dashboard at `/__haze` with a queue dashboard |
| Deployment | node, bun, deno, docker, cloudflare, vercel, netlify, aws-lambda — with migration and worker entries |

See how this compares with other Node.js frameworks, and what is coming next, in the [roadmap](https://penna-org.github.io/haze/roadmap).

## Packages

| Package | Description |
| --- | --- |
| [`@hazejs/core`](./packages/core) | Runtime: container, routing, middleware, auth, cache, queues, events, WebSocket, storage, mail |
| [`@hazejs/vite`](./packages/vite) | Vite plugin, hot-reloading dev server, build presets and preview |
| [`@hazejs/cli`](./packages/cli) | The `haze` command line |
| [`@hazejs/orm`](./packages/orm) | Models, query builder and migrations on drizzle; MongoDB adapter |
| [`@hazejs/testing`](./packages/testing) | Vitest integration and HTTP test client |
| [`@hazejs/ai`](./packages/ai) | AI toolkit: providers, streaming, tools, structured output, agents, RAG, MCP, `useChat` |
| [`@hazejs/socket.io`](./packages/socketio) | Socket.IO server integration |
| [`@hazejs/oauth`](./packages/oauth) | OAuth / OpenID Connect social login |
| [`@hazejs/search`](./packages/search) | Full-text search for models |
| [`@hazejs/graphql`](./packages/graphql) | GraphQL over HTTP and WebSocket |
| [`@hazejs/microservices`](./packages/microservices) | Messaging between services over Redis, NATS and gRPC |
| [`create-hazejs`](./packages/create) | Project scaffolding (api / vue / react templates) |

## Documentation

- **[Documentation site](https://penna-org.github.io/haze/)** — guides for every module, in English and 简体中文
- [Roadmap & comparison](https://penna-org.github.io/haze/roadmap)
- [Design notes](./docs/design.md) (Chinese, includes per-milestone implementation records)

## Contributing

Issues and pull requests are welcome — please read the [contributing guide](./CONTRIBUTING.md) and our [code of conduct](./CODE_OF_CONDUCT.md). Security issues: see [SECURITY.md](./SECURITY.md).

## License

[MIT](./LICENSE)
