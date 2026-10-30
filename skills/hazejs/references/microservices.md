# Microservices (`@hazejs/microservices`)

Service-to-service messaging by pattern, NestJS-style: a service declares handlers for patterns like `orders.find`; other services call them with `send()` (request / reply) or `emit()` (fire-and-forget event). The same handlers run over NATS, Redis, gRPC or an in-process memory bus. Snippets use the API-template layout (`config/*.ts`, `app/...`, `route/*.ts`, `~/` = backend `srcDir`); in vue/react projects the same files live under `server/`.

Full guide: [microservices.md](../../../docs/guide/microservices.md) · production listeners: [deployment.md#microservice-listeners](../../../docs/guide/deployment.md)

## Install and register

```bash
pnpm add @hazejs/microservices
pnpm add @nats-io/transport-node              # nats   (legacy `nats` v2 package is used if that is what's installed)
pnpm add ioredis                              # redis
pnpm add @grpc/grpc-js @grpc/proto-loader     # grpc (Node only)
# memory: nothing
```

Transport libraries are optional peers, imported on first use; a missing one throws `The <driver> microservice transport requires "<pkg>". Install it with: pnpm add <pkg>`.

```ts
// app/provider/MicroserviceProvider.ts
import { microservicesProvider } from '@hazejs/microservices'

export default microservicesProvider()   // options: { handlers?: MessageHandler[] } — extra, non-discovered handlers
```

The provider binds `MicroserviceManager` (handlers from `app/message/*.ts` + `options.handlers`), listens on boot when `autoListen` is on, and closes listeners and client connections on app shutdown.

## Configuration

```ts
// config/microservices.ts
import { env } from '@hazejs/core'
import { defineMicroservicesConfig } from '@hazejs/microservices'

export default defineMicroservicesConfig(() => ({
  default: env('MICROSERVICE_TRANSPORT', 'nats'),
  name: 'orders',                 // this service's queue group
  timeout: 5000,
  // listen: ['nats', 'grpc'],
  // autoListen: false,
  transports: {
    nats: { driver: 'nats', servers: env('NATS_URL', 'nats://127.0.0.1:4222') },
    redis: { driver: 'redis', connection: 'default' },           // name from config/redis.ts
    grpc: { driver: 'grpc', url: '0.0.0.0:50051', protoPath: 'proto/orders.proto', package: 'orders' },
    memory: { driver: 'memory' },
  },
}))
```

| Option | Default | Notes |
| --- | --- | --- |
| `default` | first key of `transports` | used by `Microservice.send/emit` and `client()` without a name; no transports → throws |
| `name` | — | queue group (NATS, memory) unless a transport sets `queue`. Same name = instances share work; different names = each service gets its own copy of an event. **Unset (NATS): every instance receives every message** (for requests, first reply wins). Memory ignores the group for `send` (always one subscriber, round-robin) and only fans out `emit` |
| `timeout` | `5000` | default `send()` timeout, ms |
| `listen` | `[default]` | transports served by `microservice:listen`, `autoListen`, `listenMicroservices()` |
| `autoListen` | `false` | listen whenever the app boots (monolith, tests) |
| `transports` | `{}` | named transports (below) |

## Message handlers

Files in `app/message/*.ts` (top level only — not recursive; no `make:` generator) default-export one handler or an array. Anything else throws at boot: `app/message/<file>: default export must be defineMessageHandler(...) or an array of them`.

```ts
// app/message/orders.ts
import { NotFoundException } from '@hazejs/core'
import { defineMessageHandler } from '@hazejs/microservices'
import * as v from 'valibot'
import { Order } from '~/app/model/Order'

export const FindOrder = defineMessageHandler('orders.find', { schema: v.object({ id: v.number() }) }, async ({ id }, ctx) => {
  const order = await Order.find(id)
  if (!order)
    throw new NotFoundException(`Order ${id} not found`)   // caller gets RemoteError 404
  return order                                              // reply (JSON-serialized)
})

export default [
  FindOrder,
  defineMessageHandler('orders.created', async (order: { id: number }, ctx) => {   // event: return value ignored
    ctx.logger.info(`order ${order.id} created (${ctx.kind} via ${ctx.transport})`)
  }),
  defineMessageHandler('OrderService.FindOne', { transport: 'grpc' }, async req => ({ id: req.id })), // only on grpc
]
```

Signatures: `defineMessageHandler(pattern, handle)` or `defineMessageHandler(pattern, { schema?, transport? }, handle)`; `handle(payload, ctx)`. With `schema`, `payload` is the schema's output type.

| Option | Default | Notes |
| --- | --- | --- |
| `schema` | — | any Standard Schema (valibot, zod, arktype); validated via core `validate()`; failure → caller gets `RemoteError` 422 with `issues` |
| `transport` | all listened transports | `'grpc'` or `['nats', 'redis']` |

| `MessageContext` | |
| --- | --- |
| `ctx.pattern`, `ctx.id` | the message |
| `ctx.kind` | `'request'` (`send`) or `'event'` (`emit`) — one handler can serve both |
| `ctx.transport` | transport **name** (config key) it arrived on |
| `ctx.app`, `ctx.logger` | app; child logger tagged `{ pattern, transport }` |
| `ctx.container`, `ctx.make(Token)` | child container per message, disposed afterwards (request-scoped services resolve here) |

`inject()` works only in the synchronous part of the handler (it runs inside `container.call()`); after an `await` use `ctx.make()`.

## Calling other services

```ts
// app/controller/CheckoutController.ts
import type { HttpContext } from '@hazejs/core'
import { Microservice } from '@hazejs/microservices'
import type { Order } from '~/app/model/Order'

export class CheckoutController {
  async show(ctx: HttpContext) {
    const orders = Microservice.client('nats')                       // named transport
    const order = await orders.send<Order>('orders.find', { id: Number(ctx.param('id')) }, { timeout: 3000 })
    await orders.emit('orders.viewed', { id: order.id })
    return order
  }
}
```

| API | Notes |
| --- | --- |
| `Microservice.client(name?)` | `MicroserviceClient` for a configured transport (default if omitted); unknown name throws |
| `Microservice.send(pattern, data?, { timeout? })` / `.emit(pattern, data?)` | default transport |
| `client.send<T>(pattern, data?, { timeout? })` | resolves with the reply; `timeout` ms, defaults to config `timeout` (5000); `0` = wait forever |
| `client.send(Handler, payload)` | pass a shared `defineMessageHandler` definition: payload and reply types inferred (`PayloadOf<H>`, `ReplyOf<H>`) |
| `client.emit(pattern \| Handler, data?)` | resolves once published; never waits for handlers or reports their errors |
| `inject(MicroserviceManager)` / `app.make(MicroserviceManager)` | `.client(name)`, `.transport(name)`, `.listen(opts)`, `.handlers`, `.dispatch(transport, packet)`, `.close()` |

The facade resolves the app via `useApp()` (requests, commands, jobs); it throws `Microservices are not configured: add microservicesProvider() in app/provider` without the provider. Clients connect lazily on first use. Payloads and replies are JSON (gRPC: protobuf) — `Date` → string, class instances → plain objects, `undefined`/functions dropped.

## Errors (all extend `HttpException`, so they render sensibly if they escape a controller)

| Situation | Caller receives | Status / `code` |
| --- | --- | --- |
| handler threw `HttpException` < 500 (`NotFoundException`, `BusinessException`, …) | `RemoteError` | remote status and code, `data` kept |
| payload failed `schema` | `RemoteError` with `.issues` | 422 |
| handler threw anything else (or ≥ 500) | `RemoteError`, message hidden from HTTP clients unless `app.debug` | 502 |
| no reply within timeout | `MicroserviceTimeoutError` | 504, `MICROSERVICE_TIMEOUT` |
| nobody listening (NATS no responders, memory with no subscriber, gRPC server down / unmapped pattern / streaming method) | `MicroserviceUnavailableError` | 503, `MICROSERVICE_UNAVAILABLE` |
| listener has no handler for the pattern (e.g. filtered by `transport`) | `RemoteError` from `NoHandlerError` | 404, `NO_MESSAGE_HANDLER` |

`RemoteError` has `pattern`, `remote` (`SerializedError`: `name, message, status?, code?, data?, issues?`) and `issues`. `serializeError(err)` is exported. Event-handler errors are logged on the receiver (`Microservice message "<pattern>" on <transport> failed`) and never reach the emitter. A timeout does **not** cancel the remote handler; it keeps running.

```ts
import { MicroserviceTimeoutError, MicroserviceUnavailableError, RemoteError } from '@hazejs/microservices'

try { return await Microservice.send('orders.find', { id }) }
catch (e) {
  if (e instanceof RemoteError && e.status === 404) return null
  if (e instanceof MicroserviceUnavailableError || e instanceof MicroserviceTimeoutError) return fallback()
  throw e
}
```

## Running the listener

Handlers receive nothing until a listener runs.

| Where | How |
| --- | --- |
| Dev | `npx haze microservice:listen` (transports from `listen`, else `default`); `-t nats,grpc` / `--transport`. Boots the app in the dev-server module graph without an HTTP port; handler edits apply per message; **new patterns need a restart** |
| Monolith / tests | `autoListen: true` — listens on every app boot (web process, `haze dev`, `worker.mjs` commands, tests) |
| Production worker | a long-running command calling `listenMicroservices(app)` (there is no built-in production entry) |

```ts
// app/command/ListenMessages.ts — run: node dist/worker.mjs command listen:messages
import process from 'node:process'
import { defineCommand } from '@hazejs/core'
import { listenMicroservices } from '@hazejs/microservices'

export default defineCommand({
  description: 'Listen for microservice messages',
  async run(_args, { app }) {
    const listener = await listenMicroservices(app, { transports: ['nats'] }) // default: listen ?? [default]
    app.logger.info(`Listening for ${listener.patterns.length} pattern(s) on ${listener.transports.join(', ')}`)
    await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) })
    await listener.close()   // stop consuming, let in-flight handlers finish
  },
})
```

`listenMicroservices(app, { transports?, resolve? })` → `MicroserviceListener { transports, patterns, close() }` (`resolve: () => Application` dispatches each message to the latest app — used by the dev command). If one transport fails to start, the others are closed and the error is thrown. Listeners need a long-running process: not on serverless / edge presets.

## Transports

### NATS (`driver: 'nats'`)

| Option | Default | Notes |
| --- | --- | --- |
| `servers` | `nats://127.0.0.1:4222` | string or array |
| `prefix` | `''` | subject = `prefix + pattern` |
| `queue` | config `name` | queue group |
| `options` | — | passed to `connect()` (`user`, `pass`, `token`, `tls`, …) |

`send` = NATS request/reply, fails fast with 503 when nobody subscribes. Listeners subscribe with the queue group → each request/event handled by one instance per service; each service gets its own event copy. Expired requests (past deadline) are dropped by the listener. The listener opens its own connection; `close()` drains subscriptions, waits for in-flight handlers, then drains the connection.

### Redis (`driver: 'redis'`)

| Option | Default | Notes |
| --- | --- | --- |
| `connection` | `default` connection (`REDIS_URL`) | named connection from `config/redis.ts` |
| `url` | — | inline address, overrides `connection`; standalone default `REDIS_URL` or `redis://127.0.0.1:6379` |
| `prefix` | `haze:ms:` | key/channel prefix |
| `concurrency` | `10` | requests a listener processes at once (events are not limited) |
| `options` | — | passed to ioredis |

- `send`: `LPUSH <prefix>req:<pattern>` (list TTL `max(timeout, 60s)`), listeners `BRPOP` → exactly one instance handles each request; reply via pub/sub on `<prefix>reply:<clientId>`.
- `emit`: `PUBLISH <prefix>evt:<pattern>` → **every** listening instance of every service receives it (no queue groups, `queue`/`name` ignored).
- Redis can't detect "nobody listening": `send` waits for the full timeout (504, never 503). Requests popped after their deadline are skipped.
- Connections in an app: shared command client for publishing, +1 dedicated subscriber for replies, a listener +2 (`BRPOP`, event subscriber). The connection's `keyPrefix` applies to request lists, not pub/sub channels. Standalone `createTransport()`/`redisTransport()` own and close all their connections.

### gRPC (`driver: 'grpc'`, Node only)

```proto
// proto/orders.proto
syntax = "proto3";
package orders;
service OrderService { rpc FindOne (OrderById) returns (Order); }
message OrderById { int32 id = 1; }
message Order { int32 id = 1; string item = 2; }
```

```ts
grpc: {
  driver: 'grpc',
  url: '0.0.0.0:50051',                       // listener binds; clients connect (use the service host on clients, e.g. 'orders:50051')
  protoPath: 'proto/orders.proto',            // string | string[], relative to process cwd
  package: 'orders',
  methods: { 'OrderService.FindOne': 'orders.find' }, // key: 'Service.Method' or 'pkg.Service.Method'
},
```

| Option | Default | Notes |
| --- | --- | --- |
| `url` | required | bind + connect address |
| `protoPath` | required | no services found → throws |
| `package` | all packages | |
| `methods` | — | unmapped methods use pattern `Service.Method` (e.g. `OrderService.FindOne`) |
| `loader` | `{ keepCase: true, longs: String, enums: String, defaults: true, oneofs: true }` | merged with yours |
| `credentials` | insecure | `{ server: ServerCredentials, client: ChannelCredentials }` |
| `channelOptions` | — | server + client |

- Unary only; streaming methods → `UNIMPLEMENTED` server-side / 503 client-side. Fields not in the proto are dropped; missing fields get proto defaults.
- Error mapping: 400/422 → `INVALID_ARGUMENT`, 401 → `UNAUTHENTICATED`, 403 → `PERMISSION_DENIED`, 404 → `NOT_FOUND`, 409 → `ALREADY_EXISTS`, 429 → `RESOURCE_EXHAUSTED`, 501 → `UNIMPLEMENTED`, 503 → `UNAVAILABLE`, 504 → `DEADLINE_EXCEEDED`, other 4xx → `FAILED_PRECONDITION`, else `INTERNAL`; no handler → `UNIMPLEMENTED`. Full error in `x-haze-error-bin` metadata → hazejs clients get the same `RemoteError`.
- `emit` is a unary call whose result/error is ignored; on the server it arrives with `ctx.kind === 'request'`. Shutdown: graceful, forced after 5 s.

### Memory (`driver: 'memory'`)

`{ driver: 'memory', channel?, queue? }` — `channel` default `'default'`, `queue` default config `name`. Process-global bus per `channel` (survives HMR, shared by all apps in the process). Behaves like a network transport: JSON round-trip, `send` → 503 when no subscriber, async delivery. `send` always goes to **one** subscriber, round-robin across all subscribers of the pattern (queue group ignored); `emit` delivers one copy per queue group (round-robin inside the group) and one to each subscriber without a group. Use for tests and for splitting a monolith into modules before deploying separately.

### Custom (`driver: 'custom'`)

`{ driver: 'custom', create: () => Transport, queue? }`. `Transport` = `{ send(pattern, data, { timeout }), emit(pattern, data), listen({ patterns, dispatch, queue?, onError }) → { close() }, close() }`; helpers/types `Packet`, `Reply`, `Dispatch`. Outside a hazejs app: `createClient(createTransport(config), { timeout })`, or the factories `natsTransport()`, `redisTransport()`, `grpcTransport()`, `memoryTransport()`.

## Deployment topology

- **Gateway + services**: the HTTP app calls `Microservice.client(...)`; each service is its own hazejs app with `app/message/*` and a distinct `name`, running the `listen:messages` command (or `autoListen: true` in its web process). Scale a service by running more instances with the same `name`.
- **Shared contracts**: export handler definitions (or just pattern constants and types) from a shared package so `client.send(FindOrder, …)` is typed on both sides.
- **NATS** for request/reply + once-per-service events; **Redis** when you already have it (but events fan out to every instance); **gRPC** when non-hazejs clients must call in; **memory** for monoliths / tests.
- No persistence or retries: a message sent while nobody listens is lost (NATS/memory fail fast; Redis requests wait in the list until timeout). Use queues for durable work.

## Testing

No fake exists — use the memory transport and listen inside the test (listeners close when `useTestApp` disposes the app).

```ts
// tests/orders.test.ts
import { listenMicroservices, MicroserviceManager, RemoteError } from '@hazejs/microservices'
import { useTestApp } from '@hazejs/testing'
import { expect, it } from 'vitest'

// either MICROSERVICE_TRANSPORT=memory in .env.test (if config reads it) or:
const t = useTestApp({
  configOverrides: { microservices: { default: 'memory', transports: { memory: { driver: 'memory', channel: 'orders-test' } } } },
})

it('finds an order', async () => {
  await listenMicroservices(t.app)
  const client = t.make(MicroserviceManager).client()
  expect(await client.send('orders.find', { id: 1 })).toMatchObject({ id: 1 })
  await expect(client.send('orders.find', { id: 'x' })).rejects.toMatchObject({ status: 422 })
  await expect(client.send('orders.find', { id: 999 })).rejects.toBeInstanceOf(RemoteError)
})

it('gateway route maps remote errors', async () => {
  await listenMicroservices(t.app)
  expect((await t.get('/api/orders/999')).status).toBe(404)
})
```

- Events are delivered asynchronously: poll/wait for side effects after `emit()` before asserting.
- Unit-test a handler without transport: `await t.make(MicroserviceManager).dispatch('memory', { id: '1', pattern: 'orders.find', kind: 'request', data: { id: 1 } })`.
- The memory bus is global per `channel`; use a unique channel per suite if test files run in the same process.

## Gotchas

- Nothing is consumed until a listener runs (`haze microservice:listen`, `autoListen`, or `listenMicroservices`). `haze dev` alone does not listen unless `autoListen: true`.
- `autoListen: true` listens in **every** process that boots the app — web, `haze dev`, `worker.mjs` commands such as `queue:work`, and `microservice:listen` (which then listens twice). Prefer a dedicated listener command in production.
- Set `name` per service. Without it NATS delivers every request to every instance (handlers run N times, first reply wins); memory still routes each `send` to one subscriber but fans `emit` out to every ungrouped subscriber.
- Redis events reach every instance — make event handlers idempotent or use NATS. Redis `send` to a missing service waits the full timeout (504), never 503.
- Patterns are subscribed at listen time: adding a handler/pattern requires restarting the listener (dev too). Handlers only in `app/message/*.ts` (not subfolders) or `microservicesProvider({ handlers })`.
- `inject()` only before the first `await` in a handler; then use `ctx.make()`.
- JSON payloads: no `Date`, `Map`, class instances, `BigInt`. gRPC silently drops fields not in the proto.
- 5xx/unknown remote errors become 502 with the message hidden (unless `app.debug`); log on the service side.
- `timeout: 0` waits forever; a timed-out request may still be executed by the service — make side-effecting handlers idempotent.
- gRPC: Node only, unary only, `protoPath` resolved from the process cwd (copy `.proto` files into the deploy image).
