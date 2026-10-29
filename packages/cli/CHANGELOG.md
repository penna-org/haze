# @hazejs/cli

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
