---
name: hazejs-migration
description: Migrate an existing Node.js backend (Fastify, Express, Koa, Hono, NestJS or a hand-rolled http server) to the hazejs framework (@hazejs/core) without rewriting its business logic. Use when the user wants to replace, port, move or "switch the backend to hazejs", assess how hard such a migration would be, keep an existing API contract while changing the web framework, or verify that a hazejs port behaves exactly like the original (tests as an oracle, benchmarks, end-to-end checks). Also use when wiring hazejs into a codebase that already has its own container, router abstraction, error format or Drizzle setup.
---

# Migrating a Node.js backend to hazejs

This skill is distilled from a real migration: a 32k-line Fastify 5 + awilix admin backend (RBAC, approval engine, AI gateway with SSE, chunked uploads with Range, socket.io, demo mode) moved to hazejs with **all 403 integration tests passing unchanged in behaviour**, 103 fewer dependencies and throughput within noise of Fastify. Read [references/fastify-mapping.md](references/fastify-mapping.md) for the concrete adapter code and [references/verification.md](references/verification.md) for the verification checklist. For other source frameworks see [references/other-frameworks.md](references/other-frameworks.md). For hazejs APIs themselves, use the `hazejs` skill.

## Strategy: swap the kernel, keep the business layer

Do not rewrite controllers and services into idiomatic hazejs in the same change. Migrate in two steps:

1. **Kernel swap (this skill).** Replace the web framework, DI container and plugins underneath the project's *own* abstractions (its `Router`/`Controller` helpers, `Cradle`/container types, error class, logger interface). Business modules keep compiling against the same interfaces. The existing test suite proves behaviour is unchanged.
2. **Idiomatic follow-ups (optional, later).** Move pieces to native hazejs features one at a time (e.g. `defineResource`, `inject()`, `@hazejs/orm` models), each with green tests.

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
- **Streams, files, SSE**: return Web `Response` objects (`new Response(Readable.toWeb(stream), { status, headers })`); detect client disconnect with `ctx.req.signal`; raw request bodies via `Readable.fromWeb(ctx.req.body)`.
- **Sockets**: attach socket.io (or any protocol needing the Node server) through `registerServerExtension({ name, matches, node: server => io.attach(server) })` — or use `@hazejs/socket.io` if you are free to change the server code.
- **Lifecycle**: start background services in a provider's `boot()`, stop them in `shutdown()`; `app.serve()` handles SIGINT/SIGTERM (stop listening → wait in-flight → dispose providers).
- **Test client**: provide an `inject()` compatible with the old one on top of `app.fetch()` so test files barely change.

## Phase 3 — verify

Work through [references/verification.md](references/verification.md): full suite, typecheck, lint, architecture rules, bundle, runtime-only install, real server smoke (HTTP, SSE, sockets, shutdown), browser walkthrough, interleaved benchmark against the old version. Only edit tests for *equivalent* differences (attribute order, header casing, richer health payload) and say so explicitly.

## Gotchas found in practice

- hazejs wraps results in `{ code, message, data }` and returns **422** for validation unless you change the formatter/handler — the most common contract break.
- Route parameters are URL-decoded (since the fix made during this migration); older hazejs builds were not.
- `throttle:max,window` buckets are keyed by *spec + user/IP*, so two routes with the same numbers share a counter. For per-route limits register a named limiter per route (`config.set('throttle.limiters.<name>', { max, window, key })`) and call `throttle(ctx, next, name)`.
- The default rate-limit store is process-global; when tests boot several apps in one process, pass a per-app `throttle.store`.
- Per-route middleware runs **before** validation (validation happens when the handler runs) — keep auth (401) and demo/maintenance guards (403) ahead of 400s, as Fastify's `onRequest` did.
- Audit/access logging that needs the final status belongs in `ctx.onResponse(response => …)`; it also sees errors rendered by the exception handler.
- `ctx.setHeader()` headers are merged into a `Response` you return, so security headers still apply to streams and files.
- socket.io's `io.close()` throws (and never calls back) if it was never attached to a server — guard it in tests that don't listen.
- SPA fallback only answers requests whose `Accept` contains `text/html`; JSON/fetch callers get the JSON 404.
- Cookie attribute order differs from other frameworks (`Max-Age` before `Path`); compare attributes as a set in tests. `ctx.setCookie` defaults to `Secure` outside debug — pass `secure: ctx.secure` for http intranet deployments.
- Until `@hazejs/*` is on npm, vendor it as a tarball (`pnpm --filter @hazejs/core pack --pack-destination vendor`, dependency `file:vendor/hazejs-core-<v>.tgz`) and bundle it into `dist`; a `link:` to a path outside the repo breaks Docker builds.
- `@hazejs/orm` cannot yet take drizzle's `casing`, a PostgreSQL session time zone or an existing client; keep the project's own drizzle setup during the kernel swap.
