---
'@hazejs/ai': major
'@hazejs/auto-import': major
'@hazejs/cli': major
'@hazejs/core': major
'@hazejs/devtools': major
'@hazejs/graphql': major
'@hazejs/microservices': major
'@hazejs/oauth': major
'@hazejs/orm': major
'@hazejs/search': major
'@hazejs/socket.io': major
'@hazejs/testing': major
'@hazejs/vite': major
'create-hazejs': major
---

hazejs 1.0, the first stable release. All `@hazejs/*` packages and `create-hazejs` share version 1.0.0 and follow semantic versioning from here on: breaking changes only land in a new major, with an upgrade guide.

Security fixes included in this release:

- **Rate limiting behind proxies.** With `app.trustProxy`, `ctx.ip` is now the `X-Forwarded-For` entry appended by the nearest trusted proxy (the rightmost) instead of the leftmost one, which the client can set itself; previously a client could get a fresh `throttle` bucket per request by sending its own `X-Forwarded-For`. `trustProxy` also accepts the number of trusted hops (`trustProxy: 2` behind a CDN and a load balancer). The Cloudflare Workers entry passes `cf-connecting-ip` and the AWS Lambda adapter passes the event's `sourceIp` as the client address, so on those platforms `ctx.ip` works without `trustProxy` and `throttle` no longer counts every anonymous request under one shared key. New `setClientAddress(request, ip)` export for custom entries; `throttle` logs a warning once when no client address is known.
- **Two-factor login lockout.** Wrong codes are counted per user in the cache (new `twoFactor.cacheStore` option, default store) for `challengeTtl`, not in the session cookie the client holds, so replaying the login cookie no longer resets `maxAttempts`. After `maxAttempts` wrong codes the user cannot complete a challenge until `challengeTtl` has passed, even after entering the password again.
- **Passkey challenges.** In `challenge: 'session'` mode a used challenge is also recorded in the cache, so an old session cookie cannot replay a registration or authentication response.

Packaging: `@hazejs/cli` depends on `@hazejs/vite` with a caret range instead of an exact version, every package has `main` / `types` fallbacks for older module resolution, and `@hazejs/microservices` declares the legacy `nats` client as an optional peer dependency.
