# @hazejs/microservices

Message-pattern microservices for hazejs: request / reply (`send`) and events (`emit`) over Redis, NATS, gRPC or an in-memory transport, with handlers discovered from `app/message/*.ts` and optional Standard Schema validation.

## Install

```bash
pnpm add @hazejs/microservices
pnpm add ioredis                              # redis transport
pnpm add @nats-io/transport-node              # nats transport
pnpm add @grpc/grpc-js @grpc/proto-loader     # grpc transport
```

## Usage

```ts
// app/message/orders.ts
import { defineMessageHandler } from '@hazejs/microservices'

export default defineMessageHandler('orders.find', async ({ id }: { id: number }) => ({ id, status: 'paid' }))
```

```ts
// anywhere in another service
import { Microservice } from '@hazejs/microservices'

const order = await Microservice.client('orders').send('orders.find', { id: 1 }, { timeout: 3000 })
await Microservice.client('orders').emit('orders.created', order)
```

Run the listener with `haze microservice:listen`.

Part of [hazejs](https://github.com/penna-org/haze) — see the main README for documentation.

## License

[MIT](./LICENSE)
