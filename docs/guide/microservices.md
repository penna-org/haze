# Microservices

`@hazejs/microservices` lets hazejs services talk to each other with message patterns, in the style of NestJS microservices. A service declares handlers for patterns such as `orders.find`; other services call them with `send()` (request / reply) or `emit()` (events, fire-and-forget). The same handlers work over Redis, NATS, gRPC or an in-memory transport for tests.

::: tip Paths
Examples on this page use the API template layout (`app/...`, `config/...`). In a full-stack project these live under `server/`.
:::

## Installation

```bash
pnpm add @hazejs/microservices
# then the client library of the transport you use
pnpm add ioredis                              # redis
pnpm add @nats-io/transport-node              # nats
pnpm add @grpc/grpc-js @grpc/proto-loader     # grpc
```

The transport libraries are optional peer dependencies and are loaded only when a transport of that driver is used. The memory transport needs nothing.

Register the provider:

```ts
// app/provider/MicroserviceProvider.ts
import { microservicesProvider } from '@hazejs/microservices'

// Handlers in app/message are registered automatically
export default microservicesProvider()
```

## Configuration

```ts
// config/microservices.ts
import { env } from '@hazejs/core'
import { defineMicroservicesConfig } from '@hazejs/microservices'

export default defineMicroservicesConfig(() => ({
  default: env('MICROSERVICE_TRANSPORT', 'nats'),
  // This service's name: the queue group on NATS and memory
  name: 'orders',
  timeout: 5000,
  transports: {
    nats: { driver: 'nats', servers: env('NATS_URL', 'nats://127.0.0.1:4222') },
    redis: { driver: 'redis', url: env('REDIS_URL', 'redis://127.0.0.1:6379') },
    grpc: { driver: 'grpc', url: '0.0.0.0:50051', protoPath: 'proto/orders.proto', package: 'orders' },
    memory: { driver: 'memory' },
  },
}))
```

| Option | Description |
| --- | --- |
| `default` | Transport used by `Microservice.send()` / `emit()` and `client()` without a name. Defaults to the first one |
| `name` | Service name, used as the queue group. Instances with the same name share the work; different services each receive events. Without it, every instance receives every message |
| `timeout` | Default `send()` timeout in milliseconds. Default `5000` |
| `listen` | Transports the listener serves. Default: only `default` |
| `autoListen` | Start listening when the app boots (monoliths, tests). Default `false` |
| `transports` | Named transports, see [Transports](#transports) |

## Message handlers

Each file in `app/message/*.ts` default-exports a handler, or an array of handlers, created with `defineMessageHandler(pattern, options?, handle)`:

```ts
// app/message/orders.ts
import { NotFoundException } from '@hazejs/core'
import { defineMessageHandler } from '@hazejs/microservices'
import * as v from 'valibot'
import { Order } from '~/app/model/Order'

export default [
  // Request / reply: the return value is sent back
  defineMessageHandler('orders.find', { schema: v.object({ id: v.number() }) }, async ({ id }) => {
    const order = await Order.find(id)
    if (!order)
      throw new NotFoundException(`Order ${id} not found`)
    return order
  }),

  // Event: the return value is ignored
  defineMessageHandler('orders.created', async (order: { id: number }, ctx) => {
    ctx.logger.info(`order ${order.id} created`)
  }),
]
```

A handler can serve both `send()` and `emit()`; `ctx.kind` tells you which (`'request'` or `'event'`).

| Option | Description |
| --- | --- |
| `schema` | Standard Schema (valibot, zod, arktype …) for the payload. A failure is returned to the caller as a `422` with `issues` |
| `transport` | Only handle the pattern on these transports (`'grpc'` or `['nats', 'redis']`). Default: every listened transport |

The context passed to the handler:

| Member | Description |
| --- | --- |
| `ctx.pattern` / `ctx.kind` / `ctx.id` | The message |
| `ctx.transport` | The transport name it arrived on |
| `ctx.app` / `ctx.logger` | The application and a logger tagged with the pattern |
| `ctx.container` / `ctx.make(key)` | A child [container](./container) for this message, disposed afterwards |

`inject()` works in the synchronous part of the handler, as in a constructor; use `ctx.make()` after an `await`.

## Calling other services

```ts
// app/controller/CheckoutController.ts
import type { HttpContext } from '@hazejs/core'
import { Microservice } from '@hazejs/microservices'

export class CheckoutController {
  async show(ctx: HttpContext) {
    const orders = Microservice.client('nats')
    const order = await orders.send<Order>('orders.find', { id: Number(ctx.param('id')) }, { timeout: 3000 })
    await orders.emit('orders.viewed', { id: order.id })
    return order
  }
}
```

- `Microservice.client(name?)` returns a client for a configured transport. `Microservice.send()` / `Microservice.emit()` use the default transport.
- `send(pattern, data, { timeout })` resolves with the reply. `timeout: 0` waits forever.
- `emit(pattern, data)` resolves once the event is published, without waiting for handlers.
- When the services share code, pass the handler definition instead of a string; payload and reply types are inferred: `client.send(FindOrder, { id: 1 })`.

Clients connect on first use and disconnect when the application shuts down. You can also resolve `MicroserviceManager` from the container (`app.make(MicroserviceManager).client('nats')`).

## Errors

| Situation | Error on the caller | Status |
| --- | --- | --- |
| Handler threw an `HttpException` below 500 (`NotFoundException`, `BusinessException` …) | `RemoteError` with the remote status, `code` and `data` | as remote |
| Payload failed the handler's `schema` | `RemoteError` with `issues` | `422` |
| Handler threw anything else | `RemoteError`; the message is hidden from HTTP clients unless `app.debug` is on | `502` |
| No reply within `timeout` | `MicroserviceTimeoutError` | `504` |
| Nobody listens (NATS no responders, memory, gRPC server down, unmapped gRPC pattern) | `MicroserviceUnavailableError` | `503` |
| Listener has no handler for the pattern | `RemoteError` from `NoHandlerError` | `404` |

All of them extend `HttpException`, so an error that escapes a controller renders with a sensible status. `RemoteError` exposes `pattern`, `remote` (the serialized remote error) and `issues`. Errors thrown by event handlers are logged on the receiving side and never reach the emitter.

Payloads and replies are serialized as JSON (gRPC: protobuf), so dates arrive as strings and class instances as plain objects.

## Running the listener

Handlers only receive messages while a listener runs. In development:

```bash
npx haze microservice:listen                  # transports from `listen` (or `default`)
npx haze microservice:listen --transport nats,grpc
```

The command runs the app in the dev server's module graph without opening the HTTP port. Each message uses the latest code, so edits to a handler apply without a restart; adding a new pattern needs a restart.

In production, call `listenMicroservices(app)` from a worker entry, or set `autoListen: true` to listen inside the web process:

```ts
// worker entry
import { listenMicroservices } from '@hazejs/microservices'

const listener = await listenMicroservices(app, { transports: ['nats'] })
process.once('SIGTERM', async () => {
  await listener.close() // stop consuming, let running handlers finish
  await app.dispose()
})
```

## Transports

### NATS

Uses the official [`@nats-io/transport-node`](https://github.com/nats-io/nats.js) client (the deprecated `nats` v2 package works too if it is installed instead).

| Option | Description |
| --- | --- |
| `servers` | Server URL(s). Default `nats://127.0.0.1:4222` |
| `prefix` | Subject prefix. By default the pattern is the subject (`orders.created`) |
| `queue` | Queue group. Default: the config's `name` |
| `options` | Passed to `connect()` (`user`, `pass`, `token`, `tls` …) |

`send()` is a NATS request / reply and fails immediately with `503` when nobody subscribes. Listeners subscribe with the queue group, so each request and each event is handled by one instance per service, while every service gets its own copy of an event.

### Redis

Uses [ioredis](https://github.com/redis/ioredis).

| Option | Description |
| --- | --- |
| `url` | Default `redis://127.0.0.1:6379` |
| `prefix` | Key and channel prefix. Default `haze:ms:` |
| `concurrency` | Requests a listener processes at once. Default `10` |
| `options` | Passed to ioredis |

- `send()` pushes the request onto a list (`<prefix>req:<pattern>`). Listeners pop with `BRPOP`, so every request is handled by exactly one instance. Replies come back over pub/sub on a channel owned by the caller.
- `emit()` publishes on `<prefix>evt:<pattern>`. Redis pub/sub has no queue groups: **every** listening instance receives every event. Make event handlers idempotent, or use NATS when each service must handle an event once.
- Redis cannot tell that nobody is listening, so `send()` waits until the timeout. Expired requests are skipped when a listener picks them up later.

### gRPC

Node only, using [`@grpc/grpc-js`](https://github.com/grpc/grpc-node) and `@grpc/proto-loader`. Unary methods in your `.proto` file are mapped to message patterns, and the same handlers serve them.

```proto
// proto/orders.proto
syntax = "proto3";
package orders;

service OrderService {
  rpc FindOne (OrderById) returns (Order);
}
message OrderById { int32 id = 1; }
message Order { int32 id = 1; string item = 2; }
```

```ts
// config/microservices.ts (excerpt)
transports: {
  grpc: {
    driver: 'grpc',
    url: '0.0.0.0:50051',          // the listener binds here; clients connect here
    protoPath: 'proto/orders.proto',
    package: 'orders',
    methods: { 'OrderService.FindOne': 'orders.find' }, // otherwise the pattern is 'OrderService.FindOne'
  },
},
```

| Option | Description |
| --- | --- |
| `url` | Address the listener binds to and clients connect to |
| `protoPath` | One or more `.proto` files |
| `package` | Only use services from this proto package |
| `methods` | Method → pattern. Unlisted methods use `Service.Method` |
| `loader` | `@grpc/proto-loader` options. Defaults: `keepCase`, `longs: String`, `enums: String`, `defaults`, `oneofs` |
| `credentials` | `{ server, client }` TLS credentials. Default: insecure |
| `channelOptions` | Passed to the gRPC server and client |

Handler errors map to gRPC status codes (404 → `NOT_FOUND`, 422 → `INVALID_ARGUMENT`, 401 → `UNAUTHENTICATED` …) and the full error travels in the `x-haze-error-bin` metadata, so hazejs clients get the same `RemoteError` as on the other transports.

Limits: unary calls only (streaming methods answer `UNIMPLEMENTED`); payloads are encoded with the proto definition, so fields it does not declare are dropped; `emit()` is a unary call whose result is ignored; not available on Bun, Deno or edge runtimes.

### Memory

In-process, for tests or for splitting a monolith into modules before deploying them separately. Clients and listeners in the same process share a bus (`channel`, default `default`). It behaves like a network transport: payloads go through JSON, `send()` fails with `503` when nobody listens, and queue groups balance work the way NATS does.

### Custom transports

`{ driver: 'custom', create: () => transport }` plugs in your own implementation of the `Transport` interface (`send`, `emit`, `listen`, `close`). `createTransport(config)` and `createClient(transport)` also work outside a hazejs app.

## Testing

Use the memory transport and listen in the test:

```ts
// tests/orders.test.ts
import { listenMicroservices, MicroserviceManager } from '@hazejs/microservices'
import { expect, it } from 'vitest'
import { createApp } from './app'

it('finds an order', async () => {
  const app = await createApp({ microservices: { default: 'memory', transports: { memory: { driver: 'memory' } } } })
  await listenMicroservices(app)
  const order = await app.make(MicroserviceManager).client().send('orders.find', { id: 1 })
  expect(order).toMatchObject({ id: 1 })
})
```

## Limitations

- There is no message persistence or retry. Use [queues](./queues) for work that must survive restarts.
- Patterns are subscribed when the listener starts; new patterns need a restart.
- Redis events reach every instance (see above); the memory transport only works within one process.
