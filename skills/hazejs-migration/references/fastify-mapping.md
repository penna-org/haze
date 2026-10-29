# Fastify (+ awilix + @fastify plugins) → hazejs

Concept mapping and the adapter code used in the reference migration. Snippets are trimmed from working code; adapt names to the project. All hazejs imports come from `@hazejs/core`.

## Mapping table

| Fastify world | hazejs | Notes |
| --- | --- | --- |
| `Fastify({ logger, trustProxy, bodyLimit })` | `new Application({ config: { app: { trustProxy, bodyLimit }, logger: { level, format } } })` | `format: 'json'` in production, `'pretty'` in dev |
| `app.register(plugin, { prefix })` scopes | route groups / per-route middleware | hazejs has no encapsulated plugin scopes; build middleware lists per route |
| `fastify-type-provider-zod` validator | `route.validate({ params, query, body })` | Zod 4 is Standard Schema; results in `ctx.validated` |
| zod serializer (`safeEncode`) | call `z.safeEncode(schema, result)` in your route wrapper | hazejs does not serialize by schema |
| `setErrorHandler` | `class AppExceptionHandler extends ExceptionHandler` | `render()` returns the body; `shouldReport()` filters logging |
| `setNotFoundHandler` | `NotFoundException` in the handler's `render()` | hazejs throws it for unmatched routes |
| `onRequest` hook (auth) | route middleware `(ctx, next) => …` | `ctx.set('auth', …)` with a `ContextState` augmentation |
| `onResponse` hook (audit) | `ctx.onResponse(response => …)` inside a route middleware | sees the final status, including rendered errors |
| `preSerialization` hook | your route wrapper before encoding | e.g. masking fields |
| `@fastify/rate-limit` per route | built-in `throttle` with a named limiter per route | see "Rate limiting" below |
| `@fastify/helmet` | global middleware `secureHeaders` + `config.secureHeaders` | COOP / Origin-Agent-Cluster / HSTS only over https |
| `@fastify/cors` | global middleware `cors` + `config.cors` | |
| `@fastify/static` (`preCompressed`, notFound → index.html) | `static: { dir, spaFallback: true, precompressed: true, exclude }` | runs after global middleware; HTML gets `no-cache` |
| `@fastify/swagger` + Scalar | `config.openapi` (`path`, `docsPath`, `ui: 'scalar'`), `generateOpenAPI(app)` | vendor fields via `.doc({ extensions: { 'x-…': … } })` |
| awilix PROXY container | `Container` + one `createToken(name)` per name | see "Container bridge" |
| `reply.header/code/send(stream)` | return `new Response(body, { status, headers })` or `ctx.status()` / `ctx.setHeader()` | |
| `reply.raw.on('close')` | `ctx.req.signal` (aborts when the client disconnects early) | |
| `addContentTypeParser('*', raw)` | `Readable.fromWeb(ctx.req.body)` and skip `ctx.body()` | |
| `request.protocol` / `request.host` | `ctx.origin`, `ctx.secure` (honour `app.trustProxy`) | |
| `request.ip` | `ctx.ip` (X-Forwarded-For only with `app.trustProxy`) | |
| `app.server` for socket.io | `registerServerExtension({ name, matches, node })` | attached when `serve()` creates the Node server |
| `app.listen()` | `app.serve({ port, hostname, silent })` → srvx server (`.ready()`, `.url`, `.node.server`, `.close()`) | |
| `close-with-grace` | built into `serve()`; release resources in provider `shutdown()` | |
| `app.inject()` | `app.fetch(new Request(...))` (wrap it, see below) | |
| `app.ready()` hooks | provider `boot()` | `app.boot()` runs providers then compiles routes |
| pino `log.info(obj, msg)` | `Logger.info(msg, obj)` | wrap if business code is pino-style |

## Application assembly

```ts
import { Application, defineRoutes } from '@hazejs/core'

export async function buildApp({ env, db, onClose }: BuildOptions) {
  // Objects that need the application (its container / config) are assigned after `new Application`;
  // routes and providers only use them during boot.
  let container: Container
  let pipeline: RoutePipeline
  const app = new Application({
    mode: env.NODE_ENV,
    env: false, // the project validates its own env (e.g. with Zod)
    config: {
      app: { name: 'my-api', debug: false, trustProxy: env.TRUST_PROXY, response: { envelope: false }, bodyLimit: 2 * 1024 * 1024 },
      logger: { level: env.LOG_LEVEL, format: env.NODE_ENV === 'production' ? 'json' : 'pretty' },
      middleware: { global: ['secureHeaders', ...(env.CORS_ORIGIN.length ? ['cors'] : [])] },
      secureHeaders: { contentSecurityPolicy: false },
      cors: { origin: env.CORS_ORIGIN },
      throttle: { store: localRateLimitStore() },
      openapi: { enabled: env.DOCS_ENABLED, path: '/docs/openapi.json', docsPath: '/docs', envelope: false },
      health: { path: '/health', checks: { database: async () => void (await db.execute(sql`select 1`)) } },
    },
    exceptionHandler: AppExceptionHandler,
    routes: [defineRoutes(r => registerControllers(r, container, modules, pipeline))],
    providers: [{
      async boot() { for (const s of backgroundServices(container)) await s.start(context) },
      async shutdown() {
        for (const s of backgroundServices(container).reverse()) await s.stop()
        await onClose?.() // close the database last
      },
    }],
  })
  container = createAppContainer({ env, db, logger }, modules, app.container)
  pipeline = { middleware: route => [audit(route), authenticate(route), rateLimit(route)].filter(Boolean) }
  await app.boot()
  return app
}
```

## Container bridge (keep `constructor(deps: Pick<Cradle, ...>)`)

```ts
import { Container as HazeContainer, createToken } from '@hazejs/core'
import type { Token } from '@hazejs/core'

const tokens = new Map<string, Token<unknown>>()
function tokenOf(name: string): Token<unknown> {
  let token = tokens.get(name)
  if (!token)
    tokens.set(name, (token = createToken(name)))
  return token
}

export class Container {
  readonly cradle: Cradle
  constructor(readonly haze = new HazeContainer()) {
    // Resolved on access, so constructors that read `deps.userService` create it lazily (singletons)
    this.cradle = new Proxy({} as Cradle, { get: (_, name) => typeof name === 'string' ? this.resolve(name as keyof Cradle) : undefined })
  }
  value<K extends keyof Cradle>(name: K, value: Cradle[K]) { this.haze.instance(tokenOf(name), value); return this }
  singleton<K extends keyof Cradle>(name: K, Class: new (deps: Cradle) => Cradle[K]) {
    this.haze.singleton(tokenOf(name), () => new Class(this.cradle)); return this
  }
  resolve<K extends keyof Cradle>(name: K): Cradle[K] { return this.haze.make(tokenOf(name)) as Cradle[K] }
}
```

(`erasableSyntaxOnly` projects cannot use parameter properties — assign fields in the constructor body instead.) Pass `app.container` as `haze` so business singletons live in the framework's root container; unit tests can still `new Container().value('repo', fake).singleton('service', Service)`.

## Route wrapper

```ts
const route = builder[method](url, async (http: HttpContext) => {
  const v = http.validated as Record<string, unknown>
  const body = options.body ? v.body
    : isRaw(http) ? (http.req.body ? Readable.fromWeb(http.req.body as never) : Readable.from([]))
    : method === 'GET' ? undefined : await http.body()
  const ctx = { params: options.params ? v.params : http.params(), query: options.query ? v.query : http.query(), body, http, /* auth getters */ }
  const result = await handler(ctx)
  if (result instanceof Response || !options.response) return result
  const encoded = z.safeEncode(options.response, result)
  if (!encoded.success) throw new AppError(500, ['…', 'Internal server error'])
  return encoded.data
})
if (schemas) route.validate(schemas) // { params, query, body } that are set
route
  .doc({ summary, tags, response: wireSchema(options.response), security: options.public ? [] : [{ bearer: [] }],
    extensions: { 'x-permission': permissions } })
  .middleware(...pipeline.middleware({ method, url, options }))
```

Document the *encoded* response (what goes over the wire): wrap the Zod schema so OpenAPI reads its input side.

```ts
export function wireSchema(schema: z.ZodType) {
  const json = () => z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })
  return { '~standard': { version: 1 as const, vendor: 'zod', validate: (value: unknown) => ({ value }), jsonSchema: { input: json, output: json } } }
}
```

## Error format

```ts
export class AppExceptionHandler extends ExceptionHandler {
  override shouldReport(error: unknown) {
    return error instanceof AppError ? error.statusCode >= 500 : super.shouldReport(error)
  }
  override render(error: unknown, ctx: HttpContext) {
    const body = toBody(error, ctx) // { statusCode, code, message, details? }
    ctx.set('failure', body.message) // for the audit log
    ctx.status(body.statusCode)
    if (HTTPError.isError(error)) error.headers?.forEach((v, k) => ctx.setHeader(k, v)) // retry-after etc.
    return body
  }
}
// ValidationException → 400 with details [{ path: `${target === 'query' ? 'querystring' : target}.${issue.path}`, message }]
// NotFoundException → 404 route_not_found; TooManyRequestsException → 429; HTTPError 400 /json/i → invalid JSON body; 413 → too large
```

## Rate limiting per route

```ts
export function rateLimiter(config: Config) {
  let index = 0
  return ({ method, url, options }: RouteInfo): MiddlewareHandler | undefined => {
    if (!options.rateLimit) return undefined
    const name = `route${index++}`
    config.set(`throttle.limiters.${name}`, {
      max: options.rateLimit.max,
      window: 60, // seconds, or '1m'
      key: (ctx: { ip?: string }) => `${method} ${url}:${ctx.ip ?? 'unknown'}`,
    })
    return (ctx, next) => throttle(ctx, next, name)
  }
}
```

Pass a per-application store (`config.throttle.store`) implementing `RateLimitStore` (`hit(key, windowSeconds)`, `reset(key)`) if several apps run in one process.

## Audit log after the response

```ts
const audit: MiddlewareHandler = (ctx, next) => {
  ctx.onResponse((response) => {
    const auth = ctx.get('auth')
    if (auth) logs.record({ userId: auth.userId, status: response.status, durationMs: performance.now() - ctx.startedAt, error: ctx.get('failure') })
  })
  return next()
}
```

Put it first in the route's middleware list so it also records requests rejected by later middleware (403).

## Streams, files and SSE

```ts
// File download with Range / ETag
return new Response(Readable.toWeb(await driver.open(key, range)) as ReadableStream<Uint8Array>, { status: 206, headers })

// SSE with disconnect handling
const abort = new AbortController()
ctx.http.req.signal.addEventListener('abort', () => abort.abort(), { once: true })
const stream = new ReadableStream<Uint8Array>({
  start(controller) { /* enqueue encoded `event: …\ndata: …\n\n`, close when done */ },
  cancel: () => abort.abort(),
})
return new Response(stream, { headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' } })
```

## socket.io on the same port

```ts
const io = new Server({ serveClient: false, cors })
registerServerExtension({
  name: 'realtime',
  matches: pathname => pathname === '/socket.io' || pathname.startsWith('/socket.io/'),
  node: (server) => { io.attach(server); attached = true },
})
// on stop: unregisterServerExtension('realtime', extension); if (attached) await new Promise(r => io.close(() => r()))
```

## Test client compatible with `app.inject()`

```ts
async inject({ method = 'GET', url, headers, payload, remoteAddress = '127.0.0.1' }) {
  const h = new Headers(headers)
  let body: string | Uint8Array | undefined
  if (payload !== undefined) {
    if (typeof payload === 'string' || payload instanceof Uint8Array) body = payload
    else { body = JSON.stringify(payload); if (!h.has('content-type')) h.set('content-type', 'application/json') }
  }
  const request = new Request(new URL(url, 'http://localhost'), { method, headers: h, body })
  Object.defineProperty(request, 'ip', { value: remoteAddress }) // h3 reads the client IP from request.ip
  const response = await app.fetch(request)
  const raw = Buffer.from(await response.arrayBuffer())
  return { statusCode: response.status, headers: Object.fromEntries(response.headers), body: raw.toString('utf8'), rawPayload: raw, json: () => JSON.parse(raw.toString('utf8')) }
}
```

## Listening (tests that need real sockets, and `main.ts`)

```ts
const server = app.serve({ hostname: '127.0.0.1', port: 0, silent: true })
await server.ready()
server.url           // http://127.0.0.1:54321/
server.node?.server  // node:http Server
await server.close(true) // closeAllConnections, then app.dispose()
```

`serve()` installs SIGINT/SIGTERM handlers: stop listening → wait for in-flight requests → `dispose()` (providers' `shutdown()` in reverse) → exit.
