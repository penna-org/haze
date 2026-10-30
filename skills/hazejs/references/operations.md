# Operations: CLI, configuration, layout, full-stack, deployment, observability

How to run, configure, build and ship a hazejs app. Snippets use the API-template layout (`config/*.ts`, `app/...`, `route/*.ts`, `~/` = backend `srcDir`). In vue/react projects the backend lives under `server/`.

## The `haze` CLI

Full guide: [cli.md](../../../docs/guide/cli.md). From `@hazejs/cli` (dev dependency). Run via package scripts (`pnpm dev`) or `npx haze <command>`. Every command accepts `--root <dir>`; `npx haze --help` lists built-ins plus your own commands.

Commands that need the app (`route:list`, `module:list`, `typegen`, `openapi`, `repl`, `db:*`, `queue:*`, `schedule:*`, `search:*`, `microservice:listen`, custom commands) boot it inside the Vite module graph without opening a port and run TypeScript source directly — no build needed.

### Run and build

| Command | What it does | Options |
| --- | --- | --- |
| `haze dev` | Dev server; changes apply on the next request, no restart. Uses `vite.config.*` if present (full-stack) | `--port/-p` (PORT → `haze.config.ts` `port` → 3000), `--host` |
| `haze build` | Production build, `NODE_ENV=production` | `--preset/-p` (`node` `bun` `deno` `docker` `cloudflare` `vercel` `netlify` `aws-lambda`), `--outDir`, `--minify` (backend-only projects) |
| `haze start` | Runs `dist/index.mjs` (or `dist/server/index.mjs` full-stack), `NODE_ENV=production`, loads `.env` from project root | `--port/-p`, `--host` |
| `haze preview` | Runs the built output the way its preset runs (process / in-process function / Miniflare) | `--port/-p` (4173), `--host`, `--open` |
| `haze test` | Vitest with `NODE_ENV=test`; no args → `vitest run`; args replace `run` | e.g. `haze test --watch`, `haze test run tests/user` |

### Inspect and set up

| Command | What it does | Options |
| --- | --- | --- |
| `haze route:list` | Routes with method, path, name, handler, middleware | `--json` |
| `haze module:list` | Enabled modules in enable order | `--json` |
| `haze typegen` | Writes `.haze/types/haze.d.ts`, `.haze/types/i18n.d.ts`, `.haze/routes.ts` | — |
| `haze openapi` | Prints the OpenAPI 3.1 document (docs need not be enabled) | `--output/-o openapi.json` |
| `haze repl` | Shell with booted app, `config`, `inject`, facades, `Db`, models; top-level await | `--eval/-e "<code>"` |
| `haze key:generate` | Writes a 256-bit `APP_KEY` to `.env` (exit 1 if one exists) | `--force`, `--show` |
| `haze stub:publish` | Copies generator stubs to `stubs/` | `--force` |

### Generators (`haze make:<type> <name>`)

Paths are relative to `srcDir` (tests go to root `tests/`). Common options: `--force`, `--app/-a <app>` (multi-app), `--module/-m <module>` (local module). Names are normalized (`user`, `User`, `UserController` → `UserController`) and may include subdirectories, except for auto-discovered kinds (`interceptor`, `event`, `listener`, `job`, `policy`, `notification`, `channel`, `config`, `route`, `seeder`).

| Command | Generates |
| --- | --- |
| `make:controller User [-r]` | `app/controller/UserController.ts` (`--resource` = REST methods) |
| `make:service` / `make:repository` | `app/service/UserService.ts` / `app/repository/UserRepository.ts` |
| `make:model Post [--table --dialect --soft-delete]` | `app/model/Post.ts` + `database/schema/posts.ts` |
| `make:middleware` / `make:interceptor` / `make:provider` | `app/middleware/…`, `app/interceptor/…`, `app/provider/…Provider.ts` |
| `make:event` / `make:listener` / `make:job` | `app/event/…`, `app/listener/…`, `app/job/…` |
| `make:policy` / `make:validate` / `make:resource` | `app/policy/…Policy.ts`, `app/validate/user.ts` (valibot, or zod if only zod installed), `app/resource/…Resource.ts` |
| `make:command SendReport` | `app/command/SendReport.ts` → runs as `haze send:report` |
| `make:mail` / `make:notification` / `make:channel` | `app/mail/…Mail.ts`, `app/notification/…Notification.ts`, `app/channel/order.ts` |
| `make:view Home` | `app/view/Home.tsx` |
| `make:config payment` / `make:route admin` | `config/payment.ts` / `route/admin.ts` |
| `make:seeder` / `make:factory` / `make:test` | `database/seeders/…`, `database/factories/…Factory.ts`, `tests/….test.ts` |
| `make:notifications-table`, `make:auth-tables`, `make:queue-tables` | schema files in `database/schema/` (`--dialect`, `--force`; `make:queue-tables --no-generate`) |
| `make:module blog` | `modules/blog/` skeleton |

### Database, queues, scheduler, search, microservices

| Command | Notes |
| --- | --- |
| `haze db:generate` | drizzle-kit migration from `database/schema/*.ts`; `--connection/-c`, `--module/-m`, `--name`, `--custom` |
| `haze db:migrate` | Run pending migrations (module migrations first); `--connection/-c`, `--all` |
| `haze db:seed` | Run `database/seeders` in file-name order; `--file <name>` |
| `haze queue:work` | Consume jobs; `--connection`, `--queue/-q a,b` (priority order), `--concurrency/-c` (1). Job edits apply without restart |
| `haze queue:failed` / `queue:retry [id]` / `queue:forget <id>` / `queue:flush` | Failed-job management; each accepts `--connection` |
| `haze schedule:list` / `schedule:run` / `schedule:work` | List; run due tasks once (system cron every minute, exit 1 on failure); long-running loop |
| `haze search:import <Model>` / `search:flush <Model>` / `search:sync-settings [Model]` | `@hazejs/search`; `search:import --chunk` |
| `haze microservice:listen` | `--transport/-t nats,grpc`; dev only (no production entry) |
| `haze down` / `haze up` / `haze maintenance:status` | Maintenance mode (see below) |

Custom commands: every file in `app/command/**` that default-exports `defineCommand()` — `app/command/db/Cleanup.ts` runs as `haze db:cleanup`.

## Configuration

Full guide: [configuration.md](../../../docs/guide/configuration.md)

Two kinds: **application config** in `config/*.ts` (runtime, `config('app.name')`) and **toolchain config** in `haze.config.ts` (CLI + Vite plugin).

```ts
// config/app.ts — file name = config key; deep-merged over framework defaults
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  trustProxy: true,   // behind a trusted proxy/load balancer
}))
```

Typed helpers per file: `defineAuthConfig`, `defineCacheConfig`, `defineCorsConfig`, `defineCsrfConfig`, `defineFilesystemConfig`, `defineHealthConfig`, `defineHttpConfig`, `defineI18nConfig`, `defineMailConfig`, `defineMaintenanceConfig`, `defineMiddlewareConfig`, `defineObservabilityConfig`, `defineOpenAPIConfig`, `defineQueueConfig`, `defineRedisConfig`, `defineScheduleConfig`, `defineSecureHeadersConfig`, `defineSessionConfig`, `defineTenancyConfig`, `defineThrottleConfig`, `defineWebSocketConfig` (all `@hazejs/core`); `defineDatabaseConfig` (`@hazejs/orm`), `defineAIConfig`, `defineGraphQLConfig`, `defineMicroservicesConfig`, `defineSearchConfig`, `defineOAuthConfig`, `defineSocketIOConfig` from their packages. `config/logger.ts` and your own files use `defineConfig`.

**Use the function form whenever you call `env()`** — config modules are imported before boot; the function runs after `.env` is loaded.

```ts
env('APP_NAME', 'my-app')   // string
env('PORT', 3000)           // number (falls back if not numeric)
env('DB_LOGGING', false)    // boolean: true/1/yes/on vs false/0/no/off/''
env('APP_URL')              // string | undefined
```

`.env` load order (later wins; real env vars always win): `.env` → `.env.local` (**skipped in test mode**) → `.env.[mode]` → `.env.[mode].local`. Mode from `NODE_ENV`: `production`/`test` as-is, anything else `development`. Files load from the project root (in production: the process cwd; `haze start` switches to the root).

```ts
import { config, Config, inject } from '@hazejs/core'

config('app.name'); config('payment.retries', 3)
class X { private config = inject(Config) }   // .get/.has/.set/.all; ctx.config in requests
```

Generated types (`haze dev` or `haze typegen` → `.haze/types/haze.d.ts`): config keys, named routes, policy abilities; once generated, unknown keys are type errors (reading an unknown key needs a default). Keep `.haze/types/**/*.d.ts` in `tsconfig.json` `include`.

`config/app.ts` options: `name`, `debug` (true in dev), `url` (`APP_URL`), `key` (`APP_KEY`), `previousKeys` (`APP_PREVIOUS_KEYS`), `bodyLimit` (`'1mb'`), `trustProxy` (false), `cookie`, `requestIdHeader` (`'x-request-id'` or `false`), `response` (envelope), `apps` (multi-app).

```ts
// haze.config.ts — all optional
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  srcDir: '.',        // 'server' in vue/react templates
  port: 3000,         // PORT wins
  preset: 'node',     // haze build --preset overrides
  // outDir: 'dist', host, typegen: true, cloudflare: { wrangler, websocket }, vercel: { cron },
  // externals: { trace, traceDeps, inline }, vite: { ... } (backend-only projects)
})
```

## Project layout

Full guide: [directory-structure.md](../../../docs/guide/directory-structure.md)

| | `api` template | `vue` / `react` templates |
| --- | --- | --- |
| Backend source (`srcDir`) | project root (`app/`, `config/`, `route/`, `database/`, `lang/`, `schedule/`) | `server/` (same folders, plus `app/socket/`) |
| Frontend | — (`app/view` TSX views) | `src/` (`api.ts` with CSRF flow, `socket.ts`, AI chat component) |
| Vite config | none (`vite` option in `haze.config.ts`) | `vite.config.ts` with `haze()` |
| tsconfig | `tsconfig.json` | `tsconfig.app.json` (frontend) + `tsconfig.server.json` (backend, `~/*` → `./server/*`) |
| Typecheck script | `tsc --noEmit` | `vue-tsc --build` / `tsc --build` |

Always at the project root regardless of `srcDir`: `.env*`, `tests/`, `stubs/`, `.haze/`, `dist/`, `data/`, `storage/`. `~/` always resolves to `srcDir`.

Auto-discovered (first level only, except `app/command/**` and `lang/**`): `config/*.ts`, `route/*.ts`, `app/provider/*.ts`, `app/exception/Handler.ts`, `app/response/Formatter.ts`, `app/interceptor/*`, `app/policy/*`, `app/job/*`, `app/event/*`, `app/listener/*`, `app/notification/*`, `app/channel/*`, `app/message/*`, `app/socket/*`, `schedule/*.ts`, `app/view/**/*.tsx`, `modules/<name>/…`. **Not** discovered: controllers (routes reference them), services, models, middleware (alias in `config/middleware.ts`), mail, resources. Adding/deleting a discovered file in dev regenerates the manifest — no restart.

Template scripts: `dev`, `build`, `start`, `preview`, `queue` (`haze queue:work`), `schedule` (`haze schedule:work`), `test`, `routes` (`haze route:list`), `typecheck`, `typegen`, `db:generate`, `db:migrate`, `db:seed`. First run: `pnpm install && pnpm db:migrate && pnpm dev`.

## Full-stack with Vite (`@hazejs/vite`)

Full guide: [fullstack.md](../../../docs/guide/fullstack.md)

```ts
// vite.config.ts
import { haze } from '@hazejs/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [vue(), haze()],            // haze({ prefix: ['/api', '/webhooks'] }) for several prefixes
})
```

| `haze()` option | Default |
| --- | --- |
| `prefix` | `'/api'` (string or array) |
| `srcDir` | from `haze.config.ts`, else `.` (passing it here stops `haze.config.ts` from being read) |
| `alias` | `'~'` (`false` disables) |
| `port`, `host`, `outDir`, `typegen`, `cloudflare`, `vercel`, `externals` | from `haze.config.ts` |
| `preset` | `HAZE_PRESET`, then `haze.config.ts`, else `node` |

- **Dev**: one server on Vite's port (5173). Paths matching the prefixes and `/__haze` go to the backend before Vite's middleware; everything else is Vite. Same origin: no proxy, no CORS. The prefix is **not stripped** — define routes with it (`r.group({ prefix: '/api' }, …)`).
- **Env**: both sides read the same `.env`; only `VITE_*` reach the browser.
- **CSRF**: templates enable `csrf` globally and add `GET /api/csrf-cookie`; `src/api.ts` echoes `XSRF-TOKEN` as `X-XSRF-TOKEN`.
- **Realtime**: `r.ws('/api/ws', …)` shares the port; Socket.IO attaches at `/socket.io/`.
- **Build**: `haze build` (= `vite build`) produces `dist/client` + `dist/server/{index,migrate,worker}.mjs` + traced `node_modules`. Build metadata in `.haze/build.json`.
- **Production (`node`)**: one process serves the prefixes from the app, other GET/HEAD from `dist/client` (`/assets/*` immutable, HTML `no-cache`, SPA fallback for HTML requests, never for API paths). Global middleware (`secureHeaders`, `cors`) also runs for static files. On `vercel`/`netlify`/`cloudflare` the CDN serves the client and only the prefixes reach the function.
- **Tests**: `vitest.config.ts` uses `defineHazeTestConfig` from `@hazejs/testing/config` (backend only).

## Deployment

Full guide: [deployment.md](../../../docs/guide/deployment.md)

```bash
haze build                          # node (default)
haze build --preset docker          # or preset in haze.config.ts; HAZE_PRESET for raw `vite build`
haze build --preset cloudflare --minify
```

| Preset | Output | Run / deploy |
| --- | --- | --- |
| `node` | `dist/index.mjs` (full-stack: `dist/server/index.mjs` + `dist/client`) | `node dist/index.mjs` or `haze start` |
| `bun` | same as node | `bun dist/index.mjs` |
| `deno` | `dist/server/index.mjs` | `deno run -A dist/server/index.mjs` |
| `docker` | `dist/` = build context: `server/`, `Dockerfile` (node:22-slim), runtime `package.json`, `.dockerignore` | `docker build -t app dist` |
| `aws-lambda` | `dist/lambda/` | zip it; handlers `index.handler` (HTTP), `index.schedule` (EventBridge `rate(1 minute)`), `index.migrate` |
| `vercel` | `.vercel/output/` (Build Output API) | `vercel deploy --prebuilt` |
| `netlify` | `dist/server/`, `.netlify/v1/functions/haze-server.mjs`, `netlify.toml` | `netlify deploy --build` |
| `cloudflare` | single-file `dist/index.mjs` + `dist/wrangler.json` (`nodejs_compat`) | `npx wrangler deploy -c dist/wrangler.json` |

Long-running presets listen on `PORT` (default `haze.config.ts` `port`, else 3000) and `HOST` (default `0.0.0.0`). Dependencies are bundled; DB drivers/native modules are traced into `node_modules` next to the entry, so `dist/` is self-contained (docker installs externals inside the image; cloudflare stubs unsupported ones). Build `aws-lambda`/`vercel` on Linux (CI/Docker) for correct native binaries.

**Secrets / env**: node/bun/deno load `.env` + `.env.production` from cwd; docker `-e APP_KEY=…` (`.env` is not copied); Lambda env vars; `vercel env add APP_KEY`; `netlify env:set APP_KEY …`; `npx wrangler secret put APP_KEY -c dist/wrangler.json`.

### Production migrations, workers, commands

| Preset | Migrations |
| --- | --- |
| node / bun | `node dist/migrate.mjs [--connection <name>] [--all]` (full-stack: `dist/server/migrate.mjs`) |
| deno | `deno run -A dist/server/migrate.mjs` |
| docker | `docker run --rm <image> node server/migrate.mjs` |
| aws-lambda | invoke handler `index.migrate` with `{ "connection"?, "all"? }` |
| vercel / netlify | `npx haze db:migrate` before the build, with production `DATABASE_URL` |
| cloudflare | D1: `npx wrangler d1 migrations apply <db> --remote -c dist/wrangler.json`; Turso: `haze db:migrate` in CI |

`migrate.mjs` exists only when the project uses `@hazejs/orm`. Process presets (`node`, `bun`, `deno`, `docker`) also emit `worker.mjs`:

```bash
node dist/worker.mjs queue --queue emails,default --concurrency 5 --connection redis
node dist/worker.mjs schedule              # long-running scheduler
node dist/worker.mjs schedule:run          # once (system cron each minute)
node dist/worker.mjs command inspire --all # app/command; `command` alone lists them
node dist/worker.mjs down --secret=deploy-2026 --retry=60
node dist/worker.mjs up
node dist/worker.mjs maintenance:status
```

Full-stack projects and `deno`/`docker` put these in `dist/server/`. Serverless/edge presets have no `worker.mjs`; schedules run via Cloudflare Cron Triggers, EventBridge (Lambda) or Vercel Cron (`/__haze/schedule`, needs `CRON_SECRET`; `vercel: { cron: '0 3 * * *' }` for Hobby). Microservice listeners: `autoListen: true` or a long-running custom command calling `listenMicroservices(app)`.

### Cloudflare

```ts
// haze.config.ts — merged into dist/wrangler.json
export default defineHazeConfig({
  preset: 'cloudflare',
  cloudflare: {
    wrangler: {
      vars: { DB_DRIVER: 'd1', CACHE_STORE: 'kv', QUEUE_CONNECTION: 'cloudflare' },
      d1_databases: [{ binding: 'DB', database_name: 'my-db', database_id: '<id>' }],
      kv_namespaces: [{ binding: 'CACHE', id: '<id>' }],
      r2_buckets: [{ binding: 'BUCKET', bucket_name: 'my-bucket' }],
      queues: { producers: [{ binding: 'QUEUE', queue: 'jobs' }], consumers: [{ queue: 'jobs' }] },
    },
  },
})
```

Drivers read bindings by name: DB `{ driver: 'd1', binding: 'DB' }`, cache `{ driver: 'kv', binding: 'CACHE' }`, storage `{ driver: 'r2', binding: 'BUCKET' }`, queue `{ driver: 'cloudflare', binding: 'QUEUE' }`. String bindings are copied into `process.env` on the first request; read others with `usePlatformBinding('NAME')`. `r.ws()` routes get a `HazeWebSocket` Durable Object. Stubbed (throw when used): `ioredis`, `bullmq`, `mysql2`, `mongodb`, `libsql`, `@electric-sql/pglite`, `nodemailer`, `socket.io` and its adapters — use D1/Turso, KV/Upstash, Cloudflare Queues, an HTTP mail driver, R2, `r.ws()`. D1 has no interactive transactions (`(await Db.drizzle()).batch([...])`).

## Graceful shutdown and hot reload

- `app.serve()` (the `node`/`bun`/`deno`/`docker` entry) handles `SIGINT`/`SIGTERM`: stop listening and wait for in-flight requests, then `app.dispose()`, then exit.
- `dispose()` calls each provider's `shutdown(app)` in reverse order, closes queue connections and mail transports, disposes the container, flushes and closes log channels (`http`/`file`), and closes shared Redis/persistent connections.
- `worker.mjs queue` stops reserving and waits for running jobs on `SIGTERM`/`SIGINT`.
- Flush external SDKs (e.g. OpenTelemetry `sdk.shutdown()`) from a provider's `shutdown()` hook — the process exits right after disposing.

```ts
// app/provider/TelemetryProvider.ts
import { defineProvider } from '@hazejs/core'

export default defineProvider({
  async shutdown() { await flushMetrics() },
})
```

Hot reload in dev: editing anything under `srcDir` (including `config/` and views) or a `.env` file rebuilds the app and swaps it in place; the terminal prints `reloaded in …`. The old app is disposed (`reason: 'hmr'`) after its in-flight requests finish, so provider `shutdown()` runs on every reload, while shared Redis connections survive. If the new version fails to load, the previous one keeps serving. `queue:work` and `schedule:work` pick up job/schedule edits without restarting. Frontend changes use Vite HMR and do not reload the backend.

## Maintenance mode

Full guide: [maintenance.md](../../../docs/guide/maintenance.md)

```bash
npx haze down --secret=let-me-in --retry=60   # visiting /let-me-in sets a bypass cookie
npx haze down --with-secret --render=Maintenance --except=/api/webhooks/*,/status
npx haze up
```

| `haze down` flag | Meaning |
| --- | --- |
| `--secret` / `--with-secret` | Bypass secret (letters, digits, `-`, `_`) / generate and print one |
| `--retry` | `Retry-After` seconds (60) |
| `--refresh` | `Refresh` header seconds |
| `--status` | Status code (503) |
| `--redirect` | Redirect browser requests to a path |
| `--render` | View in `app/view` instead of the built-in page (props `{ status, title, message, lang, retry, refresh, state }`) |
| `--except` | Comma-separated pass-through paths, `*` wildcard |
| `--message` | Message or translation key |

```ts
// config/maintenance.ts
import { defineMaintenanceConfig } from '@hazejs/core'

export default defineMaintenanceConfig({
  driver: 'cache',   // or 'file' (storage/framework/down)
  store: 'redis',    // shared store → one command takes down every instance
  // key, interval (2000 ms), except, pauseWorkers (true), workerSleep, cookie, bypassTtl (43200 s)
})
```

Running servers, workers and the scheduler notice within `interval` (2 s), no restart. Still served while down: `except` paths, `/health*`, `/__haze` (dev), and requests with a valid bypass cookie. JSON clients and every `/api` path get the error envelope; browsers get the HTML page. Queue workers pause between jobs; scheduled tasks are skipped. In code: `Maintenance.down({ withSecret: true })`, `Maintenance.isDown()`, `Maintenance.up()`; events `MaintenanceModeEnabled` / `MaintenanceModeDisabled`.

## Observability

Full guides: [observability.md](../../../docs/guide/observability.md), [errors.md](../../../docs/guide/errors.md)

### Health checks (on by default, every mode)

```ts
// config/health.ts
import { cacheCheck, dbCheck, defineHealthConfig, queueCheck, redisCheck, storageCheck } from '@hazejs/core'
import { Db } from '@hazejs/orm'

export default defineHealthConfig({
  timeout: 3000,                 // per check (default 5000)
  cache: 5000,                   // reuse readiness result for 5 s
  checks: {
    db: dbCheck(Db),
    cache: cacheCheck(),
    redis: redisCheck(),         // PING default connection
    storage: { check: storageCheck('s3'), critical: false },
    queue: queueCheck({ connection: 'redis', maxFailed: 100 }),
    payments: async ({ signal }) => (await fetch('https://status.example.com', { signal })).ok,
  },
  // path: '/health', enabled, verbose
})
```

| Endpoint | Response |
| --- | --- |
| `GET /health/live` | always `200 { "status": "ok" }` (liveness) |
| `GET /health`, `GET /health/ready` | runs checks in parallel: `200` ok/degraded, `503` when a critical check fails |

Served before global middleware (no auth/CSRF/throttle, no envelope). A check passes on nothing/`true`/string, fails on `false`/throw, or returns `{ status: 'degraded', message }`. Production hides error details (`check failed`) unless `verbose: true`.

### OpenTelemetry

Needs `@opentelemetry/api` (optional peer) plus your SDK started before the app:

```ts
// config/observability.ts
import { defineObservabilityConfig } from '@hazejs/core'

export default defineObservabilityConfig({
  otel: { enabled: true /* , traces: { cache: true, db: false }, metrics: false, ignorePaths: [...] */ },
  dashboard: { limit: 1000, redactHeaders: ['x-tenant-token'], ignorePaths: ['/api/poll'] },
})
```

```bash
node --import ./instrumentation.mjs dist/index.mjs         # NodeSDK in a plain .mjs file
NODE_OPTIONS='--import ./instrumentation.mjs' haze dev
```

Spans: SERVER per request, ORM queries, queue send/process, `mail.send`, `@hazejs/ai` chat/embeddings, outgoing `Http`/`tracedFetch`, cache (opt-in). Metrics: `http.server.request.duration`, `http.server.active_requests`, `messaging.process.duration`, `haze.queue.job.failures`. `traceparent` is continued on incoming requests, sent by `Http`/`tracedFetch`, and carried through queued jobs; `injectTraceContext()` / `withTraceContext()` for custom transports. JSON log lines get `trace_id`/`span_id`. Keep `@opentelemetry/instrumentation-http` off for incoming requests (duplicate spans).

### Dev dashboard `/__haze`

Development only (never installed in production or tests, even with `enabled: true`). Records requests, queries, jobs, mail (HTML preview), events, cache, logs, exceptions, AI calls and outgoing HTTP, all linked to the originating request; live over SSE; JSON at `/__haze/api/entries`, `/__haze/api/requests/:requestId`, `/__haze/api/stats`, `/__haze/api/stream`. The **Queues** tab retries/forgets/flushes failed jobs; mount it in production with `queueDashboard(r, { path: '/admin/queues' })` inside your own auth group. Hook in with `onTelemetry((kind, data) => …)`.

### Logging

```ts
// config/logger.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  level: env('LOG_LEVEL', 'info'),   // silent|error|warn|info|debug|trace (warn in tests)
  // format: 'pretty' | 'json' (json in production), requests: true (access log, off in tests)
  channel: 'production',
  channels: {
    production: { driver: 'stack', channels: ['console', 'file', 'loki'] },
    file: { driver: 'file', path: 'storage/logs/app.log', daily: true, maxFiles: 14 },
    loki: { driver: 'http', url: env('LOKI_URL', 'http://localhost:3100/loki/api/v1/push'), format: 'loki', level: 'warn' },
  },
}))
```

Drivers: `console` (default), `json`, `file` (Node/Bun/Deno only), `http` (batched; `format` `json`/`ndjson`/`loki`/fn), `custom`, `stack`. Use `ctx.logger` in requests (carries the request ID) and `inject(Logger).child({ service: 'report' })` elsewhere; methods `error warn info success debug trace`; `logger.channel('audit').info(...)`; `await logger.flush()`. Every request gets `ctx.requestId`, echoed in `x-request-id` (incoming safe IDs are reused).

## Gotchas

- `.env.local` is **not** loaded in test mode; `haze test` uses `.env.test` (templates point `DATABASE_URL` at `:memory:`). Real environment variables beat every `.env` file.
- Config objects that call `env()` must use the function form, or they read `process.env` before `.env` is loaded.
- `.haze/` types only exist after `haze dev` or `haze typegen` — run `haze typegen` in CI before `tsc`. Before generation, config/route/i18n keys are untyped.
- In full-stack dev the Vite server only forwards the API prefixes and `/__haze` to the backend. Routes outside the prefix (e.g. `/health`, `/docs`, `/graphql`) are unreachable in dev; move them under `/api` (`config/health.ts` `path`, `config/openapi.ts` `path`/`docsPath`) or add the prefix to `haze({ prefix: [...] })`.
- The prefix is never stripped: `haze({ prefix: '/api' })` still needs routes declared as `/api/...`.
- OpenAPI docs (`/docs`) are disabled in production by default; `haze openapi -o openapi.json` still works. The `/__haze` dashboard never exists in production.
- `haze start` / `haze preview` need a prior `haze build`. `haze preview` uses the preset recorded in `.haze/build.json`; Cloudflare preview needs `miniflare` as a dev dependency.
- Serverless/edge presets (`cloudflare`, `vercel`, `netlify`, `aws-lambda`) have no `worker.mjs` and no command entry: no long-running queue workers, use the platform's scheduler and migration route from the table above. Cloudflare has no `.env` and no TCP drivers (ioredis, mysql2, BullMQ, nodemailer, socket.io are stubbed and throw at use); the `file` log channel and local disks don't work there. WebSocket/Socket.IO are unavailable on Lambda.
- `migrate.mjs` is only emitted when `@hazejs/orm` is used; Docker images don't contain `.env` — pass `APP_KEY` etc. with `-e`.
- With the default `memory` cache store, maintenance state goes to `storage/framework/down` and only affects that machine. Use a shared store (`redis`, KV, Upstash) for fleets and for serverless platforms.
- Maintenance mode blocks the frontend files too in production (backend serves `dist/client`); add `/assets/*` to `except` if a custom page needs them. Health checks keep returning 200 while down.
- Microservice listeners, queue workers and schedulers need long-running processes; `search:*`, `microservice:listen`, `openapi`, `typegen`, `repl` have no production entry — wrap needed operations in an `app/command` and run `worker.mjs command <name>`.
- Auto-discovery only scans the first directory level for most kinds; `app/job/billing/Charge.ts` is never loaded. Controllers and middleware are never discovered.
- `database/schema/*.ts` is read by drizzle-kit directly — do not use the `~` alias there.
- Provider `shutdown()` runs on every dev hot reload, not only on process exit.
- `APP_KEY` must be ≥ 32 characters and set as a real env var / secret in production; `haze key:generate --force` invalidates existing cookies, sessions and tokens.

## Serving a separately built frontend (backend-only projects)

`config/static.ts` → `defineConfig(() => ({ dir: env('WEB_DIST_DIR'), spaFallback: true, precompressed: true, exclude: ['/api', '/socket.io'] }))`. Relative `dir` resolves against the project root; nothing is served while it is unset. The docker preset's Dockerfile includes `HEALTHCHECK` on `/health/live`.

