# @hazejs/core

The hazejs runtime: application lifecycle, IoC container, routing, middleware, exception handling, validation, auth & authorization, sessions, cache, queues, scheduler, events, WebSocket, file storage and mail — on top of [h3 v2](https://h3.dev).

## Install

```bash
pnpm add @hazejs/core
```

## Usage

```ts
import { createApplication, defineRoutes } from '@hazejs/core'

const app = await createApplication({
  routes: [
    defineRoutes(r => r.get('/hello', () => ({ message: 'Hello, hazejs!' })))
  ],
})
app.serve({ port: 3000 })
```

Most projects use it through the `haze` CLI or the Vite plugin, which discover `app/`, `config/` and `route/` automatically. Optional drivers are peer dependencies — install only what you use (`ioredis`, `bullmq`, `@upstash/redis`, `nodemailer`, `@aws-sdk/client-s3`, …).

Part of [hazejs](https://github.com/penna-org/haze) — see the main README for documentation.

## License

[MIT](./LICENSE)
