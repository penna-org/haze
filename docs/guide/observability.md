# Observability

hazejs ships four observability building blocks:

- **Health checks**: `/health`, `/health/ready` and `/health/live` endpoints for load balancers and orchestrators.
- **OpenTelemetry**: traces and metrics for HTTP requests, queries, queued jobs, mail and AI calls, with W3C trace context propagation. It needs the optional `@opentelemetry/api` package.
- **Dev dashboard**: a page at `/__haze` that records requests, queries, jobs, mail, events, cache operations, logs, exceptions, AI calls and outgoing HTTP requests while you develop.
- **Queue dashboard**: lists failed jobs and lets you retry or delete them. It is a tab of the dev dashboard and can also be mounted in production behind your own middleware.

Log channels (files, HTTP shipping to Loki / Datadog / Better Stack, …) are covered in [Errors & Logging](./errors#channels).

## Health checks

Health checks are on by default, with no checks configured. To add checks, create `config/health.ts`:

```ts
// config/health.ts
import { cacheCheck, dbCheck, defineHealthConfig, queueCheck, redisCheck, storageCheck } from '@hazejs/core'
import { Db } from '@hazejs/orm'

export default defineHealthConfig({
  // path: '/health',
  timeout: 3000,
  checks: {
    db: dbCheck(Db),
    cache: cacheCheck(),
    redis: redisCheck(), // PING on the default connection of config/redis.ts
    storage: { check: storageCheck('s3'), critical: false },
    queue: queueCheck({ connection: 'redis', maxFailed: 100 }),
    payments: async ({ signal }) => {
      const response = await fetch('https://status.example.com/api', { signal })
      return response.ok || { status: 'degraded', message: `status page returned ${response.status}` }
    },
  },
})
```

| Endpoint | Purpose | Response |
|----------|---------|----------|
| `GET /health/live` | Liveness: the process can serve requests | Always `200 { "status": "ok" }` |
| `GET /health`, `GET /health/ready` | Readiness: runs every check in parallel | `200` when `ok` or `degraded`, `503` when `down` |

The readiness response looks like this:

```json
{
  "status": "degraded",
  "checks": {
    "db": { "status": "ok", "latencyMs": 1.42 },
    "storage": { "status": "down", "latencyMs": 3000.4, "message": "timed out after 3000ms" }
  }
}
```

- A check passes when it returns nothing, `true` or a string (shown as `message`). It fails when it returns `false` or throws. It can also return `{ status: 'degraded', message }`.
- A failing **critical** check (the default) makes the status `down`. A failing non-critical check (`critical: false`), or one that returns `degraded`, makes it `degraded`.
- Each check gets a timeout (`timeout`, 5000 ms by default; per check with `{ check, timeout }`). When it runs out, the check's `signal` is aborted.
- Error messages appear in the response outside production. In production they are logged and the response only says `check failed`, so hostnames and connection strings don't leak. Set `verbose: true` to show them anyway.
- `cache: 5000` reuses the readiness result for 5 seconds, so frequent probes don't hammer the database.

The endpoints are served before global middleware: authentication, CSRF and rate limiting don't apply, and responses are not wrapped in the response envelope. If you define your own `GET /health` route, yours wins. Set `enabled: false` to turn them off, or `path` to move them.

Built-in checks:

| Check | What it does |
|-------|--------------|
| `dbCheck(Db, { connection?, query? })` | Runs `select 1` through `@hazejs/orm`'s `Db` (passed in, so core doesn't depend on the ORM) |
| `cacheCheck(store?)` | Writes, reads and deletes a short-lived key |
| `redisCheck(name? \| client)` | `PING` on a [Redis connection](./redis) (default: the `default` one). A name that is not a connection but a cache store gets a cache check on that store (the older form). Or `client.ping()` on an ioredis-style client |
| `storageCheck(disk?)` | Checks that the disk responds (read only) |
| `queueCheck({ connection?, maxFailed? })` | Reports waiting / delayed / active / failed counts; `degraded` above `maxFailed` |

Kubernetes example:

```yaml
livenessProbe:
  httpGet: { path: /health/live, port: 3000 }
readinessProbe:
  httpGet: { path: /health/ready, port: 3000 }
  periodSeconds: 10
```

::: tip Full-stack projects
In full-stack mode the backend only receives `/api/*` in development, so set `path: '/api/health'` if your load balancer goes through the same server.
:::

## OpenTelemetry

hazejs depends only on `@opentelemetry/api`, an optional peer dependency. You install and start the SDK (exporters, sampling, resource) yourself, so you stay in control of where data goes.

```bash
pnpm add @opentelemetry/api @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http \
  @opentelemetry/exporter-metrics-otlp-http @opentelemetry/sdk-metrics
```

```ts
// config/observability.ts
import { defineObservabilityConfig } from '@hazejs/core'

export default defineObservabilityConfig({
  otel: {
    enabled: true,
    // traces: { cache: true },      // cache spans are off by default
    // metrics: false,
    // ignorePaths: ['/health', '/__haze', /^\/assets\//],
  },
})
```

### Starting the SDK

The SDK must start before the application. Put it in a plain `.mjs` file and load it with Node's `--import`:

```js
// instrumentation.mjs
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
node --import ./instrumentation.mjs dist/index.mjs        # production
NODE_OPTIONS='--import ./instrumentation.mjs' haze dev    # development
node --import ./instrumentation.mjs dist/worker.mjs queue # queue workers
```

`NodeSDK` registers the AsyncLocalStorage context manager and the W3C propagator that hazejs relies on. To flush spans on shutdown, call `sdk.shutdown()` from a service provider's `shutdown()` hook, because `app.serve()` exits right after disposing the application. hazejs already creates the HTTP server spans, so leave `@opentelemetry/instrumentation-http` off for incoming requests (or remove it) to avoid duplicates. Outgoing `http` / `undici` instrumentation is fine.

When `otel.enabled` is false (the default), or when the package is missing, every hook is a no-op that costs a single variable check. If `enabled` is true but `@opentelemetry/api` isn't installed, hazejs logs a warning and carries on.

### What is traced

| Span | Kind | Attributes |
|------|------|------------|
| `GET /users/:id` (one per request) | SERVER | `http.request.method`, `url.path`, `url.query`, `url.scheme`, `http.route`, `http.response.status_code`, `server.address`, `server.port`, `user_agent.original`, `error.type` |
| `SELECT`, `INSERT`, … (`@hazejs/orm` queries) | CLIENT | `db.system.name`, `db.query.text`, `db.operation.name`, `db.namespace` (connection) |
| `send <queue>` / `process <queue>` | PRODUCER / CONSUMER | `messaging.system`, `messaging.operation.type`, `messaging.destination.name`, `messaging.message.id`, `haze.job.name`, `haze.job.attempt`, `haze.job.status` |
| `mail.send` | CLIENT | `haze.mail.mailer`, `haze.mail.driver`, `haze.mail.recipients` |
| `chat <model>` / `embeddings <model>` (`@hazejs/ai`) | CLIENT | `gen_ai.operation.name`, `gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.response.finish_reasons` |
| `cache.get`, `cache.set`, … (opt-in) | CLIENT | `haze.cache.store`, `haze.cache.key`, `haze.cache.hit` |
| `GET` (`tracedFetch`, [`Http`](./http-client)) | CLIENT | `http.request.method`, `url.full`, `server.address`, `http.response.status_code` |

Responses with a 5xx status mark the span as an error, and the exception the handler rendered is recorded as a span event. Turn individual span types off with `traces: { db: false, ai: false, … }`. Health check and dashboard paths are ignored by default.

Your own spans nest under the request span automatically:

```ts
import { trace } from '@opentelemetry/api'

const tracer = trace.getTracer('billing')
await tracer.startActiveSpan('charge', async (span) => {
  try {
    await gateway.charge(order)
  }
  finally {
    span.end()
  }
})
```

### Trace context propagation

- **Incoming**: a `traceparent` / `tracestate` header continues the caller's trace.
- **Outgoing HTTP**: every request made with the [`Http` client](./http-client) gets a CLIENT span and sends `traceparent` downstream. `tracedFetch()` does the same for plain `fetch` calls. Without OpenTelemetry both are plain `fetch`.
- **Queues**: `dispatch()` writes the trace context into the job message (`message.context`), and the worker continues the same trace, even in another process or on Redis.
- **Custom transports**: `injectTraceContext(carrier)` writes the current context into a plain object; `withTraceContext(carrier, fn)` runs `fn` inside a context read from one.

```ts
import { injectTraceContext, tracedFetch, withTraceContext } from '@hazejs/core'

const res = await tracedFetch('https://inventory.internal/api/stock', { method: 'POST', body })

await bus.publish('orders', { order, headers: injectTraceContext() })
bus.subscribe('orders', message => withTraceContext(message.headers, () => handle(message.order)))
```

When no propagator is registered, hazejs reads and writes W3C `traceparent` itself.

### Metrics

| Metric | Type | Attributes |
|--------|------|------------|
| `http.server.request.duration` (s) | Histogram | method, scheme, `http.route`, `http.response.status_code`, `error.type` |
| `http.server.active_requests` | UpDownCounter | method, scheme |
| `messaging.process.duration` (s) | Histogram | queue, `haze.job.name`, `error.type` |
| `haze.queue.job.failures` | Counter | queue, `haze.job.name` (jobs that failed after all attempts) |

### Logs

While a span is active, JSON log lines (and every non-console [log channel](./errors#channels)) include `trace_id` and `span_id`, so your log platform can jump from a log line to its trace.

### Cloudflare Workers and other runtimes

The hooks only use `@opentelemetry/api`, so they work on Bun, Deno and Workers. `NodeSDK` is Node-only, though. On Workers you need a Workers-compatible tracer provider (for example a community package built on the OTLP exporter), the `nodejs_compat` flag for AsyncLocalStorage, and to flush spans with `ctx.waitUntil()`. Bun and Deno can use the regular SDK packages if they support the exporter you pick.

## Dev dashboard

In development, open `http://localhost:3000/__haze` (in full-stack projects, the Vite dev server's port). The dashboard records, in memory:

- **Requests**: method, path, route pattern, status, duration, request ID, client IP, and request / response headers (`authorization`, `cookie`, `set-cookie`, `x-api-key` and CSRF tokens are masked).
- **Queries** from `@hazejs/orm`, with bindings and duration.
- **Jobs** dispatched and processed (status, attempt, duration, error).
- **Mail** sent, with a sandboxed preview of the rendered HTML.
- **Events**, **cache** hits / misses / writes, **logs**, **exceptions** (5xx), **AI calls** (model, tokens, latency), and **outgoing HTTP requests** made with [`Http`](./http-client) (method, URL, status, duration, sizes; credentials masked).

Everything is linked to the request that caused it, including jobs that run later and the mail they send. Click a request to see its queries, jobs, mail and logs together. New entries stream in live over Server-Sent Events. When debug mode renders the error page, it links to the request in the dashboard.

The dashboard is a single self-contained page: no CDN, no build step. It is served before global middleware and is **only ever enabled in development**. In production and tests it isn't installed, even if the config says `enabled: true`.

```ts
// config/observability.ts
export default defineObservabilityConfig({
  dashboard: {
    // enabled: false,
    // path: '/__haze',
    limit: 1000, // entries kept per type (ring buffer), default 500
    redactHeaders: ['x-tenant-token'],
    ignorePaths: ['/api/poll'],
  },
})
```

The data is also available as JSON:

| Endpoint | Description |
|----------|-------------|
| `GET /__haze/api/entries?type=query&requestId=&limit=&after=` | Entries, newest first (`type`: `request`, `query`, `job`, `mail`, `event`, `cache`, `log`, `exception`, `ai`) |
| `GET /__haze/api/entries/:id` | One entry |
| `GET /__haze/api/requests/:requestId` | A request and everything linked to it |
| `GET /__haze/api/stats` | Counts per type |
| `GET /__haze/api/stream` | Server-Sent Events: `event: entry` for each new entry |
| `POST /__haze/api/clear` | Clears the buffers |

### How recording works

Core reports through a small in-process telemetry bus. When nobody listens (production without OpenTelemetry), every report is a single `Set.size` check. `@hazejs/orm` and `@hazejs/ai` don't import core for this: they look for the bus at `globalThis[Symbol.for('hazejs.telemetry')]`. Your own packages can report and listen the same way:

```ts
import { onTelemetry, recordTelemetry } from '@hazejs/core'

const stop = onTelemetry((kind, data) => {
  if (kind === 'query' && data.duration > 500)
    console.warn('Slow query', data.sql)
})
```

## Queue dashboard

The **Queues** tab of the dev dashboard shows, for each queue connection (except `sync`), the waiting / delayed / active / failed counts and the failed jobs with their error and payload. You can retry one job, retry all, delete one (forget) or flush all failed jobs, which is the same as `haze queue:retry`, `queue:forget` and `queue:flush`.

To use it in production, mount it in a route file behind your own middleware:

```ts
// route/admin.ts
import { defineRoutes, queueDashboard } from '@hazejs/core'

export default defineRoutes((r) => {
  r.group({ middleware: ['auth', 'can:viewQueues'] }, (r) => {
    queueDashboard(r, { path: '/admin/queues' })
  })
})
```

```ts
// app/policy/abilities.ts
import type { User } from '~/app/model/User'
import { defineAbilities } from '@hazejs/core'

export default defineAbilities({
  viewQueues: (user: User) => user.role === 'admin',
})
```

This registers `GET /admin/queues` (the page) and `/admin/queues/api` (the JSON API). The routes are hidden from OpenAPI. Retry, forget and flush require the `x-haze-dashboard: 1` header, which the page sends along with the `XSRF-TOKEN` cookie value, so they work with CSRF protection and can't be triggered from another site. The default `path` is `/__haze/queues`; in development the dev dashboard answers that path first.

Counts are available for the `memory` and `redis` drivers. Cloudflare Queues are consumed by the Worker, so their failed jobs live in the dead-letter queue you configured in wrangler.
