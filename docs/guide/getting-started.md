# Getting Started

This guide creates a new hazejs project, runs it, and walks through adding your first route and controller.

::: warning Pre-release
hazejs is in `0.x`. The `@hazejs/*` packages are published on npm, but APIs may still change between minor versions until `1.0` — check the [changelog](https://github.com/penna-org/haze/releases) when upgrading.
:::

## Prerequisites

- **Node.js 22.12 or later** (required by Vite 8).
- **pnpm** is recommended. npm and yarn work too.

## Create a project

::: code-group

```sh [pnpm]
pnpm create hazejs my-app
```

```sh [npm]
npm create hazejs@latest my-app
```

```sh [yarn]
yarn create hazejs my-app
```

:::

Without a `-t` flag you are asked for a template interactively. Pass it explicitly to skip the prompt:

```sh
pnpm create hazejs my-app -t api     # backend-only API
pnpm create hazejs my-app -t vue     # Vue 3 full-stack
pnpm create hazejs my-app -t react   # React 19 full-stack
```

::: tip
With npm, separate the flags from the package name: `npm create hazejs@latest my-app -- -t vue`.
:::

| Template | What you get |
| --- | --- |
| `api` | A backend-only service. Code lives at the project root (`app/`, `config/`, `route/`). |
| `vue` | Vue 3 + hazejs in one repository, one port and one build. The backend lives in `server/`. |
| `react` | The same full-stack setup with React 19. |

In non-interactive environments (CI, no TTY) the `api` template is used by default. Pass `--force` to scaffold into a non-empty directory (its contents are removed first).

The scaffolder:

- copies the template and sets the `name` in `package.json` from the directory name;
- writes a fresh, random `APP_KEY` into `.env` — it signs cookies, encrypts sessions and is the default JWT secret;
- adds a `pnpm-workspace.yaml` that declares how dependency build scripts are handled (pnpm 11 requires it), unless the project is created inside an existing pnpm workspace.

It does **not** install dependencies. Do that next:

```sh
cd my-app
pnpm install
```

## What's inside

The `api` template is a complete, working example — not an empty shell. It includes:

- `GET /api/hello` and `POST /api/hello` with request validation;
- a `users` resource backed by a SQLite database and a `User` model, shaped by an [API resource](./resources) (`app/resource/UserResource.ts`) that shows the email only to the user and admins;
- JWT registration, login and `/api/auth/me`, with a policy that lets users edit only their own profile;
- account endpoints under `/api/auth`: [personal access tokens](./api-tokens) (`/tokens`), email verification, password reset, and [GitHub login](./oauth) that turns on once `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` are set in `.env` (`config/oauth.ts`, `@hazejs/oauth`);
- a streaming [AI](./ai) chat endpoint, `POST /api/chat` (`config/ai.ts`);
- an event, listeners, a queued job, a mail and a scheduled task;
- a [notification](./notifications) (`WelcomeNotification`, sent by mail and broadcast) and a private [broadcast channel](./broadcasting) for each user (`app/channel/user.ts`);
- translations in `lang/en` and `lang/zh-CN` with `config/i18n.ts`, so the welcome mail, validation errors and framework messages follow the request's language ([Localization](./localization));
- an example console command, `haze inspire` (`app/command/Inspire.ts`);
- a WebSocket route at `/api/ws`;
- tests for all of the above.

The full-stack templates add a Vue or React frontend in `src/` (including an AI chat component) and a Socket.IO namespace. See [Directory Structure](./directory-structure) for a tour of every folder.

## Run it

The template uses SQLite (`data/app.db`). Create the tables once before the first run, then start the dev server:

```sh
pnpm db:migrate
pnpm dev
```

The `api` template listens on `http://localhost:3000`:

```sh
curl localhost:3000/api/hello
# {"code":0,"message":"ok","data":{"app":"my-app","message":"Hello, hazejs!"}}
```

Full-stack projects run through Vite instead, on Vite's port (`http://localhost:5173` by default) — the page and `/api/**` share it. See [Full-stack with Vite](./fullstack).

A few pages come with no setup. In development, `/__haze` opens the [dev dashboard](./observability#dev-dashboard) (requests, queries, jobs, mail, logs) and `/docs` shows the [OpenAPI](./openapi) docs generated from your routes; `/health` answers [health checks](./observability#health-checks) in every mode. In full-stack projects the Vite dev server only passes `/api/**` and `/__haze` to the backend, so move the OpenAPI paths (`path` and `docsPath` in `config/openapi.ts`) and the health path (`config/health.ts`) under `/api` if you need them there.

Edit any controller, service, route or config file and the change is live on the next request. The process does not restart; the terminal prints a `reloaded` line instead.

## Your first route and controller

Generate a service and a controller:

```sh
npx haze make:service Post      # app/service/PostService.ts
npx haze make:controller Post   # app/controller/PostController.ts
```

The service holds business logic and knows nothing about HTTP:

```ts
// app/service/PostService.ts
export class PostService {
  private posts = [
    { id: 1, title: 'Hello hazejs' },
    { id: 2, title: 'Second post' },
  ]

  all() {
    return this.posts
  }

  find(id: number) {
    return this.posts.find(post => post.id === id)
  }
}
```

The controller receives the request, calls the service through `inject()`, and returns plain data:

```ts
// app/controller/PostController.ts
import type { HttpContext } from '@hazejs/core'
import { inject, NotFoundException } from '@hazejs/core'
import { PostService } from '~/app/service/PostService'

export class PostController {
  private posts = inject(PostService)

  index() {
    return this.posts.all()
  }

  show(ctx: HttpContext) {
    const post = this.posts.find(Number(ctx.param('id')))
    if (!post)
      throw new NotFoundException(`Post ${ctx.param('id')} not found`)
    return post
  }
}
```

`~` is an alias for the backend source directory, so imports stay the same wherever a file lives. Routes are not discovered from controllers — register them in `route/api.ts`, inside the existing `/api` group:

```ts
// route/api.ts
import { PostController } from '~/app/controller/PostController'

export default defineRoutes((r) => {
  r.group({ prefix: '/api', as: 'api.' }, (r) => {
    // ...existing routes
    r.get('/posts', [PostController, 'index']).name('posts.index')
    r.get('/posts/:id', [PostController, 'show']).name('posts.show')
  })
})
```

Save, and try it:

```sh
curl localhost:3000/api/posts/1
# {"code":0,"message":"ok","data":{"id":1,"title":"Hello hazejs"}}

curl localhost:3000/api/posts/9
# 404, rendered by the exception handler in the same envelope
```

Run `pnpm routes` to see the new entries in the route table. Because the routes are named, `router.url('api.posts.show', { id: 1 })` is type-checked once types are generated (the dev server does this automatically).

### Add a test

```sh
npx haze make:test post   # tests/post.test.ts
```

```ts
// tests/post.test.ts
import { useTestApp } from '@hazejs/testing'
import { describe, expect, it } from 'vitest'

const t = useTestApp()

describe('posts', () => {
  it('shows a post', async () => {
    const res = await t.get('/api/posts/1')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ id: 1, title: 'Hello hazejs' })
  })
})
```

```sh
pnpm test
```

Tests boot the real application in-process — no port is opened. See [Testing](./testing).

## Package scripts

Every template ships with these scripts:

| Script | Command | Purpose |
| --- | --- | --- |
| `dev` | `haze dev` | Dev server with in-place hot reload |
| `build` | `haze build` | Production build (`dist/`) |
| `start` | `haze start` | Run the production build |
| `preview` | `haze preview` | Run the build locally with its deployment preset |
| `queue` | `haze queue:work` | Consume queued jobs |
| `schedule` | `haze schedule:work` | Run scheduled tasks every minute |
| `test` | `haze test` | Run Vitest |
| `routes` | `haze route:list` | Print the route table |
| `typecheck` | `tsc --noEmit` | Type check (`vue-tsc --build` / `tsc --build` in full-stack templates) |
| `typegen` | `haze typegen` | Generate types for config keys, routes, abilities and translation keys, plus the route list for the typed client |
| `db:generate` | `haze db:generate` | Generate a migration from schema changes |
| `db:migrate` | `haze db:migrate` | Run pending migrations |
| `db:seed` | `haze db:seed` | Run seeders |

Extra flags are passed through, for example `pnpm db:generate --name create_posts`. The [CLI Reference](./cli) documents every command.

## Next steps

- [Directory Structure](./directory-structure) — what each folder is for
- [Configuration](./configuration) — `config/*.ts`, `.env` and `haze.config.ts`
- [Routing](./routing) and [Controllers](./controllers) — the HTTP layer in depth
- [Database](./database) — schemas, migrations and models
- [API Resources](./resources) and [OpenAPI](./openapi) — shape responses, document the API and call it from a typed client
- [Authentication](./authentication), [API Tokens](./api-tokens), [Two-Factor & Passkeys](./two-factor) and [OAuth Social Login](./oauth) — the account features the template starts with
- [Notifications](./notifications) and [Broadcasting](./broadcasting) — reach users by mail, chat apps and realtime channels
- [Localization](./localization) — translations and per-request language
- [Console Commands](./console) — your own `haze` commands and the REPL
- [Observability](./observability) — health checks, OpenTelemetry and the dev dashboard
- [Testing](./testing) — the test client and fakes
- [Deployment](./deployment) — build for Node, Docker, serverless or the edge
