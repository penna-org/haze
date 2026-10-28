# Deployment

`haze build` produces a production bundle for the platform you deploy to. The same project — API-only or [full-stack](./fullstack) — can target long-running servers, containers, serverless functions or Cloudflare Workers by switching the preset.

## Building

```bash
haze build                     # node preset (default)
haze build --preset docker     # or -p docker
haze build --preset cloudflare --minify
```

The preset can also be set in `haze.config.ts`; `--preset` takes precedence:

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  preset: 'cloudflare',
})
```

In full-stack projects `haze build` runs `vite build` with your `vite.config.ts`, building `dist/client` and the server in one go. If you call `vite build` directly, the preset comes from `haze.config.ts` or the `HAZE_PRESET` environment variable.

Other build flags: `--minify` (default off) and `--outDir` (API-only projects; full-stack projects use `outDir` in `haze.config.ts`).

## Presets

| Preset | Output | Run / deploy |
|--------|--------|--------------|
| `node` | `dist/index.mjs` (full-stack: `dist/server/index.mjs` + `dist/client`) | `node dist/index.mjs` or `haze start` |
| `bun` | Same layout as `node` | `bun dist/index.mjs` |
| `deno` | `dist/server/index.mjs` | `deno run -A dist/server/index.mjs` |
| `docker` | `dist/` is the build context: `server/`, `Dockerfile`, runtime `package.json` | `docker build -t app dist` |
| `aws-lambda` | `dist/lambda/` (full-stack: client inside it) | Zip `dist/lambda`, handler `index.handler` |
| `vercel` | `.vercel/output/` (Build Output API) | `vercel deploy --prebuilt` |
| `netlify` | `dist/server/`, `.netlify/v1/functions/haze-server.mjs`, `netlify.toml` | `netlify deploy --build` |
| `cloudflare` | `dist/index.mjs` (single-file Worker) + `dist/wrangler.json` | `npx wrangler deploy -c dist/wrangler.json` |

After each build the CLI prints the exact commands for your project, including migration and worker commands.

For full-stack projects, `node`, `bun`, `deno`, `docker` and `aws-lambda` serve `dist/client` from the same process (with SPA fallback for non-API paths); on `vercel`, `netlify` and `cloudflare` static files are served by the platform's CDN and only the backend prefixes reach your function.

## Environment variables and APP_KEY

`APP_KEY` signs cookies, encrypts sessions, signs JWTs and storage URLs, and must be set in production. Generate one with `haze key:generate`, and keep it secret.

| Preset | How to provide variables |
|--------|--------------------------|
| node / bun / deno | `.env` and `.env.production` are loaded from the working directory at startup (`haze start` runs from the project root). Real environment variables always win. |
| docker | `docker run -e APP_KEY=<key> …` (or your orchestrator's secrets). `.env` is not copied into the image. |
| aws-lambda | Lambda environment variables. |
| vercel | `vercel env add APP_KEY` |
| netlify | `netlify env:set APP_KEY <key>` |
| cloudflare | `npx wrangler secret put APP_KEY -c dist/wrangler.json`; plain values go in `vars`. |

Long-running presets listen on `PORT` (default: the `port` in `haze.config.ts`, else 3000) and `HOST` (default `0.0.0.0`).

## Dependencies

Like Nitro, hazejs bundles every dependency it can. Database drivers, native modules and a few packages that cannot be bundled stay external, and after the build their files are traced (with nf3, the tracer Nitro uses) and copied into the output's `node_modules`. The result is self-contained: you can copy `dist/` to a server and run it without `pnpm install`.

| Preset | Bundled | External packages |
|--------|---------|-------------------|
| node / bun / deno | Everything except drivers | Traced into `node_modules` next to the entry |
| aws-lambda / vercel | Everything except drivers | Always traced |
| docker | Everything except drivers | Installed inside the image (`npm install`), so native binaries match Linux |
| netlify | Everything except drivers | Bundled by Netlify at deploy time |
| cloudflare | Everything | Unsupported drivers are replaced by stubs |

Only drivers your project actually installs are included. Fine-tune this in `haze.config.ts`:

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  externals: {
    traceDeps: ['sharp', 'some-pkg*'], // keep external and trace (a trailing * copies the whole package)
    inline: ['postgres'], // force into the bundle
    // trace: false,                    // node / bun: keep dependencies external and use the project's node_modules
  },
})
```

::: warning Build Lambda and Vercel bundles on Linux
`aws-lambda` and `vercel` run on Linux. If tracing picks up platform-specific native binaries while building on macOS or Windows, the build warns you — build those presets in CI or Docker so the right binaries are copied.
:::

## Production migrations

Migration files are bundled into the output, so production needs neither the source tree nor drizzle-kit.

| Preset | Run migrations |
|--------|----------------|
| node / bun | `node dist/migrate.mjs` (`bun dist/migrate.mjs`); full-stack: `dist/server/migrate.mjs`. Flags: `--connection <name>`, `--all` |
| deno | `deno run -A dist/server/migrate.mjs` |
| docker | `docker run --rm <image> node server/migrate.mjs` |
| aws-lambda | Invoke the same bundle with handler `index.migrate` (event `{ "connection"?, "all"? }`) |
| vercel / netlify | Run `npx haze db:migrate` before the build command, with the production `DATABASE_URL` |
| cloudflare (D1) | `npx wrangler d1 migrations apply <db-name> --remote -c dist/wrangler.json` |
| cloudflare (Turso) | Run `npx haze db:migrate` in CI |

`migrate.mjs` is only generated when the project uses `@hazejs/orm`. See [Database](./database).

## Queue workers, the scheduler and commands

The `node`, `bun`, `deno` and `docker` presets also emit `worker.mjs`:

```bash
node dist/worker.mjs queue                     # consume jobs (default queue: default)
node dist/worker.mjs queue --queue emails,default --concurrency 5 --connection redis
node dist/worker.mjs schedule                  # long-running scheduler
node dist/worker.mjs schedule:run              # run due tasks once (call from system cron every minute)
node dist/worker.mjs command                   # list your commands (app/command)
node dist/worker.mjs command inspire --all     # run one; exits with the command's exit code
```

Workers stop gracefully on `SIGTERM` / `SIGINT`, letting running jobs finish. In full-stack projects (and always with `deno`) the path is `dist/server/worker.mjs`; in Docker, `docker run <image> node server/worker.mjs queue`.

`worker.mjs command` runs the [console commands](./console) in `app/command` without the CLI or the source, which makes it the place for one-off and cron-driven maintenance in production. Serverless and edge presets have no command entry.

On the other platforms scheduled tasks are triggered by the platform: Cron Triggers on Cloudflare, an EventBridge rule on Lambda, Vercel Cron on Vercel. See [Queues](./queues) and [Task Scheduling](./scheduling).

### Microservice listeners {#microservice-listeners}

[Microservice](./microservices) handlers in `app/message` only receive messages while a listener runs. `haze microservice:listen` is a development command: it needs the CLI and the source. In production, either set `autoListen: true` in `config/microservices.ts` so every web instance also listens, or run a dedicated process. The build has no microservice entry of its own; a long-running command works:

```ts
// app/command/ListenMessages.ts — node dist/worker.mjs command listen:messages
import process from 'node:process'
import { defineCommand } from '@hazejs/core'
import { listenMicroservices } from '@hazejs/microservices'

export default defineCommand({
  description: 'Listen for microservice messages',
  async run(_args, { app }) {
    const listener = await listenMicroservices(app)
    await new Promise((resolve) => {
      process.once('SIGTERM', resolve)
      process.once('SIGINT', resolve)
    })
    await listener.close() // stop consuming and let running handlers finish
  },
})
```

Like queue workers, listeners need a long-running process, so they are not available on serverless or edge presets.

## Health checks

Every build serves `/health/live` (liveness, always 200) and `/health` / `/health/ready` (readiness: runs the checks in `config/health.ts` and returns 503 when a critical one fails). They bypass global middleware, so load balancers don't need credentials:

```ts
// config/health.ts
import { cacheCheck, dbCheck, defineHealthConfig } from '@hazejs/core'
import { Db } from '@hazejs/orm'

export default defineHealthConfig({
  checks: { db: dbCheck(Db), cache: cacheCheck() },
})
```

```dockerfile
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3000/health/ready || exit 1
```

Point Kubernetes `livenessProbe` at `/health/live` and `readinessProbe` at `/health/ready`. In production, failure details are logged instead of returned. See [Observability](./observability#health-checks) for the built-in checks and OpenTelemetry setup.

## Previewing a build

```bash
haze build --preset vercel
haze preview          # or pnpm preview; full-stack projects can also use vite preview
```

`haze preview` runs the **build output** for the preset it was built with (recorded in `.haze/build.json`) on port 4173 (`--port`, `--host`, `--open` are available):

| Preset | How it runs |
|--------|-------------|
| node / docker | Starts the output as a process and proxies requests to it (loads `.env` from the project root) |
| bun / deno | Same, using Bun or Deno (Deno can also come from the `deno` npm package) |
| aws-lambda / vercel / netlify | Calls the function handler in-process |
| cloudflare | Runs the Worker in Miniflare (`pnpm add -D miniflare`) |

For `cloudflare`, `vars`, D1, KV and Durable Object bindings are read from `dist/wrangler.json`, values from `.env` / `.env.production` are passed as bindings, local data persists in `.haze/preview`, and D1 migrations are applied automatically. Without Miniflare you can run `npx wrangler dev -c dist/wrangler.json` instead.

## Docker

```bash
haze build --preset docker
docker build -t my-app dist
docker run -p 3000:3000 -e APP_KEY=<key> my-app
```

The generated `dist/Dockerfile` is based on `node:22-slim`. Your code and pure-JS dependencies are already bundled; the runtime `package.json` lists only the external drivers, which are installed inside the image with `npm install --omit=dev` so native binaries are built for Linux. A `.dockerignore` is generated too.

## AWS Lambda

`dist/lambda` contains `index.mjs`, its traced `node_modules` and (for full-stack apps) the client build. Zip the folder and create a function with runtime `nodejs22.x`:

| Handler | Purpose |
|---------|---------|
| `index.handler` | HTTP: API Gateway (HTTP API and REST API), ALB and Function URL events |
| `index.schedule` | Scheduled tasks, triggered by an EventBridge rule `rate(1 minute)` |
| `index.migrate` | Production migrations (only with `@hazejs/orm`) |

All three use the same bundle. WebSocket and Socket.IO are not available on Lambda.

## Vercel

The `vercel` preset writes the [Build Output API](https://vercel.com/docs/build-output-api) layout to `.vercel/output`: static files in `static/`, the server in `functions/__server.func` (Node.js 22) and routing in `config.json`. Deploy it with `vercel deploy --prebuilt`.

If the project has scheduled tasks, a Vercel Cron job calls `/__haze/schedule` every minute. Set `CRON_SECRET` (`vercel env add CRON_SECRET`); requests without `Authorization: Bearer $CRON_SECRET` get a 401. Hobby plans only allow daily crons, so adjust the expression:

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  preset: 'vercel',
  vercel: { cron: '0 3 * * *' },
})
```

## Netlify

The `netlify` preset builds the server to `dist/server` and writes a Netlify Functions (v2) entry at `.netlify/v1/functions/haze-server.mjs`. If there is no `netlify.toml`, one is created with the build command and publish directory; full-stack builds also get a `_redirects` SPA fallback. Deploy with `netlify deploy --build`.

## Cloudflare

The `cloudflare` preset bundles everything into a single `dist/index.mjs` and generates `dist/wrangler.json` with `nodejs_compat` enabled. For full-stack projects, `dist/client` is served by Workers Assets with SPA fallback, and the backend prefixes are routed to the Worker first.

```bash
haze build --preset cloudflare
npx wrangler secret put APP_KEY -c dist/wrangler.json
npx wrangler d1 migrations apply my-db --remote -c dist/wrangler.json   # when using D1
npx wrangler deploy -c dist/wrangler.json
```

### Bindings

Anything in `cloudflare.wrangler` is merged into the generated `wrangler.json`, so this is where D1, KV, R2, Queues, vars and routes go:

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  preset: 'cloudflare',
  cloudflare: {
    wrangler: {
      vars: { DB_DRIVER: 'd1', CACHE_STORE: 'kv', QUEUE_CONNECTION: 'cloudflare' },
      d1_databases: [
        { binding: 'DB', database_name: 'my-db', database_id: '<id>' },
      ],
      kv_namespaces: [
        { binding: 'CACHE', id: '<id>' },
      ],
      r2_buckets: [
        { binding: 'BUCKET', bucket_name: 'my-bucket' },
      ],
      queues: {
        producers: [{ binding: 'QUEUE', queue: 'jobs' }],
        consumers: [{ queue: 'jobs' }],
      },
    },
  },
})
```

Each driver reads its binding by name:

| Feature | Config | Default binding |
|---------|--------|-----------------|
| Database | `{ driver: 'd1', binding: 'DB' }` in `config/database.ts`, or `turso` over HTTP | `DB` |
| Cache | `{ driver: 'kv', binding: 'CACHE' }` in `config/cache.ts` | `CACHE` |
| Storage | `{ driver: 'r2', binding: 'BUCKET' }` in `config/filesystem.ts` | `BUCKET` |
| Queues | `{ driver: 'cloudflare', binding: 'QUEUE' }` in `config/queue.ts` | `QUEUE` |

The project templates already contain the `kv` cache store and `cloudflare` queue connection as commented-out entries — uncomment them before switching `CACHE_STORE` / `QUEUE_CONNECTION`. The `vars` above only take effect if your config files read them. A common pattern for the database is SQLite locally and D1 on Workers:

```ts
// config/database.ts
import { env } from '@hazejs/core'
import { defineDatabaseConfig } from '@hazejs/orm'

export default defineDatabaseConfig(() => ({
  default: 'main',
  connections: {
    main: env('DB_DRIVER', 'sqlite') === 'd1'
      ? { driver: 'd1', binding: 'DB' }
      : { driver: 'sqlite', url: env('DATABASE_URL', 'file:./data/app.db') },
    // Turso: { driver: 'turso', url: env('DATABASE_URL'), authToken: env('DATABASE_AUTH_TOKEN') }
  },
}))
```

D1 databases without `migrations_dir` use the `migrations/` folder copied into `dist/`. D1 does not support interactive transactions — use `(await Db.drizzle()).batch([...])` for atomic writes.

The generated Worker also wires up the rest of the platform:

- **Queues** — the Worker exports `queue()`, which consumes Cloudflare Queues batches; failed jobs are retried with `message.retry({ delaySeconds })`.
- **Cron Triggers** — when the project has scheduled tasks, `triggers.crons` is set to every minute (unless you set `triggers` yourself) and `scheduled()` runs the due tasks.
- **Durable Objects** — when routes use `r.ws()` (or `cloudflare.websocket: true`), a `HazeWebSocket` Durable Object and its migration are added; all WebSocket connections live in it so `Socket.publish` reaches everyone. See [WebSocket](./websocket).

### Environment and platform bindings

Workers have no `.env`. Before handling each request, the entry calls `setPlatformBindings(env)` so drivers can look up bindings, and on the first request it copies string bindings (vars and secrets) into `process.env`, so `env('APP_KEY')` works as usual. Read a binding in your own code with `usePlatformBinding()` (`setPlatformBindings()` is exported too, for custom entries and tests):

```ts
// app/service/ImageService.ts
import { usePlatformBinding } from '@hazejs/core'

export class ImageService {
  images() {
    return usePlatformBinding<{ fetch: typeof fetch }>('IMAGES')
  }
}
```

### Unsupported drivers

Packages that need TCP sockets or native code cannot run on Workers. They are replaced at build time with modules that throw when used: `ioredis`, `bullmq`, `mysql2`, `mongodb`, `libsql`, `@electric-sql/pglite`, `nodemailer`, `socket.io`, `@socket.io/bun-engine` and `@socket.io/redis-adapter`. Use the edge-friendly alternatives instead: D1 or Turso for the database, KV or Upstash for cache, Cloudflare Queues, an HTTP [mail](./mail) driver, R2 for [storage](./storage), and `r.ws()` instead of Socket.IO.
