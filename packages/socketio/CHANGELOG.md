# @hazejs/socket.io

## 0.2.0

### Minor Changes

- [`8f7e23e`](https://github.com/penna-org/haze/commit/8f7e23eb48f366ddd8847eb3492cf4b47dbf29a4) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Notifications: `defineNotification()` delivered over mail, database, broadcast, Slack, signed webhooks and WeCom / DingTalk / Feishu bots, queued per channel, with on-demand routes, custom channels, `Notification.fake()`, a database store in `@hazejs/orm` and `haze make:notification` / `make:notifications-table`. Broadcasting: private and presence channels authorized in `app/channel/*.ts`, delivered over WebSocket, SSE and Socket.IO (Redis for multiple instances), events with `broadcastOn`, whispers, `Broadcast.fake()` and the `@hazejs/core/echo` client.

- [`175e253`](https://github.com/penna-org/haze/commit/175e253f1f42dd5466a7c4409c46b04939bbebce) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Unified Redis connections. New `config/redis.ts` (`defineRedisConfig`) declares named connections: a URL or host / port / password / db / TLS, Cluster, Sentinel or a custom client factory, each with an optional `keyPrefix`. Without the file there is one implicit `default` connection reading `REDIS_URL`. The cache `redis` store, the BullMQ queue driver, WebSocket broadcasting, the broadcasting bus, the Socket.IO Redis adapter and the microservices Redis transport accept `connection: '<name>'` (default: the `default` connection), so a single `REDIS_URL` configures all of them; the inline `url` / `options` / `client` forms keep working and take precedence. A shared `RedisManager` opens one command connection per name (kept across hot reloads, closed on shutdown) and dedicated connections for subscribers and blocking commands; BullMQ receives the settings with `keyPrefix` removed and `maxRetriesPerRequest: null`. New `Redis` facade and `useRedis()`, `redisCheck(name)` pings a connection (cache store names still work), and connection names are typed from the generated config. ioredis is loaded through one helper with a single install hint. New projects include `config/redis.ts`, and their cache, queue, WebSocket and Socket.IO configs reference `connection: 'default'`.

### Patch Changes

- Updated dependencies [[`2a5031b`](https://github.com/penna-org/haze/commit/2a5031b801e01a23781828e61e76c22bb9554450), [`1feefd3`](https://github.com/penna-org/haze/commit/1feefd347c59e86ddbb215b0cddb28172a6bce75), [`704870c`](https://github.com/penna-org/haze/commit/704870c8282875ad5a2d81012a96049e31e77b59), [`d9523dc`](https://github.com/penna-org/haze/commit/d9523dce1bb88b486d6ba78a41d7760c9d57b70a), [`bae4c9c`](https://github.com/penna-org/haze/commit/bae4c9c44fd056515610a32cc5077b499d536671), [`8f7e23e`](https://github.com/penna-org/haze/commit/8f7e23eb48f366ddd8847eb3492cf4b47dbf29a4), [`899ac66`](https://github.com/penna-org/haze/commit/899ac66ec154510893708a3505e956cda0e22eac), [`8437ae9`](https://github.com/penna-org/haze/commit/8437ae94e16fef8c96ba64e96fbfad4946c75eec), [`175e253`](https://github.com/penna-org/haze/commit/175e253f1f42dd5466a7c4409c46b04939bbebce), [`b0eaecc`](https://github.com/penna-org/haze/commit/b0eaeccea3472d7b8d095e2f9cc66706c35b8d56), [`743e0c6`](https://github.com/penna-org/haze/commit/743e0c646b305b1532357fe09a51e6665ac8fb33)]:
  - @hazejs/core@0.2.0

## 0.1.2

### Patch Changes

- Updated dependencies [[`871c8de`](https://github.com/penna-org/haze/commit/871c8dea99f83cfd80a65ac739baa9010379d85d)]:
  - @hazejs/core@0.1.2

## 0.1.1

### Patch Changes

- First release published to npm (0.1.0 was versioned but never reached the registry).
- Updated dependencies []:
  - @hazejs/core@0.1.1

## 0.1.0

### Minor Changes

- [`0a8b1a0`](https://github.com/penna-org/haze/commit/0a8b1a01afe59845b50cf76ef4a9f39c0ff500af) - First public release of hazejs: routing, IoC container, middleware, validation, ORM and migrations, authentication and authorization, CSRF, rate limiting, cache, queues, scheduler, events, WebSocket and Socket.IO, file storage, mail, testing helpers, the `haze` CLI, the Vite full-stack plugin and deployment presets for node, bun, deno, docker, cloudflare, vercel, netlify and aws-lambda.

### Patch Changes

- Updated dependencies [[`0a8b1a0`](https://github.com/penna-org/haze/commit/0a8b1a01afe59845b50cf76ef4a9f39c0ff500af)]:
  - @hazejs/core@0.1.0
