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

Commands: `haze search:import Post`, `haze search:flush Post`, `haze search:sync-settings [Post]` (creates DB full-text index too). Tests: `Search.fake()` / `Search.restore()`.

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

## GraphQL (`@hazejs/graphql`)

Full guide: [graphql.md](../../../docs/guide/graphql.md). `pnpm add @hazejs/graphql graphql`. `export default graphqlProvider(schema)` in `app/provider/GraphQLProvider.ts` serves `GET`/`POST /graphql` (GraphiQL + introspection outside production). Schema via `defineSchema({ typeDefs, resolvers })` or code-first (`objectType`, `field`, `list`, `nonNull`). `config/graphql.ts` (`defineGraphQLConfig`): `path`, `graphiql`, `introspection`, `maxDepth` (15), `maxComplexity`, `subscriptions` (graphql-transport-ws over WebSocket, `createPubSub()`). Mount manually with `graphqlHandler(schema, opts)`. Batching via `defineLoader`/`createLoader`.

## Microservices (`@hazejs/microservices`)

Full guide: [microservices.md](../../../docs/guide/microservices.md). `export default microservicesProvider()`; handlers in `app/message/*.ts` via `defineMessageHandler('orders.find', { schema }, handler)`. `config/microservices.ts` (`defineMicroservicesConfig`): `default`, `name` (queue group), `timeout` (5000), `listen`, `autoListen`, `transports` (`nats`, `redis` with `connection`, `grpc`, `memory`, `custom`). Call with `Microservice.client('nats').send(pattern, data, { timeout })` / `.emit(pattern, data)`. Listen in dev with `haze microservice:listen [-t nats,grpc]`; in production use `autoListen: true` or `listenMicroservices(app)` in a command. Errors: `RemoteError`, `MicroserviceTimeoutError` (504), `MicroserviceUnavailableError` (503).

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
- Translated validation/HTTP messages only appear when `config/i18n.ts` exists; `t()` works without it. Queue jobs and commands use `defaultLocale` unless wrapped in `I18n.withLocale()`.
- Rotating `APP_KEY` with `APP_PREVIOUS_KEYS` keeps only `Crypt` payloads and signed route URLs valid; sessions, signed cookies, JWTs and temporary storage URLs break.
- Search sync is not transactional and query-builder mass updates (`Post.where(...).update()`) don't sync — run `haze search:import`. `searchable()` must be called in the model file or the CLI commands won't see it.
- Tenant `belongsToTenant` scope only covers model queries; raw `Db.table()` / `Db.execute()` and builder `insert()` see/skip all tenants. Scheduled tasks run without a tenant — loop with `Tenancy.run()`.
- Views: route files are `.ts`, so use `ctx.view(Component, props)` there, not JSX. `.tsx` outside `srcDir` (e.g. React `src/`) is not compiled with the hazejs runtime. `old()` returns the fallback without a started session.
- `@hazejs/ai` agents only persist history when both `memory` and `conversationId` are given. The default knowledge-base store is in memory; production needs your own `VectorStore`.
- GraphiQL and introspection are disabled in production by default; microservice handlers receive nothing until a listener runs (`autoListen` or `listenMicroservices`).
