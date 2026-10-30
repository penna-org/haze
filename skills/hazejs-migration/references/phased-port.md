# Porting a large backend in phases

After the kernel swap, the reference project (a 32k-line Fastify admin backend, 292 routes, 403 integration tests) was rebuilt **idiomatically** on hazejs: `app/` + `config/` + 18 local modules (`modules/<name>/{module.ts,route/,app/{provider,job,event,listener},schedule/}`), `inject()` everywhere, `r.group` + `[Controller, 'action']`, a JWT guard with a Gate fallback for permission codes, `@hazejs/socket.io`, `@hazejs/orm`, jobs / schedules / listeners instead of timers, the `haze` toolchain and the docker preset. Every route kept its method, path and middleware chain; the suite stayed green after every phase (403 → 410 tests). This page is what made that work. API details are in the `hazejs` skill.

## Order of phases

1. Shared code first, switch imports to `~/`.
2. Temporary DI bridge (old name-based injection and `inject()` side by side).
3. All file moves in one commit.
4. Per-module conversion — can run in parallel (several people / agents), one module per change: routes through an endpoint helper, services to `inject()`, repositories to the ORM.
5. Auth, permissions and the error contract.
6. Background work → jobs, schedules, listeners.
7. Delete the bridge and the old adapters; Docker end-to-end.

Run the full suite, `tsc` and lint after each step; compare `haze route:list --json` against the route table captured before (method, path, middleware) to prove routing did not drift.

## (a) Shared code first, then the `~/` alias

Move the cross-cutting code (`app/support`, `app/shared`, `app/middleware`, exceptions, env, i18n helpers) into the hazejs layout before any module, and rewrite imports to `~/app/...`. Modules then only change their own files.

**Exception: schema / model table files keep relative imports.** drizzle-kit loads `database/schema/*.ts` (and any file they import) outside Vite, where `~/` does not resolve. Keep those files importing only `drizzle-orm` and relative paths.

## (b) A temporary DI bridge

With dozens of services still written as `constructor(deps: Pick<Cradle, 'userService' | ...>)`, converting them one by one requires that the old name and the class resolve to **the same singleton**:

```ts
// app/support/legacy-container.ts — delete when the last module is converted
import type { Container, Token } from '@hazejs/core'
import { createToken } from '@hazejs/core'

const tokens = new Map<string, Token<unknown>>()
const tokenOf = (name: string) => tokens.get(name) ?? tokens.set(name, createToken(name)).get(name)!

export function bridge(container: Container, registry: Record<string, new (...args: any[]) => unknown>) {
  const cradle = new Proxy({} as Cradle, { get: (_, name) => typeof name === 'string' ? container.make(tokenOf(name)) : undefined })
  for (const [name, Class] of Object.entries(registry)) {
    if (Class.length > 0) // not converted yet: `constructor(deps)` gets the cradle
      container.singleton(Class, () => new Class(cradle))
    container.singleton(tokenOf(name), () => container.make(Class)) // old name → the instance inject(Class) returns
  }
  return cradle
}
```

Converted classes (`private users = inject(UserService)`, no constructor parameters) need no binding — the container builds them on first use. Bind on `app.container` so framework services (Logger, Config) and business services share one container; circular dependencies are reported with the chain.

## (c) Centralize file moves before parallel work

Do every rename / move (old `src/modules/x/*` → `modules/x/...`, controllers, routes, jobs) in **one** mechanical commit with imports fixed and tests green, then start converting. Parallel workers that also move files produce conflicting imports and duplicate files; workers that only edit file contents merge cleanly.

## (d) A declarative endpoint helper

The old router took one options object per route (summary, permission, schemas, response, rate limit, demo flag, audit options). Keep that object and map it onto hazejs route methods, so route files change shape but not content:

```ts
// app/support/http/endpoint.ts
export function endpoints(tag: string) {
  return (route: Route, o: EndpointOptions): Route => {
    const schemas = Object.fromEntries(Object.entries({ params: o.params, query: o.query, body: o.body }).filter(([, s]) => s))
    if (Object.keys(schemas).length)
      route.validate(schemas)
    const permissions = o.permission ? [o.permission].flat() : []
    return route
      .doc({ summary: o.summary, tags: [tag], response: o.response && wireSchema(o.response), security: o.public ? [] : [{ bearer: [] }], extensions: permissions.length ? { 'x-permission': permissions } : {} })
      .meta({ summary: o.summary, response: o.response, bodyLimit: o.bodyLimit, demo: o.demo, auditBody: o.auditBody })
      .middleware(
        'audit',
        ...(o.public ? [] : ['auth', ...permissions.map(code => `can:${code}`)]), // aliases: OpenAPI adds 401/403
        'demo',
        ...(o.rateLimit ? [`throttle:per-minute-${o.rateLimit.max}`] : []),
        'bodyLimit',
        'vo', // innermost: encodes the handler's raw value with meta.response
      )
  }
}

// modules/biz/route/purchase.ts
const api = endpoints('Purchases')
export default defineRoutes((r) => {
  r.group({ prefix: '/biz/purchases' }, (r) => {
    api(r.get('/', [PurchaseController, 'list']), { summary: 'List', permission: 'biz:purchase:list', query: PurchaseQuery, response: pageOf(PurchaseVo) })
  })
})
```

Keep the middleware as **alias strings** (registered in `config/middleware.ts`), not per-route closures: `route:list` stays readable and OpenAPI recognises `auth` / `can:`.

## (e) Meta-driven middleware via `ctx.route`

Each alias reads what the route declared from `ctx.route.meta` (and the pattern from `ctx.route.path`): the audit log takes `meta.summary` and skips the body when `meta.auditBody === false`; `bodyLimit` sets `ctx.bodyLimit = meta.bodyLimit`; the demo-mode guard allows writes only when `meta.demo` is set; `vo` runs `z.safeEncode(meta.response, await next())` and passes `Response` / streams through. Per-route throttle buckets come from a limiter whose `key` includes `ctx.route.path`. One middleware instance serves every route.

## (f) Controllers are per request — side effects belong at boot

Controllers are request-scoped and singletons are built on first use. A service that registered something in its constructor (a binding into the approval engine, a timer, a listener on another library) used to be created at container build time; now it is created on the first request that touches it — or never in a worker process. Create such services in a provider:

```ts
// modules/biz/app/provider/PurchaseProvider.ts
export default defineProvider({ boot: app => app.onBooted(() => app.make(PurchaseBinding).register()) })
```

## (g) Module providers boot before app providers

Module providers run first, then `app/provider/*`. If the app provider opens / waits for the database, loads settings or registers the Gate fallback, module providers must wait with `app.onBooted(cb)` (runs after every provider's `boot`, awaited, still part of boot). Use `onBooted` for anything that touches the database from a module.

## (h) Keep the API contract in the exception handler

Let framework middleware throw framework exceptions and translate them once:

- `ValidationException` (422) → the old status (400) and field paths (`body.x`, `querystring.x`);
- `UnauthorizedException` → old codes (`error.code` is `'unauthenticated'` or `'token_invalid'` from the `auth` middleware);
- `AuthorizationException` (403) → old `forbidden` code, message naming `error.abilities` when `error.reason` is empty;
- `UniqueConstraintException` (409, `code: 'unique_violation'`) → the old conflict code;
- `NotFoundException` for unmatched routes → the old `route_not_found`.

OpenAPI still shows 422 for validation (a known limitation) — document the real status in the handler or the docs.

## (i) ORM conversion rules

- **Reads, filters, joins** → `Db.table(t)` with explicit `field()`; for "row + a few joined columns" use `field({ ...getTableColumns(t), ownerName: users.name })` or nest a whole table `field({ log: logs, user: users })` (nullable after `leftJoin`, typed when in the same chain). Pass drizzle conditions straight to `where()` — `where(undefined)` is ignored, so `where(scopeSql)` from a data-permission service works when the scope is empty. Wrap reusable base queries in functions (builders are mutable).
- **Writes** → models (`create`, `save`, `Model.updateById(id, values)` for single-statement updates, `Model.query().delete(id)`), so timestamps, read-only fields and optimistic locks apply. Pass ``sql`now()` `` where the database clock matters — `create()` uses the app clock.
- **Keep complex SQL on drizzle**: statistics, recursive CTEs, a library's own storage, `skip locked` queues. `Db.drizzleSync()` / `Db.drizzle()` are transaction-aware; a library that opens its own transaction joins with `Db.joinTransaction(tx, fn)`.
- **Unique constraints**: catch `UniqueConstraintException` and switch on `error.constraint` (also `table`, `columns`, `detail`; parsed for PostgreSQL, MySQL, SQLite, MongoDB) instead of matching driver codes. Keep a fallback that walks `cause` for `23505` on writes still done with raw drizzle.
- Model queries are fully typed now — wrong column names that used to compile become errors; fix them, don't cast.
- Add `expectTypeOf` checks for the query shapes you rely on (joined nullable columns, `column()` types); type regressions don't fail runtime tests.

## (j) Background timers → jobs, schedules, listeners

| Old | New |
| --- | --- |
| `setInterval` in a service started at boot | `defineJob` (with `withoutOverlapping()` middleware when runs must not overlap) + `s.job(Job).everyMinute().onOneServer()` in `modules/<m>/schedule/*.ts` |
| fire-and-forget call after a state change | `defineEvent` + `defineListener` (sync, or `queue: true` for slow work); `afterCommit: true` when it must not see uncommitted data |
| retry loop / outbox poller | job with `tries` + `backoff`, plus a schedule that re-dispatches what was missed |

- Jobs and listeners get services with `job.app.make(Service)` / `ctx.app.make(Service)`; payload-less jobs take `_payload: void` and dispatch with `Job.dispatch()` / `s.job(Job)`.
- **Write-backs that must commit with the main change stay in-process** in the same transaction (a direct call, a sync hook). Only side effects (notifications, webhooks, AI reviews) move to listeners / jobs. If the transaction belongs to another library (approval engine), `afterCommit` inside `Db.joinTransaction` fires before that library's COMMIT — keep wrapping the library's commit for post-commit work.
- Listener bodies: use block bodies — an arrow returning a service's `false` stops the remaining listeners. Listener errors are logged and isolated, so a listener failure no longer fails the request.
- Make jobs idempotent (claim rows, outbox status); `database` `retryAfter` above the longest `timeout`.

## (k) Docker: web / queue / scheduler

- One image, roles by command: one-shot `migrate` (`node server/migrate.mjs && node server/worker.mjs command db:init`), `app` (web), `queue` (`worker.mjs queue --connection database`), `scheduler` (`worker.mjs schedule`), plus postgres and redis. Disable the HTTP healthcheck on queue / scheduler containers.
- A `WORKER_IN_SERVER` env var drives `runInServer` in `config/queue.ts` and `config/schedule.ts`: on for the single-container demo (in-memory database), off in the split topology.
- Redis carries what crosses containers: the Socket.IO adapter (jobs in `queue` push to browsers on `app`), schedule / job-middleware locks (`store: 'redis'`).
- Migrations are bundled into `migrate.mjs` (the `virtual:haze/migrations` files; an in-process PGlite can run them at boot with `runMigrations({ files })`). `migrate.mjs` boots every provider against the not-yet-migrated database, so providers must check that tables exist before reading them. There is no production seed entry — seed through an idempotent app command.
- `stop_grace_period` (e.g. 15 s) > `app.shutdownTimeout` (e.g. 8 s), so open WebSockets are closed by the app, not killed.
- Verify in the topology, not only in tests: empty database → ready, migrate twice (0 the second time), restart `app` (tokens survive), SIGTERM with a browser connected, a job in `queue` reaching the browser, uploads / Range / ETag, SSE first byte.
