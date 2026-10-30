# @hazejs/auto-import

## 1.0.0

### Major Changes

- [#14](https://github.com/penna-org/haze/pull/14) [`80169cf`](https://github.com/penna-org/haze/commit/80169cf2ae0ad9159fe1dc50d71a845c6fb91a6b) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - hazejs 1.0, the first stable release. All `@hazejs/*` packages and `create-hazejs` share version 1.0.0 and follow semantic versioning from here on: breaking changes only land in a new major, with an upgrade guide.
  
  Security fixes included in this release:
  
  - **Rate limiting behind proxies.** With `app.trustProxy`, `ctx.ip` is now the `X-Forwarded-For` entry appended by the nearest trusted proxy (the rightmost) instead of the leftmost one, which the client can set itself; previously a client could get a fresh `throttle` bucket per request by sending its own `X-Forwarded-For`. `trustProxy` also accepts the number of trusted hops (`trustProxy: 2` behind a CDN and a load balancer). The Cloudflare Workers entry passes `cf-connecting-ip` and the AWS Lambda adapter passes the event's `sourceIp` as the client address, so on those platforms `ctx.ip` works without `trustProxy` and `throttle` no longer counts every anonymous request under one shared key. New `setClientAddress(request, ip)` export for custom entries; `throttle` logs a warning once when no client address is known.
  - **Two-factor login lockout.** Wrong codes are counted per user in the cache (new `twoFactor.cacheStore` option, default store) for `challengeTtl`, not in the session cookie the client holds, so replaying the login cookie no longer resets `maxAttempts`. After `maxAttempts` wrong codes the user cannot complete a challenge until `challengeTtl` has passed, even after entering the password again.
  - **Passkey challenges.** In `challenge: 'session'` mode a used challenge is also recorded in the cache, so an old session cookie cannot replay a registration or authentication response.
  
  Packaging: `@hazejs/cli` depends on `@hazejs/vite` with a caret range instead of an exact version, every package has `main` / `types` fallbacks for older module resolution, and `@hazejs/microservices` declares the legacy `nats` client as an optional peer dependency.

## 0.5.0

### Minor Changes

- [#11](https://github.com/penna-org/haze/pull/11) [`57b3b34`](https://github.com/penna-org/haze/commit/57b3b34daf04d05252f6fc5e0cd059b6676ca116) Thanks [@aibayanyu20](https://github.com/aibayanyu20)! - Add auto imports. With the new `@hazejs/auto-import` package installed and `autoImport: true` in `haze.config.ts` (off by default), controllers, services, repositories, models, middleware, validators, events, jobs, mail, notifications and resources (`app/<kind>/**` and `modules/*/app/<kind>/**`), plus a curated list of framework APIs from the new `@hazejs/core/auto-imports` and `@hazejs/orm/auto-imports` presets (`defineRoutes`, `inject`, `env`, `HttpContext`, the HTTP exceptions, `Model`, `Db`, …), can be used without import statements in the dev server, builds, tests and CLI commands. Imports are added after TypeScript is compiled (type-only usages add nothing), the dev server reloads when exports are added or removed, and global declarations are written to `.haze/types/auto-imports.d.ts` so classes work as types, generics keep their constraints and default exports get names. `autoImport` accepts `dirs`, `imports` (other packages, e.g. `{ from: 'valibot', imports: [['*', 'v']] }`), `presets` (default: every installed `@hazejs/*` package with a preset; `[]` turns them off), `ignore` and `exclude` (default: `database/schema/**`). `haze()` now returns an array of plugins (`plugins: [haze()]` is unchanged; use `haze()[0].api` for the plugin API), `haze typegen` always writes types, `haze make:*` leaves out imports that would be auto-imported, and `create-hazejs --auto-import` turns the option on in new projects.
