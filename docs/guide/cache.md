# Cache

hazejs ships a cache layer in `@hazejs/core`: in-memory, Redis, Upstash and Cloudflare KV drivers behind a `Cache` facade. The API follows ThinkPHP (`Cache.set`, `Cache.get`, `Cache.inc`, `Cache.tag`, `cache()`), and the Laravel / PSR-16 names work too. On top of that there are tags, typed access to Redis hashes, lists, sets and sorted sets, atomic locks and a response-caching middleware. The same stores also back [rate limiting and sessions](./security) when you run more than one instance.

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
| `default` | Name of the store used by the `Cache` facade and `cache()` |
| `prefix` | Prepended to every key; `clear()` only removes keys under this prefix. Default `haze:` |
| `stores` | Named store configurations |
| `responseStore` | Store used by `cacheResponse`; defaults to `default` |
| `serializer` | `'typed'` (default), `'json'` or a custom serializer; each store can override it. See [Serialization](#serialization) |

Store names and drivers end up in the generated config types, so `Cache.store('redis')` is typed as a Redis store and a misspelled store name fails type checking (see [Typing](#typing)).

## Drivers

| Driver | Package | Atomic | Runs on the edge | Typical use |
| --- | --- | --- | --- | --- |
| `memory` | — | Yes | Yes (per isolate) | Development, tests, single instance |
| `redis` | `ioredis` | Yes | No (TCP) | Multi-instance Node / Bun / Docker / Lambda |
| `upstash` | `@upstash/redis` | Yes | Yes (HTTP) | Vercel, Netlify, Workers |
| `kv` | — (Workers binding) | No | Cloudflare only | Caching and sessions on Workers |
| `custom` | — | Your choice | Your choice | Anything implementing `CacheStore` |

- **redis** uses a named connection from [`config/redis.ts`](./redis) (`connection`, default: the `default` connection, which reads `REDIS_URL`); the store runs on that connection's shared command client, so Cluster, Sentinel and TLS are configured there. The connection's `keyPrefix` goes before the cache `prefix`, and `clear()` handles it. The older inline forms still work and take precedence: `url` (with `options` passed to ioredis) or a ready-made ioredis `client`. Increments, `push` and lock releases run as Lua scripts. Install with `pnpm add ioredis`.
- **upstash** needs `url` and `token`. Install with `pnpm add @upstash/redis`.
- **kv** reads the Workers binding named in `binding` (default `CACHE`). KV is eventually consistent, its minimum TTL is 60 seconds (shorter TTLs are enforced through metadata), and `add` / `increment` / `push` are read-then-write. Locks refuse to run on it.
- **custom** takes `{ driver: 'custom', store }`, where `store` implements the `CacheStore` interface exported from `@hazejs/core`: `get`, `set`, `add`, `delete`, `increment`, `deleteIf`, `clear`, plus `driver` and `atomic`. The optional `ttl`, `touch`, `push`, `handler`, `commands` and `tags` members enable the matching features.

What each driver supports is summarized in [Driver capabilities](#driver-capabilities).

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

await Cache.has('greeting')
await Cache.delete('greeting')
const flash = await Cache.pull('flash') // read and delete

const stats = await Cache.remember('stats', '10m', () => computeStats())
const settings = await Cache.rememberForever('settings', () => loadSettings())

await Cache.inc('views') // atomic, starts at 0
await Cache.dec('stock', 2)
await Cache.push('recent', { id: 7 }) // append to an array item

await Cache.store('redis').get('key') // a specific store
await Cache.clear() // everything under this store's prefix
```

| Method | Aliases | Description |
| --- | --- | --- |
| `get(key, fallback?)` | | Read a value; `fallback` may be a value or a (async) function |
| `getMultiple(keys)` | `many` | Read several keys into an object |
| `has(key)` | | Whether the key exists |
| `set(key, value, ttl?)` | | Write a value; no TTL means forever |
| `setMultiple(values, ttl?)` | `setMany` | Write several keys |
| `add(key, value, ttl?)` | | Write only if missing; returns whether it was written |
| `delete(key)` | `forget` | Delete a key; returns whether it existed |
| `deleteMultiple(keys)` | `deleteMany` | Delete several keys; returns how many existed |
| `pull(key)` | | Read and delete |
| `remember(key, ttl, fn)` | | Read, or run `fn` and cache its result (`undefined` is not cached) |
| `rememberForever(key, fn)` | | `remember` without expiry |
| `inc(key, by?, ttl?)` | `increment` | Atomic increment; the TTL is applied only when the key is created |
| `dec(key, by?, ttl?)` | `decrement` | Atomic decrement |
| `push(key, value, ttl?)` | | Append to an array item, creating it when missing. See [Push](#push) |
| `ttl(key)` | | Remaining seconds: a number, `undefined` for forever, `null` when missing |
| `touch(key, ttl?)` | `expire` | Change the TTL without rewriting the value (omit `ttl` for forever); returns whether the key exists |
| `clear()` | `flush` | Delete every key under the configured prefix |
| `tag(names)` | | A [tagged cache](#tags) |
| `handler()` | | The [underlying client](#the-underlying-client) |
| `lock(name, ttl?, owner?)` / `restoreLock(name, owner)` | | [Atomic locks](#atomic-locks) |
| `store(name?)` | | Switch to another store; returns a repository with the same methods |
| `redis(name?)` | | A store with [Redis data structures](#redis-data-structures); throws for other drivers |

The aliases are the same methods, so use whichever style your team prefers.

### TTL formats

A TTL is either a number of seconds or a string with a unit: `'30s'`, `'10m'`, `'2h'`, `'7d'`. Omit it to store the value forever.

### Remaining time and touch

```ts
await Cache.set('report', data, '1h')
await Cache.ttl('report') // 3600
await Cache.touch('report', '1d') // extend without rewriting the value
await Cache.expire('report') // make it permanent
await Cache.ttl('missing') // null
```

### Push

`push` appends one value to an array item and creates `[value]` when the key is missing. A value that is not an array throws a `TypeError`. Without a TTL the item keeps its current expiry (a new item is permanent); with one, the TTL is reset.

On `memory`, `redis` and `upstash`, `push` is atomic, so concurrent pushes never lose items. On Redis it is a Lua script that appends the encoded element to the end of the stored JSON array (`SETRANGE`) without decoding it, so the value stays a plain string that `get()` reads as an array. On `kv`, and with a custom serializer, it is read-then-write.

Unlike ThinkPHP, `push` does not remove duplicates or cap the array at 1,000 items. For long or frequently trimmed lists, use a [Redis list](#redis-data-structures).

## ThinkPHP → hazejs

| ThinkPHP | hazejs | Notes |
| --- | --- | --- |
| `Cache::set('name', $value, 3600)` | `await Cache.set('name', value, 3600)` | The TTL also accepts `'1h'` |
| `Cache::get('name', 'default')` | `await Cache.get('name', 'default')` | |
| `Cache::has / delete / pull` | `Cache.has / delete / pull` | |
| `Cache::inc('name', 3)` / `Cache::dec(...)` | `Cache.inc('name', 3)` / `Cache.dec(...)` | Atomic on memory, redis and upstash |
| `Cache::push('name', $value)` | `Cache.push('name', value)` | No de-duplication or 1,000-item cap |
| `Cache::remember('name', fn, 3600)` | `Cache.remember('name', 3600, fn)` | The TTL comes **before** the callback |
| `Cache::clear()` | `Cache.clear()` | Only keys under this app's prefix |
| `Cache::getMultiple / setMultiple / deleteMultiple` | Same names | |
| `Cache::store('redis')` | `Cache.store('redis')` | Typed per driver |
| `Cache::tag('t')->set(...)` / `->clear()` | `Cache.tag('t').set(...)` / `.clear()` | Read tagged items through the same tags (see [Tags](#tags)) |
| `Cache::tag('t')->append('name')` | — | Not supported |
| `Cache::handler()` | `await Cache.handler()` | |
| `Cache::store('redis')->handler()->hSet(...)` | `Cache.redis().hash(key).set(...)` | Typed, prefixed and serialized |
| `cache('name')` / `cache('name', $v, 3600)` / `cache('name', null)` | Same | See [below](#the-cache-helper) |

## The `cache()` helper

```ts
import { cache } from '@hazejs/core'

await cache('greeting', { text: 'hi' }, '10m') // set
const greeting = await cache<{ text: string }>('greeting') // get
await cache('greeting', null) // delete
await cache().remember('stats', '1h', compute) // the default store's repository
```

The helper always uses the default store. Only `null` deletes; `cache(key, undefined)` writes `null`, like `Cache.set`.

## Tags

Tags group items so you can invalidate them together:

```ts
await Cache.tag('user').set('user:1', user, '1h')
await Cache.tag(['user', 'post']).set('feed:1', feed)

await Cache.tag('user').get('user:1')
await Cache.tag(['post', 'user']).remember('feed:2', '10m', () => buildFeed(2)) // order does not matter

await Cache.tag('user').clear() // removes user:1 and feed:1, which was also tagged with 'user'
await Cache.store('redis').tag('user').clear() // tags on a specific store
```

A tagged cache supports `get`, `set`, `add`, `has`, `delete`, `many`, `pull`, `remember`, `rememberForever`, `inc` / `dec`, `push`, `ttl`, `touch` and `clear()`. `Cache.tag('a').tag('b')` is the same as `Cache.tag(['a', 'b'])`.

How it works: each tag has a version stored under `<prefix>tag:<name>:version`. A tagged item is stored in a namespace derived from the versions of all its tags, and `clear()` gives each of its tags a new version, so every item written with any of those tags becomes unreachable. This works on every driver, including KV. On `redis`, each tag also keeps an index of its keys, and `clear()` deletes them right away to free memory. On the other drivers, cleared items stay in storage until they expire, so give tagged items a TTL there.

::: warning Read with the same tags
A tagged item is only found through the same set of tags it was written with: `Cache.tag(['user', 'post']).set('feed', ...)` cannot be read with `Cache.get('feed')` or `Cache.tag('user').get('feed')`. Laravel behaves the same way. ThinkPHP, by contrast, stores tagged items under their plain key and uses the tag only for clearing.
:::

Tag versions live under the store prefix and the [tenant prefix](./tenancy), so clearing a tag in one app or tenant does not affect another. The keys `tag:*`, `tagged:*` and `lock:*` are reserved.

## Redis data structures

A store whose driver is `redis` gives you typed handles for Redis hashes, lists, sets and sorted sets. Keys get the cache prefix and the tenant prefix, and every element goes through the same [serializer](#serialization) as `get` / `set`. Sorted-set scores stay numbers.

```ts
import { Cache } from '@hazejs/core'

const redis = Cache.redis() // or Cache.store('redis'), typed from config/cache.ts

// Hash
const user = redis.hash('user:1')
await user.set('name', 'Ada')
await user.set({ email: 'ada@example.com', visits: 0 }, '1h')
await user.increment('visits')
await user.all() // { name: 'Ada', email: '...', visits: 1 }

// List
const recent = redis.list<{ id: number }>('recent', '1d')
await recent.push({ id: 1 }, { id: 2 })
await recent.trim(-100, -1) // keep the last 100
await recent.range(0, 9)

// Set (setOf() takes a TTL)
await redis.set('online').add('u1', 'u2')
await redis.setOf('online', '5m').has('u1')

// Sorted set (alias zset)
const board = redis.sortedSet('scores')
await board.add('ada', 42)
await board.add({ bob: 7, cy: 19 })
await board.increment('bob', 5)
await board.top(10) // [{ member: 'ada', score: 42 }, ...]
await board.rank('ada', { reverse: true }) // 0
```

| Structure | Methods |
| --- | --- |
| `hash(key, ttl?)` | `get(field)`, `set(field, value, ttl?)`, `set(record, ttl?)`, `all()`, `has(field)`, `delete(...fields)`, `increment(field, by?)`, `decrement`, `keys()`, `values()`, `length()` |
| `list(key, ttl?)` | `push(...values)` (RPUSH), `unshift(...values)` (LPUSH), `pop()`, `shift()`, `range(start?, stop?)`, `all()`, `length()`, `trim(start, stop)`, `remove(value, count?)` |
| `set(key)` / `setOf(key, ttl?)` | `add(...members)`, `remove(...members)`, `has(member)`, `members()`, `size()`, `pop(count?)`, `random(count?)` |
| `sortedSet(key, ttl?)` / `zset` | `add(member, score, ttl?)`, `add(record)`, `add([[member, score], ...], ttl?)`, `increment(member, by?)`, `score(member)`, `rank(member, { reverse })`, `range(start?, stop?, { reverse, withScores })`, `top(n)`, `rangeByScore(min, max, { reverse, withScores, limit })`, `remove(...members)`, `size()` |
| Every handle | `expire(ttl?)`, `ttl()`, `exists()`, `drop()`; lists, sets and sorted sets also have `delete()` |

- **TTL** applies to the whole key. Pass it when you create the handle (`redis.list('recent', '1d')`) and it is set after every write, in the same `MULTI` transaction. `hash.set` and `sortedSet.add` also take a TTL directly. `expire()` / `ttl()` work on a handle at any time.
- **`set(key)` with one argument** returns a set handle; with a value it is the ordinary cache write `set(key, value, ttl?)`. Use `setOf(key, ttl)` for a set with a TTL.
- **Hash fields** are deleted with `delete(field, ...fields)`; `drop()` deletes the whole hash.
- **Set members** are compared by their serialized form, so object members need the same key order.
- **Sorted-set members** that are arrays must use the entries form `add([[member, score]])`, and a single object argument is read as a `{ member: score }` record.
- `rangeByScore` bounds accept numbers, `'-inf'`, `'+inf'` and `'(5'` (exclusive).
- Reading a structure's key with `get()` throws `WRONGTYPE`, as in Redis.

For commands not covered here, use `redis.command(key, 'zunionstore', ...)` (prefixed and traced) or the raw client from `handler()`. See [Redis](./redis#cache-structures-or-the-redis-facade) for when to use these structures and when to use the `Redis` facade.

### In tests

`memory` stores emulate the same structures in-process, with the same return values, and drop empty structures as Redis does. Tests can point the `redis` store at memory and exercise code that uses `Cache.redis()` without a server:

```ts
// test config
cache: { stores: { redis: { driver: 'memory' } } }
```

The emulation is meant for tests: it lives in one process and covers only the commands above.

### Typing

- `Cache.store('redis')` returns `RedisCacheRepository` when `config/cache.ts` declares `redis` with `driver: 'redis'`, `MemoryCacheRepository` for `memory` stores (the same API, for tests), and `CacheRepository` for other drivers. The types come from the generated config (`haze dev` / `haze typegen`); before it is generated, every store is a `CacheRepository`.
- `Cache.redis(name?)` always returns `RedisCacheRepository` and throws at runtime when the store has no data structures (memory stores are accepted, for tests).
- `isRedisCache(repository)` is the runtime type guard, and `CacheRepositoryFor<'name'>` gives the type for a store name.

```ts
import { Cache, isRedisCache } from '@hazejs/core'

const store = Cache.store() // the default store: CacheRepository
if (isRedisCache(store))
  await store.hash('report').set('status', 'done')
```

## Serialization

Values are stored as JSON with type restoration by default: `Date`, `BigInt`, `Map`, `Set`, and `undefined` inside arrays and objects come back as the same types. Only those values get a compact tag. Everything else stays plain JSON, so other languages and tools can still read the data:

```json
{"id":1,"name":"Ada","joined":{"$t":"Date","v":"2026-10-28T08:00:00.000Z"},"roles":{"$t":"Set","v":["admin"]}}
```

- Objects with `toJSON()` (models, resources) are stored through `toJSON()`, as before.
- Values written by earlier versions (plain JSON) read back unchanged. The one exception is an object whose only keys are `$t` and `v`, with `$t` set to one of the tag names. New values containing such objects are escaped automatically.
- Increments and locks store raw numbers and strings and do not go through the serializer.

Choose the serializer globally or per store:

```ts
export default defineCacheConfig(() => ({
  default: 'redis',
  serializer: 'typed', // the default
  stores: {
    redis: { driver: 'redis', connection: 'default' },
    // Plain JSON, e.g. for data another service reads: Date and BigInt become strings
    shared: { driver: 'redis', connection: 'default', serializer: 'json' },
    // Your own: { serialize(value): string, deserialize(raw): unknown }
    packed: { driver: 'redis', connection: 'default', serializer: msgpackSerializer },
  },
}))
```

`jsonSerializer` and `typedSerializer` are exported for reuse. With a custom serializer, `push` falls back to read-then-write, and hash `increment` only works on fields that the serializer stores as plain numbers.

::: warning Upgrading
With the typed serializer, a cached `Date` comes back as a `Date` and a `BigInt` as a `bigint`; earlier versions returned strings. During a rolling deploy, instances that still run an older version read new tagged values as `{ $t, v }` objects. Set `serializer: 'json'` to keep the previous behavior.
:::

## The underlying client

`handler()` returns the driver's client for anything the cache API does not cover:

| Driver | `await Cache.store(name).handler()` |
| --- | --- |
| `redis` | The shared ioredis client of the store's connection from `config/redis.ts` (the same instance the `Redis` facade uses), typed as `RedisClient` |
| `upstash` | The `@upstash/redis` client (`UpstashClientLike`; cast to `Redis` from `@upstash/redis` for the full types) |
| `memory` | The in-memory `Map<string, MemoryCacheEntry>` |
| `kv` | The KV binding (`KvNamespaceLike`; cast to `KVNamespace`) |

Keys you use on the client directly do not get the cache prefix. `repository.key('name')` returns the prefixed key.

## Driver capabilities

| | memory | redis | upstash | kv |
| --- | --- | --- | --- | --- |
| Atomic `add` / `inc` / locks | Yes | Yes | Yes | No (read-then-write) |
| `push` | Atomic | Atomic (Lua) | Atomic (Lua) | Read-then-write |
| `ttl()` | Yes | Yes | Yes | From metadata; items written without a TTL report forever |
| `touch()` | Yes | Yes (`EXPIRE` / `PERSIST`) | Yes | Rewrites the value (KV cannot change only the TTL) |
| Tags | Versions | Versions + key index deleted on `clear()` | Versions | Versions, eventually consistent |
| Data structures | Emulated (for tests) | Yes | — | — |
| `handler()` | `Map` | ioredis client | Upstash client | KV binding |

A `custom` store gets each feature when it implements the matching optional member of `CacheStore`. Without `touch`, `touch()` rewrites the value; without `push`, `push()` is read-then-write.

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

`manager.store(name?)` returns the same repositories as the facade (it also accepts any string), and `manager.redis(name?)` matches `Cache.redis()`. Cache operations, including tag clears and data-structure commands, show up in the [dev dashboard](./observability) and, when enabled, as OpenTelemetry spans.
