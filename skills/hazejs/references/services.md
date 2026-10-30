# Services: cache, Redis, storage, HTTP client, i18n, crypto, search, tenancy, views, AI

Cross-cutting services that ship with `@hazejs/core` or as optional `@hazejs/*` packages. Snippets use the API-template layout (`config/*.ts`, `app/...`, `route/*.ts`, `~/` = backend `srcDir`). In vue/react projects the same files live under `server/`.

Every `config/<name>.ts` uses the function form (`defineXxxConfig(() => ({ ... }))`) whenever it reads `env()`, so values from `.env` are seen.

## Cache

Full guide: [cache.md](../../../docs/guide/cache.md)

```ts
// config/cache.ts — without this file: one in-memory store, prefix 'haze:'
import { defineCacheConfig, env } from '@hazejs/core'

export default defineCacheConfig(() => ({
  default: env('CACHE_STORE', 'memory'),
  prefix: env('CACHE_PREFIX', 'my-app:'),          // clear() only removes keys under it
  stores: {
    memory: { driver: 'memory' },
    redis: { driver: 'redis', connection: 'default' }, // connection from config/redis.ts
    upstash: { driver: 'upstash', url: env('UPSTASH_REDIS_REST_URL', ''), token: env('UPSTASH_REDIS_REST_TOKEN', '') },
    kv: { driver: 'kv', binding: 'CACHE' },           // Cloudflare Workers binding
  },
  responseStore: 'redis',                            // used by the cacheResponse middleware
  // serializer: 'typed' (default) | 'json' | { serialize, deserialize }
}))
```

| Driver | Package | Atomic | Edge | Use |
| --- | --- | --- | --- | --- |
| `memory` | — | yes | per isolate | dev, tests, single instance |
| `redis` | `ioredis` | yes | no (TCP) | multi-instance Node/Bun/Docker/Lambda |
| `upstash` | `@upstash/redis` | yes | yes (HTTP) | Vercel, Netlify, Workers |
| `kv` | Workers binding | **no** | Cloudflare only | caching/sessions on Workers; locks throw |
| `custom` | — | your choice | your choice | `{ driver: 'custom', store }` implementing `CacheStore` |

| Config option | Default | Notes |
| --- | --- | --- |
| `default` | `'memory'` | store behind `Cache` and `cache()` |
| `prefix` | `'haze:'` | before every key; tenant prefix comes after it |
| `stores` | `{ memory: { driver: 'memory' } }` | names + drivers are typegen'd: a misspelled `Cache.store('x')` or `connection` is a type error |
| `responseStore` | `default` | store used by `cacheResponse` |
| `serializer` | `'typed'` | global; each store may override (`{ driver: 'redis', serializer: 'json' }`) |

- `redis`: `connection` (default: the `default` connection of `config/redis.ts`). Legacy inline forms take precedence: `client` (ready ioredis instance) > `url` (+ `options`; keeps old default `maxRetriesPerRequest: 2`) > `connection`. The connection's `keyPrefix` goes before the cache `prefix`; `clear()` accounts for it. `inc`/`push`/lock release run as Lua.
- `upstash`: `url` + `token` required (`pnpm add @upstash/redis`); independent of `config/redis.ts`.
- `kv`: `binding` (default `'CACHE'`, or the binding object). Eventually consistent, min TTL 60 s (shorter TTLs enforced via metadata), `add`/`inc`/`push` are read-then-write, `touch()` rewrites the value.
- `custom` store members: `driver`, `atomic`, `get`, `set`, `add`, `delete`, `increment` (→ `{ value, ttl }`), `deleteIf(key, expected)`, `clear(prefix)`; optional `ttl`, `touch`, `push`, `handler`, `commands` (data structures), `tags` (key index), `close`. Missing `touch` → rewrite; missing `push` → read-then-write.
- Conditional store: `...(redis ? { locks: { driver: 'redis', connection: 'default' } } : {})` inside `stores`; using an absent store throws `Cache store "locks" is not defined`.

### API (`Cache` facade, `cache()` helper)

```ts
import { Cache, cache } from '@hazejs/core'

await Cache.set('greeting', { text: 'hi' }, '10m')   // TTL: seconds or '30s' '10m' '2h' '7d'; omit = forever
await Cache.get<{ text: string }>('greeting')
await Cache.get('name', 'guest')                     // fallback value
await Cache.get('name', () => loadName())            // fallback fn
await Cache.add('k', 1, 60)                          // only if missing → boolean
await Cache.pull('flash')                            // read + delete
const stats = await Cache.remember('stats', '10m', () => computeStats()) // TTL BEFORE callback
await Cache.rememberForever('settings', loadSettings)
await Cache.inc('views'); await Cache.dec('stock', 2) // atomic; TTL applied only on creation
await Cache.push('recent', { id: 7 })                // append to array item
await Cache.ttl('report')                            // seconds | undefined (forever) | null (missing)
await Cache.touch('report', '1d')                    // change TTL without rewriting; alias expire()
await Cache.store('redis').get('key')                // a specific store (typed per driver)
await Cache.clear()                                  // alias flush()

await cache('greeting', { text: 'hi' }, '10m')       // set (default store only)
await cache<{ text: string }>('greeting')            // get
await cache('greeting', null)                        // delete — only null deletes
await cache().remember('stats', '1h', compute)       // repository of default store
```

Aliases: `many`/`getMultiple`, `setMany`/`setMultiple`, `forget`/`delete`, `deleteMany`/`deleteMultiple`, `increment`/`inc`, `decrement`/`dec`, `expire`/`touch`, `flush`/`clear`. `handler()` returns the raw client (ioredis, Upstash client, `Map`, KV binding) — keys used there are **not** prefixed; `repository.key('name')` gives the prefixed key.

| Method | Returns / semantics |
| --- | --- |
| `get(key, fallback?)` | value; `fallback` is a value or (async) fn, used when missing |
| `many(keys)` | `Record<key, T \| undefined>` |
| `has(key)` / `delete(key)` | boolean (`delete` → whether it existed) |
| `deleteMany(keys)` | number of keys that existed |
| `set(key, value, ttl?)` / `setMany(record, ttl?)` | void; no TTL = forever |
| `add(key, value, ttl?)` | boolean (written); atomic except `kv` |
| `remember(key, ttl, fn)` | cached or computed; `undefined` results not cached |
| `inc/dec(key, by = 1, ttl?)` | new number; missing key starts at 0; TTL only on creation; stored raw (no serializer) |
| `push(key, value, ttl?)` | creates `[value]`; non-array value → `TypeError`; without `ttl` keeps current expiry, with `ttl` resets it; atomic on memory/redis/upstash; no dedupe, no 1000-item cap (use `redis.list`) |
| `ttl(key)` | seconds \| `undefined` (forever) \| `null` (missing) |
| `touch(key, ttl?)` | boolean (exists); omit `ttl` → forever |
| `lock(name, ttl = 60, owner?)` / `restoreLock(name, owner)` | `Lock` |
| `store(name?)` / `redis(name?)` | facade only; `redis()` throws unless the driver is `redis` (or `memory`, for tests) |

### Tags, locks, response cache

```ts
await Cache.tag('user').set('user:1', user, '1h')
await Cache.tag(['user', 'post']).set('feed:1', feed)
await Cache.tag(['post', 'user']).get('feed:1')   // must read with the SAME tag set (order irrelevant)
await Cache.tag('user').clear()                   // invalidates everything tagged 'user'

import { LockTimeoutException } from '@hazejs/core'
await Cache.lock('report', '30s').run(() => generateReport())     // throws LockTimeoutException if taken
await Cache.lock('report', '30s').run(() => generateReport(), 5)  // wait up to 5 s
const lock = Cache.lock('import', 120)
if (await lock.get()) { try { await runImport() } finally { await lock.release() } }
// lock.block(seconds), Cache.restoreLock(name, lock.owner) from another process
```

- Tagged cache: `get`, `set`, `add`, `has`, `delete`, `many`, `pull`, `remember`, `rememberForever`, `inc`/`dec`, `push`, `ttl`, `touch`, `clear()`. `Cache.tag('a').tag('b')` ≡ `Cache.tag(['a', 'b'])`; per store: `Cache.store('redis').tag('user')`. ThinkPHP `tag()->append()` has no equivalent.
- Tag mechanics: version key `<prefix>tag:<name>:version`; `clear()` bumps the versions. Only `redis` also deletes the old keys (tag key index); on memory/upstash/kv cleared items linger until expiry — give tagged items a TTL. Reserved key spaces: `tag:*`, `tagged:*`, `lock:*`.
- Locks: atomic set-if-absent + random `owner` token; default TTL 60 s; `get()` = one try → boolean; `block(seconds, intervalMs = 250)` throws `LockTimeoutException`; `run(fn, waitSeconds?)` acquires, runs, releases; `release()` only deletes when this owner holds it. memory/redis/upstash only (`kv` throws).
- `cacheResponse:<ttl = 60>[,user]`: caches only `200` `GET`/`HEAD` by path + query; skips `Cache-Control: no-store`/`private`; never stores `Set-Cookie`; hits get `Age`. Stored in `responseStore`.

```ts
// route/api.ts — caches 200 GET/HEAD responses; X-Cache: HIT|MISS
r.get('/api/stats', [StatsController, 'index']).middleware('cacheResponse:60')
r.get('/api/me/feed', [FeedController, 'index']).middleware('cacheResponse:5m,user') // per user
```

### Typed Redis structures (redis store; memory emulates them for tests)

```ts
const redis = Cache.redis()                       // or Cache.store('redis') once types are generated
const user = redis.hash('user:1')
await user.set({ email: 'ada@example.com', visits: 0 }, '1h')
await user.increment('visits'); await user.all()
const recent = redis.list<{ id: number }>('recent', '1d')
await recent.push({ id: 1 }); await recent.trim(-100, -1); await recent.range(0, 9)
await redis.set('online').add('u1')               // set(key) with ONE arg = set handle
await redis.setOf('online', '5m').has('u1')        // set with TTL
const board = redis.sortedSet('scores')            // alias zset
await board.add('ada', 42); await board.increment('bob', 5); await board.top(10)
await redis.command('zscores', 'zunionstore', /* ... */) // anything else: prefixed + traced
```

Every handle: `expire(ttl?)`, `ttl()`, `exists()`, `drop()`. Keys get cache prefix + tenant prefix; values go through the serializer. `isRedisCache(repo)` is the runtime guard; `inject(CacheManager)` is the injectable manager.

| Handle | Methods |
| --- | --- |
| `hash(key, ttl?)` | `get(field)`, `set(field, value, ttl?)`, `set(record, ttl?)`, `all()`, `has(field)`, `delete(...fields)`, `increment(field, by?)`, `decrement`, `keys()`, `values()`, `length()` |
| `list(key, ttl?)` | `push(...v)` (RPUSH), `unshift(...v)` (LPUSH), `pop()`, `shift()`, `range(start = 0, stop = -1)`, `all()`, `length()`, `trim(start, stop)`, `remove(value, count = 0)`, `delete()` |
| `set(key)` / `setOf(key, ttl?)` | `add(...m)`, `remove(...m)`, `has(m)`, `members()`, `size()`, `pop(count?)`, `random(count?)`, `delete()` |
| `sortedSet(key, ttl?)` / `zset` | `add(member, score, ttl?)`, `add({ m: score })`, `add([[m, score]], ttl?)`, `increment(m, by?)`, `decrement`, `score(m)`, `rank(m, { reverse })`, `range(start?, stop?, { reverse, withScores })`, `top(n)` → `{ member, score }[]`, `rangeByScore(min, max, { reverse, withScores, limit: { offset, count } })`, `remove(...m)`, `size()`, `delete()` |
| repository | `command(key, 'zunionstore', ...args)`, `commandBatch(key, [['hset', ...], ['expire', ...]])` (MULTI on redis) |

- Handle TTL applies to the whole key and is re-set after every write in the same `MULTI`; `drop()` deletes the key, `hash.delete(...)` deletes fields.
- `set(key)` with **one** arg = set handle; with a value it is the normal cache write. Set members compare by serialized form (same key order for objects). Sorted-set array members need the entries form. `rangeByScore` bounds: numbers, `'-inf'`, `'+inf'`, `'(5'` (exclusive). Reading a structure key with `get()` throws `WRONGTYPE`.
- Tests: map the store to memory (`cache: { stores: { redis: { driver: 'memory' } } }`) — same API and return values, empty structures dropped, single process only.

### Typing, serialization, raw client

- After typegen: `Cache.store('redis')` → `RedisCacheRepository` (driver `redis`), `MemoryCacheRepository` (driver `memory`, same API), else `CacheRepository`; `Cache.store()` (default) is `CacheRepository` → narrow with `isRedisCache()`. `CacheRepositoryFor<'name'>` gives the type. `manager.store(name)` also accepts any string.
- Typed serializer = plain JSON plus tags only for `Date`, `BigInt`, `Map`, `Set`, `undefined`-in-containers: `{"$t":"Date","v":"2026-…"}`. Objects with `toJSON()` (models) are stored via `toJSON()`. `jsonSerializer` / `typedSerializer` are exported; custom = `{ serialize(value): string, deserialize(raw): unknown }` (then `push` is read-then-write and hash `increment` only works on plain-number fields). Rolling deploys from older versions: use `'json'`.

| Driver | `await Cache.store(n).handler()` |
| --- | --- |
| `redis` | shared ioredis client of the connection (same instance as `Redis.client(conn)`), typed `RedisClient` |
| `upstash` | `@upstash/redis` client (`UpstashClientLike`) |
| `memory` | `Map<string, MemoryCacheEntry>` |
| `kv` | the binding (`KvNamespaceLike`) |

Cache operations (incl. tag clears and structure commands) appear in the dev dashboard and as OpenTelemetry spans.

## Redis

Full guide: [redis.md](../../../docs/guide/redis.md). All TCP Redis access uses `ioredis` (`pnpm add ioredis`). Cache, queues (BullMQ), WebSocket broadcast, broadcasting bus, Socket.IO adapter and microservices refer to connections **by name**.

```ts
// config/redis.ts — optional: without it there is one 'default' connection from REDIS_URL
import { defineRedisConfig, env } from '@hazejs/core'

export default defineRedisConfig(() => ({
  default: 'default',
  connections: {
    default: { url: env('REDIS_URL', 'redis://127.0.0.1:6379') },
    cache: { url: env('REDIS_CACHE_URL', 'redis://127.0.0.1:6379/1'), keyPrefix: 'cache:' },
    // { host, port, username, password, db, tls } | { cluster: [...] } | { sentinels, name } | { client: () => new IORedis(...) }
  },
}))
```

```ts
import { Redis, useRedis } from '@hazejs/core'

await Redis.set('visits', 0)
await Redis.incr('visits')
await Redis.connection('cache').get('report:today')
await useRedis('cache').hset('user:1', { name: 'Ada' })
const client = await Redis.client()               // full ioredis client (pipelines, multi)
const sub = await Redis.subscriber()              // dedicated; never SUBSCRIBE on the shared one
await sub.subscribe('orders')
const blocking = await Redis.create('default', { maxRetriesPerRequest: null }) // for BRPOP etc.
await blocking.quit()
```

Use cache structures for app data that should share the cache prefix/tenant isolation/`Cache.clear()`; use the `Redis` facade for raw keys, streams, Lua, pub/sub. `keyPrefix` prefixes keys only, never pub/sub channels; BullMQ ignores it (use the queue `prefix`). `client` must be a **factory**, not an instance.

| Connection form | Options |
| --- | --- |
| single node | `url` (`redis://` / `rediss://`) or `host`, `port`, `username`, `password`, `db`, `tls` (`true` or ioredis TLS options) |
| cluster | `cluster: [{ host, port } \| 'host:port']`; node options in `options.redisOptions` (top-level `username`/`password`/`db`/`tls` are copied there) |
| sentinel | `sentinels: [{ host, port }]` + `name` (master name) |
| custom | `client: () => new IORedis(...)` — called again for dedicated connections (import ioredis' `Redis` under another name) |
| every form except `client` | `keyPrefix`, `options` (passed to ioredis as-is: `connectTimeout`, `maxRetriesPerRequest`, `retryStrategy`, …). A `client` factory's instance is used as-is (`keyPrefix`/`options` ignored); dedicated connections `duplicate()` it with their overrides |

- `default`: defaults to `'default'`, else the first connection. No file → implicit `default` from `REDIS_URL` (fallback `redis://127.0.0.1:6379`); standalone scripts (no app) use the same fallback.
- Features pick a connection with `connection: '<name>'`; neither `connection` nor `url` → default. Inline precedence: `client` (cache only) > `url` > `connection` > default. `options` next to `connection` override that connection's options and open a separate connection for that feature.
- `Redis.*` commands run on the shared command connection (lazy, survives dev hot reload, closed on `app.dispose()`/`SIGTERM`). Common commands are typed; others return `Promise<any>`. Full ioredis types: `await Redis.client() as unknown as IORedis` → `.pipeline()`, `.multi()`. In classes: `inject(RedisManager).connection('cache')`.
- Connection names are typegen'd (`GeneratedRedisConnections`): `Redis.connection('cahce')` or `connection: 'cahce'` in other configs fails type checking.

| Feature | Config key | Connections opened |
| --- | --- | --- |
| cache `redis` store (+ throttle, sessions, locks, `onOneServer`) | `config/cache.ts` `stores.<n>.connection` | shared |
| queue `redis` (BullMQ) | `config/queue.ts` `connections.<n>.connection` | BullMQ's own (settings only, `keyPrefix` stripped, `maxRetriesPerRequest: null`); Cluster: give queue `prefix` a hash tag `{haze}` |
| WebSocket broadcast / broadcasting bus / Socket.IO adapter | `broadcast.connection` / `bus.connection` / `adapter.connection` | shared publish + 1 dedicated subscriber each |
| microservices `redis` transport | `transports.<n>.connection` | client: shared + 1; listener: shared + 2 |
| health | `redisCheck(name?)` in `config/health.ts` | shared `PING`; name tried as Redis connection, then cache store |

`upstash` (HTTP) is cache-only and the only Redis option on Workers/Vercel Edge; no pub/sub or blocking commands there.

## File storage

Full guide: [storage.md](../../../docs/guide/storage.md)

```ts
// config/filesystem.ts — without it: 'local' (storage/app) and 'public' (storage/app/public, served at /storage)
import { defineFilesystemConfig, env } from '@hazejs/core'

export default defineFilesystemConfig(() => ({
  default: env('FILESYSTEM_DISK', 'local'),
  disks: {
    local: { driver: 'local', root: 'storage/app' },
    public: { driver: 'local', root: 'storage/app/public', url: '/storage', serve: true },
    s3: {
      driver: 's3',
      bucket: env('S3_BUCKET', ''),
      region: env('S3_REGION', 'us-east-1'),
      endpoint: env('S3_ENDPOINT', '') || undefined,   // MinIO, R2 S3 API, …
      accessKeyId: env('S3_ACCESS_KEY_ID', ''),
      secretAccessKey: env('S3_SECRET_ACCESS_KEY', ''),
    },
    r2: { driver: 'r2', binding: 'BUCKET', url: 'https://files.example.com' },
  },
}))
```

| Driver | Notes |
| --- | --- |
| `local` | Node/Bun/Deno; `root`, `url`, `serve: true` lets the framework serve files under a site-path `url` |
| `s3` | `pnpm add @aws-sdk/client-s3 @aws-sdk/lib-storage @aws-sdk/s3-request-presigner`; options `bucket`, `region`, `endpoint`, `forcePathStyle`, credentials, `root`, `url`, `multipartThreshold` |
| `r2` | Workers binding (`binding`, default `BUCKET`); no native presigning |
| `memory` / `custom` | tests / your own `DiskDriver` |

- Top-level: `default` (`'local'`), `disks` (merged over built-in `local` + `public`), `signedRoute` (`'/__haze/storage'`).
- `local`: `root` default `storage/app`, resolved against cwd; streamed I/O; paths can never leave the root. `serve` default `false` and requires a site-path `url`; skipped on Workers.
- `s3`: `bucket` required; `region` `'us-east-1'`; `forcePathStyle` defaults to `true` when `endpoint` is set; no keys → SDK default credential chain; `root` = key prefix; `multipartThreshold` 8 MB (streams always multipart); without `url` use `temporaryUrl()`.
- `r2`: `binding` name from `wrangler.json` `r2_buckets` (default `'BUCKET'`) or an `R2Bucket` object; need direct presigned links → `s3` driver against R2's S3 API.
- `memory`: `{ driver: 'memory', url? }`. `custom`: `{ driver: 'custom', disk }`, `DiskDriver` = `put`, `get`, `stream`, `meta`, `delete`, `copy`, `list`, optional `url`, `temporaryUrl`.

```ts
import { Storage } from '@hazejs/core'

await Storage.put('reports/2026.csv', csv)                     // default disk
const disk = Storage.disk('s3')
await disk.put('exports/data.json', json, { contentType: 'application/json', cacheControl: 'max-age=60' })
const path = await disk.putFile('avatars', file)               // random name, keeps extension
await disk.text('notes/a.txt'); await disk.json<T>('x.json')   // undefined when missing
await disk.exists('a'); await disk.copy('a', 'b'); await disk.move('b', 'c'); await disk.delete(['a', 'c'])
await disk.files('notes', { recursive: true })
Storage.disk('public').url('avatars/ada.png')                  // throws if the disk has no url
await disk.temporaryUrl('invoices/42.pdf', '10m', { download: 'invoice-42.pdf' })
```

| Disk method (also on `Storage` for the default disk) | Returns |
| --- | --- |
| `put(path, content, { contentType?, cacheControl?, filename? })` | path; content: `string \| Uint8Array \| ArrayBuffer \| Blob \| ReadableStream`; `contentType` inferred from extension; `cacheControl` stored as S3/R2 metadata; `filename` becomes S3 `Content-Disposition` only (R2 drops it) |
| `putFile(dir, file, opts?)` / `putFileAs(dir, file, name, opts?)` | path (random name + original extension / given name; only last name segment used) |
| `get(path)` / `text` / `json<T>` / `stream` | `Uint8Array` / string / T / `ReadableStream` — `undefined` when missing |
| `meta(path)` | `{ path, size, contentType?, lastModified?, etag? }` \| `undefined` |
| `exists` / `missing` / `size(path)` | boolean / boolean / number \| `undefined` |
| `delete(path \| paths)` / `deleteDirectory(dir)` | number that existed |
| `copy(from, to)` / `move(from, to)` | void |
| `files(dir = '', { recursive? })` | paths; direct children unless `recursive` |
| `url(path)` / `temporaryUrl(path, expires, { download? })` | string (sync) / `Promise<string>`; `expires` seconds or `'10m'` |
| `response(path, { download?: true \| name, headers?, request? })` / `download(path, name?)` | `Response` (streamed, `Content-Type`/`Length`, `ETag`, `Last-Modified`; missing → `NotFoundException`) |

Path safety: leading `/` stripped, `.`/duplicate segments collapsed, any `..` segment rejected. With tenancy, paths (and their URLs) get `tenants/<id>/`. `Storage.fake(name?)` keeps the disk's `url`; `Storage.restore(name?)` restores; `useTestApp()` gives each test a fresh app.

`temporaryUrl`: native presigned URL on `s3`; on `local`/`r2`/`memory` a framework-signed `/__haze/storage/<disk>/<path>?expires=…&signature=…` (HMAC with `APP_KEY`, 403 when tampered/expired). Set `APP_URL` for absolute links.

```ts
// Uploads: ctx.file() returns an UploadedFile
const path = await (await ctx.file('avatar'))!.store('avatars', 'public')  // disk name or { disk, cacheControl }
await (await ctx.file('doc'))!.storeAs('docs', 'contract.pdf', { disk: 's3' })

// File responses (ETag/304/HEAD when request is passed)
r.get('/reports/:name', ctx => Storage.response(`reports/${ctx.param('name')}`, { request: ctx.req }))
r.get('/export', () => Storage.download('reports/2026.csv', 'report.csv'))

// Tests
const fake = Storage.fake('public'); await fake.assertExists(path)  // assertMissing/assertCount/assertDirectoryEmpty
```

## Outgoing HTTP client (`Http`)

Full guide: [http-client.md](../../../docs/guide/http-client.md). Fetch-based, zero deps, runs on every runtime. Builders are immutable — every method returns a new builder.

```ts
import { Http } from '@hazejs/core'

const res = await Http.get('https://api.example.com/users', { query: { page: 2 } })
const users = await res.throw().json<User[]>()        // throw() → HttpRequestException on 4xx/5xx
await Http.post(url, { name: 'Ada' })                  // JSON by default
await Http.asForm().post(url, data); await Http.asMultipart().post(url, { photo: file })
await Http.withToken(token).acceptJson().timeout('5s').retry(3, { backoff: 'exponential' }).get(url)

// app/service/github.ts — reusable configured builder
export const github = Http.baseURL('https://api.github.com').withToken(process.env.GITHUB_TOKEN!)
await github.withUrlParameters({ owner: 'penna-org', repo: 'haze' }).get('/repos/{owner}/{repo}')
```

```ts
// config/http.ts — defaults apply to Http (not Http.create()); named clients
import { defineHttpConfig, env } from '@hazejs/core'

export default defineHttpConfig(() => ({
  defaults: { timeout: '10s', headers: { 'user-agent': 'my-app/1.0' } },
  clients: {
    github: { baseURL: 'https://api.github.com', token: env('GITHUB_TOKEN'), timeout: '5s', retry: { times: 3, backoff: 'exponential' } },
  },
}))
// await Http.client('github').get('/user')
```

| Feature | API |
| --- | --- |
| Timeout | `timeout('5s' \| ms \| false)`, **per attempt**, default `30s`; `TimeoutException` |
| Retries | `retry(times, { delay, backoff, maxDelay, retryAfter, maxRetryAfter, when })`; `times` includes the first attempt; default retries on connect errors and 408/425/429/500/502/503/504 |
| Pools | `Http.pool(p => [p.get(a), p.get(b)], { concurrency: 5 })` or object form `{ user: p.get(...) }` |
| Middleware | `withMiddleware(async (request, next) => next(request))` — runs per attempt |
| Streaming | `res.stream()` (Uint8Array chunks), `res.sse()` (events) |
| Third-party SDKs | `new OpenAI({ fetch: Http.timeout(false).toFetch() })` |
| Errors | `HttpRequestException`, `ConnectionException`, `TimeoutException`, `StrayRequestException` |
| Tests | `Http.fake({ 'api.github.com/*': Http.response({...}) })`, `Http.preventStrayRequests()`, `Http.assertSent(...)`, `Http.sequence()` |

Requests: `get(url, opts?)`, `head`, `delete(url, opts?)` (body via `opts.body`), `post/put/patch(url, data?, opts?)`, `send(method, url, opts?)` → `Promise<HttpClientResponse>`. `opts` = any builder setting for one request (`query`, `headers`, `timeout`, `retry`, `signal`, …). `query`: arrays repeat the key, `null`/`undefined` skipped, existing URL params kept.

| Builder | Notes |
| --- | --- |
| `baseURL(url)` | concatenated (`/api/v1` + `/users`); absolute URLs ignore it; `{placeholders}` from `withUrlParameters()` (encoded) |
| `withHeaders(obj)`, `withHeader(n, v)`, `accept(type)`, `acceptJson()`, `contentType(t)`, `withUserAgent(ua)` | |
| `withToken(token, type = 'Bearer')`, `withBasicAuth(user, pass)` | `user:pass@` in a URL becomes basic auth |
| `withQuery(obj)`, `withOptions(opts)`, `withSignal(signal)`, `withFetch(fn)`, `withoutRedirecting()` | `withFetch(env.SVC.fetch.bind(env.SVC))` for Workers service bindings |
| `asJson()` (default), `asForm()`, `asMultipart()`, `bodyFormat(f)`, `attach(name, contents, filename?, type?)`, `withBody(body, contentType?)` | nested objects → `user[name]`, arrays repeat; `Blob`/`File` in multipart = file; objects → JSON (`BigInt` → string); strings/`Blob`/buffers/`FormData`/`URLSearchParams`/`ReadableStream` sent as is |
| `throw(enabled = true)` | auto `HttpRequestException` on 4xx/5xx |
| `client(name)`, `pool(fn, { concurrency })`, `toFetch()` | `toFetch()` buffers the request body |

| Response member | Notes |
| --- | --- |
| `status`, `statusText`, `headers`, `url`, `redirected`, `ok`, `raw`, `request`, `faked` | |
| `successful()`, `failed()`, `clientError()`, `serverError()`, `redirect()`, `header(name)` | |
| `json<T>()`, `text()`, `blob()`, `bytes()`, `arrayBuffer()` | share one buffer (re-callable); empty body → `json()` is `null`; 4xx/5xx bodies are pre-buffered |
| `stream()`, `sse()` | read once, unbuffered; `sse()` → `{ event, data, id, retry }` |
| `throw()`, `throwIf(cond)`, `toResponse()` | `toResponse()` = standard `Response` to return from a route |

Client options (`config/http.ts` `defaults`/`clients.<name>`, `Http.create(opts)`): `baseURL`, `headers`, `query`, `token`, `basicAuth: [user, pass]`, `timeout` (`30s`, `false` = none, numbers = ms), `retry` (number or options), `bodyFormat` (`json`), `middleware`, `fetch`, `redirect` (`follow` \| `manual` \| `error`), `throw`. Top-level `redactHeaders: string[]` masks extra headers in telemetry. Layering: `defaults` → named client → builder → per-request; headers/query merge, middleware accumulates, rest overrides. `Http.create()` skips `defaults`.

Retry options: `delay` (`100ms`), `backoff` (`'constant'` default \| `'linear'` \| `'exponential'` \| `number[]` \| `(retry) => ms`), `maxDelay`, `retryAfter` (`true`; honors `retry-after`/`retry-after-ms` on 429/503), `maxRetryAfter` (`60s`; longer → returns the response), `when(response, error, request)` replaces the default rule. Exhausted → last response returned (call `throw()`) or last `ConnectionException` thrown. Abort via `signal` rejects with the signal's reason (not retried).

Errors: `HttpRequestException` (`response`, `request`, `status`, `body` = first 500 chars), `ConnectionException` (`request`, `cause`), `TimeoutException extends ConnectionException` (`timeout` ms), `StrayRequestException`. Messages redact URL credentials and secret-looking query params (`token`, `api_key`, `key`, `secret`, `password`, `signature`, `code`, …). Timeout covers headers + body read, not `stream()`/`sse()` (bound those with `signal`).

Pool: `p` inherits builder settings; requests start only when scheduled; a thrown error stops scheduling and rejects the pool (HTTP error statuses are just responses). Middleware: first registered = outermost; order `defaults` → client → builder; runs per attempt (`request.attempt`); `request.url/method/headers/body` writable.

```ts
// Testing (per app; with useTestApp() each test is clean; without an app call Http.restore() in afterEach)
Http.fake()                                                        // every request → empty 200
Http.fake({
  'api.github.com/*': Http.response({ login: 'ada' }, 200, { 'x-ratelimit-remaining': '42' }),
  'POST example.com/users': Http.response({ id: 1 }, 201),          // method prefix
  'example.com/users/*': request => Http.response({ id: request.url.split('/').pop() }), // undefined → next rule
  'example.com/health': 'ok',                                      // string/object = 200 body
  'example.com/down': Http.failedConnection(),                     // throws ConnectionException
  'api.example.com/jobs/*': Http.sequence().push({ s: 'queued' }).push('', 500).pushStatus(204)
    .pushFailedConnection().whenEmpty(Http.response({ s: 'done' })), // or dontFailWhenEmpty(); else throws when used up
})
Http.allowStrayRequests(['127.0.0.1:*'])
Http.assertSent((request, response) => request.hasHeader('authorization', /^Bearer /) && request.json().name === 'Ada')
Http.assertNotSent(fn); Http.assertSentCount(2) /* retries count */; Http.assertNothingSent()
Http.assertSentInOrder([fn1, fn2]); Http.assertSequencesAreEmpty(); Http.recorded(fn?) // [request, response | undefined][]
```

Patterns match the full URL with or without query; `*` matches anything incl. `/`; no scheme = any scheme. Later `fake()` rules win. Fakes still run middleware, retries, `throw()` and telemetry. Assertions need `fake()` or `preventStrayRequests()` first. `HttpClientRequest`: `method`, `url`, `headers`, `body` (encoded), `data` (pre-encoding), `json()`, `form()`, `text()`, `header(n)`, `hasHeader(n, string | RegExp)`, `query`, `isJson()`/`isForm()`/`isMultipart()`, `attempt`, `client`.

## Localization

Full guide: [localization.md](../../../docs/guide/localization.md)

```ts
// lang/en/messages.ts  (file name = first key segment; subdirs nest; JSON works too)
export default {
  welcome: 'Welcome, {name}!',
  apples: { zero: 'No apples', one: 'One apple', other: '{count} apples' },
}
```

```ts
// config/i18n.ts — presence of this file turns on translated validation + framework messages
import { defineI18nConfig } from '@hazejs/core'

export default defineI18nConfig({
  defaultLocale: 'en',
  fallbackLocale: 'en',
  locales: ['en', 'zh-CN'],
  detect: ['query:lang', 'cookie:locale', 'header'],  // also 'header:x-locale'
})
```

```ts
import { I18n, t } from '@hazejs/core'

t('messages.welcome', { name: 'Ada' })      // request locale, works in services
t('messages.apples', { count: 3 })          // Intl.PluralRules
ctx.locale; ctx.t('messages.welcome', { name }); ctx.setLocale(user.locale)
await I18n.withLocale(user.locale, () => notifyUser(user))  // jobs/commands use defaultLocale otherwise
```

| i18n option | Default | Notes |
| --- | --- | --- |
| `defaultLocale` | `'en'` | used when detection finds nothing; also for jobs/commands/schedule |
| `fallbackLocale` | `defaultLocale` | consulted for missing keys |
| `locales` | dirs under `lang/` + `defaultLocale` | detection only returns one of these |
| `detect` | `['query:lang', 'cookie:locale', 'header']` | `query:<name>`, `cookie:<name>`, `header` (Accept-Language, q-values), `header:<name>` |

- Detected lazily on first read per request; matched case-insensitively then by language (`zh`, `zh_cn`, `zh-TW` → `zh-CN` if it is the only Chinese locale); unsupported values skipped.
- Current locale precedence: `I18n.withLocale()` scope > request locale > `I18n.setLocale()` outside a request > `defaultLocale`. `setLocale()` inside a request affects only that request.
- `I18n`: `t`, `locale()`, `setLocale(l)`, `withLocale(l, fn)` (follows `await`), `has(key, locale?)`, `locales()`, `load(locale, messages)` (merge messages, e.g. from a package provider). Injectable: `inject(I18nManager)`.
- Values: string with `{param}` (unknown placeholders left as is), plural object (`zero` `one` `two` `few` `many` `other`; `zero` used for `count: 0` when present, `other` = fallback), or `(params) => string`.
- Validation (valibot + zod 4 issue types; arktype etc. keep their own messages): placeholders `{attribute}`, `{min}`, `{max}`, `{size}`, `{values}`, `{value}`; built-in `en` + `zh-CN` (`frameworkMessages`). Schema messages are kept unless they are translation keys: `v.check(isFree, 'validation.nickname_taken')`.
- `lang/<locale>/http.ts` keys cover route-not-found, 401/403/404/419/429/500, invalid signatures, ORM `unique_violation`; placeholders like `route_not_found: 'Nothing here: [{method}] {path}'`.
- Mail locale: `.locale()` on the pending mail > `defineMail` `locale` option > current locale. Queued mails render at queue time, so the locale sticks.
- Missing key → tries `zh-CN` → `zh` → `fallbackLocale` → returns the key itself.
- Override validation messages in `lang/<locale>/validation.ts` (`required`, `min.string`, `attributes`, `custom.<path>.<rule>`); framework/HTTP messages in `lang/<locale>/http.ts` (`403`, `route_not_found`, `maintenance`, …).
- A schema message or exception message that is a translation key gets translated: `new NotFoundException('errors.post_missing')`.
- Mail: `Mail.to(email).locale('zh-CN').send(WelcomeMail, payload)`.
- `haze typegen`/`haze dev` writes `.haze/types/i18n.d.ts`; unknown keys become type errors (`key as TranslationKey` for dynamic).

## Encryption and signed URLs

Full guides: [security.md#encryption](../../../docs/guide/security.md), [routing.md#signed-urls](../../../docs/guide/routing.md)

```ts
import { Crypt } from '@hazejs/core'

const token = await Crypt.encrypt({ userId: 1, scope: 'export' })   // AES-256-GCM, JSON, 'v1.<base64url>'
const data = await Crypt.decrypt<{ userId: number, scope: string }>(token) // DecryptException if tampered
const secret = await Crypt.encryptString('sk_live_...'); await Crypt.decryptString(secret)
// custom key: new Encrypter(key, previousKeys)
```

```ts
import { inject, Router } from '@hazejs/core'

const router = inject(Router)
await router.signedUrl('unsubscribe', { id: user.id })
await router.temporarySignedUrl('invitations.accept', '7d', { id: invitation.id })
await router.signedUrl('downloads.show', { file }, { expiresIn: '30m', query: { as: 'report.csv' } })

r.get('/unsubscribe/:id', [NewsletterController, 'unsubscribe']).middleware('signed').name('unsubscribe')
r.get('/downloads/:file', [DownloadController, 'show']).middleware('signed:utm_source,utm_medium') // ignore params
// or: await ctx.hasValidSignature()
```

`APP_KEY` (≥ 32 chars, `haze key:generate`) backs both. Rotate with `APP_PREVIOUS_KEYS=old1,old2`: only `Crypt` payloads and signed route URLs fall back to previous keys; signed cookies, sessions, JWTs and temporary storage URLs become invalid.

## Full-text search (`@hazejs/search`)

Full guide: [search.md](../../../docs/guide/search.md). `pnpm add @hazejs/search`.

```ts
// app/provider/SearchProvider.ts
import { searchProvider } from '@hazejs/search'
export default searchProvider()

// config/search.ts — without it: the 'database' engine
import { env } from '@hazejs/core'
import { defineSearchConfig } from '@hazejs/search'

export default defineSearchConfig(() => ({
  default: env('SEARCH_ENGINE', 'database'),
  engines: {
    database: {},
    meilisearch: { url: env('MEILISEARCH_URL', 'http://127.0.0.1:7700'), key: env('MEILISEARCH_KEY', '') },
  },
  prefix: env('SEARCH_PREFIX', ''),
  queue: false,              // true → sync through the queue
}))
```

| Engine | Index lives in |
| --- | --- |
| `database` | MySQL `FULLTEXT`, PostgreSQL `tsvector`, SQLite FTS5, or `mode: 'like'` |
| `meilisearch` / `typesense` | external server (HTTP, no SDK) |
| `elasticsearch` / `opensearch` | cluster (`url`, `auth`, `refresh`) |
| `memory` | process (tests); `custom` = your `SearchEngine` |

| Config / engine option | Default | Notes |
| --- | --- | --- |
| `default` | `'database'` | engine for models that don't set `engine` |
| `engines.<name>.driver` | the key name | `meilisearch: {...}` is a Meilisearch engine |
| `prefix` | `''` | prepended to every index name |
| `queue` | `false` | `true` or `{ connection, queue }` → sync via the built-in `search:sync` job |
| `chunk` | `500` | `search:import` batch size |
| database | `mode: 'fulltext'` \| `'like'`; `language: 'english'` (PG regconfig); `mysqlMode: 'natural'` \| `'boolean'` | |
| meilisearch | `url`, `key`, `wait: false`, `waitTimeout: 30000` (ms) | CLI commands always wait |
| typesense | `url`, `key` | |
| elasticsearch / opensearch | `url`, `auth: { username, password } \| { apiKey }`, `refresh: true \| 'wait_for'`, `keywordSuffix: '.keyword'` | |
| meilisearch / typesense / elasticsearch / opensearch | `fetch` | custom fetch (proxies, tests) |
| custom | `{ driver: 'custom', engine }` | `SearchEngine`: `driver`, `update(index, docs)`, `delete(index, keys)`, `search(index, query)`, `flush(index)`, optional `syncSettings`, `deleteIndex`, `settle` |

```ts
// app/model/Post.ts — call searchable() in the model's own file
export const SearchablePost = searchable(Post, {
  toSearchable: post => ({ title: post.title, body: post.body, status: post.status }),
  shouldBeSearchable: post => post.status !== 'archived',
  settings: { searchable: ['title', 'body'], filterable: ['status'], sortable: ['views'] },
})

import { search, withoutSyncing } from '@hazejs/search'
const page = await search(Post, 'haze').where('status', 'published').orderBy('views', 'desc').paginate(1, 20)
await withoutSyncing(() => seedPosts())
```

| `searchable()` option | Default / notes |
| --- | --- |
| `index` | table name (config `prefix` + tenant prefix added in front) |
| `engine` | config `default` |
| `toSearchable(model)` | `model.toJSON()` (so `hidden` fields stay out); may be async; primary key added automatically |
| `shouldBeSearchable(model)` | `false` keeps it out / removes it on update |
| `settings` | `searchable`, `filterable`, `sortable`, + engine-specific `meilisearch`, `typesense` (`fields: [{ name, type, sort, facet }]`), `elasticsearch` (`mappings`, `settings`); applied by `search:sync-settings` |
| `queue` | overrides config `queue` |
| `importQuery(q)` | adjust the `search:import` query, e.g. `q => q.with('author')` |
| `database` | `columns` (default `settings.searchable`, else all string columns), `mode`, `language`, `vectorColumn` (existing PG `tsvector`), `mysqlMode`, `indexName` (`<table>_search`), `fts: { table: '<table>_fts', sync: 'triggers' \| 'engine', tokenize: 'unicode61' \| 'trigram' }` |

| Builder (`search(Model, q)` / `SearchablePost.search(q)`) | Notes |
| --- | --- |
| `where(field, value)`, `whereIn`, `whereNotIn` | exact filters; external engines need the field in `settings.filterable` |
| `orderBy(field, dir?)` | replaces relevance; external engines need `settings.sortable` |
| `take(n)` | limit for `get`/`keys`/`raw`, default 1000 |
| `options({...})` | engine-native params (Meili search params, Typesense `num_typos`…, ES `_search` body fields like `highlight`, database `mode`/`mysqlMode`/`raw: true` for FTS5 syntax) |
| `constrain(q => …)` | constrains the ORM query that loads models (database engine: the search query itself) |
| `within(index)` | search another index of the model |
| `get()`, `first()` | models in engine order; missing/soft-deleted rows skipped |
| `paginate(page = 1, perPage = 15)` | `{ data, total, page, perPage, lastPage }` (`data` may be shorter than `perPage`) |
| `keys()`, `count()`, `raw()` | keys without a DB query / match count / raw engine response |

- Sync on model events: create/update write (or remove if `shouldBeSearchable` is false); delete and soft-delete remove, `restore()` re-adds; force delete removes. Not transactional: rollback leaves the doc — write with `withoutSyncing()` then import, or use `queue`.
- Queued sync: job `search:sync` (tries 3, backoff 5 s/30 s); document computed at dispatch; the worker must register `searchProvider()`. The `database` engine always syncs inline.
- Database engine: MySQL `MATCH … AGAINST` (needs a `FULLTEXT` index on exactly those columns; InnoDB min token 3, stopwords), PostgreSQL/PGlite `to_tsvector @@ websearch_to_tsquery` + GIN index on the same expression, SQLite/libsql/Turso/D1 FTS5 `MATCH` ordered by `bm25()`, or `mode: 'like'` (no index; `ILIKE` on PG). Soft deletes, global scopes and tenant scope apply. FTS5 `triggers` mode indexes real columns only; `engine` mode indexes `toSearchable()` output (needs `search:import` for rows changed outside model events). User input is quoted for FTS5; last term is a prefix match.
- Index DDL for migrations: `searchIndexSql(Post)` / `dropSearchIndexSql(Post)` (string[]), or `await createSearchIndex(Post)`.
- Meilisearch writes are async tasks (`wait: true` in tests). Typesense: collection auto-created (schema `{ name: '.*', type: 'auto' }`), max 250 hits/page (`get()` pages for you), declare sortable strings in `settings.typesense.fields`; schema change = flush + sync-settings. ES/OpenSearch: `_bulk` writes, `multi_match` (all words) + `term(s)` filters on `field.keyword` (set `keywordSuffix: ''` for explicit keyword mappings); never sort on `text` fields.
- Tenancy: `belongsToTenant` models get the tenant column in documents and auto-filtered searches; database-per-tenant prefixes the index (`acme_posts`) — run `search:import` per tenant in `Tenancy.run()`.

Commands: `haze search:import Post`, `haze search:flush Post`, `haze search:sync-settings [Post]` (creates DB full-text index too). Model name = class or index name. In code: `importSearchable(Post, { chunk?, onProgress? })` → count, `flushSearchable(Post)`, `syncSearchSettings(models?)`. Tests: `const engine = Search.fake()` (all engines → one memory engine, no queue) → `engine.documents('posts')`; `Search.restore()`. Also `Search.engine(name?)`, `Search.withoutSyncing`. Engine HTTP failures throw `SearchEngineError` (`status`, `body`).

## Multi-tenancy

Full guide: [tenancy.md](../../../docs/guide/tenancy.md). In core; DB parts in `@hazejs/orm`.

```ts
// config/tenancy.ts — when this file exists, the tenant is resolved before global middleware
import { defineTenancyConfig } from '@hazejs/core'
import { Tenant } from '../app/model/Tenant'

export default defineTenancyConfig({
  resolvers: ['subdomain', 'header'],   // 'domain' | 'subdomain' | 'header' (X-Tenant) | 'path' (/t/:tenant) | (ctx) => key
  domain: 'example.com',
  find: key => Tenant.where('slug', key).find(),   // null → 404
  remember: '1m',
  except: ['/health', '/webhooks/*'],
  // global: false → only routes with the `tenancy` middleware
  database: { connections: ['tenant'], config: (tenant, base) => ({ ...base, url: tenant.databaseUrl }) },
})
```

```ts
import { currentTenant, Tenancy, useTenant } from '@hazejs/core'

ctx.tenant; useTenant(); currentTenant(); Tenancy.key(); Tenancy.check()
await Tenancy.run('acme', () => Post.create({ title: 'Hello' }))   // jobs, commands, scripts
Tenancy.central(() => { /* no tenant */ })

// Single DB with a tenant column:
export class Project extends Model.define(projects) {
  static override belongsToTenant = true   // adds 'tenant' global scope + fills tenantId
}
```

Isolation by default: cache keys get `tenant:<id>:`, storage paths `tenants/<id>/`, per-tenant session cookie/key, queued jobs carry and restore the tenant. Extend the `Tenant` type via `declare module '@hazejs/core' { interface Tenant { ... } }`.

| Option | Default | Notes |
| --- | --- | --- |
| `resolvers` | `['header']` | tried in order; first key wins |
| `find(key)` | required | `null`/`undefined` → 404 |
| `id(tenant)` | `tenant.id` | used for `tenantId`, prefixes, connection names; only `[A-Za-z0-9_.-]` |
| `remember` | off | in-process cache of `find()` (`'1m'` or seconds) |
| `header` / `domain` / `path` | `'X-Tenant'` / — / `'/t'` | resolver settings; `subdomain` matches one level only (`a.acme.example.com` doesn't) |
| `centralDomains` | — | hosts that never resolve (with `subdomain`, `domain` itself is central) |
| `except` | — | paths without tenancy; trailing `*` = prefix |
| `required` | `true` | `false` → continue without a tenant when no key |
| `global` | `true` | `false` → only routes with the `tenancy` middleware (`import { tenancy } from '@hazejs/core'`) |
| `cache` | every store, `tenant:<id>:` | `false` or `{ stores: ['redis'], prefix: id => 't:' + id + ':' }`; also covers cache sessions, throttle, query cache |
| `storage` | every disk, `tenants/<id>/` | `false` or `{ disks, prefix: id => … }`; URLs include the dir |
| `session` | `true` | cookie `haze_session_<id>`, per-tenant derived key; `false` shares sessions |
| `queue` | `true` | jobs (incl. queued mail, listeners, search sync) carry the id; worker re-`find()`s it; deleted tenant → job fails without retry |
| `database` | — | `{ connections: ['tenant'] (default: default connection), config: (tenant, base, name) => ({ ...base, url }) }` |

- `path` resolver does not rewrite URLs: declare `r.group({ prefix: '/t/:tenant' }, …)`. Signed storage links and OpenAPI docs are served before tenant resolution, static assets after it (behind global middleware); unknown-tenant 404 goes through the exception handler.
- `Tenancy`: `run(tenant | key, fn)` (unknown key → `TenantNotFoundException`, 404), `central(fn)`, `current<T>()`, `key()`, `check()`, `find(key)`. `useTenant()` throws outside a tenant context; `currentTenant()`/`ctx.tenant` return `undefined`.
- Database per tenant: inside a context the listed connection `tenant` resolves to `tenant@<id>` (opened once, pooled until shutdown); models with `static connection = 'tenant'`, `Db.connection('tenant')`, transactions and `runMigrations()` follow it; unlisted connections (central) never switch; outside a context the template config is used. SQLite: `config: (tenant, base) => ({ ...base, url: 'file:./data/tenants/' + tenant.id + '.db' })`. Close idle ones: `useDatabaseManager().close('tenant@acme')`.
- Column mode: `belongsToTenant = true` (column `tenantId`) or a column name; scope `tenant` covers relations, `find()`, counts, mass update/delete; bypass with `withoutGlobalScope(['tenant'])`; unfiltered outside a context; SQL models only (not MongoDB).
- Tests: `app.request('/projects', { headers: { 'x-tenant': 'acme' } })` or `Tenancy.run({ id: 'acme' }, fn)` (object form skips `find()`).

## TSX server views

Full guide: [views.md](../../../docs/guide/views.md). JSX runtime is in `@hazejs/core` (`jsxImportSource: '@hazejs/core'`), compiled by the Vite plugin for `.tsx` inside `srcDir` only. Works on every preset.

```tsx
// app/view/Home.tsx   (haze make:view Home)
import type { ViewChild } from '@hazejs/core'

export default function Home(props: { name: string, children?: ViewChild }) {
  return <html lang="en"><body><h1>Hello, {props.name}</h1>{props.children}</body></html>
}
```

```ts
// route/web.ts (plain .ts: pass component + props instead of JSX)
r.get('/', ctx => ctx.view(Home, { name: 'Ada' }))
r.get('/admin', ctx => ctx.view('admin/Dashboard', { user }))   // by name: app/view/admin/Dashboard.tsx
// in .tsx: return ctx.view(<Home name="Ada" />, { status: 404, headers: { 'cache-control': 'no-store' } })
```

| Render API | Notes |
| --- | --- |
| `ctx.view(<Home />, init?)` / `ctx.view(Home, props, init?)` / `ctx.view('admin/Dashboard', props, init?)` | `text/html`, skips the JSON envelope; by-name loads `app/view/<name>.tsx` (default export, or a named export equal to the file name) |
| `view(...)` | same overloads, no `ctx` needed |
| `return <Home />` | JSX returned from a handler or middleware is rendered too |
| `await renderToString(node)` | string (mail bodies) |

`init = { status?, headers? }`; status defaults to `ctx.status()` (else 200). Output starting with `<html` gets `<!DOCTYPE html>` prepended; elsewhere use `<><Doctype /><html>…</html></>`. Render errors go to the exception handler. Async components render siblings concurrently, order preserved.

| Attribute value | Output |
| --- | --- |
| `disabled` / `{true}` | bare attribute; `false`/`null`/`undefined` omit it |
| `class` / `className` | string, array, or `{ active: isActive }` object: `class={['btn', { active }]}` |
| `style` | string or object; camelCase → kebab-case; numbers get `px` except unitless (`opacity`, `lineHeight`, `zIndex`, …) |
| `htmlFor` | `for` |
| functions | omitted; promises are awaited |

Text and attributes are always escaped, including `<script>`/`<style>` content → inline code via `dangerouslySetInnerHTML={{ __html: css }}`. Void elements have no closing tag; `data-*`, `aria-*`, `hx-*` (htmx), `x-*` (Alpine) accepted everywhere; custom elements need a hyphen.

```tsx
// app/view/PostForm.tsx — form round-trip (routes need ['session', 'csrf'] middleware)
import { csrfField, old, useHttpContext, useView } from '@hazejs/core'
export default function PostForm(props: { error?: string }) {
  const { locale, t } = useView()          // { ctx, locale, t, old, csrfToken: () => Promise<string> }
  return (
    <form method="post" action="/posts" lang={locale} data-path={useHttpContext().path}>
      {csrfField()}                         {/* async: hidden _token input */}
      <input name="title" value={old('title')} />
      <button type="submit">{t('messages.save')}</button>
    </form>
  )
}
// route: if (!body.title) { await flashInput(); return ctx.redirect('/posts/new') }
// flashInput(input?) defaults to the request body, drops _token/password/password_confirmation/current_password and keeps only string/number/boolean/array values (no files)
```

tsconfig of the backend (templates already set it: `tsconfig.json` in `api`, `tsconfig.server.json` in vue/react): `"jsx": "react-jsx", "jsxImportSource": "@hazejs/core"`, include `**/*.tsx`. The Vite plugin compiles only the backend (SSR) environment; a file with its own `/** @jsxImportSource react */` pragma is left alone.

Helpers: `view()` (no ctx), `renderToString(node)` (mail bodies), `rawHtml(html)` / `dangerouslySetInnerHTML` (unescaped), `Doctype`, `useView()` → `{ ctx, locale, t, old, csrfToken }`, `csrfField()`, `old(field, fallback?)` + `flashInput()` (need `session` middleware). Components may be `async`. Event-handler props (`onClick`) are dropped — no client runtime, no hydration, no streaming.

## AI (`@hazejs/ai`)

Full guide: [ai.md](../../../docs/guide/ai.md). No vendor SDKs (plain `fetch`), runs on Workers too.

```ts
// config/ai.ts
import { defineAIConfig } from '@hazejs/ai'
import { env } from '@hazejs/core'

export default defineAIConfig(() => ({
  default: env('AI_MODEL', 'openai:gpt-5-mini'),     // 'provider:model' or alias
  aliases: { fast: 'deepseek:deepseek-chat', smart: 'anthropic:claude-opus-5-5' },
  defaults: { embedding: 'openai:text-embedding-3-small' },
  providers: { openai: { driver: 'openai' }, anthropic: { driver: 'anthropic' }, ollama: { driver: 'ollama', baseURL: 'http://localhost:11434/v1' } },
}))

// app/provider/AIProvider.ts
import { aiProvider } from '@hazejs/ai'
export default aiProvider()
```

Drivers: `openai`, `anthropic`, `google`, `azure`, `bedrock`, `cloudflare`, `deepseek`, `qwen`, `moonshot`, `zhipu`, `doubao`, `siliconflow`, `openrouter`, `groq`, `xai`, `mistral`, `ollama`, `openai-compatible`. Keys come from env (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, …) unless `apiKey` is set.

- Other env: azure `AZURE_API_KEY` + `AZURE_RESOURCE_NAME`; bedrock AWS credentials or `AWS_BEARER_TOKEN_BEDROCK` (SigV4 built in); cloudflare `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`, or `{ driver: 'cloudflare', binding: 'AI' }` (Workers `ai` binding, read at call time); presets `DEEPSEEK_API_KEY`, `DASHSCOPE_API_KEY` (qwen), `MOONSHOT_API_KEY`, `ZHIPU_API_KEY`, `ARK_API_KEY` (doubao), `SILICONFLOW_API_KEY`, `OPENROUTER_API_KEY`, `GROQ_API_KEY`, `XAI_API_KEY`, `MISTRAL_API_KEY`; `ollama` needs none; `openai-compatible` takes `baseURL` + `apiKey`.
- Config: `default` (language model), `defaults: { embedding, image, speech, transcription }`, `aliases`, `providers` (`{ driver, ...settings }` or a provider instance). Model refs: `'provider:model'` (provider = key in `providers`) or alias; omitted `model` → default for that kind. `AI.model(ref?)` resolves; `AI.configured` checks setup.
- Outside hazejs: `generateText({ model: createAnthropic()('claude-opus-5-5'), … })` or `configureAI(...)`. Custom drivers: `registerAIDriver('name', (settings, name) => provider)`.

| Call setting (`generateText`/`streamText`/`generateObject`/agents) | Notes |
| --- | --- |
| `model`, `system`, `prompt` (string or content parts), `messages` | user parts: `{ type: 'image', image: bytes \| url }`, `{ type: 'file', data, mediaType: 'application/pdf' }` |
| `maxOutputTokens`, `temperature`, `topP`, `topK`, `stopSequences`, `seed`, `headers` | |
| `reasoning: { effort, summary }` | effort `'minimal' \| 'low' \| 'medium' \| 'high' \| 'xhigh' \| 'max'`, mapped per provider |
| `providerOptions: { anthropic: { cacheControl: true } }` | keyed by provider name |
| `maxRetries` (2), `timeout`, `abortSignal` | retries 408/409/429/5xx/network, honors `retry-after` |
| `tools`, `toolChoice` (`'auto' \| 'none' \| 'required' \| { toolName }`), `maxSteps`, `stopWhen(step)`, `onStepFinish(step)` | `maxSteps`: 10 with executable tools else 1 (agents: always 10) |

- `generateText` result: `text`, `reasoningText`, `toolCalls`, `toolResults`, `finishReason`, `usage` (last step), `totalUsage`, `steps`, `warnings`, `response.messages` (append to history to continue), `providerMetadata`.
- `streamText` returns synchronously; members are promises/iterables: `textStream`, `fullStream` (all events, re-iterable), `text`, `reasoningText`, `toolCalls`, `toolResults`, `finishReason`, `usage`, `totalUsage`, `steps`, `response`, `consume()`; callbacks `onEvent`, `onFinish({ text, finishReason, totalUsage, steps, responseMessages })`, `onError`. `toResponse({ sendReasoning? })`.
- Tools: `parameters` = any Standard Schema (valibot via `@valibot/to-json-schema`, zod 4, arktype) or `jsonSchema({...})`; input validated before `execute`; invalid input and thrown errors go back to the model as error results.
- `generateObject`/`streamObject({ schema })` → `object` / `partialObjectStream`; invalid → `NoObjectGeneratedError`. Other errors: `APICallError`, `NoSuchModelError`, `UnsupportedFeatureError`, `InvalidToolCallError` (all `AIError`).
- Embeddings: `AI.embed({ value })`, `AI.embedMany({ values })` (batched by model limit, parallel), `AI.cosineSimilarity(a, b)`.
- `createKnowledgeBase({ model?, store?, split?: { chunkSize: 1000, overlap: 100 } | false })` → `add(docs | strings)` → ids, `search(q, { topK: 5, minScore?, filter?: Partial<metadata> | fn })`, `remove(ids)`, `asTool({ description?, topK? })`. `VectorStore` = `upsert(records)`, `query(embedding, opts)`, `delete(ids)`, `count()`; default `createMemoryVectorStore()`.
- Agents: `AI.agent({ name?, model?, instructions: string | ({ conversationId, context }) => string, tools?, maxSteps?, memory?, ...callSettings })`; `generate({ prompt | messages, conversationId?, context?, model? })`; `await agent.stream(...)` returns a `Promise<StreamTextResult>` (unlike `AI.streamText`); `asTool({ description? })` → tool taking `{ task }`.
- Memory: `memoryConversationStore({ maxMessages? })` (per process), `cacheConversationStore(cache, { ttl?, maxMessages?, prefix: 'ai:conversation:' })` with any cache repository; trimmed at user-message boundaries; `ConversationMemory` = `load`, `append`, `clear`.
- MCP client: `createMCPClient({ transport: { type: 'http', url, headers } | { type: 'stdio', command, args }, name?, version?, fetch? })` → `tools({ include? })`, `listTools()`, `callTool(name, args)`, `request(method, params)`, `close()`; protocol 2026-07-28 with automatic fallback to ≤ 2025-11-25. Server: `createMCPServer({ name, version, title?, instructions?, tools, allowedOrigins?, cache? }).handle(request)`.
- Media: `AI.generateImage({ model, prompt, size })` → `image.data`; `AI.generateSpeech({ model, text, voice })` → `audio`; `AI.transcribe({ model, audio, language })` → `text`.

```ts
import { AI, cacheConversationStore, createKnowledgeBase, createMCPClient, createMCPServer } from '@hazejs/ai'
import { Cache } from '@hazejs/core'
import * as v from 'valibot'

const { text } = await AI.generateText({ model: 'smart', system: '…', prompt: '…', reasoning: { effort: 'low' } })
// controller: stream to the client (hazejs SSE protocol for useChat)
return AI.streamText({ messages, tools: { weather } }).toResponse() // or toUIMessageStreamResponse() / toTextStreamResponse()

const weather = AI.tool({ description: 'Weather of a city', parameters: v.object({ city: v.string() }), execute: ({ city }) => fetchWeather(city) })
const { object } = await AI.generateObject({ schema: v.object({ name: v.string() }), prompt: '…' })
const { embeddings } = await AI.embedMany({ values: ['a', 'b'] })

const docs = createKnowledgeBase({ model: 'openai:text-embedding-3-small' })  // in-memory VectorStore by default
await docs.add([{ id: 'refunds', content: policy }]); await docs.search('money back?', { topK: 3 }) // docs.asTool()

export const support = AI.agent({
  name: 'support', model: 'smart', instructions: 'You are support.', tools: { weather },
  memory: cacheConversationStore(Cache.store('redis'), { ttl: '7d', maxMessages: 50 }),
})
await support.generate({ prompt, conversationId: String(user.id) })   // also .stream(), .asTool()

const mcp = createMCPClient({ transport: { type: 'http', url: 'https://mcp.example.com/mcp' } }) // or stdio
const tools = await mcp.tools()
const server = createMCPServer({ name: 'acme', version: '1.0.0', tools: { weather } })
r.post('/mcp', ctx => server.handle(ctx.req)).middleware('auth')
```

Frontend: `useChat({ api: '/api/chat' })` from `@hazejs/ai/vue` or `@hazejs/ai/react` (`@hazejs/ai/client` → `createChat()`). Tools loop up to `maxSteps` (default 10 with executable tools); a tool without `execute` stops the loop and returns the call. Images/speech: `AI.generateImage`, `AI.generateSpeech`, `AI.transcribe`. Tests: `AI.fake(['reply'])` + `AI.restore()`, `mockModel()`.

- `useChat` / `createChat` options: `api` (`'/api/chat'`), `headers` and `body` (object or fn — templates send the CSRF token via `headers`), `credentials`, `fetch`, `initialMessages`, `generateId`, `onEvent`, `onFinish(message, { messages, finishReason, usage, aborted })`, `onError`. Returns `messages` (with `parts`), `status` (`'ready' | 'submitted' | 'streaming' | 'error'`), `error`, `sendMessage(text | { text, files })`, `regenerate()`, `stop()`, `setMessages()`, `addToolResult({ toolCallId, output })` (client-side tools), `clearError()`; only the Vue/React `useChat` wrappers add `input` / `handleSubmit` (`createChat` has neither). The body is `{ messages }` in the server `Message` format → pass straight to `streamText`. Vercel AI SDK frontends: return `toUIMessageStreamResponse()` and convert input with `convertUIMessages(body.messages)`.
- `AI.fake(replies)` replaces every model (string refs and model objects); replies used in order (the last one repeats forever), each text or `{ toolCalls: [{ toolName, input }] }`; embeddings/images/speech return deterministic fakes. Returned fake: `requests`, `assertPrompted(pred?)`, `assertNotPrompted()`, `assertPromptedTimes(n)`, `assertPromptContains(text)`. `mockModel(replies)` = standalone model for unit tests without an app.

## GraphQL (`@hazejs/graphql`)

`graphqlProvider(schema)`, `defineSchema` (schema-first / code-first), resolver context, loaders, subscriptions, limits, errors, testing: see [graphql.md](graphql.md).

## Microservices (`@hazejs/microservices`)

`microservicesProvider()`, `app/message/*.ts` handlers, `Microservice.client().send/emit`, NATS / Redis / gRPC / memory transports, listeners, errors, testing: see [microservices.md](microservices.md).

## Gotchas

- `memory` cache, memory sessions, the throttle default and `memoryConversationStore` are **per process**. With several instances use a shared store (`redis`/`upstash`) for cache, `session` (`{ driver: 'cache', store: 'redis' }`), `throttle.store` and maintenance mode.
- `Cache.remember(key, ttl, fn)` — TTL comes **before** the callback (ThinkPHP order is reversed). `undefined` results are not cached, and there is no stampede protection; wrap in `Cache.lock()` if needed.
- Tagged items are only readable through the exact same tag set; `Cache.get('feed')` will not find an item written with `Cache.tag('user')`.
- `cache(key, undefined)` writes `null`; only `cache(key, null)` deletes.
- `kv` is not atomic and eventually consistent (min TTL 60 s); `Cache.lock()` throws on it. `ioredis` does not run on Workers (it is stubbed) — use `upstash` or `kv` there.
- The typed serializer round-trips `Date`/`BigInt`/`Map`/`Set`. Data read by other services should use `serializer: 'json'`.
- Keys used via `Cache.handler()` or the `Redis` facade do not get the cache prefix or tenant prefix, and `Cache.clear()` does not touch them.
- Do not `SUBSCRIBE` or run blocking commands on the shared `Redis` connection; use `Redis.subscriber()` / `Redis.create()` and `quit()` them yourself.
- `Storage.disk(x).url()` throws when the disk has no `url`. `temporaryUrl()` on local/R2 is a site-relative path unless `APP_URL` (or `app.url`) is set. Local `serve: true` is skipped on Cloudflare Workers.
- `Http` timeouts are per attempt; `retry(3)` means 3 attempts total. Requests with a `ReadableStream` body are never retried. `Http.fake()` does not patch `globalThis.fetch` — pass `Http.toFetch()` to SDKs.
- `Http` 4xx/5xx responses do **not** throw unless you call `.throw()` (response or builder) or set `throw: true`; `pool()` likewise resolves error statuses as responses. The timeout stops applying once you read with `stream()`/`sse()`.
- On non-`redis` cache drivers, cleared tagged items stay in storage until they expire; always give tagged items a TTL there.
- Translated validation/HTTP messages only appear when `config/i18n.ts` exists; `t()` works without it. Queue jobs and commands use `defaultLocale` unless wrapped in `I18n.withLocale()`.
- Rotating `APP_KEY` with `APP_PREVIOUS_KEYS` keeps only `Crypt` payloads and signed route URLs valid; sessions, signed cookies, JWTs and temporary storage URLs break.
- Search sync is not transactional and query-builder mass updates (`Post.where(...).update()`) don't sync — run `haze search:import`. `searchable()` must be called in the model file or the CLI commands won't see it.
- Search: Meilisearch/Typesense reject `where`/`orderBy` on fields missing from `settings.filterable`/`sortable` — run `haze search:sync-settings` after changing settings. Elasticsearch/OpenSearch filter/sort any field (unmapped ones just match nothing). `paginate()` defaults to 15 per page; un-paginated `get()` caps at 1000 (`take()`).
- Tenant ids may only contain letters, digits, `_`, `-`, `.`. `Tenancy.run('key', fn)` calls `find()`; pass the tenant object to skip the lookup.
- Tenant `belongsToTenant` scope only covers model queries; raw `Db.table()` / `Db.execute()` and builder `insert()` see/skip all tenants. Scheduled tasks run without a tenant — loop with `Tenancy.run()`.
- Views: route files are `.ts`, so use `ctx.view(Component, props)` there, not JSX. `.tsx` outside `srcDir` (e.g. React `src/`) is not compiled with the hazejs runtime. `old()` returns the fallback without a started session.
- `@hazejs/ai` agents only persist history when both `memory` and `conversationId` are given. The default knowledge-base store is in memory; production needs your own `VectorStore`.
- `AI.streamText()` is synchronous, but `agent.stream()` is async: `return (await support.stream({ prompt, conversationId })).toResponse()`.
