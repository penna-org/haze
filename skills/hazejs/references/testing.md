# Testing (`@hazejs/testing`)

Vitest runs the real application in-process (no port): same `config/`, `route/`, `app/` discovery as `haze dev`, an HTTP client, and per-application fakes for queues, events, mail, storage, notifications, broadcasts, outgoing HTTP, search and AI.

Full guide: [Testing](../../../docs/guide/testing.md). Feature pages: [Queues](../../../docs/guide/queues.md) · [Events](../../../docs/guide/events.md) · [Mail](../../../docs/guide/mail.md#testing) · [Storage](../../../docs/guide/storage.md#testing) · [Notifications](../../../docs/guide/notifications.md#testing) · [Broadcasting](../../../docs/guide/broadcasting.md#testing) · [HTTP Client](../../../docs/guide/http-client.md#testing) · [Search](../../../docs/guide/search.md#testing) · [AI](../../../docs/guide/ai.md#testing) · [Factories](../../../docs/guide/factories.md) · [WebSocket](../../../docs/guide/websocket.md)

## Setup

```ts
// vitest.config.ts
import { defineHazeTestConfig } from '@hazejs/testing/config'
import { defineConfig } from 'vitest/config'

export default defineConfig(defineHazeTestConfig())
// Merges any Vitest config: defineHazeTestConfig({ test: { include: ['tests/**/*.test.ts'] } })
// Plugin options go under `haze` (normally read from haze.config.ts, e.g. srcDir: 'server' for full-stack)
```

`defineHazeTestConfig()` registers the haze Vite plugin (provides `virtual:haze/app` and the `~` alias), sets `environment: 'node'`, and inlines `@hazejs/testing` so it can import the virtual module.

```ini
# .env.test  (shipped by the templates)
DATABASE_URL=:memory:
```

Env load order in test mode: `.env` → `.env.test` → `.env.test.local` (later wins). `.env.local` is **skipped**. Real process env vars always win over files.

```bash
haze test                       # = vitest run (sets NODE_ENV=test)
haze test watch                 # args replace the default and go to vitest as-is
haze test run tests/auth.test.ts
haze make:test user             # tests/user.test.ts  (--module blog → modules/blog/tests/)
```

## The test app and client

```ts
// tests/post.test.ts
import { refreshDatabase } from '@hazejs/orm'
import { useTestApp } from '@hazejs/testing'
import { beforeEach, describe, expect, it } from 'vitest'
import UserFactory from '~/database/factories/UserFactory'

const t = useTestApp()                     // new app before each test, disposed after
beforeEach(() => refreshDatabase({ migrations: 'database/migrations' }))

describe('posts', () => {
  it('validates input', async () => {
    const res = await t.post('/api/posts', { title: '' })
    expect(res.status).toBe(422)
    expect(res.body.errors[0]).toMatchObject({ target: 'body', path: 'title' })
  })

  it('lists posts', async () => {
    const res = await t.get('/api/posts', { query: { page: 2 } })
    expect(res.ok).toBe(true)
    expect(res.body.data).toEqual(expect.any(Array))
  })

  it('creates as a logged-in user', async () => {
    const user = await UserFactory.create()
    const client = await t.actingAs(user)  // async!
    const res = await client.post('/api/posts', { title: 'Hello' })
    expect(res.status).toBe(201)
  })
})
```

| Client method | Notes |
|---|---|
| `get(path, init?)` / `delete(path, init?)` | |
| `post(path, body?, init?)` / `put(...)` / `patch(...)` | Objects → JSON + `content-type: application/json`; `string`, `FormData`, `URLSearchParams`, `Blob` sent as-is (use `FormData` for uploads) |
| `init` | `RequestInit` (minus `body`) plus `query: Record<string, string \| number \| boolean>` |
| `withHeaders(headers)` | New client sending those headers on every request (chainable) |
| `actingAs(user, guard?)` | `Promise<TestClient>` logged in as `user` |

| Response field | Description |
|---|---|
| `status` | HTTP status |
| `ok` | `true` for 2xx |
| `headers` | `Headers` |
| `body` | Parsed JSON when the content type contains `json`, else text (e.g. SSE streams) |
| `text` | Raw text |

The `useTestApp()` object also has `t.app` (the `Application`), `t.make(key)` (resolve from the container), `t.request(input, init?)` (raw fetch → `Response`) and `t.close()`.

```ts
// Replace bindings after providers register, before boot
const t = useTestApp({
  override: c => c.instance(PaymentGateway, new FakePaymentGateway()),
})

// Non-hook version: manage lifetime yourself
import { createTestApp } from '@hazejs/testing'
const app = await createTestApp({ override: c => c.instance(Repo, fakeRepo) })
try { expect((await app.get('/api/health')).status).toBe(200) }
finally { await app.close() }
```

## Authentication

`actingAs(user, guard?)` uses the default guard from `config/auth.ts` unless named:

| Guard driver | What it does |
|---|---|
| `jwt` | Issues a real token → `Authorization: Bearer …` |
| session | Logs in and replays the real session cookie |
| `token` (API tokens) | Creates a real personal access token with abilities `['*']` |

For specific abilities use the lower-level helper from **`@hazejs/core`** (not `@hazejs/testing`), which returns headers:

```ts
import { issueTestCredentials } from '@hazejs/core'

it('rejects tokens without posts:write', async () => {
  const ada = await UserFactory.create()
  const headers = await issueTestCredentials(t.app, ada, 'token', { abilities: ['posts:read'] })
  const res = await t.withHeaders(headers).post('/api/posts', { title: 'Hi' })
  expect(res.status).toBe(403)
})
```

Raw tokens also work: `t.withHeaders({ authorization: \`Bearer ${token}\` }).get('/api/auth/me')`. Broadcast channel auth is tested with `actingAs()` + `POST /broadcasting/auth`.

## Database

```ts
import { refreshDatabase } from '@hazejs/orm'
beforeEach(() => refreshDatabase({ migrations: 'database/migrations' }))
// full-stack (srcDir: 'server'): refreshDatabase({ migrations: 'server/database/migrations' })
```

| Option | Default | Description |
|---|---|---|
| `migrations` | `<srcDir>/database/migrations` | Project migrations dir, **relative to cwd** |
| `connection` | default connection | Which connection to refresh |
| `modules` | `true` | Also run enabled modules' migrations first; `false` = app only |

It closes the connection, reopens it, and runs migrations. With `:memory:` SQLite that means a brand-new empty DB per test. On a MongoDB connection it drops the database instead. There is no per-test transaction-rollback helper — isolation comes from `:memory:` + `refreshDatabase()`.

Factories create data (see [database.md](./database.md#factories)):

```ts
import UserFactory from '~/database/factories/UserFactory'

const [ada, bob] = await UserFactory.createMany([{ name: 'Ada' }, { name: 'Bob' }])
const admin = await UserFactory.state('admin').create()
await t.post('/api/users', await UserFactory.raw())   // attributes as a request body
```

Tenant-scoped data: `await Tenancy.run({ id: 'acme' }, () => Project.create({ name: 'Rocket' }))` (`Tenancy` from `@hazejs/core`).

## Fakes

Fakes record instead of performing. They belong to the **current application**, so with `useTestApp()` they reset every test. Create them inside the test, or in a `beforeEach` registered **after** `useTestApp()`.

```ts
// tests/auth.test.ts
import { Events, Mail, MailFake, Queue } from '@hazejs/core'
import { refreshDatabase } from '@hazejs/orm'
import { useTestApp } from '@hazejs/testing'
import { beforeEach, it } from 'vitest'
import UserRegistered from '~/app/event/UserRegistered'
import SendWelcomeEmail from '~/app/job/SendWelcomeEmail'
import WelcomeMail from '~/app/mail/WelcomeMail'

const t = useTestApp()
let queue: ReturnType<typeof Queue.fake>
beforeEach(() => { queue = Queue.fake() })
beforeEach(() => refreshDatabase({ migrations: 'database/migrations' }))

const ada = { name: 'Ada', email: 'ada@example.com', password: 'correct horse' }

it('queues and sends the welcome mail', async () => {
  const res = await t.post('/api/auth/register', ada)
  queue.assertDispatched(SendWelcomeEmail, p => p.userId === res.body.data.user.id)
  const mail = Mail.fake()
  await queue.drain()                                   // run recorded jobs in order (delays ignored)
  mail.assertSent(WelcomeMail, sent => MailFake.hasRecipient(sent, ada.email))
})

it('emits UserRegistered without running listeners', async () => {
  const events = Events.fake([UserRegistered])          // only these events are faked
  await t.post('/api/auth/register', ada)
  events.assertEmittedTimes(UserRegistered, 1)
  queue.assertNotDispatched(SendWelcomeEmail)           // listener did not run
})
```

### Queue — `Queue.fake()` (`@hazejs/core`)

| Member | Description |
|---|---|
| `assertDispatched(job, predicate?)` / `assertNotDispatched(job, predicate?)` | `job` = job definition or name string (`'mail:send'`); predicate gets the payload |
| `assertCount(n)` | Total dispatches |
| `assertChained([JobA, JobB.with(payload)])` | A chain with these jobs (and payloads) |
| `assertBatched(batch => bool)` / `assertBatchCount(n)` / `assertNothingBatched()` | Batches (recorded, **not run** by `drain()`) |
| `assertPushedUnique(job, predicate?)` / `assertSkipped(job, predicate?)` | Unique jobs: pushed once / duplicate skipped (locks simulated in memory, released by `drain()`) |
| `drain()` | Runs recorded jobs; jobs they dispatch (next chain link) are recorded again — call again to continue |
| `dispatched`, `chains`, `batches`, `skipped` | Raw records |

### Events — `Events.fake(events?)`

`assertEmitted(event, predicate?)`, `assertNotEmitted(event, predicate?)`, `assertEmittedTimes(event, n)`, `emitted`. Faked events do not run listeners; unlisted events behave normally when a list is passed.

### Mail — `Mail.fake()`

| Member | Description |
|---|---|
| `assertSent(matcher, predicate?)` / `assertNotSent` / `assertSentTimes(matcher, n)` | Sent mails |
| `assertQueued(matcher, predicate?)` / `assertNotQueued` | Queued mails |
| `assertNothingSent()` / `assertNothingQueued()` | |
| `sent`, `queued` | Records `{ mail?, payload, mailer, message, delay? }` |
| `MailFake.hasRecipient(mail, address)` | Static; checks to/cc/bcc, case-insensitive |

`matcher` is a mail definition or a function receiving the record. Example: `mail.sent.at(-1)!.payload` to pull a link out of a mail.

### Storage — `Storage.fake(disk?)`

Returns a `FakeDisk` (in-memory, keeps the disk's configured `url`). All assertions are **async**: `await disk.assertExists(path | paths)`, `assertMissing(path | paths)`, `assertCount(dir, n)` (recursive), `assertDirectoryEmpty(dir)`.

```ts
it('uploads an avatar', async () => {
  const disk = Storage.fake('public')
  const user = await UserFactory.create()
  const form = new FormData()
  form.set('avatar', new File([new Uint8Array([137, 80, 78, 71])], 'me.png', { type: 'image/png' }))
  const res = await (await t.actingAs(user)).post('/api/auth/avatar', form)
  await disk.assertExists(res.body.data.path)
})
```

### Notifications — `Notification.fake()`

| Member | Description |
|---|---|
| `assertSentTo(notifiable \| notifiable[], definition, predicate?)` | Same type + id counts as the same notifiable |
| `assertNotSentTo(notifiable, definition, predicate?)` | |
| `assertSentOnDemand(definition, predicate?)` | Sent via `Notification.route()`; `sent.notifiable.routes` |
| `assertSentTimes(definition, n)` / `assertCount(n)` | |
| `assertNothingSentTo(notifiable)` / `assertNothingSent()` | |
| `sentTo(notifiable, definition, predicate?)` | Records with `notifiable`, `payload`, `channels`, `queued`, `message(channel)` (async render) |

```ts
const notifications = Notification.fake()
await t.post('/api/invoices/1/pay')
notifications.assertSentTo(ada, InvoicePaid, s => s.payload.amount === 99 && s.channels.includes('mail'))
const [sent] = notifications.sentTo(ada, InvoicePaid)
expect(await sent.message('mail')).toMatchObject({ subject: 'Payment received' })
```

### Broadcast — `Broadcast.fake()`

`assertBroadcast(event, predicate?)` (event name or `defineEvent` definition), `assertBroadcastOn(channel, event?, predicate?)`, `assertNotBroadcast(event, predicate?)`, `assertBroadcastTimes(event, n)`, `assertNothingBroadcast()`, `broadcasts` (`{ channels, event, data, except?, definition? }`).

```ts
const b = Broadcast.fake()
await t.post('/api/orders/1/ship')
b.assertBroadcastOn('private-orders.1', 'OrderShipped', item => item.data.orderId === 1)
```

### Outgoing HTTP — `Http.fake(stubs?)` (`@hazejs/core`)

Assertions live on the **`Http` facade** (the returned fake has the same methods). Only requests made through `Http` are intercepted.

```ts
import { Http } from '@hazejs/core'

it('shows the GitHub profile', async () => {
  Http.preventStrayRequests()                     // unmatched requests throw StrayRequestException
  Http.fake({
    'api.github.com/user': Http.response({ login: 'ada' }),
    'POST example.com/users': Http.response({ id: 1 }, 201),
    'example.com/users/*': request => Http.response({ id: request.url.split('/').pop() }),
    'example.com/down': Http.failedConnection(),  // throws ConnectionException
    'api.example.com/jobs/*': Http.sequence().push({ status: 'queued' }).pushStatus(204).whenEmpty(Http.response({ status: 'done' })),
    '*': Http.response('', 500),
  })
  const res = await t.get('/api/profile')
  expect(res.body.data.login).toBe('ada')
  Http.assertSent(req => req.url === 'https://api.github.com/user' && req.hasHeader('authorization', 'Bearer test-token'))
})
```

| Method | Checks |
|---|---|
| `Http.assertSent((request, response) => bool)` / `assertNotSent(predicate)` | Any / no recorded request matches |
| `Http.assertSentCount(n)` | Exactly `n` (each retry counts) |
| `Http.assertNothingSent()` / `assertSentInOrder([pred, …])` | |
| `Http.assertSequencesAreEmpty()` | All sequences consumed |
| `Http.recorded(predicate?)` | `[request, response]` pairs |
| `Http.allowStrayRequests(['127.0.0.1:*'])` | Let some unmatched requests through |

Patterns match the full URL (with or without query); `*` matches anything incl. `/`; no scheme = any scheme; optional method prefix. Later `Http.fake()` calls add rules checked **first**. Bare strings/objects are 200 bodies; `Http.fake()` with no args answers every request with an empty 200. Request object: `method`, `url`, `headers`, `body`, `data`, `json()`, `form()`, `text()`, `header(name)`, `hasHeader(name, value?)`, `query`, `attempt`.

### Search — `Search.fake()` (`@hazejs/search`)

```ts
import { search, Search } from '@hazejs/search'

it('indexes published posts', async () => {
  const engine = Search.fake()              // all engines → one in-memory engine, sync without the queue
  await Post.create({ title: 'Hello', status: 'published' })
  expect(engine.documents('posts')).toHaveLength(1)
  expect((await search(Post, 'hello').get())[0]!.title).toBe('Hello')
  Search.restore()
})
```

### AI — `AI.fake(replies)` (`@hazejs/ai`)

```ts
import { AI } from '@hazejs/ai'
afterEach(() => AI.restore())               // REQUIRED: the AI fake is process-wide

it('runs tools before answering', async () => {
  const fake = AI.fake([{ toolCalls: [{ toolName: 'currentTime', input: {} }] }, 'It is now afternoon.'])
  const res = await t.post('/api/chat', { messages: [{ role: 'user', content: 'What time is it?' }] })
  expect(res.body).toContain('event: tool-result')   // SSE → body is text
  fake.assertPromptedTimes(2)
})
```

Replies are consumed in order (text or `{ toolCalls }`); embeddings/images/speech return deterministic fake data. Assertions: `assertPrompted(predicate?)`, `assertNotPrompted()`, `assertPromptedTimes(n)`, `assertPromptContains(text)`; `fake.requests`. Outside an app, `mockModel(replies)` is a standalone model.

### Restoring

`Queue.restore()`, `Events.restore()`, `Mail.restore()`, `Storage.restore(disk?)`, `Notification.restore()`, `Broadcast.restore()`, `Http.restore()`, `Search.restore()`, `AI.restore()`.

## Other packages

- **Microservices**: no fake; use the `memory` transport (e.g. `MICROSERVICE_TRANSPORT=memory` in `.env.test` if your config reads it), then `await listenMicroservices(t.app)` and `t.make(MicroserviceManager).client().send('orders.find', { id: 1 })`.
- **OAuth**: set the `fetch` option of the oauth config to an in-process fake.
- **GraphQL**: plain requests, e.g. `(await t.actingAs({ id: 1 })).post('/graphql', { query: '{ me { id } }' })`.

## WebSocket

The client is HTTP-only; a plain GET to a WS route returns `426`. For real sockets, serve on a random port:

```ts
it('answers ping with pong', async () => {
  const server = t.app.serve({ port: 0, hostname: '127.0.0.1', silent: true })
  await server.ready()
  const socket = new WebSocket(`${server.url!.replace(/^http/, 'ws').replace(/\/$/, '')}/api/ws`)
  const messages: string[] = []
  socket.addEventListener('message', e => messages.push(String(e.data)))
  await new Promise(resolve => socket.addEventListener('open', resolve))
  socket.send('ping')
  await expect.poll(() => messages.at(-1)).toBe(JSON.stringify({ type: 'pong' }))
  socket.close()
  await server.close(true)
})
```

Socket.IO has no documented test helper; use the same serve-on-port approach with a client library if needed.

## Real services in CI

Real env vars override `.env.test`, so export e.g. `QUEUE_CONNECTION=redis` / `REDIS_URL` in CI and guard tests with `describe.skipIf(!process.env.S3_BUCKET)(...)`.

## Gotchas

- **`useTestApp()` must be called at module top level**; `t.*` only works inside tests/hooks. Accessing `t.app` outside throws.
- **Hook order matters**: fakes and `refreshDatabase()` in a `beforeEach` must be registered **after** `useTestApp()` (its `beforeEach` creates the app they bind to).
- **`actingAs()` returns a Promise** — `(await t.actingAs(user)).get(...)`; without `await` you are calling methods on a Promise.
- `issueTestCredentials` is exported from `@hazejs/core`, not `@hazejs/testing`, and takes `(app, user, guard?, { abilities? })`.
- **Fresh DB requires `DATABASE_URL=:memory:`**; with a file URL `refreshDatabase()` only re-runs pending migrations and keeps data. Keep `read`/`write` out of the test connection (only the writer is migrated).
- `refreshDatabase({ migrations })` is resolved **relative to cwd**, not srcDir; full-stack projects need `server/database/migrations`.
- `.env.local` is ignored in tests; put test-only overrides in `.env.test` / `.env.test.local`.
- **Most fakes are per-application** and reset automatically, but **`AI.fake()` is process-wide** — always `afterEach(() => AI.restore())`. `Http` without a booted app also uses a process-wide fake: call `Http.restore()` in `afterEach` for pure unit tests.
- `Events.fake()` without a list fakes **every** event, so listeners (including ones that dispatch jobs) stop running.
- `queue.drain()` does not run batches and ignores delays; jobs dispatched while draining are recorded, not run — call `drain()` again.
- A fake only records what happens after it is created: call `Mail.fake()` before `queue.drain()` (or before the request) that sends the mail.
- `Storage` fake assertions are async (`await disk.assertExists(...)`); the other fakes' assertions are sync.
- `res.body` is text (not JSON) for non-JSON responses such as SSE; assert with `toContain`.
- Factory sequence counters are not reset between tests — don't assert exact `user1@example.com` values.
- There is no time-travel / clock helper in hazejs; use Vitest's `vi.useFakeTimers()` / `vi.setSystemTime()` if needed.
