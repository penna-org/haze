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
| `haze route:list` | Routes with method, path, name, handler, middleware (inline functions as `name()`) | `--json` (stdout = JSON only, boot logs → stderr) |
| `haze module:list` | Enabled modules in enable order | `--json` |
| `haze typegen` | Writes `.haze/types/haze.d.ts`, `.haze/types/i18n.d.ts`, `.haze/routes.ts` | — |
| `haze openapi` | Prints the OpenAPI 3.1 document (docs need not be enabled) | `--output/-o openapi.json` |
| `haze devtools:report` | Static site of the app structure (overview, graph, routes, internals; no runtime data). Needs `@hazejs/devtools` | `--out/-o` (`.haze/devtools-report`), `--base` (`/`) |
| `haze repl` | Shell with booted app, `config`, `inject`, `useApp`, facades (`Cache Queue Events Storage Mail`, `Db`), every export of `app/model/**`; top-level await; history in `.haze/repl_history`; `.reload`, `.exit` | `--eval/-e "<code>"` (multi-statement code needs `return`; throw → exit 1) |
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

- Subdirectories are **rejected** for `make:interceptor`, `event`, `listener`, `job`, `policy`, `notification`, `channel`, `config`, `route`, `seeder` (first-level discovery). `make:controller admin/User` → `app/controller/admin/UserController.ts` is fine.
- `make:notification InvoicePaid` → file and **type** `InvoicePaidNotification` (rename the file for a shorter type).
- `--app/-a`: ignored by `make:test`, unsupported by `make:command`/`make:factory`; per app only `route`, `config`, `provider`, `exception`, `response` are discovered — keep jobs/events/listeners/policies/notifications/channels in shared `app/`. `--module/-m` needs an existing module, can't combine with `--app`.
- `make:model --dialect` is inferred: `mysql2` → mysql, `postgres`/`pg`/`@electric-sql/pglite` → postgres, only `mongodb` → mongodb (`MongoModel`, no schema file), else sqlite. Default table = plural snake case (`OrderItem` → `order_items`). An existing schema file is left untouched.
- `make:queue-tables` also runs `db:generate` (skip with `--no-generate`); none of the `*-tables` commands support MongoDB.
- `haze stub:publish` names: `controller`, `controller.resource`, `service`, `repository`, `middleware`, `interceptor`, `provider`, `event`, `listener`, `job`, `policy`, `validate`, `validate.zod`, `test`, `config`, `route`, `seeder`, `command`, `mail`, `notification`, `channel`, `resource`, `factory`, `view`, `model`, `model.mongodb`, `module`, `module.{config,controller,route,test}`, `schema.{sqlite,postgres,mysql}`, `notifications.{…}`, `auth-tables.{…}`, `queue-tables.{…}`. Placeholders `{{ className }}`, `{{ camelName }}`, `{{ kebabName }}`, `{{ routePath }}`, `{{ commandName }}`. `stubs/<name>.stub` wins over the built-in.

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

Custom commands: every file in `app/command/**` that default-exports `defineCommand()` — `app/command/db/Cleanup.ts` runs as `haze db:cleanup`. `--root` is consumed by `haze` unless the command defines its own `root` arg. Built-in commands don't boot the app to list yours.

`db:generate` reads `database/schema/*.ts` and writes `database/migrations` (non-default connections: `database/migrations/<connection>`); override per connection with `schema` / `migrations` in `config/database.ts`. `db:migrate` = the production `migrate.mjs` code path; module migrations run first, each tracked in its own table. `db:seed` runs enabled local modules' seeders first; each file default-exports `(app) => …`. `search:*` loads `app/model` and `app/<app>/model` (call `searchable()` in the model's own file); the model argument is the class or index name.

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

`config/app.ts` options: `name`, `debug` (true in dev), `url` (`APP_URL`), `key` (`APP_KEY`), `previousKeys` (`APP_PREVIOUS_KEYS`), `bodyLimit` (`'1mb'`), `trustProxy` (`false`; `true` = 1 trusted proxy hop, number = n hops), `shutdownTimeout` (`10` s, see graceful shutdown), `cookie`, `requestIdHeader` (`'x-request-id'` or `false`), `response` (envelope), `apps` (multi-app).

```ts
// haze.config.ts — all optional
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  srcDir: '.',        // 'server' in vue/react templates
  port: 3000,         // PORT wins
  preset: 'node',     // haze build --preset overrides
  // outDir: 'dist', host, typegen: true, cloudflare: { wrangler, websocket }, vercel: { cron },
  // externals: { trace, traceDeps, inline }, devtools: { ... } | false, vite: { ... } (backend-only projects)
})
```

| `haze.config.ts` option | Default | Notes |
| --- | --- | --- |
| `srcDir` | `'.'` | `'server'` in full-stack templates |
| `port` | `3000` | Backend-only dev port + production default; `PORT` wins. Full-stack dev uses Vite's port |
| `host` | `localhost` dev, `0.0.0.0` prod | `HOST` wins in production |
| `outDir` | `'dist'` | |
| `typegen` | `true` | `.haze/types` while `haze dev` runs |
| `preset` | `'node'` | `--preset` > `HAZE_PRESET` (raw `vite build`) > this |
| `cloudflare` | — | `wrangler` (merged into `dist/wrangler.json`), `websocket` (Durable Object; auto when routes use `r.ws()`) |
| `vercel` | — | `cron` (default every minute) |
| `externals` | — | `trace` (`true`; `false` = node/bun load deps from project `node_modules`), `traceDeps` (keep external + trace; `pkg*` copies whole package), `inline` (force-bundle) |
| `devtools` | on when `@hazejs/devtools` installed | `false` or options, see DevTools below |
| `vite` | — | Extra Vite config, backend-only projects only |
| `autoImport` | `false` | `true` or options, see Auto imports below (needs `@hazejs/auto-import`) |

### Auto imports (`@hazejs/auto-import`)

`pnpm add -D @hazejs/auto-import` + `autoImport: true` in `haze.config.ts` (off by default; `create-hazejs --auto-import` sets it up). The `haze()` plugin adds imports after TS is stripped, everywhere it runs (`haze dev`/`build`, Vitest via `defineHazeTestConfig()`, CLI commands); hand-written imports keep working and win.

- Imported: every export of `app/{controller,service,repository,model,middleware,interceptor,validate,event,job,mail,notification,resource}/**` and the same dirs in `modules/*/app/`; named exports keep their name, default exports use their declared name or the file name (`send-receipt.ts` → `sendReceipt`). Plus presets from installed packages: `@hazejs/core/auto-imports` (`defineRoutes`, `define*Config`, `inject`, `env`, `validate`, facades, exceptions, `HttpContext`, …) and `@hazejs/orm/auto-imports` (`Model`, `Db`, `defineFactory`, `transaction`, …). Not scanned: `app/listener`, `app/policy`, `app/provider`, `config`, `route`. Left out of presets: names clashing with globals (`Storage`, `Lock`) and generic helpers (`t`, `raw`, `when`, `cache`, `can`).
- Options (object instead of `true`): `dirs` (globs relative to `srcDir`, replaces the default list; `a/b` = first level, `a/b/**` = recursive), `imports` (`{ from, imports: ['z', ['*', 'v'], ['default', 'dayjs'], { name, as?, type? }] }`), `presets` (package names; `[]` = none), `ignore` (names never imported), `exclude` (default `['database/schema/**', 'modules/*/database/schema/**']`). Precedence on clashes: `dirs` > `imports` > presets (dev server warns).
- Types: `.haze/types/auto-imports.d.ts`, refreshed by the dev server and `haze typegen` (run it before `tsc` in CI; keep `.haze/types/**/*.d.ts` in `tsconfig`). Full-stack: backend only, the frontend sees neither imports nor declarations.
- `haze()` now returns an **array** of plugins (`[main, autoImport]`); `plugins: [vue(), haze()]` still works (Vite flattens).
- Not transformed (write imports by hand): `haze.config.ts`, `vite.config.ts`, `vitest.config.ts`, `database/schema/*.ts` (drizzle-kit). `haze make:*` omits auto-imported names when it is on.

`Config` (`inject(Config)`, `ctx.config`, `app.config`): `get(key, default?)`, `has`, `set`, `all`. Multi-app: inside a request `config()`/`ctx.config` return `app/<name>/config/*.ts` deep-merged over the global files. `app.mode` is read-only. Dev: editing `.env*` or `config/` hot-reloads the app.

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

### Providers and boot order

`app.boot()` runs every provider's `register(container, app)`, then every `boot(app)` in order: **module providers first** (in module enable order), then the project's `app/provider/*.ts`, then the callbacks queued with `app.onBooted(cb)` (awaited; a throw fails boot; called immediately once the app is booted). Use `onBooted` in a module provider for anything that needs what an app provider prepares in its `boot()` — an open database connection, loaded settings, a Gate fallback:

```ts
// modules/shop/app/provider/ShopProvider.ts
export default defineProvider({
  boot: app => app.onBooted(() => app.make(OrderBinding).register()),
})
```

Singletons are created on first `make()` / `inject()`. A service whose constructor registers side effects (hooks into another library, timers, bindings) does nothing until something resolves it — and controllers, being request-scoped, only resolve it on the first request. Create such services at boot (`onBooted(() => app.make(Service))`) or, better, move the side effect into a provider.

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
- **Detection**: `haze dev/build/preview` treat a project as full-stack only when a `vite.config.{ts,mts,js,mjs}` contains the string `'@hazejs/vite'`; a tooling-only `vite.config.ts` (vite-plus tasks, lint/test settings) keeps it backend-only. Deps: `@hazejs/core`, dev `@hazejs/vite` + `@hazejs/cli`.
- **Errors in dev**: opening a failing `/api/...` URL in the browser shows the dev error page; `fetch` still gets JSON.
- **Preview**: `haze preview` (= `vite preview`) runs the real build for its preset on 4173; WebSockets are forwarded for process presets.
- **TypeScript**: `tsconfig.server.json` includes `server/**`, `tests/**`, `*.config.ts`, `.haze/types/**/*.d.ts`, types `node`, `vite/client`, `@hazejs/vite/client` (declares `virtual:haze/app`, `virtual:haze/migrations`).

Serving a frontend you build yourself (`createApplication({ static })` or `config/static.ts`):

| `StaticOptions` | Default | |
| --- | --- | --- |
| `dir` | — (required) | Build directory |
| `spaFallback` | `false` | HTML requests for missing files → `index.html` (no-cache) |
| `exclude` | `[]` | Path prefixes never served, e.g. `['/api']` |
| `immutablePrefix` | `'/assets/'` | `Cache-Control: public, max-age=31536000, immutable` |
| `precompressed` | `false` | `true` = serve `.br`/`.gz` siblings by `Accept-Encoding` (brotli preferred), or `{ encoding: ext }`; falls back to the original file |

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

Long-running presets listen on `PORT` (default `haze.config.ts` `port`, else 3000) and `HOST` (default `0.0.0.0`). Dependencies are bundled; DB drivers/native modules are traced into `node_modules` next to the entry, so `dist/` is self-contained (docker installs externals inside the image; cloudflare stubs unsupported ones). Build `aws-lambda`/`vercel` on Linux (CI/Docker) for correct native binaries. Client IP: the cloudflare entry passes `cf-connecting-ip` and aws-lambda the event's `sourceIp` (no `trustProxy` needed); vercel/netlify sit behind a proxy → `trustProxy: true`; custom entries call `setClientAddress(request, ip)` (`@hazejs/core`).

| Preset | Dependencies |
| --- | --- |
| node / bun / deno | Bundled except drivers; drivers traced (nf3) into `node_modules` next to the entry |
| aws-lambda / vercel | Same, always traced (build on Linux) |
| docker | Externals listed in the runtime `package.json`, installed in the image (`npm install --omit=dev`) so native binaries match Linux |
| netlify | Externals bundled by Netlify at deploy time |
| cloudflare | Everything bundled; unsupported drivers replaced by throwing stubs |

Backend-only builds empty `outDir` first (only when it is inside the project). After a build the CLI prints the entry, the externals and the exact run/migrate/worker commands. Full-stack: `node`/`bun`/`deno`/`docker`/`aws-lambda` serve `dist/client` from the same process; `vercel`/`netlify`/`cloudflare` serve it from the CDN.

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

`migrate.mjs` exists only when the project uses `@hazejs/orm`. It **boots the whole application** (every provider's `register` + `boot`) before migrating, so on an empty database providers run before any table exists: a provider that queries tables in `boot()` must check first (e.g. `select to_regclass('settings') is not null`) or catch and fall back to defaults. Production builds have **no seed entry** (`database/seeders` and `haze db:seed` are dev-only): put initial data in an idempotent console command (`app/command/db/Init.ts` → `node server/worker.mjs command db:init`) and run it after `migrate.mjs`.

Process presets (`node`, `bun`, `deno`, `docker`) also emit `worker.mjs`:

```bash
node dist/worker.mjs queue --queue emails,default --concurrency 5 --connection redis
node dist/worker.mjs schedule              # long-running scheduler
node dist/worker.mjs schedule:run          # once (system cron each minute)
node dist/worker.mjs command inspire --all # app/command; `command` alone lists them
node dist/worker.mjs down --secret=deploy-2026 --retry=60
node dist/worker.mjs up
node dist/worker.mjs maintenance:status
```

`worker.mjs` subcommands: `queue` (default when none given; `--queue/-q` default `default`, `--concurrency/-c` default 1, `--connection`), `schedule`, `schedule:run` (exit 1 if a task failed), `command [name] [args]`, `down`/`up`/`maintenance:status`; anything else exits 1. `--connection` names a `config/queue.ts` connection; the worker reads the same `REDIS_URL`/`config/redis.ts` as the web process.

Full-stack projects and `deno`/`docker` put these in `dist/server/`. For one process that also runs the scheduler and a queue worker (dev, single instance), set `runInServer: true` in `config/schedule.ts` and `config/queue.ts` instead (see async-and-realtime.md); never in tests or console commands. Serverless/edge presets have no `worker.mjs`; schedules run via Cloudflare Cron Triggers, EventBridge (Lambda) or Vercel Cron (`/__haze/schedule`, needs `CRON_SECRET`; `vercel: { cron: '0 3 * * *' }` for Hobby). Microservice listeners: `autoListen: true` in `config/microservices.ts` (every web instance listens) or a long-running command:

```ts
// app/command/ListenMessages.ts — node dist/worker.mjs command listen:messages
import process from 'node:process'
import { defineCommand } from '@hazejs/core'
import { listenMicroservices } from '@hazejs/microservices'

export default defineCommand({
  description: 'Listen for microservice messages',
  async run(_args, { app }) {
    const listener = await listenMicroservices(app)
    await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) })
    await listener.close() // stop consuming, let running handlers finish
  },
})
```

Search in production: call `importSearchable()` / `syncSearchSettings()` from a command and run it with `worker.mjs command`.

### Preview and serverless entries

| Preset | `haze preview` runs it as |
| --- | --- |
| node / docker | child process + proxy (loads root `.env`) |
| bun / deno | same with Bun / Deno (Deno may come from the `deno` npm package) |
| aws-lambda / vercel / netlify | function handler called in-process |
| cloudflare | Miniflare (`pnpm add -D miniflare`): bindings from `dist/wrangler.json`, `.env`/`.env.production` passed as bindings, data in `.haze/preview`, D1 migrations auto-applied; no WebSocket proxying (use `wrangler dev -c dist/wrangler.json`) |

- **aws-lambda**: zip `dist/lambda` (runtime `nodejs22.x`); `index.handler` accepts API Gateway HTTP/REST, ALB and Function URL events. No WebSocket/Socket.IO, no queue consumer (use `redis`/`database` with a worker elsewhere).
- **vercel**: `.vercel/output/` with `static/`, `functions/__server.func` (Node 22), `config.json`. Cron hits `/__haze/schedule` with `Authorization: Bearer $CRON_SECRET` (401 otherwise).
- **netlify**: Functions v2 entry; a `netlify.toml` (build command + publish dir) is created if missing; full-stack builds also get a `_redirects` SPA fallback.
- **cloudflare**: the Worker exports `fetch`, `queue()` (consumes Cloudflare Queues; retry = `message.retry({ delaySeconds })`), `scheduled()` (when tasks exist, `triggers.crons` = every minute unless you set `triggers`), and `HazeWebSocket` (Durable Object + migration, binding `HAZE_WEBSOCKET`) when routes use `r.ws()`. Full-stack: Workers Assets with SPA fallback, backend prefixes routed to the Worker first. D1 without `migrations_dir` uses the `migrations/` folder copied into `dist/`. `setPlatformBindings(env)` runs before each request (exported for custom entries/tests).

### Docker topology (one image, several roles)

The same image runs every role; only the command differs. Proven layout (compose):

| Service | Command | Notes |
| --- | --- | --- |
| `migrate` (one-shot, `restart: 'no'`) | `sh -c 'node server/migrate.mjs && node server/worker.mjs command db:init'` | others `depends_on: { migrate: { condition: service_completed_successfully } }` |
| `app` (web) | default `node server/index.mjs` | the preset's `HEALTHCHECK` hits `/health/live` |
| `queue` | `node server/worker.mjs queue --connection database` | scale with replicas; `healthcheck: { disable: true }` (no HTTP port) |
| `scheduler` | `node server/worker.mjs schedule` | one replica, or several with `onOneServer()` + Redis |
| `db`, `redis` | postgres / redis with healthchecks | |

- Turn in-process workers off in this topology (`runInServer: false`, e.g. driven by a `WORKER_IN_SERVER` env var) and on for single-container demos.
- Redis is what makes the split work: `config/socketio.ts` `adapter: { driver: 'redis' }` (or the broadcasting bus) so a job in the `queue` container reaches browsers connected to `app`; `store: 'redis'` in `config/schedule.ts` / `config/queue.ts` for `onOneServer` / `withoutOverlapping` / unique locks across containers.
- Share a volume for local-disk storage between `app` and `queue` when jobs touch uploaded files.
- `stop_grace_period` must exceed `app.shutdownTimeout` (and the longest job you want to finish on stop); Docker's default is 10 s, the same as the default `shutdownTimeout`.
- Verify the topology itself, not just tests: start from an empty database, restart `app` (tokens must survive), stop with running WebSockets, and check that a job in `queue` pushes to a browser.

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

- `app.serve()` (the `node`/`bun`/`deno`/`docker` entry) handles `SIGINT`/`SIGTERM`: stop listening and wait for in-flight requests, then `app.dispose()`, then exit. WebSockets, SSE streams and keep-alive sockets never finish on their own, so after `app.shutdownTimeout` (`config/app.ts`, default `10`; seconds or `'30s'`) the remaining connections are closed forcibly. Keep the orchestrator's grace period above it (Docker `stop_grace_period` default 10 s, Kubernetes `terminationGracePeriodSeconds` 30 s).
- `dispose()` also stops in-process workers (`runInServer`) after their running jobs finish.
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

| `config/maintenance.ts` | Default | |
| --- | --- | --- |
| `driver` | `'cache'` | `'cache'` \| `'file'` |
| `store` | default cache store | a `memory` store falls back to the `file` location (not in tests; `haze down` says so) |
| `key` | `'framework:down'` | cache prefix is prepended |
| `file` | `'storage/framework/down'` | relative to project root |
| `interval` | `2000` ms | per-process cache of the state; `up` reaches everyone within it |
| `except` | `[]` | merged with `--except` |
| `pauseWorkers` | `true` | pause queue workers between jobs, skip due tasks (reason `maintenance`) |
| `workerSleep` | `3000` ms | how often paused workers re-check |
| `cookie` | `'haze_maintenance'` | bypass cookie name |
| `bypassTtl` | `43200` s | bypass cookie lifetime |

Running servers, workers and the scheduler notice within `interval` (2 s), no restart (also in `haze dev`). Still served while down: `except` paths, `/health*`, `/__haze` (dev), and requests with a valid bypass cookie. Visiting `/<secret>` sets the signed (`APP_KEY`) cookie and redirects to `/`; the secret is stored as SHA-256; a new `down --secret` invalidates old cookies. The middleware runs right after the request scope and exception boundary — before storage links, OpenAPI, health, global middleware and static files (no auth/CSRF while down).

- **JSON** (no `text/html` in `Accept`, or any `/api` path): `{ "code": 503, "message": "The application is down for maintenance. Please check back soon.", "data": null }`; translated via i18n key `http.maintenance`.
- **HTML**: self-contained page, the `--render` view (falls back to built-in + warning if missing/throws), or `--redirect` (add the target to `except` to serve your own route).
- Every response: `Retry-After`, `Refresh` (when set), `Cache-Control: no-store`.

```ts
import { defineListener, Maintenance, MaintenanceModeEnabled } from '@hazejs/core'

const { secret, state } = await Maintenance.down({ withSecret: true, retry: 120 }) // DownOptions mirror the CLI flags; except: string[]
await Maintenance.isDown({ fresh: true }); await Maintenance.state(); await Maintenance.up() // up() → boolean

// app/listener/NotifyOps.ts — events fire only in the process that ran down()/up()
export default defineListener(MaintenanceModeEnabled, ({ state }) => console.log(new Date(state.time)))
// MaintenanceModeDisabled payload: { time }
```

Serverless/edge: no `worker.mjs` and no writable disk — use `driver: 'cache'` with KV/Upstash/Redis and run `haze down` from a machine with the same store credentials, or write the key: `wrangler kv key put --binding CACHE "haze:framework:down" '{"time":0,"status":503,"retry":60}'` (`<cache prefix>framework:down`; KV propagation takes up to a minute).

## Observability

Full guides: [observability.md](../../../docs/guide/observability.md), [errors.md](../../../docs/guide/errors.md) (logging, request IDs, exception handler), [devtools.md](../../../docs/guide/devtools.md)

### Logging

```ts
// config/logger.ts — no dedicated helper; use defineConfig
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  level: env('LOG_LEVEL', 'info'),
  channel: 'production',               // string | string[]
  channels: {
    production: { driver: 'stack', channels: ['console', 'file', 'loki'] },
    file: { driver: 'file', path: 'storage/logs/app.log', daily: true, maxFiles: 14 },
    loki: { driver: 'http', url: env('LOKI_URL', 'http://localhost:3100/loki/api/v1/push'), format: 'loki', labels: { app: 'shop' }, level: 'warn' },
    audit: { driver: 'file', path: 'storage/logs/audit.log', daily: false },
    datadog: { driver: 'http', url: 'https://http-intake.logs.datadoghq.eu/api/v2/logs', headers: { 'DD-API-KEY': env('DD_API_KEY', '') } },
    sentry: { driver: 'custom', level: 'error', transport: { log: entry => forward(entry), flush: async () => {}, close: async () => {} } },
  },
}))
```

| `config/logger.ts` | Default | |
| --- | --- | --- |
| `level` | `info` (`warn` in tests) | `silent` `error` `warn` `info` `debug` `trace`; default for channels without their own `level` |
| `format` | `json` in production, else `pretty` | console channel only |
| `requests` | on, off in tests | access line per request (`GET /api/hello 200 3ms`); goes to every channel; health/`/__haze` paths are never access-logged |
| `tag` | `'hazejs'` | |
| `write` | error → stderr, rest → stdout | `(line, level) => void` sink for console JSON lines |
| `channel` | `'console'` | channel name(s) written to |
| `channels` | `console`, `json` built in | definitions below |

| Driver | Options (defaults) |
| --- | --- |
| `console` | `level`; pretty or JSON per `format` |
| `json` | `level`, `stream: 'stdout' \| 'stderr'` (stdout); NDJSON regardless of `format` |
| `file` | `path` (`storage/logs/haze.log`, relative to cwd), `daily` (`true` → `haze-2026-10-28.log`), `maxFiles` (14 incl. today; `0` = keep all), `level`. Node/Bun/Deno only |
| `http` | `url`, `method` (`POST`), `headers`, `format` (`json` array \| `ndjson` \| `loki` \| `(entries) => body`), `batchSize` (100), `interval` (2000 ms), `maxBuffer` (10000; oldest dropped), `labels` (Loki; default `{ service: tag, level }`), `fetch`, `level` |
| `custom` | `transport: LogTransport \| (entry) => void`, `level` |
| `stack` | `channels: string[]` |

- `LogEntry` = the JSON line: `{ time, level, tag, msg, requestId?, ...context, err?: { name, message, status?, stack } }`, plus `trace_id`/`span_id` while an OTel span is active. Call args: strings join into `msg`, plain objects merge in as fields (`logger.info('Order', { orderId })`), an `Error` becomes `err`. `LogTransport = { log(entry), flush?(), close?() }`.
- Factories `jsonTransport()`, `fileTransport()`, `httpTransport()`, `createLogTransport(name, config)` are exported for reuse.
- `http` delivery errors go to stderr and never throw; a batch is sent at `batchSize` or after `interval`.
- `Logger` methods: `error warn info success debug trace` (`success` logs at info), `child(context)`, `channel(...names)` (only those channels; keeps child context), `flush()`, `close()`. `ctx.logger` = child with `requestId` (+ `app` in multi-app); `app.logger` / `inject(Logger)` elsewhere; `job.logger`, listener `ctx.logger`, command `ctx.logger` likewise.
- The app flushes and closes all channels on `dispose()`; call `await logger.flush()` yourself in short scripts that exit without disposing.

### Request IDs

`ctx.requestId` is in every `ctx.logger` line and echoed in the `x-request-id` response header. An incoming `x-request-id` matching `[\w.:-]{1,128}` is reused (cross-service correlation); otherwise a UUID is generated. `config/app.ts` `requestIdHeader: 'x-correlation-id'` renames it; `false` neither reads nor sends the header (an ID is still generated). The dev dashboard and the debug error page link entries by this ID.

### Error reporting

`app/exception/Handler.ts` (see http.md › Exceptions): `report(error, ctx)` logs `[METHOD] /path` + error via `ctx.logger` at `error` level; `shouldReport()` is false for `dontReport` classes and every 4xx `HTTPError`. Hook an error tracker there:

```ts
override async report(error: unknown, ctx: HttpContext) {
  await super.report(error, ctx)
  if (this.shouldReport(error)) Sentry.captureException(error, { tags: { requestId: ctx.requestId } })
}
```

A throwing `report()` is logged and the response still renders. Independently, every rendered 5xx is recorded on the OTel request span (exception event, error status) and as a dashboard `exception` entry. Failures outside requests are logged by their runner: jobs (`failed()` hook + `haze.queue.job.failures` metric), listeners (`Listener "X" failed`), scheduled tasks (`onFailure`), commands (exit 1).

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
    analytics: dbCheck(Db, { connection: 'analytics', query: 'select 1' }),
    cache: cacheCheck(),
    redis: redisCheck(),         // PING default connection
    storage: { check: storageCheck('s3'), critical: false, timeout: 10_000 },
    queue: queueCheck({ connection: 'redis', maxFailed: 100 }),
    payments: async ({ signal, app }) => {
      const res = await fetch('https://status.example.com/api', { signal })
      return res.ok || { status: 'degraded', message: `status page returned ${res.status}` }
    },
  },
})
```

| `config/health.ts` | Default | |
| --- | --- | --- |
| `enabled` | `true` | |
| `path` | `'/health'` | also serves `<path>/ready` and `<path>/live` |
| `timeout` | `5000` ms | per check; on timeout `signal` aborts |
| `checks` | `{}` | `name: fn` or `{ check, timeout?, critical? (true) }` |
| `verbose` | `true` except production | include failure messages (timeout messages always shown) |
| `cache` | `0` ms | reuse the readiness report |

| Endpoint | Response |
| --- | --- |
| `GET/HEAD <path>/live` | always `200 { "status": "ok" }` (liveness) |
| `GET/HEAD <path>`, `<path>/ready` | `{ status, checks: { name: { status, latencyMs, message? } } }`; `200` ok/degraded, `503` down |

- Result mapping: nothing/`true` → ok; string → ok with `message`; `false`/throw → down; `{ status?, message? }` as given. Overall: a failing critical check → `down`; a failing non-critical or any `degraded` → `degraded`. Thrown errors are logged (`Health check failed`, `check: name`); production responses say `check failed`.
- Built-ins: `dbCheck(Db, { connection?, query? })` (`select 1`; Db is passed in so core doesn't depend on the ORM), `cacheCheck(store?)` (set/get/forget a temp key), `redisCheck(name? | client)` (PING a `config/redis.ts` connection; a cache-store name falls back to a cache check; or any `{ ping() }` client), `storageCheck(disk?)` (read-only `exists`), `queueCheck({ connection?, maxFailed? })` (counts message; `degraded` above `maxFailed`; drivers without counts → ok).
- Served before global middleware (no auth/CSRF/throttle, no envelope, `cache-control: no-store`); a project `GET` route with the same path wins. `runHealthChecks(app)` returns the same report programmatically.
- Kubernetes: `livenessProbe` → `/health/live`, `readinessProbe` → `/health/ready`. Docker preset `HEALTHCHECK` hits `/health/live` (adjust if you change `path`). Full-stack dev only forwards `/api/*`: use `path: '/api/health'` if probes go through Vite.

### OpenTelemetry

Needs `@opentelemetry/api` (optional peer) plus an SDK you start **before** the app. Without the package, or with `enabled: false` (default), every hook is a no-op; `enabled: true` without the package logs a warning and continues.

```ts
// config/observability.ts
import { defineObservabilityConfig } from '@hazejs/core'

export default defineObservabilityConfig({
  otel: { enabled: true /* , name: 'hazejs', traces: { cache: true, db: false }, metrics: false, ignorePaths: [...] */ },
  dashboard: { limit: 1000, redactHeaders: ['x-tenant-token'], ignorePaths: ['/api/poll'] },
})
```

| `otel` option | Default | |
| --- | --- | --- |
| `enabled` | `false` | |
| `name` | `'hazejs'` | tracer / meter name |
| `traces` | `http db mail queue ai` on, `cache` off | per span type |
| `metrics` | `true` | |
| `ignorePaths` | health path + dashboard path | `string` (prefix) or `RegExp`; **setting it replaces the defaults** — re-add `'/health'`, `'/__haze'` |

```js
// instrumentation.mjs — plain .mjs, loaded with --import
import process from 'node:process'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { NodeSDK } from '@opentelemetry/sdk-node'

const sdk = new NodeSDK({
  serviceName: 'my-app',
  traceExporter: new OTLPTraceExporter(), // OTEL_EXPORTER_OTLP_ENDPOINT, default http://localhost:4318
  metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }),
})
sdk.start()
process.once('beforeExit', () => sdk.shutdown())
```

```bash
node --import ./instrumentation.mjs dist/index.mjs          # web
node --import ./instrumentation.mjs dist/worker.mjs queue   # workers too
NODE_OPTIONS='--import ./instrumentation.mjs' haze dev
```

| Span | Kind | Key attributes |
| --- | --- | --- |
| `GET /users/:id` (per request) | SERVER | `http.request.method`, `url.path`, `http.route`, `http.response.status_code`, `error.type` |
| `SELECT`/`INSERT`… (`@hazejs/orm`) | CLIENT | `db.system.name`, `db.query.text`, `db.operation.name`, `db.namespace` |
| `send <queue>` / `process <queue>` | PRODUCER / CONSUMER | `messaging.*`, `haze.job.name`, `haze.job.attempt`, `haze.job.status` |
| `mail.send` | CLIENT | `haze.mail.mailer`, `haze.mail.driver`, `haze.mail.recipients` |
| `chat <model>` / `embeddings <model>` | CLIENT | `gen_ai.*` (provider, model, tokens, finish reasons) |
| `cache.get`… (opt-in) | CLIENT | `haze.cache.store`, `haze.cache.key`, `haze.cache.hit` |
| `GET` (`Http` client / `tracedFetch`) | CLIENT | `http.request.method`, `url.full`, `server.address`, `http.response.status_code` |

Metrics: `http.server.request.duration` (s, histogram), `http.server.active_requests` (up-down counter), `messaging.process.duration` (s), `haze.queue.job.failures` (counter, final failures). 5xx marks the request span as error and records the rendered exception.

```ts
import { trace } from '@opentelemetry/api'
import { activeTraceIds, injectTraceContext, openTelemetryEnabled, tracedFetch, withTraceContext } from '@hazejs/core'

await trace.getTracer('billing').startActiveSpan('charge', async (span) => {
  try { await gateway.charge(order) } finally { span.end() }  // nests under the request span
})
const res = await tracedFetch('https://inventory.internal/api/stock', { method: 'POST', body }) // CLIENT span + traceparent
await bus.publish('orders', { order, headers: injectTraceContext() })          // carrier: Record<string, string>
bus.subscribe('orders', m => withTraceContext(m.headers, () => handle(m.order))) // Headers or record
activeTraceIds() // { trace_id, span_id } | undefined; openTelemetryEnabled() → boolean
```

Propagation: incoming `traceparent`/`tracestate` continue the caller's trace; `dispatch()` stores context in `message.context` so workers (other processes, Redis) continue it; without a registered propagator hazejs reads/writes W3C `traceparent` itself. `NodeSDK` registers the AsyncLocalStorage context manager + W3C propagator hazejs relies on. Keep `@opentelemetry/instrumentation-http` off for **incoming** requests (duplicate SERVER spans); outgoing `http`/`undici` instrumentation is fine. Flush with `sdk.shutdown()` from a provider `shutdown()` — `app.serve()` exits right after dispose. Workers/Bun/Deno: hooks only use the API; Workers need a Workers-compatible tracer provider, `nodejs_compat`, and `ctx.waitUntil()` flushing.

### Dev dashboard `/__haze`

Development mode only: never installed in production or tests, whatever the config says. Self-contained page (no CDN), served before global middleware, entries kept in memory (ring buffer per type) and linked to the originating `requestId` — including jobs that run later and the mail they send. Live via SSE. The debug error page links to the request.

| `observability.dashboard` | Default | |
| --- | --- | --- |
| `enabled` | `true` in development | ignored elsewhere |
| `path` | `'/__haze'` | |
| `limit` | `500` | entries kept per type |
| `redactHeaders` | — | added to the built-in list: `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, `x-api-key`, `x-csrf-token`, `x-xsrf-token` |
| `ignorePaths` | — | not recorded; dashboard + health paths always ignored |

Entry types: `request`, `query`, `job`, `mail`, `event`, `cache`, `log`, `exception` (5xx only), `ai`, `http` (outgoing `Http` calls, credentials masked), `schedule`.

| JSON API (under `<path>/api`) | |
| --- | --- |
| `GET /entries?type=&requestId=&jobId=&after=&limit=` | newest first; `limit` default 100, max 1000; unknown `type` → 422 |
| `GET /entries/:id`, `GET /requests`, `GET /requests/:requestId` | one entry; request list; `{ request, entries }` |
| `GET /stats` | `{ counts }` per type |
| `GET /stream` | SSE, `event: entry` per new entry |
| `GET /mail/:id/preview` | rendered mail HTML, sandboxed by CSP |
| `POST /clear` | clears buffers; needs header `x-haze-dashboard: 1` (same-origin) |
| `GET /queues`, `POST /queues/:connection/{retry,forget,flush}` | queue summary / actions; body `{ id? }` (`forget` requires `id`); same header rule |

Telemetry bus (what feeds the dashboard and DevTools; a single `Set.size` check when nobody listens):

```ts
import { onTelemetry, recordTelemetry } from '@hazejs/core'

const stop = onTelemetry((kind, data) => {   // kinds: query cache mail job.dispatched job.processed event log exception ai schedule http
  if (kind === 'query' && data.duration > 500) console.warn('Slow query', data.sql)
})
```

Listener errors are swallowed. Packages that don't import core report through `globalThis[Symbol.for('hazejs.telemetry')]`. AI prompt/output content is only captured while the dashboard is on (never sent to OTel).

**Queues tab / production queue dashboard**: per connection (not `sync`) waiting/delayed/active/failed counts (`memory`, `redis`, `database`) and failed jobs; retry one/all, forget, flush (= `queue:retry/forget/flush`). Production: `queueDashboard(r, { path: '/admin/queues' })` inside your own `auth` / `can:` group registers `GET <path>` + `<path>/api` (hidden from OpenAPI; default path `/__haze/queues`). Writes need `x-haze-dashboard: 1` (the page sends it plus the `XSRF-TOKEN` value, so CSRF passes). Cloudflare Queues failures live in your wrangler dead-letter queue.

### DevTools (`@hazejs/devtools`, experimental)

`pnpm add -D @hazejs/devtools` — that's all: `haze dev` finds it and prints `DevTools: http://localhost:3000/__devtools/`. Runs in the dev-server process (not in the app), survives app hot reloads, never part of `haze build` output. Full-stack: mounted on the Vite server plus a floating dock injected into HTML pages; with Vite DevTools enabled (`devtools: true` in `vite.config.ts` + `@vitejs/devtools`) the hazejs panels register there instead (one UI, one auth, one MCP endpoint).

| Panel | Shows |
| --- | --- |
| Overview | name, mode, dirs, Node version, route count, last (re)load result/error, modules, sub-apps |
| Graph | module links: defines event/job, listened-by (queued marked), schedules job, uses middleware of, mounted into; plus runtime emitted/dispatched counts |
| Routes | filterable route table incl. module/app |
| Requests | per-request waterfall (queries, cache, events, jobs incl. queued work, mail, logs, exceptions, AI, HTTP); repeated SQL flagged **N+1**. Needs the dev dashboard on |
| AI | per-model calls/tokens/latency, messages/output/tool calls (each part cut at 4000 chars), prompt playground |
| Tasks | schedules with next/last run and **Run now** (same `withoutOverlapping`/`onOneServer` checks); queue counts; per-job dispatch/success/failure |
| Internals | global middleware, aliases, groups, providers, bindings, events → listeners, jobs, with source module |
| API Docs / Dashboard | `/docs` and `/__haze` embedded when enabled |
| Terminals | browser shells + one-click `route:list`, `module:list`, `schedule:list`, `queue:work` |

| `devtools` (in `haze.config.ts`, or `haze({ devtools })` which wins) | Default | |
| --- | --- | --- |
| `base` | `'/__devtools/'` | mount path |
| `auth` | `true` | one-time code printed in the terminal on first browser connect (or open the `#devframe_otp=` link); browser stays authorized across restarts. Disable only for single-user localhost |
| `terminals` | `true` | Terminals panel (can run commands — keep `auth` on) |
| `embedded` | `true` | full-stack floating dock |
| `mcp` | `true` | MCP endpoint `<base>__mcp` |

`devtools: false` disables without uninstalling. MCP: local connections only and a local `Origin` header required (DNS-rebinding guard). Tools: `hazejs_snapshot` (call first), `hazejs_routes`, `hazejs_graph`, `hazejs_requests`, `hazejs_request`, `hazejs_ai`, `hazejs_ai-models`, `hazejs_ai-run`, `hazejs_tasks`, `hazejs_openapi`, `hazejs_run-schedule`.

```bash
claude mcp add --transport http hazejs http://localhost:3000/__devtools/__mcp --header "Origin: http://localhost:3000"
haze devtools:report -o dist/report --base /report/ && npx serve dist/report   # static; opening index.html from disk doesn't work
```

Programmatic: `app.introspect()` → serializable `{ app, modules, apps, routes, middleware: { global, aliases, groups }, providers, bindings, events, jobs, schedules, dashboard?, openapi? }`. `@hazejs/devtools` exports `createDevtools({ source, root?, base?, server?, auth?, terminals?, mcp? })` (→ `handler`, `nodeMiddleware`, `attach(server)`, `handleUpgrade`, `ready`, `close`), `buildReport({ source, outDir, base?, root? })`, `buildGraph(app.introspect())`, `setupViteDevtools`, `inspectApp`, `filterRoutes`, `listRequests`, `requestDetail`, `repeatedQueries`, `aiSummary`. `source` = `{ app, onReload(listener), import? }` (`import` is needed for Run now / AI playground).

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
- `migrate.mjs` boots every provider against a possibly empty database — providers must tolerate missing tables. There is no production `seed` entry; use an app command via `worker.mjs command`.
- A process that keeps running after `SIGTERM` usually has open WebSockets/SSE: lower `app.shutdownTimeout` or raise the orchestrator grace period, don't kill it harder.
- Pipe `haze route:list --json` (stdout is clean JSON); other commands may print boot logs to stdout.
- With the default `memory` cache store, maintenance state goes to `storage/framework/down` and only affects that machine. Use a shared store (`redis`, KV, Upstash) for fleets and for serverless platforms.
- Maintenance mode blocks the frontend files too in production (backend serves `dist/client`); add `/assets/*` to `except` if a custom page needs them. Health checks keep returning 200 while down.
- Microservice listeners, queue workers and schedulers need long-running processes; `search:*`, `microservice:listen`, `openapi`, `typegen`, `repl` have no production entry — wrap needed operations in an `app/command` and run `worker.mjs command <name>`.
- Auto-discovery only scans the first directory level for most kinds; `app/job/billing/Charge.ts` is never loaded. Controllers and middleware are never discovered.
- `database/schema/*.ts` is read by drizzle-kit directly — do not use the `~` alias there.
- Provider `shutdown()` runs on every dev hot reload, not only on process exit.
- `APP_KEY` must be ≥ 32 characters and set as a real env var / secret in production; `haze key:generate --force` invalidates existing cookies, sessions and tokens.
- Setting `otel.ignorePaths` **replaces** the default ignore list (health + `/__haze`); include them again or probes create spans.
- The OTel SDK must start before the application — load it with `--import` (also for `worker.mjs`), not from app code. `enabled: true` alone exports nothing — hazejs never creates an SDK/exporter.
- `/__haze`, the DevTools Requests/AI panels and AI content capture exist only in development; `dashboard.enabled: true` cannot turn them on in production — use `queueDashboard()` behind auth for production queue ops.
- `@hazejs/devtools` Terminals can run shell commands: never disable `auth` on a dev server reachable from other machines (`--host 0.0.0.0`).
- Health responses hide error messages in production (`check failed`); the real error is in the logs. Timeout messages are always shown.
- `http` log channels buffer in memory and drop the oldest entries past `maxBuffer`; scripts that `process.exit()` without `app.dispose()` lose buffered lines unless they `await logger.flush()`.

## Serving a separately built frontend (backend-only projects)

`config/static.ts` → `defineConfig(() => ({ dir: env('WEB_DIST_DIR'), spaFallback: true, precompressed: true, exclude: ['/api', '/socket.io'] }))`. Relative `dir` resolves against the project root; nothing is served while it is unset. The docker preset's Dockerfile includes `HEALTHCHECK` on `/health/live`.

