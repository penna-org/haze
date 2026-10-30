---
name: hazejs-migration
description: Migrate an existing Node.js backend (Fastify, Express, Koa, Hono, NestJS or a hand-rolled http server) to the hazejs framework (@hazejs/core) without rewriting its business logic. Use when the user wants to replace, port, move or "switch the backend to hazejs", assess how hard such a migration would be, keep an existing API contract while changing the web framework, or verify that a hazejs port behaves exactly like the original (tests as an oracle, benchmarks, end-to-end checks). Also use when wiring hazejs into a codebase that already has its own container, router abstraction, error format or Drizzle setup.
---

# Migrating a Node.js backend to hazejs

This skill is distilled from a real migration: a 32k-line Fastify 5 + awilix admin backend (RBAC, approval engine, AI gateway with SSE, chunked uploads with Range, socket.io, demo mode) moved to hazejs with **all 403 integration tests passing unchanged in behaviour**, 103 fewer dependencies and throughput within noise of Fastify. Read [references/fastify-mapping.md](references/fastify-mapping.md) for the concrete adapter code, [references/phased-port.md](references/phased-port.md) for the follow-up idiomatic rebuild of the same backend, and [references/verification.md](references/verification.md) for the verification checklist. For other source frameworks see [references/other-frameworks.md](references/other-frameworks.md). For hazejs APIs themselves, use the `hazejs` skill.

## Strategy: swap the kernel, keep the business layer

Do not rewrite controllers and services into idiomatic hazejs in the same change. Migrate in two steps:

1. **Kernel swap (this skill).** Replace the web framework, DI container and plugins underneath the project's *own* abstractions (its `Router`/`Controller` helpers, `Cradle`/container types, error class, logger interface). Business modules keep compiling against the same interfaces. The existing test suite proves behaviour is unchanged.
2. **Idiomatic follow-ups (optional, later).** Move pieces to native hazejs features (`inject()`, `route/` + controllers, guards and policies, `@hazejs/orm`, jobs / schedules / listeners, the `haze` toolchain), each phase with green tests — see "Porting a large backend in phases" below.

This works when the project already funnels framework access through a thin layer. If handlers use `req`/`reply` everywhere, first introduce such a layer *on the old framework*, get tests green, then swap.

## Phase 1 — assess (before touching code)

1. Run the full test suite and record the baseline (pass/skip counts, duration). This is the oracle.
2. Inventory framework touchpoints:
   ```bash
   grep -rln "from 'fastify'\|@fastify/\|express\|koa\|awilix\|inversify" src tests scripts
   grep -rn "ctx\.request\|ctx\.reply\|req\.\|res\.\|reply\.\|\.raw\b" src/modules | wc -l
   ```
   Classify each hit: routing / validation / serialization / errors / auth hooks / rate limit / security headers / CORS / static files / streaming & SSE / raw request bodies & uploads / cookies / sockets / lifecycle & shutdown / logging / OpenAPI / test client.
3. Note the **wire contract** you must keep: error body shape and status codes (hazejs defaults to a `{ code, message, data }` envelope and 422 for validation), success body shape, header names, cookie attributes, path parameter decoding, trailing slashes, HEAD handling.
4. Estimate: kernel files (usually `core/`, `middleware/`, `app.ts`, `main.ts`) + N leaf call sites. Report difficulty as *low* (< 10 leaf sites, no sockets/streams), *medium* (streams, uploads, sockets, custom DI) or *high* (handlers use the framework directly everywhere).

## Phase 2 — build the new kernel

Follow the mapping in [references/fastify-mapping.md](references/fastify-mapping.md). The essentials:

- **Create the app programmatically** with `new Application({ mode, env: false, config, exceptionHandler, routes, providers, static })` when the project validates its own environment (pass `env: false`) and needs tests to inject a database. Boot with `await app.boot()`.
- **Turn off the envelope** if the API returns bare data: `config.app.response.envelope = false`.
- **Bridge the container**: keep name-based injection by mapping each name to a `createToken(name)` on the *application's* root container (`app.container`), so business services and framework services share one container.
- **Translate routes**: the project's `Router` registers hazejs routes with `.validate({ params, query, body })` (Zod/Valibot are Standard Schema), `.doc({ summary, tags, response, security, extensions })`, and per-route middleware built from the route's declared options (auth, permissions, rate limit, audit, body limit).
- **Serialize responses yourself** if the old framework did (e.g. `z.safeEncode(responseSchema, result)` to strip fields and encode `Date`); document the *encoded* shape.
- **Keep the error format** in an `ExceptionHandler` subclass whose `render()` returns the old body and maps `ValidationException` (422) to the old status/paths.
- **Streams, files, SSE**: return Web `Response` objects (`new Response(Readable.toWeb(stream), { status, headers })`); use `ctx.sse(source)` for SSE (heartbeat, disconnect cleanup and `stream.signal` built in); raw request bodies via `Readable.fromWeb(ctx.req.body)`.
- **Sockets**: attach socket.io (or any protocol needing the Node server) through `registerServerExtension({ name, matches, node: server => io.attach(server) })` — or use `@hazejs/socket.io` if you are free to change the server code.
- **Lifecycle**: start background services in a provider's `boot()`, stop them in `shutdown()`; `app.serve()` handles SIGINT/SIGTERM (stop listening → wait in-flight → force-close WebSockets / SSE after `app.shutdownTimeout` → dispose providers).
- **Test client**: provide an `inject()` compatible with the old one on top of `app.fetch()` so test files barely change.

## Phase 3 — verify

Work through [references/verification.md](references/verification.md): full suite, typecheck, lint, architecture rules, bundle, runtime-only install, real server smoke (HTTP, SSE, sockets, shutdown), browser walkthrough, interleaved benchmark against the old version. Only edit tests for *equivalent* differences (attribute order, header casing, richer health payload) and say so explicitly.

## Porting a large backend in phases

What worked when the same 32k-line backend was rebuilt idiomatically (18 local modules, 292 routes unchanged, 410 tests). Details and code in [references/phased-port.md](references/phased-port.md).

- **Shared code first**, imports switched to the `~/` alias — except schema / model table files, which keep relative imports (drizzle-kit cannot resolve the alias).
- **A temporary DI bridge** so `constructor(deps)` name-based injection and `inject(Class)` resolve the same singleton; modules convert independently (in parallel), the bridge is deleted at the end.
- **All file moves in one commit** before parallel work; parallel workers only edit contents.
- **A declarative endpoint helper** maps the old route-options object onto `.validate()` / `.doc()` / `.meta()` / `.middleware()` with alias strings (`'auth'`, `` `can:${code}` ``, `throttle:…`), so route files keep their content and OpenAPI still sees 401/403.
- **Meta-driven middleware**: audit log, body limit, demo guard and response encoding are single aliases reading `ctx.route.meta` / `ctx.route.path`.
- **Controllers are created per request** and singletons on first use: services that registered side effects in their constructor must be created at boot (`app.onBooted(() => app.make(Service))`).
- **Module providers boot before app providers**: anything needing the database (opened by an app provider) goes in `app.onBooted()`.
- **Keep the API contract** by mapping `ValidationException`, `UnauthorizedException` (`code`), `AuthorizationException` (`abilities`), `UniqueConstraintException` and route 404s in the exception handler.
- **ORM rules**: `Db.table()` for reads / joins (explicit `field()`, nested `field({ row: table })`), models for writes (`updateById`, timestamps, locks), complex SQL stays on drizzle, unique conflicts via `UniqueConstraintException.constraint`.
- **Timers → jobs + schedules + listeners**; write-backs that must commit with the main change stay in-process in the same transaction; listeners use block bodies (a returned `false` stops the rest).
- **Docker**: one image as `migrate` / `app` / `queue` / `scheduler` with Redis (Socket.IO adapter, locks); `WORKER_IN_SERVER` → `runInServer` for single-process; migrations bundled in `migrate.mjs`; providers tolerate an unmigrated database; `stop_grace_period` > `app.shutdownTimeout`.

## Gotchas found in practice

- hazejs wraps results in `{ code, message, data }` and returns **422** for validation unless you change the formatter/handler — the most common contract break.
- Route parameters are URL-decoded (since the fix made during this migration); older hazejs builds were not. Other fixes from the same ports, so check your hazejs version before working around them: `ctx.origin` / `ctx.secure`, precompressed static files, `ctx.sse()`, `ctx.route`, `AuthorizationException`, `app.onBooted()`, `runInServer`, `afterCommit`, `app.shutdownTimeout`, app-scoped jobs / listeners / schedules, `haze` commands loading one copy of `@hazejs/core`.
- `throttle:max,window` buckets are keyed by *spec + user/IP*, so two routes with the same numbers share a counter. For per-route limits register a named limiter per route (`config.set('throttle.limiters.<name>', { max, window, key })`) and call `throttle(ctx, next, name)`.
- The default rate-limit store is process-global; when tests boot several apps in one process, pass a per-app `throttle.store`.
- Per-route middleware runs **before** validation (validation happens when the handler runs) — keep auth (401) and demo/maintenance guards (403) ahead of 400s, as Fastify's `onRequest` did.
- Audit/access logging that needs the final status belongs in `ctx.onResponse(response => …)`; it also sees errors rendered by the exception handler.
- `ctx.setHeader()` headers are merged into a `Response` you return, so security headers still apply to streams and files.
- socket.io's `io.close()` throws (and never calls back) if it was never attached to a server — guard it in tests that don't listen.
- SPA fallback only answers requests whose `Accept` contains `text/html`; JSON/fetch callers get the JSON 404.
- Cookie attribute order differs from other frameworks (`Max-Age` before `Path`); compare attributes as a set in tests. `ctx.setCookie` defaults to `Secure` outside debug — pass `secure: ctx.secure` for http intranet deployments.
- To use unreleased framework fixes, vendor `@hazejs/*` as a tarball (`pnpm --filter @hazejs/core pack --pack-destination vendor`, dependency `file:vendor/hazejs-core-<v>.tgz`) and bundle it into `dist`; a `link:` to a path outside the repo breaks Docker builds.
- Keep the project's drizzle queries and move only connections, transactions and migrations to `@hazejs/orm`: `casing: 'snake_case'`, `timezone`, `driver: 'node-postgres'` (same `pg` driver), `client` (share one PGlite between test apps), `Db.drizzleSync()` behind the repository's `db` getter, `Db.joinTransaction(tx, fn)` for libraries that open their own drizzle transactions, `runMigrations()` (same `drizzle.__drizzle_migrations` table, so deployed databases do not re-run migrations).
- With several app instances in one test process, jobs, listeners and scheduled tasks already resolve facades (including `Db`) to their own app. Code the app runs from its own `setTimeout` / emitter callbacks does not: wrap it in `runInApp(app, fn)` or `Db.withManager(app.make(DatabaseManager), fn)`, otherwise one app can query another app's database.
- Vendored tarballs: name them with a content hash (`hazejs-orm-0.2.0-<hash>.tgz`) — pnpm caches `file:` tarballs by path and will not notice a re-packed file with the same name.

## Known framework limitations (open as of M32)

Work around these in the app (and say so in the report); check `docs/design.md` in the framework repo for newer status.

- Validation is fixed at 422 in OpenAPI; remap the status in the exception handler.
- The default rate-limit store is process-global and `throttle:max,window` buckets are shared per spec — per-app `throttle.store`, per-route keys via `ctx.route.path`.
- `app.request()` / `@hazejs/testing` cannot set the client IP — build a `Request` and set `ip` (see the `inject()` shim).
- `registerServerExtension` is only documented in the skills, not the guide.
- `new Application({ routes, providers })` that need objects created from the app's container must be declared first and assigned after construction.
- The ORM connection pool is keyed by connection name per process: two apps with different *owned* configs for one name replace each other (pass `client` instead). `Db.drizzleSync()` always uses the writer; `timezone` needs startup parameters (not forwarded by PgBouncer).
- `migrate.mjs` boots every provider before migrating (providers must tolerate missing tables); production builds have no seed entry (use an app command).
- Socket.IO server state is process-level: a second app in the same process reuses the first `io`.
- `Model.create()` timestamps use the app clock — write ``sql`now()` `` where the database clock matters.
- `afterCommit` inside `Db.joinTransaction()` runs when the callback returns, before the outer library commits; no listener-level `afterCommit` (wrap with `afterCommit(() => …)`); not for MongoDB / D1.
- App context covers only framework entry points (requests, jobs, listeners, scheduled tasks); the app's own timers inherit their creation context.
- No per-job `retryAfter` (it is per connection); `join()` with a SQL condition does not accept `undefined`.
