# @hazejs/ai

## 1.0.0

### Major Changes

- [#14](https://github.com/penna-org/haze/pull/14) [`80169cf`](https://github.com/penna-org/haze/commit/80169cf2ae0ad9159fe1dc50d71a845c6fb91a6b) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - hazejs 1.0, the first stable release. All `@hazejs/*` packages and `create-hazejs` share version 1.0.0 and follow semantic versioning from here on: breaking changes only land in a new major, with an upgrade guide.
  
  Security fixes included in this release:
  
  - **Rate limiting behind proxies.** With `app.trustProxy`, `ctx.ip` is now the `X-Forwarded-For` entry appended by the nearest trusted proxy (the rightmost) instead of the leftmost one, which the client can set itself; previously a client could get a fresh `throttle` bucket per request by sending its own `X-Forwarded-For`. `trustProxy` also accepts the number of trusted hops (`trustProxy: 2` behind a CDN and a load balancer). The Cloudflare Workers entry passes `cf-connecting-ip` and the AWS Lambda adapter passes the event's `sourceIp` as the client address, so on those platforms `ctx.ip` works without `trustProxy` and `throttle` no longer counts every anonymous request under one shared key. New `setClientAddress(request, ip)` export for custom entries; `throttle` logs a warning once when no client address is known.
  - **Two-factor login lockout.** Wrong codes are counted per user in the cache (new `twoFactor.cacheStore` option, default store) for `challengeTtl`, not in the session cookie the client holds, so replaying the login cookie no longer resets `maxAttempts`. After `maxAttempts` wrong codes the user cannot complete a challenge until `challengeTtl` has passed, even after entering the password again.
  - **Passkey challenges.** In `challenge: 'session'` mode a used challenge is also recorded in the cache, so an old session cookie cannot replay a registration or authentication response.
  
  Packaging: `@hazejs/cli` depends on `@hazejs/vite` with a caret range instead of an exact version, every package has `main` / `types` fallbacks for older module resolution, and `@hazejs/microservices` declares the legacy `nats` client as an optional peer dependency.

### Patch Changes

- Updated dependencies [[`80169cf`](https://github.com/penna-org/haze/commit/80169cf2ae0ad9159fe1dc50d71a845c6fb91a6b)]:
  - @hazejs/core@1.0.0

## 0.5.0

### Patch Changes

- Updated dependencies [[`57b3b34`](https://github.com/penna-org/haze/commit/57b3b34daf04d05252f6fc5e0cd059b6676ca116)]:
  - @hazejs/core@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [[`a7d7a1b`](https://github.com/penna-org/haze/commit/a7d7a1b2c351570511883fe28cc743e2b86f5c0f)]:
  - @hazejs/core@0.4.0

## 0.3.0

### Minor Changes

- [`ea86d01`](https://github.com/penna-org/haze/commit/ea86d0175adf24563dc62ce796e602a04fbe6dcd) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - `app.introspect()` returns a serializable snapshot of the application: modules with what each one contributes (routes, providers, jobs, schedules, events, listeners, middleware), sub-apps, routes, global middleware, middleware aliases and groups with their owning module, providers, container bindings (`container.bindings()`), events with their listeners (`EventManager#events()`), queue jobs and scheduled tasks with their next run. Scheduled task runs are reported as `schedule` telemetry and shown in a new Schedule tab of the dev dashboard; request entries record the route name and module. When the dev dashboard is on, AI calls also record their messages, tools, output and tool calls (truncated); other telemetry consumers such as OpenTelemetry never receive them.

### Patch Changes

- Updated dependencies [[`7b5e0a9`](https://github.com/penna-org/haze/commit/7b5e0a95b73edbeac5aa5570483b2cbe2daf2eb8), [`cb51e0a`](https://github.com/penna-org/haze/commit/cb51e0aa95ad258aee8cc11e41cabe09448c01de), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`f46d960`](https://github.com/penna-org/haze/commit/f46d960fb67f600e402f3ba371f83c3a8f3592cb), [`ea86d01`](https://github.com/penna-org/haze/commit/ea86d0175adf24563dc62ce796e602a04fbe6dcd), [`940711c`](https://github.com/penna-org/haze/commit/940711c72b493eab636beb0fd034ff8f118165bc), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`4da85a8`](https://github.com/penna-org/haze/commit/4da85a83107181f99b029837798be84cb7c8c92a), [`bd81767`](https://github.com/penna-org/haze/commit/bd817672b975e2475a7644214396915d5f247f9b), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4), [`15e802d`](https://github.com/penna-org/haze/commit/15e802d5f341a9928720189ed49a9cba8ff168f2), [`a5fd5cf`](https://github.com/penna-org/haze/commit/a5fd5cfa6753af24f147959b29ef6af4a31c99c4)]:
  - @hazejs/core@0.3.0

## 0.2.0

### Minor Changes

- [`2c163ab`](https://github.com/penna-org/haze/commit/2c163abd3d3d1d0162bc38a9e4e5d47cc0417bb1) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - New package `@hazejs/ai`: one API for OpenAI, Anthropic, Gemini, Azure OpenAI, AWS Bedrock, Cloudflare Workers AI and OpenAI-compatible providers (DeepSeek, Qwen, Kimi, GLM, Doubao, SiliconFlow, OpenRouter, Groq, xAI, Mistral, Ollama) — text generation, streaming, tool loops, structured output, embeddings and knowledge bases, agents with conversation memory, images, speech, MCP client and server, `useChat` for Vue and React, AI SDK UI compatibility and `AI.fake()` for tests. New projects include a streaming chat endpoint and chat UI.

- [`899ac66`](https://github.com/penna-org/haze/commit/899ac66ec154510893708a3505e956cda0e22eac) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Observability: health checks at `/health` (`/health/live`, `/health/ready`, built-in cache / database / Redis / storage / queue checks), optional OpenTelemetry traces and metrics (HTTP, queue jobs with trace propagation, SQL, mail, cache and `gen_ai.*` spans), log channels (stack, JSON, daily files, batched HTTP, custom), and a development dashboard at `/__haze` for requests, queries, jobs, mail, events, cache, logs and AI calls, plus a queue dashboard with retry and forget.

### Patch Changes

- Updated dependencies [[`2a5031b`](https://github.com/penna-org/haze/commit/2a5031b801e01a23781828e61e76c22bb9554450), [`1feefd3`](https://github.com/penna-org/haze/commit/1feefd347c59e86ddbb215b0cddb28172a6bce75), [`704870c`](https://github.com/penna-org/haze/commit/704870c8282875ad5a2d81012a96049e31e77b59), [`d9523dc`](https://github.com/penna-org/haze/commit/d9523dce1bb88b486d6ba78a41d7760c9d57b70a), [`bae4c9c`](https://github.com/penna-org/haze/commit/bae4c9c44fd056515610a32cc5077b499d536671), [`8f7e23e`](https://github.com/penna-org/haze/commit/8f7e23eb48f366ddd8847eb3492cf4b47dbf29a4), [`899ac66`](https://github.com/penna-org/haze/commit/899ac66ec154510893708a3505e956cda0e22eac), [`8437ae9`](https://github.com/penna-org/haze/commit/8437ae94e16fef8c96ba64e96fbfad4946c75eec), [`175e253`](https://github.com/penna-org/haze/commit/175e253f1f42dd5466a7c4409c46b04939bbebce), [`b0eaecc`](https://github.com/penna-org/haze/commit/b0eaeccea3472d7b8d095e2f9cc66706c35b8d56), [`743e0c6`](https://github.com/penna-org/haze/commit/743e0c646b305b1532357fe09a51e6665ac8fb33)]:
  - @hazejs/core@0.2.0
