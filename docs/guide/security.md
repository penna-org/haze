# Sessions, CSRF & More

This page covers the security building blocks that sit around [authentication](./authentication): the application key, cookies, sessions, CSRF protection, CORS, security headers, rate limiting and request limits. Most of them are built-in middleware you enable by name in `config/middleware.ts` (see [Middleware](./middleware)):

```ts
// config/middleware.ts
import { defineMiddlewareConfig } from '@hazejs/core'

export default defineMiddlewareConfig({
  global: ['cors', 'secureHeaders', 'compress'],
  alias: {},
})
```

Each middleware reads its options from the config file of the same name (`config/cors.ts`, `config/session.ts`, `config/csrf.ts`, `config/throttle.ts`, `config/secureHeaders.ts`).

## The application key

`APP_KEY` in `.env` is the secret behind:

- signed cookies (HMAC-SHA256),
- sessions: the `cookie` driver encrypts session data with AES-GCM (a key derived from `APP_KEY` via HKDF), and the other drivers sign the session id,
- the default secret of `HS*` JWT guards,
- signed temporary URLs for the `local` and `r2` storage disks,
- [signed route URLs](./routing#signed-urls) and [encryption](#encryption).

New projects get their own key when they are scaffolded. To create or rotate one:

```bash
haze key:generate          # writes APP_KEY to .env
haze key:generate --force  # replace an existing key
haze key:generate --show   # print a key without writing it
```

The key must be at least 32 characters. Rotating it invalidates every signed cookie, session and token issued with the old one. You can also set `key` in `config/app.ts` instead of using the environment variable. On Cloudflare Workers, which have no `.env`, store it with `wrangler secret put APP_KEY`.

## Cookies

```ts
ctx.cookie('theme')                            // read
ctx.setCookie('theme', 'dark', { maxAge: 60 * 60 * 24 * 365 })
ctx.deleteCookie('theme')

await ctx.setSignedCookie('cart', cartId)      // readable by the client, but tamper-proof
await ctx.signedCookie('cart')                 // undefined if the signature doesn't match
```

Cookies default to `httpOnly`, `SameSite=Lax` and path `/`, plus `Secure` when `app.debug` is off. Override the defaults in `config/app.ts`:

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  cookie: { sameSite: 'strict', domain: '.example.com' },
}))
```

To store data the client must not read, put it in the session: the default `cookie` session driver encrypts it.

## Sessions

Add the `session` middleware to the routes (or globally) that need it, then use `ctx.session`:

```ts
// route/api.ts
r.post('/cart', async (ctx) => {
  const items = ctx.session.get<string[]>('cart', [])!
  ctx.session.set('cart', [...items, 'book'])
  ctx.session.flash('status', 'Added to cart')
  return ctx.noContent()
}).middleware('session')
```

| Method | Description |
|--------|-------------|
| `get(key, fallback?)` / `has(key)` / `all()` | Read |
| `set(key, value)` / `forget(key)` | Write / remove |
| `pull(key, fallback?)` | Read and remove |
| `flash(key, value)` | Value only available in the next request |
| `flush()` | Remove all data, keep the id |
| `regenerate()` | New session id, data kept (call after login or privilege changes) |
| `invalidate()` | Remove all data and regenerate the id (logout) |

Outside the middleware, `await ctx.startSession()` starts the session on demand. A session is written back only when it changed, and a new, empty session never sets a cookie. The [session guard](./authentication#session-login) starts the session by itself.

### Configuration

```ts
// config/session.ts
import { defineSessionConfig } from '@hazejs/core'

export default defineSessionConfig({
  driver: 'cookie',
  lifetime: '2h',
})
```

| Option | Default | Description |
|--------|---------|-------------|
| `driver` | `'cookie'` | See below, or a custom `SessionStore` object |
| `store` | default cache store | With `driver: 'cache'`: which store from `config/cache.ts` |
| `cookie` | `'haze_session'` | Cookie name |
| `lifetime` | `'2h'` | Duration string or seconds |
| `cookieOptions` | | Overrides the default cookie options |

| Driver | Where data lives |
|--------|------------------|
| `cookie` | Encrypted in the cookie itself. Stateless and edge-friendly, limited to about 4 KB |
| `memory` | Process memory, the cookie holds a signed id. Single instance only |
| `cache` | A [cache](./cache) store such as Redis, Upstash or KV: `{ driver: 'cache', store: 'redis' }`. Shared across instances |

A custom store implements `get(id)`, `set(id, data, ttlSeconds)` and `destroy(id)`:

```ts
// config/session.ts
import type { SessionStore } from '@hazejs/core'
import { defineSessionConfig } from '@hazejs/core'

const store: SessionStore = {
  get: async id => loadSession(id),
  set: async (id, data, ttl) => saveSession(id, data, ttl),
  destroy: async id => deleteSession(id),
}

export default defineSessionConfig({ driver: store })
```

## CSRF protection

Whenever authentication relies on cookies (a session guard, or a JWT read from a cookie), enable the `csrf` middleware. It follows Laravel's synchronizer-token approach:

1. The token is stored in the session and sent to the browser in a readable `XSRF-TOKEN` cookie (not `HttpOnly`).
2. Unsafe requests (`POST`, `PUT`, `PATCH`, `DELETE`) must send it back in an `X-XSRF-TOKEN` or `X-CSRF-TOKEN` header, or in a `_token` field of a urlencoded / multipart form.
3. A missing or wrong token fails with `419` (`CsrfTokenMismatchException`).

Clients like axios copy the `XSRF-TOKEN` cookie into the header automatically. For server-rendered forms, put `await ctx.csrfToken()` into a hidden `_token` input.

Checks are skipped for:

- safe methods (`GET`, `HEAD`, `OPTIONS`, `TRACE`),
- requests with `Authorization: Bearer …`, since they don't depend on cookies,
- paths listed in `except`,
- the test environment, unless `testing: true`.

```ts
// config/csrf.ts
import { defineCsrfConfig } from '@hazejs/core'

export default defineCsrfConfig({
  except: ['/api/webhooks/*'],
  // cookie: 'XSRF-TOKEN',  // false disables the cookie
  // testing: true,         // also verify in tests
})
```

The token rotates when a session guard logs a user in or out.

::: tip Full-stack templates
The Vue and React templates enable `csrf` globally, add a `GET /api/csrf-cookie` route that only sets the cookie, and their `src/api.ts` calls it once before the first unsafe request, then sends `X-XSRF-TOKEN` automatically. See [Full-stack with Vite](./fullstack).
:::

## CORS

The `cors` middleware must be **global**, because preflight `OPTIONS` requests don't match any route. Options go in `config/cors.ts`:

```ts
// config/cors.ts
import { defineCorsConfig, env } from '@hazejs/core'

export default defineCorsConfig(() => {
  const origin = env('CORS_ORIGIN', '*')
  return {
    origin: origin === '*' ? '*' : origin.split(',').map(item => item.trim()),
  }
})
```

| Option | Default | Description |
|--------|---------|-------------|
| `origin` | `'*'` | `'*'`, a list of strings / regular expressions, or `(origin) => boolean` |
| `methods` | `'*'` | Allowed methods for preflight requests |
| `allowHeaders` | `'*'` | Allowed request headers |
| `exposeHeaders` | `'*'` | Headers readable by the browser |
| `credentials` | `false` | Allow cookies; requires explicit origins instead of `'*'` |
| `maxAge` | `false` | Preflight cache duration |

Anchor regular-expression origins (`/^https:\/\/app\.example\.com$/`); unanchored patterns also match look-alike domains.

## Security headers

`secureHeaders` sets helmet-style defaults: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy` and `Cross-Origin-Resource-Policy: same-origin`, and a few others. `Cross-Origin-Opener-Policy` and `Origin-Agent-Cluster` are only sent on HTTPS requests (browsers ignore them over plain HTTP, and COOP logs a console error), and `Strict-Transport-Security` only on HTTPS requests when `app.debug` is off. Behind a proxy, set `app.trustProxy` so `X-Forwarded-Proto` counts. When the app serves a frontend build (`static`), global middleware such as `secureHeaders` and `cors` apply to those pages and assets too.

```ts
// config/secureHeaders.ts
import { defineSecureHeadersConfig } from '@hazejs/core'

export default defineSecureHeadersConfig({
  contentSecurityPolicy: "default-src 'self'",   // off by default
  frameOptions: 'DENY',
  headers: { 'x-robots-tag': 'noindex' },   // extra headers
})
```

Every option (`contentSecurityPolicy`, `strictTransportSecurity`, `frameOptions`, `referrerPolicy`, `crossOriginOpenerPolicy`, `crossOriginResourcePolicy`, `permissionsPolicy`) takes a string to override the value or `false` to drop the header.

## Rate limiting

```ts
// route/api.ts
r.post('/login', [AuthController, 'login']).middleware('throttle:10,60') // 10 requests per 60 seconds
r.group({ prefix: '/api', middleware: ['throttle:api'] }, (r) => { /* ... */ })
```

`throttle:<max>,<seconds>` defines a limit inline; `throttle:<name>` uses a named limiter. Requests are counted per authenticated user id, or per client IP for guests. Responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; over the limit you get `429` with `Retry-After`.

```ts
// config/throttle.ts
import { defineThrottleConfig, env } from '@hazejs/core'

export default defineThrottleConfig(() => ({
  // A store from config/cache.ts; use a shared one (e.g. redis) with several instances
  store: env('CACHE_STORE', 'memory'),
  limiters: {
    api: { max: 60, window: '1m' },
    uploads: { max: 10, window: '1h', key: ctx => `ip:${ctx.ip}` },
  },
}))
```

Without `store`, counts live in process memory (single instance). `store` can also be a custom `RateLimitStore`.

On Cloudflare Workers, prefer a Rate Limiting binding, which is atomic and global. Set `binding` on a limiter; the limit and period come from `ratelimits` in `wrangler.json`, and local development falls back to the store:

```ts
api: { max: 60, window: '1m', binding: 'API_RATE_LIMITER' },
```

## Encryption

`Crypt` encrypts values with AES-256-GCM through Web Crypto, so it works the same on Node, Bun, Deno and Cloudflare Workers. The key is derived from `APP_KEY` with HKDF and is separate from the keys used for signing and sessions.

```ts
import { Crypt } from '@hazejs/core'

const token = await Crypt.encrypt({ userId: 1, scope: 'export' })
const data = await Crypt.decrypt<{ userId: number, scope: string }>(token)

const secret = await Crypt.encryptString('sk_live_...')   // no JSON serialization
const plain = await Crypt.decryptString(secret)
```

- `encrypt()` serializes the value as JSON (dates become strings); `encryptString()` encrypts a string as is.
- Every call uses a random IV, so the same input never produces the same payload.
- The payload is a versioned, URL-safe string (`v1.<base64url>`), ready for URLs, cookies and database columns.
- Tampered, truncated or foreign payloads throw `DecryptException`.

### Key rotation

Rotating `APP_KEY` would make existing payloads unreadable. Keep the old keys in `APP_PREVIOUS_KEYS` (comma-separated) or `previousKeys` in `config/app.ts`: decryption tries the current key first, then each previous key, while new data is always encrypted with the current key. Previous keys also keep [signed URLs](./routing#signed-urls) valid.

```bash
APP_KEY=new-key...
APP_PREVIOUS_KEYS=old-key...,older-key...
```

For a custom key, create an `Encrypter` directly: `new Encrypter(key, previousKeys)`.

Passwords are hashed, not encrypted: use [`Hash`](./authentication) for those.

## Request body limit

Request bodies are capped at `1mb` by default (`bodyLimit` in `config/app.ts`). Raise it per route with the `bodyLimit` middleware; oversized bodies are rejected with `413`:

```ts
r.post('/auth/avatar', [AuthController, 'avatar']).middleware(['auth', 'bodyLimit:3mb'])
```

## Behind a proxy

When the app runs behind a trusted reverse proxy or load balancer, set `trustProxy: true` in `config/app.ts`. `ctx.ip` then comes from `X-Forwarded-For` (which affects rate limiting) and the protocol from `X-Forwarded-Proto` (which decides whether HSTS is sent). Leave it off when clients can reach the app directly, or they could spoof these headers.
