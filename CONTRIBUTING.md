# Contributing to hazejs

English · [简体中文](./CONTRIBUTING.zh-CN.md)

Thanks for your interest in hazejs! Bug reports, docs fixes, new drivers and features are all welcome. For larger changes, please open an issue or a discussion first so we can agree on the design.

## Setup

- Node.js `>=22.12` (the repo pins 22.18 in `.nvmrc` — run `nvm use`)
- pnpm 11 (`corepack enable`)

```bash
git clone https://github.com/penna-org/haze.git
cd haze
pnpm install
pnpm build       # build packages/* with tsdown
pnpm test        # build, then run all Vitest projects
pnpm lint        # @antfu/eslint-config
pnpm typecheck
```

## Repository layout

```
packages/core/      @hazejs/core      runtime (container, routing, middleware, auth, cache, queue, events, websocket, storage, mail)
packages/vite/      @hazejs/vite      Vite plugin, hot-reloading dev server, build presets, preview
packages/cli/       @hazejs/cli       the `haze` command line
packages/orm/       @hazejs/orm       drizzle-based models, query builder, migrations; MongoDB adapter
packages/testing/   @hazejs/testing   Vitest integration and HTTP test client
packages/socketio/  @hazejs/socket.io Socket.IO integration
packages/create/    create-hazejs     scaffolding and the api / vue / react templates
playground/         example app (user CRUD), also used as an integration test
docs/               design notes (docs/design.md) and roadmap
```

Try the framework against the playground:

```bash
cd playground
pnpm dev                                  # haze dev — edits apply without restarting
pnpm routes                               # haze route:list
npx haze make:controller Order --resource
```

Or scaffold a project from source: `node packages/create/bin/create-hazejs.mjs my-app -t vue`.

## Tests with real services

Tests that need external services are skipped unless their environment variable is set. CI runs all of them; locally start only what you touch:

| Variable | Service | Example |
| --- | --- | --- |
| `HAZE_TEST_REDIS_URL` | Redis (cache, queue, WebSocket, Socket.IO) | `docker run -p 6379:6379 redis:7` → `redis://127.0.0.1:6379` |
| `HAZE_TEST_UPSTASH_URL`, `HAZE_TEST_UPSTASH_TOKEN` | serverless-redis-http | see `.github/workflows/ci.yml` |
| `HAZE_TEST_MYSQL_URL` | MySQL 8 | `mysql://root:haze@127.0.0.1:3307/haze_test` |
| `HAZE_TEST_TURSO_URL` | libsql-server (sqld) | `http://127.0.0.1:8080` |
| `HAZE_TEST_S3_ENDPOINT` | S3-compatible storage (RustFS / MinIO) | `http://127.0.0.1:19000` (keys `rustfsadmin`) |
| `HAZE_TEST_SMTP_URL`, `HAZE_TEST_MAILPIT_API` | Mailpit | `smtp://127.0.0.1:11025`, `http://127.0.0.1:18025` |

Cloudflare bindings (D1, KV, R2, Queues, Durable Objects) run in Miniflare and need no setup. Bun tests run when `bun` is on the `PATH`.

## Pull requests

1. Fork and create a branch from `main`.
2. Add tests for behavior changes — every module has a Vitest suite under `packages/*/test`.
3. Run `pnpm lint`, `pnpm typecheck` and `pnpm test`.
4. Add a changeset for changes to published packages: `pnpm changeset` (pick packages and bump type, write a user-facing summary).
5. Update docs when behavior changes: the root README, the template READMEs (`packages/create/templates/*/README.md`) and, for design decisions, `docs/design.md`.

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:`, `chore:` …).

## Conventions

- ESM only, TypeScript strict mode.
- Optional drivers are optional peer dependencies and are loaded with dynamic `import()`, so unused drivers never end up in a bundle. New drivers must also be added to `DRIVER_PACKAGES` (and `EDGE_UNSUPPORTED_DRIVERS` when they cannot run on Workers) in `packages/vite/src/presets/deps.ts`.
- Every feature should work in the dev server with hot reload, in tests (with a `fake()` where it makes sense) and in the deployment presets it claims to support.
- Code comments are currently mostly in Chinese; English or Chinese are both fine in new code.

## Releases

Releases are automated with Changesets: merging changesets into `main` opens a "Version Packages" pull request, and merging that publishes to npm with provenance. All `@hazejs/*` packages share one version.

By contributing you agree that your contributions are licensed under the [MIT License](./LICENSE).
