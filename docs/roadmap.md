# Roadmap & comparison

hazejs aims to be the most complete backend framework in the Node.js ecosystem: everything a production application needs, first-party, consistent, typed and deployable anywhere — without giving up a fast, modern toolchain.

This page compares where hazejs stands today with other popular choices, and lists what comes next.

## Comparison

Legend: ✅ first-party / built in · ◐ official add-on or partial · 🧩 community package / bring your own · — not available

The comparison reflects official packages as of October 2026, to the best of our knowledge. Corrections are welcome — please open an issue.

| Capability | hazejs | NestJS | AdonisJS | Laravel (PHP, reference) | Express / Fastify / Hono |
| --- | --- | --- | --- | --- | --- |
| Routing, middleware, exception handling | ✅ | ✅ | ✅ | ✅ | ✅ (routing & middleware) |
| Dependency injection | ✅ `inject()` | ✅ decorators | ✅ | ✅ | — |
| Request validation | ✅ Standard Schema | ◐ class-validator | ✅ VineJS | ✅ | 🧩 |
| ORM, migrations, seeders | ✅ drizzle-based | 🧩 TypeORM / Prisma | ✅ Lucid | ✅ Eloquent | 🧩 |
| Authentication (JWT, session) | ✅ | ◐ Passport | ✅ | ✅ | 🧩 |
| Authorization (gates, policies) | ✅ | 🧩 CASL | ✅ Bouncer | ✅ | 🧩 |
| CSRF, CORS, secure headers, rate limiting | ✅ | ◐ | ✅ | ✅ | 🧩 |
| Cache with atomic locks | ✅ | ◐ | ✅ | ✅ | 🧩 |
| Queues with retries & delays | ✅ | ◐ BullMQ module | 🧩 | ✅ | 🧩 |
| Task scheduling | ✅ | ◐ | 🧩 | ✅ | 🧩 |
| Events & queued listeners | ✅ | ◐ | ✅ | ✅ | — |
| WebSocket / Socket.IO | ✅ both | ✅ gateways | ◐ SSE (Transmit) | ✅ Reverb | 🧩 |
| File storage (local / S3 / R2) | ✅ | 🧩 | ✅ Drive | ✅ | 🧩 |
| Mail with queued sending | ✅ | 🧩 | ✅ | ✅ | 🧩 |
| AI: multi-provider LLMs, tools, agents, RAG, MCP | ✅ `@hazejs/ai` | 🧩 | 🧩 | 🧩 | 🧩 |
| Testing fakes (queue, events, mail, storage) | ✅ | ◐ | ✅ | ✅ | — |
| Code generators & CLI | ✅ `haze make:*` | ✅ | ✅ | ✅ | — |
| Generated types (config, routes, abilities) | ✅ | — | ◐ | — | ◐ (Hono RPC) |
| Hot reload without restarting the process | ✅ | ◐ | ✅ hot-hook | n/a | 🧩 |
| Full-stack Vite (same port, one build) | ✅ any Vite framework | — | ◐ Inertia / Vite | ◐ Vite / Inertia | — |
| Edge & serverless deploy presets | ✅ 8 presets | — | — | ◐ Vapor | ◐ Hono |
| Cloudflare D1 / KV / R2 / Queues / DO drivers | ✅ | — | — | — | ◐ Hono (bindings) |
| OpenAPI generation, typed client | ✅ | ✅ | 🧩 | 🧩 | ◐ |
| Internationalization | ✅ | 🧩 | ✅ | ✅ | 🧩 |
| Notifications (multi-channel) | ✅ incl. WeCom / DingTalk / Feishu | — | 🧩 | ✅ | — |
| Broadcasting with private / presence channels | ✅ WS / SSE / Socket.IO | — | ◐ | ✅ | — |
| Custom console commands, REPL | ✅ | 🧩 | ✅ | ✅ | — |
| Observability (health, tracing, dashboards) | ✅ OpenTelemetry, `/__haze` | ◐ | ◐ | ✅ Telescope / Pulse / Horizon | 🧩 |
| OAuth social login, API tokens, 2FA | ✅ incl. passkeys, Chinese providers | 🧩 | ◐ Ally / tokens | ✅ | 🧩 |
| Full-text search | ✅ `@hazejs/search` | 🧩 | 🧩 | ✅ Scout | 🧩 |
| Multi-tenancy | ✅ | 🧩 | 🧩 | 🧩 | 🧩 |
| GraphQL, microservice transports | ✅ `@hazejs/graphql`, `@hazejs/microservices` | ✅ | 🧩 | 🧩 | 🧩 |
| Modules / packages (routes, config, migrations, jobs) | ✅ local `modules/` and npm modules | ◐ modules (no migrations) | ✅ packages | ✅ packages | ◐ Fastify plugins |
| Documentation site | ✅ | ✅ | ✅ | ✅ | ✅ |

## Done so far

| Milestone | Scope |
| --- | --- |
| M0–M4 | Monorepo, runtime core (container, routing, middleware, exceptions), Vite plugin with hot reload, CLI, Vue full-stack, scaffolding, test utilities, code generation, typegen, logging, dev error page |
| M5–M6 | Response formatter, interceptors, multi-app (prefix / domain) |
| M7–M8 | `@hazejs/orm` (MySQL, PostgreSQL, SQLite) and the MongoDB adapter |
| M9–M11 | Deployment presets, production migrations, D1 / Turso drivers, dependency tracing, `vite preview`, React template |
| M12–M13 | Built-in middleware, uploads, sessions, authentication (JWT / session), authorization (gates / policies), CSRF |
| M14–M16 | Cache, queues, scheduler, events, WebSocket (Redis fan-out, Durable Objects) |
| M17–M18 | Socket.IO, file storage (local / S3 / R2), mail (SMTP / Resend / Postmark / Mailgun / SES) |
| M19 | Documentation site (VitePress, English + 中文) on GitHub Pages; `@hazejs/ai`: 17 providers without SDK dependencies, streaming, tools, structured output, embeddings & RAG, agents with memory, images, speech, MCP, `useChat` |
| M20 | **OpenAPI** generated from routes and Standard Schema validators, Swagger / Scalar UI, typed HTTP client for frontends |
| M21 | **Console**: user-defined commands (`app/command`, `haze make:command`), `haze repl`, `make:mail`, `make:command` |
| M22 | **Notifications** (mail, database, broadcast, Slack / webhooks) and **broadcasting** with private / presence channel authorization over WebSocket, Socket.IO and SSE |
| M23 | **i18n** (localized messages, validation errors, mail), API resources / transformers, signed route URLs, encryption service |
| M24 | **Observability**: health checks, OpenTelemetry traces and metrics, log transports, a dev dashboard for requests, queries, jobs and mail; queue dashboard |
| M25 | **Auth extensions**: OAuth social login, personal access tokens, email verification and password reset flows, TOTP 2FA, passkeys |
| M26 | **Search** (database full-text, Meilisearch, Typesense, Elasticsearch / OpenSearch) and multi-tenancy |
| M27 | Optional packages: GraphQL, microservice transports (Redis, NATS, gRPC) |
| M28 | **Modules**: reusable feature units as local `modules/<name>/` folders or npm packages (`defineModule`), with routes, middleware, config defaults, providers, migrations, jobs, events, commands and policies; `make:module`, `module:list`, a `module` template |
| M29 | **Unified Redis connections**: `config/redis.ts` with named connections (single node, TLS, Cluster, Sentinel, custom factories) referenced by cache, queues, WebSocket, broadcasting, Socket.IO and microservices; shared command connections, a `Redis` facade, `redisCheck()` on a connection |
| M30 | **Cache API, ThinkPHP style**: `delete` / `clear` / `inc` / `dec` / PSR-16 aliases, atomic `push`, `ttl()` / `touch()`, `handler()`, tags on every driver, typed Redis hashes / lists / sets / sorted sets (emulated on memory for tests), the `cache()` helper, JSON serialization that restores `Date`, `BigInt`, `Map` and `Set` |

## Next

Priorities may shift with community feedback. Each milestone ships with tests, template examples and docs, and works in the dev server, in tests and in every preset it supports.

| Milestone | Scope |
| --- | --- |
| 1.0 | API freeze, benchmarks, upgrade guides, long-term support policy |

Have an idea or need something sooner? Open a [feature request](https://github.com/penna-org/haze/issues/new/choose).
