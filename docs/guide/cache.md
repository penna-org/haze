# Cache

hazejs ships a cache layer in `@hazejs/core`: a small set of drivers (in-memory, Redis, Upstash, Cloudflare KV), a `Cache` facade with Laravel-style helpers, atomic locks, and a response-caching middleware. The same stores also back [rate limiting and sessions](./security) when you run more than one instance.

::: tip Paths
Examples on this page use the API template layout (`app/...`, `config/...`). In a full-stack project these live under `server/`.
:::

## Configuration

Stores are declared in `config/cache.ts`. Without this file you get a single in-memory store and the key prefix `haze:`.

```ts
// config/cache.ts
import { defineCacheConfig, env } from '@hazejs/core'

export default defineCacheConfig(() => ({
  default: env('CACHE_STORE', 'memory'),
  // Separate apps that share one Redis
  prefix: env('CACHE_PREFIX', 'my-app:'),
  stores: {
    memory: { driver: 'memory' },
    // A connection from config/redis.ts (defaults to its `default` connection, i.e. REDIS_URL)
    redis: { driver: 'redis', connection: 'default' },
    upstash: {
      driver: 'upstash',
      url: env('UPSTASH_REDIS_REST_URL', ''),
      token: env('UPSTASH_REDIS_REST_TOKEN', ''),
    },
    kv: { driver: 'kv', binding: 'CACHE' },
  },
  // Store used by the cacheResponse middleware (defaults to `default`)
  responseStore: 'redis',
}))
```

| Option | Description |
| --- | --- |
| `default` | Name of the store used by the `Cache` facade |
| `prefix` | Prepended to every key; `flush()` only removes keys under this prefix. Default `haze:` |
| `stores` | Named store configurations |
| `responseStore` | Store used by `cacheResponse`; defaults to `default` |

## Drivers

| Driver | Package | Atomic | Runs on the edge | Typical use |
| --- | --- | --- | --- | --- |
| `memory` | — | Yes | Yes (per isolate) | Development, single instance |
| `redis` | `ioredis` | Yes | No (TCP) | Multi-instance Node / Bun / Docker / Lambda |
| `upstash` | `@upstash/redis` | Yes | Yes (HTTP) | Vercel, Netlify, Workers |
| `kv` | — (Workers binding) | No | Cloudflare only | Caching and sessions on Workers |
| `custom` | — | Your choice | Your choice | Anything implementing `CacheStore` |

- **redis** uses a named connection from [`config/redis.ts`](./redis) (`connection`, default: the `default` connection, which reads `REDIS_URL`); the store runs on that connection's shared command client, so Cluster, Sentinel and TLS are configured there. The connection's `keyPrefix` goes before the cache `prefix`, and `flush()` handles it. The older inline forms still work and take precedence: `url` (with `options` passed to ioredis) or a ready-made ioredis `client`. Increments and lock releases run as Lua scripts. Install with `pnpm add ioredis`.
- **upstash** needs `url` and `token`. Install with `pnpm add @upstash/redis`.
- **kv** reads the Workers binding named in `binding` (default `CACHE`). KV is eventually consistent, its minimum TTL is 60 seconds (shorter TTLs are enforced through metadata), and `add` / `increment` are read-then-write. Locks refuse to run on it.
- **custom** takes `{ driver: 'custom', store }`, where `store` implements the `CacheStore` interface exported from `@hazejs/core` (`get`, `set`, `add`, `delete`, `increment`, `deleteIf`, `clear`, plus `driver` and `atomic`).

::: warning KV is not atomic
Use KV for caching and sessions only. For precise counters, rate limits and locks on Workers, use Upstash, or the Cloudflare Rate Limiting binding for throttling (see [Sessions, CSRF & More](./security)).
:::

## Using the cache

```ts
import { Cache } from '@hazejs/core'

await Cache.set('greeting', { text: 'hi' }, '10m')
const greeting = await Cache.get<{ text: string }>('greeting')
const name = await Cache.get('name', 'guest') // fallback value
const lazy = await Cache.get('name', () => loadName()) // fallback function

const stats = await Cache.remember('stats', '10m', () => computeStats())
const settings = await Cache.rememberForever('settings', () => loadSettings())

await Cache.increment('views') // atomic, starts at 0
await Cache.decrement('stock', 2)
await Cache.store('redis').get('key') // a specific store
```

| Method | Description |
| --- | --- |
| `get(key, fallback?)` | Read a value; `fallback` may be a value or a (async) function |
| `many(keys)` | Read several keys into an object |
| `has(key)` | Whether the key exists |
| `set(key, value, ttl?)` | Write a value; no TTL means forever |
| `setMany(values, ttl?)` | Write several keys |
| `add(key, value, ttl?)` | Write only if missing; returns whether it was written |
| `forget(key)` | Delete a key |
| `pull(key)` | Read and delete |
| `remember(key, ttl, fn)` | Read, or run `fn` and cache its result (`undefined` is not cached) |
| `rememberForever(key, fn)` | `remember` without expiry |
| `increment(key, by?, ttl?)` | Atomic increment; the TTL is applied only when the key is created |
| `decrement(key, by?, ttl?)` | Atomic decrement |
| `flush()` | Delete every key under the configured prefix |
| `lock(name, ttl?, owner?)` / `restoreLock(name, owner)` | Atomic locks, see below |
| `store(name?)` | Switch to another store; returns a repository with the same methods |

Values are stored as JSON, so a `Date` comes back as a string.

### TTL formats

A TTL is either a number of seconds or a string with a unit: `'30s'`, `'10m'`, `'2h'`, `'7d'`. Omit it to store the value forever.

## Atomic locks

Locks are acquired with an atomic "set if absent", carry a random owner token, and expire on their own after the TTL (default 60 seconds). They work on `memory`, `redis` and `upstash`; creating one on `kv` throws.

```ts
import { Cache, LockTimeoutException } from '@hazejs/core'

// Run while holding the lock, release afterwards; throws LockTimeoutException if it is taken
await Cache.lock('report', '30s').run(() => generateReport())

// Wait up to 5 seconds for the lock
await Cache.lock('report', '30s').run(() => generateReport(), 5)

// Manual control
const lock = Cache.lock('import', 120)
if (await lock.get()) {
  try {
    await runImport()
  }
  finally {
    await lock.release()
  }
}
```

- `get()` tries once and returns a boolean.
- `block(seconds, interval?)` retries every 250 ms (by default) and throws `LockTimeoutException` when time runs out.
- `release()` only deletes the lock if this owner holds it.
- To release from another process, pass the owner along and use `Cache.restoreLock(name, lock.owner)`.

::: tip
`remember()` does not protect against a stampede: concurrent misses each compute the value. Wrap expensive computations in a lock if that matters.
:::

## Caching responses

The built-in `cacheResponse` middleware caches successful `GET` / `HEAD` responses by path and query string:

```ts
// route/api.ts
import { defineRoutes } from '@hazejs/core'
import { FeedController } from '~/app/controller/FeedController'
import { StatsController } from '~/app/controller/StatsController'

export default defineRoutes((r) => {
  r.get('/api/stats', [StatsController, 'index']).middleware('cacheResponse:60')
  // Cache separately per authenticated user
  r.get('/api/me/feed', [FeedController, 'index']).middleware('cacheResponse:5m,user')
})
```

- Only `200` responses are cached; responses with `Cache-Control: no-store` or `private` are skipped, and `Set-Cookie` is never stored.
- Responses carry `X-Cache: MISS` or `X-Cache: HIT`; hits also include an `Age` header.
- Entries go to the `responseStore` from `config/cache.ts`. See [Middleware](./middleware) for how named middleware are applied.

## Shared stores for throttling and sessions

When you run several instances, point rate limiting and sessions at the same atomic store so they share counters and data:

```ts
// config/throttle.ts
import { defineThrottleConfig, env } from '@hazejs/core'

export default defineThrottleConfig(() => ({
  store: env('CACHE_STORE', 'memory'),
  limiters: {
    api: { max: 60, window: '1m' },
  },
}))
```

Sessions use `{ driver: 'cache', store: 'redis' }`. Both are covered in [Sessions, CSRF & More](./security).

## Injecting the manager

The `Cache` facade resolves the application's `CacheManager`. You can inject it directly (see [Service Container](./container)):

```ts
// app/service/StatsService.ts
import { CacheManager, inject } from '@hazejs/core'

export class StatsService {
  private cache = inject(CacheManager)

  summary() {
    return this.cache.store('redis').remember('stats:summary', '1h', () => this.compute())
  }
}
```

`manager.store(name?)` returns a `CacheRepository` with the same methods as the facade.
