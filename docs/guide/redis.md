# Redis

Several parts of hazejs talk to Redis: the cache store, queues (BullMQ), WebSocket broadcasting, the broadcasting bus, the Socket.IO adapter and the microservices transport. They all get their connections from one place, `config/redis.ts`, and refer to a connection **by name**. A single `REDIS_URL` configures all of them, and features share one command connection instead of each opening its own.

All TCP access goes through [ioredis](https://github.com/redis/ioredis), an optional peer dependency:

```sh
pnpm add ioredis
```

::: tip Paths
Examples on this page use the API template layout (`app/...`, `config/...`). In a full-stack project these live under `server/`.
:::

## Configuration

```ts
// config/redis.ts
import { defineRedisConfig, env } from '@hazejs/core'

export default defineRedisConfig(() => ({
  default: 'default',
  connections: {
    default: { url: env('REDIS_URL', 'redis://127.0.0.1:6379') },
    cache: { url: env('REDIS_CACHE_URL', 'redis://127.0.0.1:6379/1'), keyPrefix: 'cache:' },
  },
}))
```

| Option | Description |
| --- | --- |
| `default` | Connection used when a feature names none. Defaults to `default`, or to the first connection when there is no `default` |
| `connections` | Named connections (see below) |

**Without `config/redis.ts`** there is one implicit connection, `default`, which reads `REDIS_URL` and falls back to `redis://127.0.0.1:6379`. Most single-Redis apps never need the file.

Then refer to the connection from each feature:

```ts
// config/cache.ts
stores: { redis: { driver: 'redis', connection: 'cache' } }

// config/queue.ts
connections: { redis: { driver: 'redis', connection: 'default' } }

// config/websocket.ts
broadcast: { driver: 'redis', connection: 'default', channel: 'my-app:ws' }
```

When a feature sets neither `connection` nor `url`, it uses the `default` connection.

### A connection

A connection is one of:

| Form | Options |
| --- | --- |
| Single node | `url` (`redis://` or `rediss://`), or `host`, `port`, `username`, `password`, `db`, `tls` (`true` or ioredis TLS options) |
| Cluster | `cluster`: startup nodes (`{ host, port }` or `'host:port'`). Node options (password, TLS) go in `options.redisOptions`; `username` / `password` / `db` / `tls` set at the top level are copied there |
| Sentinel | `sentinels`: `[{ host, port }]`, plus `name` (the master name) |
| Custom | `client`: a **factory** returning a new ioredis instance, `() => new Redis(...)` |

Every form also accepts `keyPrefix` (see [Key prefixes](#key-prefixes)) and `options`, which are passed to ioredis as-is (`connectTimeout`, `maxRetriesPerRequest`, `retryStrategy`, ...).

```ts
connections: {
  default: { url: env('REDIS_URL', 'redis://127.0.0.1:6379') },
  // TLS with separate credentials
  managed: { host: 'redis.internal', port: 6380, username: 'app', password: env('REDIS_PASSWORD', ''), tls: true },
  cluster: {
    cluster: [{ host: '10.0.0.1', port: 6379 }, { host: '10.0.0.2', port: 6379 }],
    options: { redisOptions: { password: env('REDIS_PASSWORD', '') } },
  },
  sentinel: { sentinels: [{ host: '10.0.0.5', port: 26379 }], name: 'mymaster', password: env('REDIS_PASSWORD', '') },
  // A factory, not an instance: hazejs calls it again for dedicated connections
  custom: { client: () => new Redis(env('REDIS_URL', ''), { enableAutoPipelining: true }) },
}
```

`client` is a factory so that hazejs can open dedicated connections (subscribers, blocking commands, BullMQ) with the same settings. Import `Redis` from `ioredis` under another name if you also use the `Redis` facade in that file.

### Typed connection names

The dev server (and `haze typegen`) infers the type of `config/redis.ts` together with the other config files. Once generated, `connection: 'cahce'` in `config/cache.ts` or `Redis.connection('cahce')` fails type checking. Without `config/redis.ts`, connection names are plain strings.

## Using Redis directly

The `Redis` facade runs commands on the default connection; `Redis.connection(name)` switches connection:

```ts
import { Redis, useRedis } from '@hazejs/core'

await Redis.set('visits', 0)
await Redis.incr('visits')
await Redis.connection('cache').get('report:today')

// Same thing as a function, for services and composables
const cache = useRedis('cache')
await cache.hset('user:1', { name: 'Ada' })
```

Commands go to the **shared command connection** of that name, opened on first use. Common commands are typed; any other ioredis command can be called the same way and returns `Promise<any>`. For pipelines, transactions or the full ioredis types, take the client itself:

```ts
import type { Redis as IORedis } from 'ioredis'

const client = await Redis.client() as unknown as IORedis
await client.pipeline().set('a', 1).set('b', 2).exec()
```

Do not `SUBSCRIBE` or run blocking commands (`BRPOP`, `XREAD BLOCK`, ...) on the shared connection. Open a dedicated one instead; you own it and close it with `quit()`:

```ts
const subscriber = await Redis.subscriber()
subscriber.on('message', (channel, message) => { /* ... */ })
await subscriber.subscribe('orders')

const blocking = await Redis.create('default', { maxRetriesPerRequest: null })
const item = await blocking.brpop('jobs', 5)
await blocking.quit()
```

In a class, inject the manager: `inject(RedisManager).connection('cache')`. Outside an application (a standalone script), the facade falls back to the implicit `default` connection from `REDIS_URL`.

## Cache structures or the Redis facade

There are two ways to work with hashes, lists, sets and sorted sets:

```ts
// Through the cache: prefixed, serialized, typed
await Cache.store('redis').hash('user:1').set({ name: 'Ada', joined: new Date() }, '1h')

// Raw commands: exactly what you send
await Redis.hset('user:1', { name: 'Ada' })
```

| | `Cache.store('redis')` structures | `Redis` facade |
| --- | --- | --- |
| Keys | Cache `prefix` + tenant prefix (+ connection `keyPrefix`) | Only the connection's `keyPrefix` |
| Values | Serialized like cache values (objects, `Date`, `BigInt` round-trip); scores stay numbers | Strings and numbers as you pass them |
| TTL | Per handle, applied after each write; `expire()` / `ttl()` | `EXPIRE` yourself |
| `Cache.clear()` | Removes them with the rest of the store | Not affected |
| Tests | Work on a `memory` store, no Redis needed | Need Redis (or a mocked ioredis) |
| Coverage | The common commands of each type | Every Redis command, pipelines, transactions, pub/sub, streams, Lua |

Use the cache structures for application data that belongs to the cache: leaderboards, counters per field, recent-item lists, online sets, anything that should share the cache prefix, isolate per tenant and be cleared with the cache. Use the `Redis` facade when you need full control over keys and encoding (data shared with other services or languages), commands the cache does not wrap (streams, `SCAN`, `ZUNIONSTORE`, Lua), pipelines or pub/sub. Both run on the same shared connection: for a store with `connection: 'default'`, `await Cache.store('redis').handler()` is the same client as `await Redis.client('default')`. See [Cache](./cache#redis-data-structures).

## Which feature uses which connection

| Feature | Config | Connections |
| --- | --- | --- |
| Cache store `redis` (and throttling, sessions, locks, schedule `onOneServer` on it) | `config/cache.ts` `stores.<name>.connection` | Shared command connection |
| Queue `redis` (BullMQ) | `config/queue.ts` `connections.<name>.connection` | BullMQ's own: one per queue, two per worker (one blocking). Not shared with other features |
| WebSocket broadcasting | `config/websocket.ts` `broadcast.connection` | Shared (publish) + 1 dedicated subscriber |
| Broadcasting bus | `config/broadcasting.ts` `bus.connection` (defaults to the WebSocket settings) | Shared (publish, presence hash) + 1 dedicated subscriber |
| Socket.IO adapter | `config/socketio.ts` `adapter.connection` | Shared (publish) + 1 dedicated subscriber |
| Microservices `redis` transport | `config/microservices.ts` `transports.<name>.connection` | Client: shared + 1 dedicated (replies). Listener: shared + 2 dedicated (`BRPOP`, events) |
| `Redis` facade, `useRedis()` | — | Shared; `subscriber()` / `create()` are dedicated |
| `redisCheck()` | `config/health.ts` | Shared (`PING`) |

So an app that uses the cache, WebSocket broadcasting, broadcasting and Socket.IO on one `REDIS_URL` opens one shared connection plus one subscriber per pub/sub feature, instead of a pair per feature. Queues are the exception: BullMQ manages its own connections and only receives the settings.

Shared connections are created lazily, kept across hot reloads in dev, and closed when the application shuts down (`app.dispose()`, `SIGTERM`). Dedicated connections are closed by the feature that opened them, with a final sweep on shutdown.

### BullMQ

BullMQ needs `maxRetriesPerRequest: null` and refuses an ioredis `keyPrefix`. The queue driver therefore receives the connection's **settings** (URL, host, password, TLS, Sentinel, `options`) with `keyPrefix` removed and `maxRetriesPerRequest: null`, and BullMQ opens its own connections. Use the queue's `prefix` option (default `haze`) to separate apps. For Cluster and custom connections the driver gets one dedicated instance (shared by the queues, duplicated by workers) and closes it with the queue. On Cluster, give `prefix` a hash tag, e.g. `{haze}`.

## Key prefixes

`keyPrefix` is ioredis's key prefix. It is added to **keys** only:

- **Cache**: the connection's prefix goes in front of the cache prefix: `cache:` + `my-app:` + `key`. `Cache.flush()` takes it into account (ioredis does not prefix `SCAN` patterns, so the store does it). [Multi-tenancy](./tenancy) adds the tenant to cache keys on its own, inside the cache prefix, and is unaffected.
- **Pub/sub channel names are not prefixed.** WebSocket broadcasting (`channel`), the broadcasting bus (`prefix`) and the Socket.IO adapter (`key`) keep their own channel prefixes; set those to separate apps that share a Redis. The broadcasting bus's presence hashes and the microservices request lists are keys, so they do get the prefix.
- **BullMQ** ignores it (see above).

## Inline settings (backward compatible)

The older per-feature forms keep working and take precedence over `connection`:

```ts
stores: { redis: { driver: 'redis', url: env('REDIS_URL', 'redis://127.0.0.1:6379') } }
```

Precedence is `client` (cache only: a ready ioredis instance) > `url` > `connection` > the default connection. `options` next to `url` are that inline connection's options; next to `connection` they override the named connection's options for that feature, which then gets its own connection. The cache store's inline `url` form keeps its old defaults (`maxRetriesPerRequest: 2`); named connections use exactly the options you configure.

Features that also run outside an application, such as `createTransport()` / `redisTransport()` from `@hazejs/microservices`, resolve connections the same way and fall back to `REDIS_URL` (or `redis://127.0.0.1:6379`); used standalone they own and close all of their connections.

## Health check

`redisCheck()` in `config/health.ts` sends `PING` on a connection:

```ts
checks: {
  redis: redisCheck(),          // the default connection
  cache: redisCheck('cache'),   // a named connection
}
```

The name is looked up as a **Redis connection first**, then as a **cache store** (the older form: a read / write check on a `redis` or `upstash` store). A name that is neither reports `down`. You can still pass any object with `ping()`. See [Observability](./observability).

## Upstash and the edge

ioredis needs TCP sockets, so it does not run on Cloudflare Workers or other edge runtimes (it is stubbed out in Workers builds). For those, use the cache's `upstash` driver, which speaks HTTP through `@upstash/redis` and is configured in `config/cache.ts` with its own `url` / `token`; it does not use `config/redis.ts`. Queues on Workers use Cloudflare Queues, and broadcasting there is limited to one isolate.

| | ioredis (`config/redis.ts`) | Upstash (`upstash` cache driver) |
| --- | --- | --- |
| Protocol | TCP (RESP) | HTTP (REST) |
| Runs on | Node, Bun, Deno, Docker, Lambda | Also Workers, Vercel Edge, Netlify |
| Used by | Cache, queues, WebSocket, broadcasting, Socket.IO, microservices, facade | Cache store only |
| Pub/sub, blocking commands | Yes | No |
