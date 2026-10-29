# @hazejs/orm

## 0.2.0

### Minor Changes

- [`2a5031b`](https://github.com/penna-org/haze/commit/2a5031b801e01a23781828e61e76c22bb9554450) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Authentication extensions. New package `@hazejs/oauth` for social login (GitHub, Google, Apple, Microsoft, GitLab, Discord, WeChat, WeChat Official Accounts, QQ, DingTalk, Feishu / Lark, WeCom, Alipay and any OpenID Connect provider) with state, PKCE, nonce and `id_token` verification. Core adds personal access tokens (`token` guard, `ctx.auth.tokenCan()`, `abilities:` / `ability:` middleware), signed email verification (`sendEmailVerification()`, `verifyEmail()`, `verified` middleware), password reset (`PasswordReset.sendLink()` / `reset()`), TOTP two-factor authentication with recovery codes and a session challenge flow (`TwoFactor`), passkeys on top of the optional `@simplewebauthn/server` (`Passkeys`) and an `authRoutes()` helper. `@hazejs/orm` adds database stores for all of them, and `haze make:auth-tables` generates their schema. New projects include token, email verification, password reset and GitHub login endpoints.

- [`bae4c9c`](https://github.com/penna-org/haze/commit/bae4c9c44fd056515610a32cc5077b499d536671) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Modules: reusable feature units that bring routes, middleware aliases / groups / global middleware, config defaults, service providers, migrations, jobs, events, listeners, schedules, commands, policies, notifications and broadcast channels into a project. Local modules live in `modules/<name>/` with the same layout as the app and are discovered automatically; module packages are npm packages built with `defineModule()` and enabled in `config/modules.ts` (`defineModulesConfig`), optionally with mount options (`prefix`, `as`, `middleware`, `app`, `connection`) and typed options. Module config defaults merge under the project's config, module providers register before the app's, conflicting middleware aliases and route names report both sources. `@hazejs/orm` runs module migrations before the app's, each tracked in its own `__drizzle_migrations_<module>` table, in `haze db:migrate`, `refreshDatabase()` and the production migration entries; the Vite plugin bundles module migrations, processes linked module packages for hot reload and generates types for module routes and config. New CLI commands `haze make:module` and `haze module:list`, a `--module` option for `make:*` and `db:generate`, a MODULE column in `route:list`, and a `module` template in `create-hazejs` for publishable module packages.

- [`8f7e23e`](https://github.com/penna-org/haze/commit/8f7e23eb48f366ddd8847eb3492cf4b47dbf29a4) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Notifications: `defineNotification()` delivered over mail, database, broadcast, Slack, signed webhooks and WeCom / DingTalk / Feishu bots, queued per channel, with on-demand routes, custom channels, `Notification.fake()`, a database store in `@hazejs/orm` and `haze make:notification` / `make:notifications-table`. Broadcasting: private and presence channels authorized in `app/channel/*.ts`, delivered over WebSocket, SSE and Socket.IO (Redis for multiple instances), events with `broadcastOn`, whispers, `Broadcast.fake()` and the `@hazejs/core/echo` client.

- [`899ac66`](https://github.com/penna-org/haze/commit/899ac66ec154510893708a3505e956cda0e22eac) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Observability: health checks at `/health` (`/health/live`, `/health/ready`, built-in cache / database / Redis / storage / queue checks), optional OpenTelemetry traces and metrics (HTTP, queue jobs with trace propagation, SQL, mail, cache and `gen_ai.*` spans), log channels (stack, JSON, daily files, batched HTTP, custom), and a development dashboard at `/__haze` for requests, queries, jobs, mail, events, cache, logs and AI calls, plus a queue dashboard with retry and forget.

- [`330f4bf`](https://github.com/penna-org/haze/commit/330f4bf99629024e368298990fe890f8a2ddbd3d) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - ThinkPHP (think-orm) feature parity for the ORM. Transactions: manual `Db.startTrans()` / `commit()` / `rollback()`, isolation levels and other options, `Db.inTransaction()`, `Model.transaction()` and row locks with `lock()`. Query builder: joins and aliases, subqueries in `whereIn` / `where` / `whereExists`, `group` / `having` / `distinct`, `union`, JSON paths (`meta->city`), time conditions (`whereTime`, `whereDay`, `whereMonth`, `whereYear`, `whereBetweenTime`…), `whereColumn` / `whereRaw` / `whereExp` / `whereNot` / `whereFindInSet` / `whereJsonContains`, `orderRaw` / `orderField` / `orderRand`, `withoutField` / `fieldRaw`, `insertIgnore` / `upsert` / `replace` / `selectInsert`, `inc` / `dec` / `exp` / `data`, `cursor()` and `paginateX()`, keyed `column()`, query caching with `cache()` and `removeOption()`. Models: global scopes, searchers (`withSearch`), read-only fields, optimistic locking, `allowField` / `force` / `inc`, static `update` / `saveAll` / `destroy(condition)` / `findOrEmpty`, cancellable before events and per-instance or per-query `hidden` / `visible` / `append` / `withAttr`. Relations: `belongsToMany` with pivot data and `attach` / `detach` / `sync`, `hasManyThrough` / `hasOneThrough`, `morphOne` / `morphMany` / `morphTo`, eager loading constraints, `withCount` / `withSum` / `withAvg` / `withMax` / `withMin`, `has` / `hasWhere` / `hasNot`, writes through relations, `bind()` and `withDefault()`.

- [`b0eaecc`](https://github.com/penna-org/haze/commit/b0eaeccea3472d7b8d095e2f9cc66706c35b8d56) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - New optional package `@hazejs/search`: full-text search for models on the database (MySQL `FULLTEXT`, PostgreSQL `tsvector`, SQLite FTS5, `LIKE`), Meilisearch, Typesense and Elasticsearch / OpenSearch over `fetch`, with index syncing on model events (optionally queued), `haze search:import` / `search:flush` / `search:sync-settings` and `Search.fake()`. Multi-tenancy in core: tenants resolved by domain, subdomain, header, path or a custom resolver, `useTenant()` / `ctx.tenant` / `Tenancy.run()`, per-tenant cache prefixes, storage directories, sessions and queued jobs; the ORM adds a database per tenant and `static belongsToTenant` for a shared database with a tenant column, plus `observeModel()` for model event observers.

- [`743e0c6`](https://github.com/penna-org/haze/commit/743e0c646b305b1532357fe09a51e6665ac8fb33) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Snowflake ids and lossless 64-bit integers. `@hazejs/orm/columns` adds `pgSnowflake()`, `mysqlSnowflake()` and `sqliteSnowflake()` columns that generate ids on insert and expose them as decimal strings, plus a `Snowflake` generator compatible with MyBatis-Plus / Hutool (same bit layout and epoch), configured with `snowflake` in `config/database.ts` or the `SNOWFLAKE_WORKER_ID` / `SNOWFLAKE_DATACENTER_ID` environment variables. MySQL connections now enable `supportBigNumbers`, and SQLite / Turso return integers beyond 2^53 as `BigInt` instead of throwing. `BigInt` values are serialized as strings in responses, model `toJSON()`, logs, cache, queue payloads, sessions and WebSocket messages (`jsonReplacer` / `toJsonSafe` in `@hazejs/core`).

### Patch Changes

- Updated dependencies [[`2a5031b`](https://github.com/penna-org/haze/commit/2a5031b801e01a23781828e61e76c22bb9554450), [`1feefd3`](https://github.com/penna-org/haze/commit/1feefd347c59e86ddbb215b0cddb28172a6bce75), [`704870c`](https://github.com/penna-org/haze/commit/704870c8282875ad5a2d81012a96049e31e77b59), [`d9523dc`](https://github.com/penna-org/haze/commit/d9523dce1bb88b486d6ba78a41d7760c9d57b70a), [`bae4c9c`](https://github.com/penna-org/haze/commit/bae4c9c44fd056515610a32cc5077b499d536671), [`8f7e23e`](https://github.com/penna-org/haze/commit/8f7e23eb48f366ddd8847eb3492cf4b47dbf29a4), [`899ac66`](https://github.com/penna-org/haze/commit/899ac66ec154510893708a3505e956cda0e22eac), [`8437ae9`](https://github.com/penna-org/haze/commit/8437ae94e16fef8c96ba64e96fbfad4946c75eec), [`175e253`](https://github.com/penna-org/haze/commit/175e253f1f42dd5466a7c4409c46b04939bbebce), [`b0eaecc`](https://github.com/penna-org/haze/commit/b0eaeccea3472d7b8d095e2f9cc66706c35b8d56), [`743e0c6`](https://github.com/penna-org/haze/commit/743e0c646b305b1532357fe09a51e6665ac8fb33)]:
  - @hazejs/core@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies [[`871c8de`](https://github.com/penna-org/haze/commit/871c8dea99f83cfd80a65ac739baa9010379d85d)]:
  - @hazejs/core@0.1.2

## 0.1.1

### Patch Changes

- First release published to npm (0.1.0 was versioned but never reached the registry).
- Updated dependencies []:
  - @hazejs/core@0.1.1

## 0.1.0

### Minor Changes

- [`0a8b1a0`](https://github.com/penna-org/haze/commit/0a8b1a01afe59845b50cf76ef4a9f39c0ff500af) - First public release of hazejs: routing, IoC container, middleware, validation, ORM and migrations, authentication and authorization, CSRF, rate limiting, cache, queues, scheduler, events, WebSocket and Socket.IO, file storage, mail, testing helpers, the `haze` CLI, the Vite full-stack plugin and deployment presets for node, bun, deno, docker, cloudflare, vercel, netlify and aws-lambda.

### Patch Changes

- Updated dependencies [[`0a8b1a0`](https://github.com/penna-org/haze/commit/0a8b1a01afe59845b50cf76ef4a9f39c0ff500af)]:
  - @hazejs/core@0.1.0
