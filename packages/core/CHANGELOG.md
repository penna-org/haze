# @hazejs/core

## 0.1.2

### Patch Changes

- [`871c8de`](https://github.com/penna-org/haze/commit/871c8dea99f83cfd80a65ac739baa9010379d85d) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - `app.url` now defaults to the `APP_URL` environment variable, so absolute links such as `Storage.temporaryUrl()` on local disks work without adding `url` to `config/app.ts`. An explicit `url` in `config/app.ts` still takes precedence.

## 0.1.1

### Patch Changes

- First release published to npm (0.1.0 was versioned but never reached the registry).

## 0.1.0

### Minor Changes

- [`0a8b1a0`](https://github.com/penna-org/haze/commit/0a8b1a01afe59845b50cf76ef4a9f39c0ff500af) - First public release of hazejs: routing, IoC container, middleware, validation, ORM and migrations, authentication and authorization, CSRF, rate limiting, cache, queues, scheduler, events, WebSocket and Socket.IO, file storage, mail, testing helpers, the `haze` CLI, the Vite full-stack plugin and deployment presets for node, bun, deno, docker, cloudflare, vercel, netlify and aws-lambda.
