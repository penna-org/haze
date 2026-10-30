# @hazejs/cli

## 1.0.0

### Major Changes

- [#14](https://github.com/penna-org/haze/pull/14) [`80169cf`](https://github.com/penna-org/haze/commit/80169cf2ae0ad9159fe1dc50d71a845c6fb91a6b) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - hazejs 1.0, the first stable release. All `@hazejs/*` packages and `create-hazejs` share version 1.0.0 and follow semantic versioning from here on: breaking changes only land in a new major, with an upgrade guide.
  
  Security fixes included in this release:
  
  - **Rate limiting behind proxies.** With `app.trustProxy`, `ctx.ip` is now the `X-Forwarded-For` entry appended by the nearest trusted proxy (the rightmost) instead of the leftmost one, which the client can set itself; previously a client could get a fresh `throttle` bucket per request by sending its own `X-Forwarded-For`. `trustProxy` also accepts the number of trusted hops (`trustProxy: 2` behind a CDN and a load balancer). The Cloudflare Workers entry passes `cf-connecting-ip` and the AWS Lambda adapter passes the event's `sourceIp` as the client address, so on those platforms `ctx.ip` works without `trustProxy` and `throttle` no longer counts every anonymous request under one shared key. New `setClientAddress(request, ip)` export for custom entries; `throttle` logs a warning once when no client address is known.
  - **Two-factor login lockout.** Wrong codes are counted per user in the cache (new `twoFactor.cacheStore` option, default store) for `challengeTtl`, not in the session cookie the client holds, so replaying the login cookie no longer resets `maxAttempts`. After `maxAttempts` wrong codes the user cannot complete a challenge until `challengeTtl` has passed, even after entering the password again.
  - **Passkey challenges.** In `challenge: 'session'` mode a used challenge is also recorded in the cache, so an old session cookie cannot replay a registration or authentication response.
  
  Packaging: `@hazejs/cli` depends on `@hazejs/vite` with a caret range instead of an exact version, every package has `main` / `types` fallbacks for older module resolution, and `@hazejs/microservices` declares the legacy `nats` client as an optional peer dependency.

### Patch Changes

- Updated dependencies [[`80169cf`](https://github.com/penna-org/haze/commit/80169cf2ae0ad9159fe1dc50d71a845c6fb91a6b)]:
  - @hazejs/vite@1.0.0

## 0.5.0

### Minor Changes

- [#11](https://github.com/penna-org/haze/pull/11) [`57b3b34`](https://github.com/penna-org/haze/commit/57b3b34daf04d05252f6fc5e0cd059b6676ca116) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Add auto imports. With the new `@hazejs/auto-import` package installed and `autoImport: true` in `haze.config.ts` (off by default), controllers, services, repositories, models, middleware, validators, events, jobs, mail, notifications and resources (`app/<kind>/**` and `modules/*/app/<kind>/**`), plus a curated list of framework APIs from the new `@hazejs/core/auto-imports` and `@hazejs/orm/auto-imports` presets (`defineRoutes`, `inject`, `env`, `HttpContext`, the HTTP exceptions, `Model`, `Db`, …), can be used without import statements in the dev server, builds, tests and CLI commands. Imports are added after TypeScript is compiled (type-only usages add nothing), the dev server reloads when exports are added or removed, and global declarations are written to `.haze/types/auto-imports.d.ts` so classes work as types, generics keep their constraints and default exports get names. `autoImport` accepts `dirs`, `imports` (other packages, e.g. `{ from: 'valibot', imports: [['*', 'v']] }`), `presets` (default: every installed `@hazejs/*` package with a preset; `[]` turns them off), `ignore` and `exclude` (default: `database/schema/**`). `haze()` now returns an array of plugins (`plugins: [haze()]` is unchanged; use `haze()[0].api` for the plugin API), `haze typegen` always writes types, `haze make:*` leaves out imports that would be auto-imported, and `create-hazejs --auto-import` turns the option on in new projects.

### Patch Changes

- Updated dependencies [[`57b3b34`](https://github.com/penna-org/haze/commit/57b3b34daf04d05252f6fc5e0cd059b6676ca116)]:
  - @hazejs/vite@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies []:
  - @hazejs/vite@0.4.0

## 0.3.0

### Minor Changes

- [`29360c7`](https://github.com/penna-org/haze/commit/29360c700a3f47424f28d4dab07d02afc98fc157) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - `haze devtools:report` writes the app structure (overview, module graph, routes, container and events) to a static site for CI artifacts and reviews (`buildReport()` in `@hazejs/devtools`). In full-stack projects that turn on Vite DevTools (`devtools: true` in `vite.config.ts`), the `haze()` plugin registers the hazejs panels inside Vite DevTools instead of serving its own at the same `/__devtools/` path (`setupViteDevtools()`). `@hazejs/vite` exports `importDevtools()`, and `devtools.mcp` turns the MCP endpoint off.

- [`940711c`](https://github.com/penna-org/haze/commit/940711c72b493eab636beb0fd034ff8f118165bc) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Maintenance mode and server-side TSX views. `haze down [--secret] [--retry] [--refresh] [--status] [--redirect] [--render] [--except] [--message]`, `haze up` and `haze maintenance:status` (in production `node dist/worker.mjs down` / `up` / `maintenance:status`) put the application into maintenance mode: requests get 503 with `Retry-After` — the JSON error envelope (translated with `http.maintenance`) for API clients, a built-in page, a custom view or a redirect for browsers — while health checks, `except` paths, the dev dashboard and browsers holding the signed bypass cookie (from visiting `/<secret>`; the secret is stored hashed) pass. The state lives in the cache store by default (`config/maintenance.ts`, `defineMaintenanceConfig`; an in-process memory store falls back to `storage/framework/down` outside tests) or a local file, is cached in each process for two seconds, and pauses queue workers and the scheduler (`pauseWorkers`). New `Maintenance` facade and `MaintenanceModeEnabled` / `MaintenanceModeDisabled` events. Core now ships a zero-dependency JSX runtime (`@hazejs/core/jsx-runtime`, `@hazejs/core/jsx-dev-runtime`) that renders escaped HTML strings on every runtime, including Workers: async components, `rawHtml()` / `dangerouslySetInnerHTML`, `Doctype`, `class` arrays and objects, `style` objects and typed HTML attributes. `ctx.view(<Home />, { status, headers })`, `ctx.view(Home, props)`, `ctx.view('admin/Dashboard', props)` (files in `app/view`), `view()` and returning a JSX node from a handler render `text/html` without the JSON envelope; `useHttpContext()`, `useView()`, `csrfField()`, `old()` and `flashInput()` help with pages and forms. The Vite plugin compiles backend `.tsx` / `.jsx` files with this runtime in the backend environment only, so React frontends keep their own JSX. New `haze make:view`; the `api` template renders a TSX welcome page at `GET /`, and template tsconfigs enable `jsxImportSource: '@hazejs/core'` for backend files.

- [`d90596b`](https://github.com/penna-org/haze/commit/d90596b2225eec4c290042b57dce7d0293569530) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - ORM connections for existing drizzle codebases. New `node-postgres` driver (`pg`, drizzle's default PostgreSQL driver) next to postgres-js. Connections accept `casing` (`'snake_case'` / `'camelCase'`) for tables whose columns are declared without names — passed to every drizzle instance, used by `upsert()` / `selectInsert()` column lists and forwarded by `haze db:generate` to drizzle-kit; `timezone` to set the PostgreSQL session time zone (`postgres`, `node-postgres`, `pglite`); and `client` to use an existing `PGlite`, `pg.Pool` / `pg.Client` or postgres-js instance that the app never closes (several apps sharing one in-memory database in tests). `Db.connect()` opens a connection eagerly and `Db.drizzleSync()` returns the current drizzle instance (the transaction object inside a transaction) for code that cannot await, such as repositories with a `db` getter. `Db.joinTransaction(tx, fn)` lets a transaction opened by another library through drizzle join the context, so `Db` / `Model` queries inside run in it and nested transactions become savepoints. Several applications in one process (typical in tests) no longer step on each other: inside a request `Db` / models use the manager of the application handling it, closing an application restores the previously active manager, transactions are tracked per manager, and `Db.withManager(manager, fn)` pins code outside requests — including timers and promises created inside — to one application's connections. `resolveSessionSync()`, `joinTransaction()` and `withDatabaseManager()` are exported for custom integrations.

- [`4da85a8`](https://github.com/penna-org/haze/commit/4da85a83107181f99b029837798be84cb7c8c92a) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Model factories and read/write splitting. `defineFactory(Model, ({ faker, sequence, n, index }) => attributes)` in `database/factories` builds typed models with `make()`, `create()`, `raw()`, `count()`, `createMany()` / `makeMany()`, named and inline states, `sequence()`, `afterMake` / `afterCreate`, factory and function attribute values, and relations read from the model: `for()` (belongsTo / morphTo), `has()` (hasMany / hasOne / morphMany / morphOne / belongsToMany) and `hasAttached()` with pivot data; multi-model creates run in a transaction. Fake data comes from `@faker-js/faker`, an optional peer loaded on first use, with the locale from `database.factories.locale` or `.locale()`. SQL connections accept `write`, `read` (one or more replicas) and `sticky`: reads go to a random replica, while writes, transactions, `lock()`, `useWriter()`, `Model.onWriter()`, `Db.useWriter(fn)`, raw `Db.execute()` / `Db.drizzle()` and `refresh()` use the primary; with `sticky`, reads after a write in the same request (or `Db.withinScope()`) stay on the primary. Works with per-tenant connections; replica queries report `replica: true` to the dev dashboard and `db.replica` on OpenTelemetry spans. `pool` also accepts `{ max, idleTimeout, connectTimeout }`. Core exports `getRequestStore()`. New `haze make:factory` (with `--module`), and the api / vue / react templates ship a `UserFactory` used by their tests.

- [`bd81767`](https://github.com/penna-org/haze/commit/bd817672b975e2475a7644214396915d5f247f9b) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Queue enhancements that work on every driver:
  
  - **Chains.** `Queue.chain([A.with(p), B.with(p)]).onConnection().onQueue().catch(Cleanup.with(p)).dispatch()` runs jobs in order. A job that fails for good drops the rest and runs `catch`.
  - **Batches.** `Queue.batch([...]).name().allowFailures().then().catch().finally().dispatch()` tracks progress (`total`, `pending`, `processed`, `failed`, `progress`, `finished`, `cancelled`). It supports `batch.cancel()`, `batch.add()`, `Queue.findBatch(id)` and `job.batch()`. State lives in a cache store (`config/queue.ts` `batches: { store, ttl }`), and `then` / `finally` run exactly once.
  - **Unique jobs.** `defineJob({ unique: { key, for, until } })` takes a cache lock on dispatch and skips duplicates. `Job.with(p).dispatch()` returns `{ id, skipped }`.
  - **Job middleware.** `defineJob({ middleware: [...] })` and the global `config/queue.ts` `middleware` wrap jobs. Built in: `rateLimited`, `withoutOverlapping`, `throttlesExceptions` and `skipIf`. Use `job.release(delay)` to put a job back without counting an attempt.
  - **Callbacks.** Chain and batch callbacks are job references (`Job.with(payload)`) or, on `sync` / `memory` connections, functions.
  - **Driver registry.** Other packages register queue drivers with `registerQueueDriver(name, factory)`.
  - **Fakes.** `Queue.fake()` adds `assertChained`, `assertBatched`, `assertBatchCount`, `assertNothingBatched`, `assertPushedUnique` and `assertSkipped`.
  
  `@hazejs/orm` adds the `database` queue driver (`driver: 'database'`, registered by `databaseProvider()`). It claims jobs with `FOR UPDATE SKIP LOCKED` on PostgreSQL and MySQL 8, and with an atomic `UPDATE … RETURNING` on SQLite, libsql, Turso and D1. It also supports delays, retries, release of stale reservations and the `failed_jobs` table.
  
  `@hazejs/cli` adds `haze make:queue-tables`, which writes the drizzle schema for the `jobs` and `failed_jobs` tables and runs `db:generate`.

### Patch Changes

- [`011b503`](https://github.com/penna-org/haze/commit/011b503abb98faadea05bd1fd23fa7b3567e728d) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - New `@hazejs/devtools` package (experimental), built on [devframe](https://devfra.me): install it as a dev dependency and `haze dev` serves a DevTools hub at `/__devtools/` with an app overview (name, mode, reload status, modules, sub-apps), a searchable route table, the `/__haze` dev dashboard and terminals with one-click `haze` commands. The hub runs in the dev server process, so its connection and state survive hot reloads; failed reloads show up as a status badge and a notification. In full-stack Vite projects the `haze()` plugin mounts it on the Vite server and injects a floating dock into the frontend. Browsers authorize once with a one-time code printed in the terminal. Configure or turn it off with `devtools` in `haze.config.ts` or the `haze()` options; production builds never include it.

- [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Queue, scheduler and event fixes found while porting a production backend onto hazejs.
  
  Application context: queued jobs (every driver, including `Queue.fake().drain()`), scheduled tasks (`s.call()` functions, `when()` / `skip()` filters, hooks and the `defineSchedule` callback) and event listeners now run in the context of the application that owns them, so the facades (`Queue`, `Events`, `Cache`, `Mail`, `Storage`, `Notification`, `Broadcast`, `Redis`, `Http`, `Db` from `@hazejs/orm`), `useApp()`, `config()` and `inject()` resolve to that application instead of the most recently booted one. New `runInApp(app, fn)`, `getContextApp()` and `getContextContainer()` exports pin and read that context in scripts and tests; a request entered inside `runInApp()` still takes precedence.
  
  After commit: new `afterCommit(fn)` and `registerAfterCommitHandler(handler)` / `deferUntilCommit(fn)` in `@hazejs/core`, implemented by `@hazejs/orm`, plus `Db.afterCommit(fn)` / `Db.connection(name).afterCommit(fn)`: inside a transaction the callback runs after the outermost commit (before `Db.transaction()` / `Db.commit()` returns; a savepoint hands its callbacks to the enclosing transaction, a rollback drops them; errors are logged), outside a transaction it runs immediately. Jobs accept `defineJob({ afterCommit: true })`, `dispatch(payload, { afterCommit })` and `Job.with(payload).afterCommit()`; a deferred `Job.with().dispatch()` resolves to `{ id, skipped: false, deferred: true }`. Events accept `defineEvent({ afterCommit: true })`, which defers the whole emit including the broadcast.
  
  Scheduling: `defineSchedule((s, app) => …)` passes the application; `s.job()` dispatches to the owning application's queue and accepts `afterCommit`. Jobs whose payload type is `void` / `undefined` (or undeclared) can be dispatched without a payload: `Job.dispatch()`, `Job.with()`, `Queue.dispatch(Job)`, `s.job(Job)` (new `DispatchArgs` / `WithArgs` / `EmitArgs` types); such a payload now stays `undefined` instead of becoming `null`.
  
  Behaviour changes: an event listener that throws (or a queued listener that cannot be dispatched) is now logged with the event and listener names and the remaining listeners still run; `emit()` no longer rejects. Registering two different jobs or two different listeners under the same name (for example `app/job/Cleanup.ts` and `app/job/admin/Cleanup.ts`, or a module's file and a project file) now fails at boot with an error naming both sources instead of silently replacing one. A successful job logs a debug line with its name, duration and attempt, and an `s.job()` task logs "Scheduled job dispatched to the queue". `queue.runInServer` no longer starts a worker for a `sync` connection (it logs a warning) or for a `memory` connection that already consumes the `default` queue, and a worker that fails to start is logged instead of causing an unhandled rejection; `QueueManager.work()` / `haze queue:work` refuse the `sync` connection with a clear error. A unique job that takes its lock in a `memory` cache store while its connection is consumed by another process logs a one-time warning.
  
  CLI: `haze schedule:*`, `queue:*`, `down` / `up` / `maintenance:status`, console commands, `repl`, `openapi`, `db:migrate`, `microservice` and `search:*` now load `@hazejs/core` (and other `@hazejs/*` packages) from the same module instance as the application when its dependencies are externalized (installed in `node_modules`), fixing `Cannot read properties of undefined (reading 'make')` from `schedule:list`.
  
  Types: Redis connection names are generated into a separate `GeneratedRedisConnections` interface, and generated config and policy imports keep their file extension so they resolve under `moduleResolution: "nodenext"` in ESM projects; `connection: 'default'` in `config/cache.ts` no longer fails with "Type 'string' is not assignable to type 'undefined'". `defineCacheConfig` accepts stores added with a conditional spread (new `CacheConfigInput` type).

- [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - `haze route:list --json` writes only the JSON document to stdout; logs printed while the application boots (and hot-update notices) go to stderr, so the output can be redirected to a file or piped to `jq`.
- Updated dependencies [[`cb51e0a`](https://github.com/penna-org/haze/commit/cb51e0aa95ad258aee8cc11e41cabe09448c01de), [`29360c7`](https://github.com/penna-org/haze/commit/29360c700a3f47424f28d4dab07d02afc98fc157), [`011b503`](https://github.com/penna-org/haze/commit/011b503abb98faadea05bd1fd23fa7b3567e728d), [`940711c`](https://github.com/penna-org/haze/commit/940711c72b493eab636beb0fd034ff8f118165bc), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`d90596b`](https://github.com/penna-org/haze/commit/d90596b2225eec4c290042b57dce7d0293569530), [`4da85a8`](https://github.com/penna-org/haze/commit/4da85a83107181f99b029837798be84cb7c8c92a), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`cb51e0a`](https://github.com/penna-org/haze/commit/cb51e0aa95ad258aee8cc11e41cabe09448c01de)]:
  - @hazejs/vite@0.3.0

## 0.2.0

### Minor Changes

- [`2a5031b`](https://github.com/penna-org/haze/commit/2a5031b801e01a23781828e61e76c22bb9554450) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Authentication extensions. New package `@hazejs/oauth` for social login (GitHub, Google, Apple, Microsoft, GitLab, Discord, WeChat, WeChat Official Accounts, QQ, DingTalk, Feishu / Lark, WeCom, Alipay and any OpenID Connect provider) with state, PKCE, nonce and `id_token` verification. Core adds personal access tokens (`token` guard, `ctx.auth.tokenCan()`, `abilities:` / `ability:` middleware), signed email verification (`sendEmailVerification()`, `verifyEmail()`, `verified` middleware), password reset (`PasswordReset.sendLink()` / `reset()`), TOTP two-factor authentication with recovery codes and a session challenge flow (`TwoFactor`), passkeys on top of the optional `@simplewebauthn/server` (`Passkeys`) and an `authRoutes()` helper. `@hazejs/orm` adds database stores for all of them, and `haze make:auth-tables` generates their schema. New projects include token, email verification, password reset and GitHub login endpoints.

- [`704870c`](https://github.com/penna-org/haze/commit/704870c8282875ad5a2d81012a96049e31e77b59) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - User console commands: `defineCommand()` in `app/command/*.ts`, discovered automatically and run with `haze <name>` or `node dist/server/worker.mjs command <name>` in production. New `haze repl` (with `--eval`), `haze make:command` and `haze make:mail`. New projects include an example `inspire` command.

- [`8b3ecb9`](https://github.com/penna-org/haze/commit/8b3ecb968282c5728314d940fb36d8fdc1d2ed94) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - New optional packages. `@hazejs/graphql`: schema-first and code-first GraphQL on graphql-js, GraphQL over HTTP, subscriptions over `graphql-transport-ws`, request-scoped loaders, depth / complexity limits, auth-aware context and GraphiQL. `@hazejs/microservices`: request/reply and events between services over memory, Redis, NATS and gRPC, with handlers discovered from `app/message` and `haze microservice:listen`.

- [`d9523dc`](https://github.com/penna-org/haze/commit/d9523dce1bb88b486d6ba78a41d7760c9d57b70a) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Localization: `lang/<locale>/*.ts`, `t()` / `ctx.locale` with query, cookie and Accept-Language detection, plurals, translated validation errors (valibot, zod) and framework error messages in English and Chinese, localized mail, and typed translation keys. API resources with `defineResource()`, `when()` / `whenLoaded()` and paginated collections, plus `haze make:resource`. Signed route URLs (`router.signedUrl()`, `temporarySignedUrl()`, the `signed` middleware) and `Crypt` (AES-256-GCM from APP_KEY, key rotation with `APP_PREVIOUS_KEYS`).

- [`bae4c9c`](https://github.com/penna-org/haze/commit/bae4c9c44fd056515610a32cc5077b499d536671) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Modules: reusable feature units that bring routes, middleware aliases / groups / global middleware, config defaults, service providers, migrations, jobs, events, listeners, schedules, commands, policies, notifications and broadcast channels into a project. Local modules live in `modules/<name>/` with the same layout as the app and are discovered automatically; module packages are npm packages built with `defineModule()` and enabled in `config/modules.ts` (`defineModulesConfig`), optionally with mount options (`prefix`, `as`, `middleware`, `app`, `connection`) and typed options. Module config defaults merge under the project's config, module providers register before the app's, conflicting middleware aliases and route names report both sources. `@hazejs/orm` runs module migrations before the app's, each tracked in its own `__drizzle_migrations_<module>` table, in `haze db:migrate`, `refreshDatabase()` and the production migration entries; the Vite plugin bundles module migrations, processes linked module packages for hot reload and generates types for module routes and config. New CLI commands `haze make:module` and `haze module:list`, a `--module` option for `make:*` and `db:generate`, a MODULE column in `route:list`, and a `module` template in `create-hazejs` for publishable module packages.

- [`8f7e23e`](https://github.com/penna-org/haze/commit/8f7e23eb48f366ddd8847eb3492cf4b47dbf29a4) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Notifications: `defineNotification()` delivered over mail, database, broadcast, Slack, signed webhooks and WeCom / DingTalk / Feishu bots, queued per channel, with on-demand routes, custom channels, `Notification.fake()`, a database store in `@hazejs/orm` and `haze make:notification` / `make:notifications-table`. Broadcasting: private and presence channels authorized in `app/channel/*.ts`, delivered over WebSocket, SSE and Socket.IO (Redis for multiple instances), events with `broadcastOn`, whispers, `Broadcast.fake()` and the `@hazejs/core/echo` client.

- [`8437ae9`](https://github.com/penna-org/haze/commit/8437ae94e16fef8c96ba64e96fbfad4946c75eec) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - OpenAPI 3.1 documents generated from routes and Standard Schema validators, served at `/openapi.json` with a Scalar or Swagger UI at `/docs` (off in production by default). Routes take `.doc({ summary, tags, response, status, hidden })`; `haze openapi` writes the document. Typegen now emits every named route's inputs and outputs, and `createClient()` from `@hazejs/core/client` gives frontends a typed HTTP client.

- [`b0eaecc`](https://github.com/penna-org/haze/commit/b0eaeccea3472d7b8d095e2f9cc66706c35b8d56) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - New optional package `@hazejs/search`: full-text search for models on the database (MySQL `FULLTEXT`, PostgreSQL `tsvector`, SQLite FTS5, `LIKE`), Meilisearch, Typesense and Elasticsearch / OpenSearch over `fetch`, with index syncing on model events (optionally queued), `haze search:import` / `search:flush` / `search:sync-settings` and `Search.fake()`. Multi-tenancy in core: tenants resolved by domain, subdomain, header, path or a custom resolver, `useTenant()` / `ctx.tenant` / `Tenancy.run()`, per-tenant cache prefixes, storage directories, sessions and queued jobs; the ORM adds a database per tenant and `static belongsToTenant` for a shared database with a tenant column, plus `observeModel()` for model event observers.

### Patch Changes

- Updated dependencies [[`2a5031b`](https://github.com/penna-org/haze/commit/2a5031b801e01a23781828e61e76c22bb9554450), [`704870c`](https://github.com/penna-org/haze/commit/704870c8282875ad5a2d81012a96049e31e77b59), [`8b3ecb9`](https://github.com/penna-org/haze/commit/8b3ecb968282c5728314d940fb36d8fdc1d2ed94), [`d9523dc`](https://github.com/penna-org/haze/commit/d9523dce1bb88b486d6ba78a41d7760c9d57b70a), [`bae4c9c`](https://github.com/penna-org/haze/commit/bae4c9c44fd056515610a32cc5077b499d536671), [`8f7e23e`](https://github.com/penna-org/haze/commit/8f7e23eb48f366ddd8847eb3492cf4b47dbf29a4), [`899ac66`](https://github.com/penna-org/haze/commit/899ac66ec154510893708a3505e956cda0e22eac), [`8437ae9`](https://github.com/penna-org/haze/commit/8437ae94e16fef8c96ba64e96fbfad4946c75eec)]:
  - @hazejs/vite@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies []:
  - @hazejs/vite@0.1.2

## 0.1.1

### Patch Changes

- First release published to npm (0.1.0 was versioned but never reached the registry).
- Updated dependencies []:
  - @hazejs/vite@0.1.1

## 0.1.0

### Minor Changes

- [`0a8b1a0`](https://github.com/penna-org/haze/commit/0a8b1a01afe59845b50cf76ef4a9f39c0ff500af) - First public release of hazejs: routing, IoC container, middleware, validation, ORM and migrations, authentication and authorization, CSRF, rate limiting, cache, queues, scheduler, events, WebSocket and Socket.IO, file storage, mail, testing helpers, the `haze` CLI, the Vite full-stack plugin and deployment presets for node, bun, deno, docker, cloudflare, vercel, netlify and aws-lambda.

### Patch Changes

- Updated dependencies [[`0a8b1a0`](https://github.com/penna-org/haze/commit/0a8b1a01afe59845b50cf76ef4a9f39c0ff500af)]:
  - @hazejs/vite@0.1.0
