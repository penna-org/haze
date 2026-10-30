---
name: hazejs-contributing
description: Work on the hazejs framework itself — the penna-org/haze monorepo (packages/core, orm, vite, cli, testing, create templates, ai, oauth, search, socketio, graphql, microservices, docs site). Use when fixing a framework bug, adding a framework feature, driver, CLI command, template change or milestone, editing docs/guide or docs/zh/guide, writing changesets, or when a hazejs app hits a framework limitation that should be fixed upstream. Not for building apps with hazejs (use `hazejs`) or porting apps to it (use `hazejs-migration`).
---

# Contributing to hazejs

The repository is a pnpm workspace: `packages/*` are the published `@hazejs/*` packages (one fixed version group, released with Changesets), `playground/` is an example app used as an integration test, `docs/` is the VitePress site (English in `docs/guide`, Chinese in `docs/zh/guide`; `docs/design.md` holds the internal design notes and per-milestone records and is excluded from the site), `docs/roadmap.md` lists milestones.

## Toolchain (each of these has broken the build before)

- Node from `.nvmrc` (22.18): run `source ~/.nvm/nvm.sh && nvm use` before pnpm / vitest when the system Node is older — Vite 8 and Vitest need ≥ 22.12.
- TypeScript is pinned to `~6.0.x` (tsdown's d.ts generation and vue-tsc need the classic JS API); `@types/node` is `^24` (the user's pnpm trust policy blocks downgrades). Do not bump these casually.
- `pnpm-workspace.yaml` enables `shellEmulator`, so globs in package.json scripts must be quoted (`--filter './packages/**'`).
- Optional drivers are optional peer dependencies loaded with dynamic `import()`; add new ones to `DRIVER_PACKAGES` (and `EDGE_UNSUPPORTED_DRIVERS` if they cannot run on Workers) in `packages/vite/src/presets/deps.ts`.

```bash
pnpm install
pnpm build                       # tsdown for every package (tests import the built dist of sibling packages)
npx vitest run packages/core/test/http.test.ts   # one file
pnpm test                        # build + all Vitest projects
pnpm typecheck                   # tsc for the repo and the playground
pnpm lint                        # @antfu/eslint-config; `npx eslint --fix <paths>` for formatting
```

Rebuild a package (`cd packages/core && npx tsdown`) before testing another package or an external app against it — consumers load `dist`, not `src`.

Tests that need real services are skipped unless `HAZE_TEST_*` variables are set (Redis, Upstash, MySQL, Turso, S3/RustFS, SMTP/Mailpit, PostgreSQL, Meilisearch/Typesense/Elasticsearch, NATS). Start only what you touch; container images need the user's approval to pull.

## Workflow for a change

1. **Understand the current behaviour in source**, not just docs: `packages/core/src/application.ts` (boot order and the h3 middleware pipeline), `routing/`, `http/context.ts`, `middleware/builtin/`, `exception/`, the subsystem's manager class.
2. **For a milestone or anything that changes public behaviour, plan first and confirm with the user** (scope, API names, defaults), then implement, test, document and record — this is the established per-milestone workflow.
3. **Write the test first or alongside**: every module has a suite in `packages/<pkg>/test`. Boot apps in-process (`createApplication({ mode: 'test', env: false, config: { logger: { level: 'silent' } }, routes: [defineRoutes(...)] })` and `app.request()`), use Miniflare for Cloudflare bindings, gate real services behind `HAZE_TEST_*`.
4. **Keep every surface working**: the dev server with hot reload (persistent resources via `definePersistent`), tests (add a `fake()` where it makes sense), and every deployment preset the feature claims (node, bun, deno, docker, aws-lambda, vercel, netlify, cloudflare).
5. **Document in both languages**: update `docs/guide/<page>.md` *and* `docs/zh/guide/<page>.md` in the same change (tables, options, defaults, gotchas); template READMEs in `packages/create/templates/*/README.md` when templates change; `docs/roadmap.md` for milestones; and the matching agent-skill reference in `skills/hazejs/references/*.md` (plus `skills/hazejs/SKILL.md` gotchas when a default changes).
6. **Record the design**: append a dated section to `docs/design.md` (Chinese) with the decisions, implementation notes, test coverage and known limitations.
7. **Add a changeset**: a `.changeset/<slug>.md` with the affected packages and bump type and a user-facing English summary (one paragraph naming every new API and behaviour change). `pnpm changeset` creates one interactively.
8. **Verify**: the touched package's tests, then `pnpm typecheck`, lint on touched paths, and the full `pnpm test` before declaring done. Report counts.

Commit messages follow Conventional Commits; this project writes the subject in Chinese (`feat: …`, `fix: …`, `docs: …`). Commit or push only when the user asks.

## Conventions

- ESM only, TypeScript strict. Source comments are mostly Chinese; English or Chinese are both fine.
- Public APIs are functions and plain objects (`defineX()` helpers, facades like `Cache` / `Queue` / `Mail`), injection via `inject()` with classes or `createToken()` — no decorators.
- Configuration lives in `config/<key>.ts` with a typed `defineXConfig` helper; defaults are merged from `defaultConfig(mode)`, module defaults, then the project's files. New config keys need defaults, the helper type, docs and typegen support where relevant.
- Discovery (`app/<dir>`, `route/`, `schedule/`, `lang/`, `modules/`) is wired in the Vite plugin (`packages/vite/src/plugin.ts`) and passed to `createApplication` options; a new discovered folder needs the plugin, the options type, `make:*` generator, templates and docs.
- Behaviour that differs between production and development (debug pages, OpenAPI, dashboards, HSTS) must default to the safe choice in production.
- Prefer Web standards (`Request`, `Response`, `ReadableStream`, `AbortSignal`) in core so the edge presets keep working; isolate Node-only code behind dynamic imports.

## Lessons from validating hazejs against a real backend

Porting a 32k-line Fastify backend surfaced issues that unit tests had missed — when an app hits a framework limitation, fix it upstream with a test rather than working around it in the app:

- route parameters were not URL-decoded;
- no trustProxy-aware `ctx.origin` / `ctx.secure`;
- static files skipped global middleware (no security headers on HTML pages) and lacked precompressed `.br`/`.gz` support and `no-cache` for HTML;
- `secureHeaders` sent COOP / Origin-Agent-Cluster over http;
- OpenAPI operations could not carry `x-*` extensions.

Fixed in the follow-up ORM round: drizzle `casing`, PostgreSQL `timezone`, the `node-postgres` driver, external `client`s, `Db.drizzleSync()`, `Db.joinTransaction()`, per-app managers and `Db.withManager()`. Still open (see the latest records in `docs/design.md`): the connection pool is keyed by connection name process-wide, so two apps with different owned configs for the same name replace each other's connection; the default rate-limit store is process-global; `throttle:max,window` buckets are shared per spec; validation status is fixed at 422 in OpenAPI; the test client cannot set the client IP; `registerServerExtension` is undocumented. Pick these up as candidates when relevant.
