# Testing

`@hazejs/testing` runs your application inside [Vitest](https://vitest.dev) without opening a port. Each test gets a fresh application built from the same `config/`, `route/` and `app/` files as `haze dev`, an HTTP client to call it, and fakes for queues, events, mail, storage, notifications, broadcasts, outgoing HTTP requests, search and AI.

## Setup

New projects come ready to test. The pieces are:

```ts
// vitest.config.ts
import { defineHazeTestConfig } from '@hazejs/testing/config'
import { defineConfig } from 'vitest/config'

export default defineConfig(defineHazeTestConfig())
```

`defineHazeTestConfig()` registers the hazejs Vite plugin (which provides the `~` alias and the app's module graph) and sets the Node environment. It accepts any Vitest config and merges it in. The plugin reads `haze.config.ts`, so a full-stack project with `srcDir: 'server'` needs nothing extra; options for the plugin can be passed under `haze`:

```ts
// vitest.config.ts (full-stack project)
import { defineHazeTestConfig } from '@hazejs/testing/config'
import { defineConfig } from 'vitest/config'

export default defineConfig(defineHazeTestConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
}))
```

### Environment

Tests run in `test` mode. Environment files are loaded in this order, later files overriding earlier ones: `.env` → `.env.test` → `.env.test.local`. `.env.local` is skipped in test mode so results are reproducible. Variables that are already set in the real environment always win.

The templates ship a `.env.test` that switches the database to SQLite in memory:

```ini
# .env.test
DATABASE_URL=:memory:
```

## Running tests

```bash
haze test          # vitest run
pnpm test          # same, via package.json
haze test watch    # arguments are passed to Vitest as-is
haze test run tests/auth.test.ts
```

`haze test` sets `NODE_ENV=test` and runs the project's Vitest. Without arguments it runs `vitest run`; any arguments replace that default.

Generate a test file with:

```bash
haze make:test user   # tests/user.test.ts
```

## Making requests

`useTestApp()` creates a new application before each test and disposes it afterwards. Call it once at the top of the file and use the returned client inside tests:

```ts
// tests/greeting.test.ts
import { useTestApp } from '@hazejs/testing'
import { describe, expect, it } from 'vitest'

const t = useTestApp()

describe('greeting', () => {
  it('says hello', async () => {
    const res = await t.get('/api/hello')
    expect(res.status).toBe(200)
    expect(res.body.data).toEqual({ app: 'my-app', message: 'Hello, hazejs!' })
  })

  it('validates the request body', async () => {
    const res = await t.post('/api/hello', { name: '' })
    expect(res.status).toBe(422)
    expect(res.body.errors[0]).toMatchObject({ target: 'body', path: 'name' })
  })
})
```

The client has `get(path, init?)`, `delete(path, init?)`, `post(path, body?, init?)`, `put(path, body?, init?)` and `patch(path, body?, init?)`.

- Objects are sent as JSON with `content-type: application/json`. Strings, `FormData`, `URLSearchParams` and `Blob` are sent as-is — use `FormData` for file uploads.
- `init` is a regular `RequestInit` plus `query`: `t.get('/api/users', { query: { page: 2 } })`.
- `withHeaders(headers)` returns a client that sends those headers on every request.

Every call resolves to a response object:

| Field | Description |
|-------|-------------|
| `status` | HTTP status code. |
| `ok` | `true` for 2xx. |
| `headers` | `Headers`. |
| `body` | Parsed JSON when the response is JSON, otherwise the text. |
| `text` | Raw response text. |

```ts
const me = await t.withHeaders({ authorization: `Bearer ${token}` }).get('/api/auth/me')
```

The object returned by `useTestApp()` also exposes `t.app` (the `Application`), `t.make(key)` to resolve services from the container, and `t.request(input, init?)` for raw fetch-style requests that return a `Response`.

### Replacing services

Pass `override` to swap bindings after providers have registered and before the app boots:

```ts
const t = useTestApp({
  override: c => c.instance(PaymentGateway, new FakePaymentGateway()),
})
```

`createTestApp(options)` is the non-hook version: it returns the same object for a single app, and you call its `close()` yourself when done.

## Authentication

`actingAs(user, guard?)` returns a client that is logged in as `user`. With a JWT guard it issues a real token in the `Authorization` header; with a session guard it creates a real session cookie. The default guard from `config/auth.ts` is used unless you name one.

```ts
it('lets users update themselves', async () => {
  const ada = await User.create({ name: 'Ada', email: 'ada@example.com' })
  const asAda = await t.actingAs(ada)

  const res = await asAda.patch(`/api/users/${ada.id}`, { name: 'Ada Lovelace' })
  expect(res.body.data.name).toBe('Ada Lovelace')
})
```

With the `token` guard of [API tokens](./api-tokens), `actingAs(user, 'token')` issues a real personal access token with every ability (`*`). To test ability checks, issue a token with specific abilities through `issueTestCredentials()`, the helper `actingAs()` is built on:

```ts
import { issueTestCredentials } from '@hazejs/core'

it('rejects tokens without posts:write', async () => {
  const headers = await issueTestCredentials(t.app, ada, 'token', { abilities: ['posts:read'] })
  const res = await t.withHeaders(headers).post('/api/posts', { title: 'Hi' })
  expect(res.status).toBe(403)
})
```

See [Authentication](./authentication) for guards.

## Database

`refreshDatabase()` from `@hazejs/orm` reconnects and runs your migrations. With `DATABASE_URL=:memory:` in `.env.test`, every test starts with a fresh, migrated database:

```ts
// tests/user.test.ts
import { refreshDatabase } from '@hazejs/orm'
import { useTestApp } from '@hazejs/testing'
import { beforeEach } from 'vitest'

const t = useTestApp()
beforeEach(() => refreshDatabase({ migrations: 'database/migrations' }))
```

Options are `migrations` (relative to the working directory, default `database/migrations`; full-stack projects use `server/database/migrations`) and `connection`. On MongoDB connections it drops the database instead. See [Database](./database).

### Model factories

[Factories](./factories) in `database/factories` create test data with realistic values, so a test only spells out what it cares about:

```ts
import UserFactory from '~/database/factories/UserFactory'

it('only lets users change themselves, unless they are admins', async () => {
  const [ada, bob] = await UserFactory.createMany([{ name: 'Ada' }, { name: 'Bob' }])
  const admin = await UserFactory.state('admin').create()
  // ...
})
```

`UserFactory.raw()` returns plain attributes, handy as a request body: `await t.post('/api/users', await UserFactory.raw())`. Fake values come from `@faker-js/faker`, a dev dependency of the templates.

::: tip Read/write splitting in tests
`refreshDatabase()` migrates only the writer. Keep `read` / `write` out of the test connection (`.env.test` usually points `DATABASE_URL` at `:memory:`), or point the replicas at the same database.
:::

## Fakes

Fakes record what your code does instead of doing it. They belong to the current application, and since `useTestApp()` creates a new one per test, they never leak between tests. Create them inside a test, or in a `beforeEach` registered after `useTestApp()`.

```ts
// tests/auth.test.ts
import { Events, Mail, MailFake, Queue } from '@hazejs/core'
import { refreshDatabase } from '@hazejs/orm'
import { useTestApp } from '@hazejs/testing'
import { beforeEach, describe, it } from 'vitest'
import UserRegistered from '~/app/event/UserRegistered'
import SendWelcomeEmail from '~/app/job/SendWelcomeEmail'
import WelcomeMail from '~/app/mail/WelcomeMail'

const t = useTestApp()
let queue: ReturnType<typeof Queue.fake>
beforeEach(() => {
  queue = Queue.fake()
})
beforeEach(() => refreshDatabase({ migrations: 'database/migrations' }))

const ada = { name: 'Ada', email: 'ada@example.com', password: 'correct horse' }

describe('registration', () => {
  it('queues and sends the welcome mail', async () => {
    const res = await t.post('/api/auth/register', ada)
    queue.assertDispatched(SendWelcomeEmail, payload => payload.userId === res.body.data.user.id)

    // Run the recorded jobs; Mail.fake() records the mail instead of delivering it
    const mail = Mail.fake()
    await queue.drain()
    mail.assertSent(WelcomeMail, sent => MailFake.hasRecipient(sent, ada.email))
  })

  it('emits UserRegistered', async () => {
    const events = Events.fake([UserRegistered])
    const res = await t.post('/api/auth/register', ada)
    events.assertEmitted(UserRegistered, payload => payload.userId === res.body.data.user.id)
    // Faked events don't run their listeners, so no job is dispatched
    queue.assertNotDispatched(SendWelcomeEmail)
  })
})
```

| Fake | Assertions & helpers |
|------|----------------------|
| `Queue.fake()` | `assertDispatched(job, predicate?)`, `assertNotDispatched(job, predicate?)`, `assertCount(n)`; chains: `assertChained([JobA, JobB.with(payload)])`; batches: `assertBatched(batch => ...)`, `assertBatchCount(n)`, `assertNothingBatched()`; unique jobs: `assertPushedUnique(job, predicate?)`, `assertSkipped(job, predicate?)`; `drain()` runs the recorded jobs in order (ignoring delays; jobs they dispatch, such as the next job of a chain, are recorded again); `dispatched`, `chains`, `batches`, `skipped` |
| `Events.fake(events?)` | `assertEmitted(event, predicate?)`, `assertNotEmitted(event, predicate?)`, `assertEmittedTimes(event, n)`, `emitted`. Pass a list to fake only those events. |
| `Mail.fake()` | `assertSent`, `assertNotSent`, `assertSentTimes`, `assertQueued`, `assertNotQueued`, `assertNothingSent`, `assertNothingQueued`; `MailFake.hasRecipient(mail, address)` |
| `Storage.fake(disk?)` | `assertExists`, `assertMissing`, `assertCount`, `assertDirectoryEmpty` (all async); see [File Storage](./storage#testing) for an upload example |
| `Notification.fake()` | `assertSentTo(notifiable, notification, predicate?)`, `assertNotSentTo`, `assertSentOnDemand`, `assertSentTimes`, `assertNothingSentTo`, `assertNothingSent`, `assertCount`; `sentTo(notifiable, notification)` returns records whose `message(channel)` renders the content |
| `Broadcast.fake()` | `assertBroadcast(event, predicate?)`, `assertBroadcastOn(channel, event?, predicate?)`, `assertNotBroadcast`, `assertBroadcastTimes`, `assertNothingBroadcast`; `broadcasts` |
| `Http.fake(stubs?)` | `Http.assertSent(predicate)`, `assertNotSent`, `assertSentCount(n)`, `assertNothingSent`, `assertSentInOrder`, `assertSequencesAreEmpty`, `recorded()`; `Http.preventStrayRequests()` makes unfaked requests throw. Only requests made through `Http` are intercepted; see [HTTP Client](./http-client#testing) |

Jobs can be matched by definition or by name, e.g. `queue.assertDispatched('mail:send')`. Each fake also has a `restore()` on its facade (`Queue.restore()`, `Events.restore()`, `Mail.restore()`, `Storage.restore()`, `Notification.restore()`, `Broadcast.restore()`, `Http.restore()`). More detail lives on each feature's page: [Queues](./queues), [Events](./events), [Mail](./mail#testing), [File Storage](./storage#testing), [Notifications](./notifications#testing), [Broadcasting](./broadcasting#testing), [HTTP Client](./http-client#testing).

### Other packages

The optional packages follow the same pattern:

- **Search** — `Search.fake()` from `@hazejs/search` replaces every engine with one in-memory engine and syncs without the queue. The returned engine exposes the indexed documents: `engine.documents('posts')`. See [Search](./search#testing).
- **AI** — `AI.fake(replies)` from `@hazejs/ai` answers every model call with the given replies, so no request leaves the process; the templates' `tests/chat.test.ts` uses it. See [AI](./ai#testing).
- **Microservices** — there is no fake; use the in-process `memory` transport instead (for example `MICROSERVICE_TRANSPORT=memory` in `.env.test`, if your config reads it), call `listenMicroservices(t.app)` in the test and send messages with `t.make(MicroserviceManager).client()`. See [Microservices](./microservices#testing).
- **OAuth** — set the `fetch` option of the OAuth config to an in-process fake so tests never reach the real providers. See [OAuth Social Login](./oauth#testing).

## Testing against real services

Fakes and in-memory drivers keep the default suite fast and offline. For integration tests against real Redis, S3, SMTP and so on, rely on the fact that real environment variables override `.env.test`: start the services in CI and export the variables your config reads, then skip those tests when the variables are missing locally.

```ts
// tests/s3.test.ts
import process from 'node:process'
import { Storage } from '@hazejs/core'
import { useTestApp } from '@hazejs/testing'
import { describe, expect, it } from 'vitest'

useTestApp()

describe.skipIf(!process.env.S3_BUCKET)('s3 disk', () => {
  it('round-trips a file', async () => {
    const disk = Storage.disk('s3')
    await disk.put('ci/hello.txt', 'hi')
    expect(await disk.text('ci/hello.txt')).toBe('hi')
    await disk.delete('ci/hello.txt')
  })
})
```

```yaml
# .github/workflows/test.yml (excerpt)
services:
  redis:
    image: redis:7
    ports: ['6379:6379']
env:
  QUEUE_CONNECTION: redis
  REDIS_URL: redis://localhost:6379
```

The environment variable names above come from the project templates' `config/*.ts`; use whatever names your config files read.
