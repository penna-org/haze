# Queues

Queues move slow work (emails, reports, webhooks) out of the request. In hazejs a job is a plain object defined with `defineJob`; it is discovered automatically, dispatched with `.dispatch()`, and consumed by an in-process queue, a Redis worker (BullMQ), a database worker or Cloudflare Queues. On top of any driver you can chain jobs, run them in batches with progress tracking, make them unique and wrap them in middleware such as rate limits.

::: tip Paths
Examples on this page use the API template layout (`app/...`, `config/...`). In a full-stack project these live under `server/`.
:::

## Defining jobs

Each file in `app/job/*.ts` default-exports a job. The file name is the job name. Generate one with:

```bash
npx haze make:job SendInvoice
```

```ts
// app/job/SendInvoice.ts
import { defineJob } from '@hazejs/core'

export interface SendInvoicePayload {
  invoiceId: number
}

const SendInvoice = defineJob({
  tries: 3, // run at most 3 times
  backoff: [10, 60], // wait 10s before the 2nd try, 60s before the 3rd
  timeout: '30s',
  queue: 'emails',
  async handle(payload: SendInvoicePayload, job) {
    job.logger.info(`Sending invoice ${payload.invoiceId} (attempt ${job.attempt})`)
    await sendInvoice(payload.invoiceId, { signal: job.signal })
  },
  // Called once every try has failed
  async failed(payload, error, job) {
    job.logger.error(`Invoice ${payload.invoiceId} failed`, error)
  },
})

export default SendInvoice
```

| Option | Description |
| --- | --- |
| `name` | Job name; defaults to the file name. Two different jobs with the same name (for example `app/job/Cleanup.ts` and `app/job/admin/Cleanup.ts`, or a module's job and a project job) fail at boot with an error naming both files; rename one or set `name` |
| `tries` | Maximum number of runs. Default `1` (no retry) |
| `backoff` | Wait before a retry: seconds, `'5m'`, an array indexed by attempt (the last entry repeats), or `'exponential'` (2^n seconds). Default `0` |
| `timeout` | Seconds or `'30s'`; a timed-out run counts as a failure and aborts `job.signal` |
| `queue` | Queue name. Default `default` |
| `connection` | Connection from `config/queue.ts`. Default: its `default` |
| `unique` | `true` or `{ key, for, until }`: skip a dispatch while the same job is already queued. See [Unique jobs](#unique-jobs) |
| `middleware` | Job middleware such as `rateLimited(...)`. See [Job middleware](#job-middleware) |
| `afterCommit` | Dispatched inside a database transaction, wait until the outermost transaction commits (dropped on rollback). See [Dispatching after commit](#after-commit) |
| `handle(payload, job)` | The work |
| `failed(payload, error, job)` | Called after the final failure |

### Job context

The second argument to `handle` and the third to `failed` is a `JobContext`:

| Field | Description |
| --- | --- |
| `id` | Job ID |
| `name` | Job name |
| `attempt` | Current attempt, starting at 1 |
| `queue` | Queue name |
| `logger` | Logger scoped to this job |
| `app` | The application |
| `signal` | `AbortSignal` that fires on timeout |
| `release(delay?)` | Put the job back on the queue to run again after `delay` (seconds or `'30s'`, default 0). It is not a failure and does not use up an attempt |
| `batch()` | The [batch](#batches) the job belongs to (a snapshot read before the run), or `undefined` |

Jobs run in the context of the application that owns them: inside `handle`, middleware and `failed`, the facades (`Queue`, `Events`, `Cache`, `Db`, `Mail`…), `useApp()`, `config()` and `inject()` resolve to that application, the same way they resolve to the current application during a request. This matters when several applications share a process (tests, multi-app setups); a global job middleware such as `Db.withManager(job.app.make(DatabaseManager), next)` is no longer needed. Scripts can pin an application the same way with `runInApp(app, fn)`.

A successful run logs a debug line with the job name, duration and attempt (`Job "SendInvoice" done in 12ms (attempt 1/3)`), next to the existing warnings for retries and errors for failures.

## Dispatching

```ts
import SendInvoice from '~/app/job/SendInvoice'

await SendInvoice.dispatch({ invoiceId: 42 })
await SendInvoice.dispatch({ invoiceId: 42 }, { delay: '10m' })
await SendInvoice.dispatch({ invoiceId: 42 }, { queue: 'high', connection: 'redis' })
```

`dispatch()` resolves to the job ID. The payload is serialized as JSON, so pass IDs rather than model instances.

A job whose payload type is `void` or `undefined` (or that declares no payload at all) is dispatched without one:

```ts
const PruneTokens = defineJob({
  async handle() { /* ... */ },
})

await PruneTokens.dispatch()
await PruneTokens.dispatch(undefined, { delay: '1h' })
await PruneTokens.with().onQueue('low').dispatch()
```

`Job.with(payload)` creates a pending job. It is what chains, batches and callbacks take, and it can also be dispatched on its own. Its `dispatch()` resolves to `{ id, skipped }`, where `skipped` tells you that a [unique job](#unique-jobs) was already queued:

```ts
const { id, skipped } = await SendInvoice.with({ invoiceId: 42 }).onQueue('high').delay('1m').dispatch()
```

The `Queue` facade offers the same thing by definition or by registered name, plus a few helpers:

```ts
import { Queue } from '@hazejs/core'

await Queue.dispatch(SendInvoice, { invoiceId: 42 }, { delay: 30 })
await Queue.dispatch('SendInvoice', { invoiceId: 42 })

await Queue.failed() // failed jobs on the default connection
await Queue.retry() // re-dispatch all failed jobs (or pass an id)
await Queue.idle() // wait until the memory queue is empty
```

### Dispatching after commit {#after-commit}

A job dispatched inside a database transaction may run before the transaction commits (and see none of its writes), or run even though the transaction rolls back. `afterCommit` holds the dispatch until the outermost transaction commits and drops it on rollback; outside a transaction it dispatches immediately:

```ts
const SendReceipt = defineJob({
  afterCommit: true, // every dispatch of this job
  async handle(payload: { orderId: number }) { /* ... */ },
})

await Db.transaction(async () => {
  const order = await Order.create({ ... })
  await SendReceipt.dispatch({ orderId: order.id }) // queued after COMMIT
  await Notify.with({ id: order.id }).afterCommit().dispatch() // per dispatch
  await Audit.dispatch({ id: order.id }, { afterCommit: true })
})
```

`{ afterCommit: false }` / `.afterCommit(false)` opts a single dispatch out. A deferred `Job.with(...).dispatch()` resolves at once to `{ id, skipped: false, deferred: true }`, where `id` is the ID the job will get; unique locks are checked only when it is actually dispatched. Deferred dispatches run after the commit and before `Db.transaction()` (or `Db.commit()`) returns; an error there, such as a failing job on the `sync` connection, is logged instead of thrown because the transaction has already committed. `Queue.fake()` records a deferred dispatch only after the commit.

This needs a database package that registers a transaction hook: `@hazejs/orm` does (SQL drivers; see [Transactions](./transactions#after-commit)). Without one, `afterCommit` jobs dispatch immediately. Events have the same option, and `afterCommit(fn)` from `@hazejs/core` defers any callback.

## Connections

```ts
// config/queue.ts
import { defineQueueConfig, env } from '@hazejs/core'

export default defineQueueConfig(() => ({
  default: env('QUEUE_CONNECTION', 'memory'),
  connections: {
    memory: { driver: 'memory', concurrency: 2 },
    sync: { driver: 'sync' },
    redis: {
      driver: 'redis',
      // A connection from config/redis.ts (default: its `default` connection)
      connection: 'default',
      queues: ['default', 'emails'],
    },
    database: { driver: 'database', connection: 'main' },
    cloudflare: { driver: 'cloudflare', binding: 'QUEUE' },
  },
  // Cache store for unique-job locks and job middleware (default: the default store)
  store: 'redis',
  // Where batch state lives and how long it is kept
  batches: { store: 'redis', ttl: '7d' },
  // Middleware that wraps every job
  middleware: [],
}))
```

| Driver | Behavior |
| --- | --- |
| `sync` | Runs the job during `dispatch()`; errors are thrown to the caller, no retries, delays ignored. See [The sync connection](#sync-connection) |
| `memory` | In-process queue consumed by the same process (`concurrency`, default 1). Handles delay and backoff with timers. Jobs are lost when the process exits. The default when `config/queue.ts` is missing |
| `redis` | BullMQ (`pnpm add bullmq ioredis`). Options: `connection` (a [Redis connection](./redis), default: the `default` one; BullMQ gets its settings without `keyPrefix` and opens its own connections), `url` (inline, takes precedence), `prefix` (default `haze`; the key prefix BullMQ uses), `queues` (managed by `queue:failed` / `queue:retry`, default `['default']`), `keepCompleted` (default 1000). Needs a separate worker process |
| `database` | A table in your SQL database, from `@hazejs/orm`. See [Database driver](#database-driver). Needs a separate worker process |
| `cloudflare` | Cloudflare Queues producer binding (`binding`, default `QUEUE`); the Worker's `queue()` handler consumes it. Delays are capped at 12 hours |

The top-level options:

| Option | Description |
| --- | --- |
| `store` | Cache store from `config/cache.ts` for unique-job locks and the state of job middleware. Default: the default store. It must support atomic operations, so use `redis` (or `memory` for a single process); hazejs logs a warning for a non-atomic store such as `kv` |
| `batches.store` | Cache store for batch state. Default: `store` |
| `batches.ttl` | How long batch state is kept. Default `'7d'` |
| `middleware` | Global job middleware, run before each job's own `middleware` |

Chains, batches, unique jobs and middleware are implemented in the queue manager, so they work the same on every driver.

### The sync connection {#sync-connection}

`sync` runs the job inside `dispatch()`, in the caller's process and async context. It is meant for development and simple tests, and it differs from a real queue:

- `delay` is ignored: the job runs immediately;
- `job.release()` cannot run the job later, so the released job is dropped (with a warning);
- there are no retries: `tries` and `backoff` don't apply, and a failure calls `failed()` and is thrown to the caller of `dispatch()`;
- nothing is kept: `queue:failed` is always empty, and there is nothing to consume (`queue:work` and `queue.runInServer` refuse or skip it).

To test delays, releases and retries, use `Queue.fake()` and `drain()` (see [Testing](#testing)), or the `memory` connection with `Queue.idle()`.

### Long-running jobs and crashed workers {#retry-after}

The `database` driver treats a job reserved for longer than its connection's `retryAfter` as abandoned by a crashed worker and hands it to another worker. `retryAfter` is a connection setting, not a job setting, so:

- keep it above the longest `timeout` of the jobs on that connection, or a job that is still running can start a second time;
- put long jobs on their own connection (for example a second `database` connection with `retryAfter: '30m'` on queue `long`), so that a crash of a short job is still picked up quickly;
- a job that already used all its tries when it is picked up again goes to the failed jobs instead of running again.

The `redis` driver relies on BullMQ's stalled-job detection: the worker renews its lock while the job runs, and a job whose worker stopped renewing it is moved back to the queue. In both cases a job can run more than once after a crash, so make jobs idempotent.

### Database driver {#database-driver}

The `database` driver stores jobs in a table of your SQL database (SQLite, libsql/Turso, D1, PostgreSQL or MySQL 8). It is a good fit when you already run a database and don't want Redis. It comes with `@hazejs/orm`, and `databaseProvider()` registers it.

1. Generate the tables. This writes `database/schema/queue.ts` (`jobs` and `failed_jobs`) and runs `haze db:generate`:

   ```bash
   npx haze make:queue-tables
   npx haze db:migrate
   ```

2. Add a connection:

   ```ts
   // config/queue.ts
   connections: {
     database: {
       driver: 'database',
       connection: 'main', // from config/database.ts, default: its default connection
       table: 'jobs',
       failedTable: 'failed_jobs',
       retryAfter: '90s',
     },
   }
   ```

3. Run a worker: `npx haze queue:work --connection database` (or `node dist/server/worker.mjs queue --connection database`).

| Option | Description |
| --- | --- |
| `connection` | Database connection. Default: the default connection of `config/database.ts` |
| `table` / `failedTable` | Table names. Default `jobs` / `failed_jobs` |
| `retryAfter` | A job reserved longer than this is treated as abandoned by a crashed worker and can be reserved again. Default `'90s'`. Keep it above the jobs' `timeout`, or a slow job runs twice |
| `sleep` | Polling interval while idle, in seconds (fractions allowed) or `'1s'`. Default 1 second. It doubles while the queue stays empty, up to `maxSleep` |
| `maxSleep` | Upper limit for the idle interval. Default: 5 × `sleep` |

How it works:

- **Claiming.** On PostgreSQL and MySQL 8 a worker runs `SELECT … FOR UPDATE SKIP LOCKED` in a transaction and then marks the row reserved (`reserved_at`, `attempts + 1`). Concurrent workers skip rows that are locked. On SQLite, libsql, Turso and D1 a single atomic `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING *` does the same.
- **Delays and retries** set `available_at`. A retried row is put back with a later `available_at`; a released job (`job.release()`) is inserted again without using up an attempt.
- **Crashed workers.** Rows reserved longer than `retryAfter` are reserved again. A worker only deletes or releases a row that still carries its own `reserved_at`, so a slow worker cannot remove a row that someone else took over. A job that already used all its tries is moved to `failed_jobs` instead of running again.
- **Failed jobs** go to `failed_jobs` (`uuid`, `connection`, `queue`, `payload`, `exception`, `failed_at`). `queue:failed`, `queue:retry`, `queue:forget`, `queue:flush`, the queue dashboard and `queueCheck()` work as with Redis.
- **Polling.** One loop per worker reserves jobs while fewer than `concurrency` are running. A dispatch from the same process wakes it immediately. On `SIGTERM` the worker stops reserving and waits for running jobs.
- **Tenancy.** Queries run in the central (no tenant) context, so the tables live in the central database even with a database per tenant. The job's tenant travels in the message as usual.

::: warning Edge runtimes
On Cloudflare Workers or other serverless platforms, dispatching through Turso or D1 works. Consuming needs a long-running worker (`haze queue:work` or `worker.mjs queue` on a server), because a Worker's `fetch` cannot keep polling. On Cloudflare, use the `cloudflare` driver if you want the platform to consume the jobs.
:::

## Chains

A chain runs jobs one after another. The next job is dispatched only after the previous one succeeded, retries included. If a job fails for good, the rest of the chain is dropped and the `catch` callbacks run.

```ts
import { Queue } from '@hazejs/core'

await Queue.chain([
  ProcessVideo.with({ id }),
  Publish.with({ id }),
  Notify.with({ id }).onQueue('emails'), // options on a job win over the chain's
])
  .onConnection('redis')
  .onQueue('media')
  .catch(Cleanup.with({ id }))
  .dispatch() // { id, skipped, chainId }
```

The remaining jobs (names and payloads) travel inside the message, so any driver works and any worker can continue the chain. Chain and batch IDs appear in the dev dashboard and on failed jobs.

### Callbacks: jobs or functions

`catch` (and a batch's `then` / `finally`) accept two kinds of callbacks:

- **A job reference** such as `Cleanup.with({ id })`. It is dispatched when the callback fires and works on every connection.
- **A function** such as `error => log(error)`. Functions cannot be serialized into a queue message, so they only work when the process that dispatched the chain also runs its jobs: the `sync` and `memory` connections. On any other connection `dispatch()` throws an error that asks for a job reference. This is a deliberate choice. A function silently dropped on a remote worker would be worse than an error at the call site.

## Batches

A batch dispatches many jobs at once and tracks them as a group:

```ts
const batch = await Queue.batch([
  ImportCsv.with({ file: 'a.csv' }),
  ImportCsv.with({ file: 'b.csv' }),
])
  .name('import')
  .allowFailures()
  .then(NotifyImported.with({ userId })) // every job succeeded
  .catch(ReportImportError.with({ userId })) // the first job failed
  .finally(CleanupUploads.with({ userId })) // every job has finished
  .dispatch()

batch.id
const current = await Queue.findBatch(batch.id)
// { total, pending, processed, failed, progress, finished, cancelled, createdAt, finishedAt, failedJobIds, ... }
```

| Field | Description |
| --- | --- |
| `total` | Number of jobs, including ones added later |
| `pending` | Jobs that have not finished yet |
| `processed` | Finished jobs that did not fail, including ones skipped after a cancel |
| `failed` | Jobs that failed for good; their IDs are in `failedJobIds` |
| `progress` | Finished jobs as a percentage, 0–100 |
| `finished` / `finishedAt` | All jobs have finished |
| `cancelled` / `cancelledAt` | The batch was cancelled |
| `createdAt` | When the batch was dispatched |

Control a batch with `await batch.cancel()`, `await batch.add([...])` (it throws once the batch has finished) and `await batch.fresh()` (re-read the state). Inside a job, `job.batch()` returns the batch it belongs to, so a job can add more work or check for cancellation:

```ts
export default defineJob({
  async handle(payload: { file: string }, job) {
    for (const chunk of await chunksOf(payload.file)) {
      if ((await job.batch()?.fresh())?.cancelled)
        return
      await importChunk(chunk)
    }
  },
})
```

The rules:

- By default the first failure cancels the batch. Jobs that have not started yet are skipped and count as processed. With `allowFailures()` every job runs.
- `catch` runs once, on the first failure. `then` runs once, when every job finished and none failed or was cancelled. `finally` runs once, when every job has finished, whatever the outcome.
- State lives in the cache store from `batches.store`. The counters use the store's atomic increments. The worker whose increment makes the finished count reach the total writes a "finished" marker with `add()`, and only the worker that wins that write runs `then` / `finally`. So the callbacks run exactly once even with many concurrent workers.
- With more than one process, the store must be shared and atomic: use `redis`. The default `memory` store is fine for the `memory` and `sync` connections. hazejs logs a warning if the store is not atomic, as with `kv`.
- Batch members ignore `unique`. Chains inside a batch are not supported.

## Unique jobs {#unique-jobs}

A unique job is skipped when the same job (and key) is already queued or running:

```ts
export default defineJob({
  unique: {
    key: (payload: { feedId: number }) => String(payload.feedId), // default: one per job name
    for: '1h', // the lock expires after this, default '1d'
    until: 'processed', // or 'processing'
  },
  async handle(payload) { /* ... */ },
})

const { skipped } = await SyncFeed.with({ feedId: 1 }).dispatch()
await SyncFeed.dispatch({ feedId: 1 }) // resolves to the ID of the job already queued
```

On dispatch, hazejs takes a cache lock (`store` in `config/queue.ts`) named after the job and key, with the message ID as owner. If the lock is held, nothing is queued. `Job.with(...).dispatch()` returns `{ skipped: true }` and `Job.dispatch()` returns the ID of the job that holds the lock. The lock is released:

- when the job starts, with `until: 'processing'` ("unique until processing");
- when the job finishes, with `until: 'processed'` (default). This includes a final failure but not a retry or a release;
- when it expires after `for`;
- when the dispatch itself fails.

Keys are scoped to the current tenant.

::: warning Use a shared store with remote workers
The lock is taken by the process that dispatches and released by the process that runs the job. With the `memory` cache store and a connection consumed by another process (`database`, `redis`), the worker cannot release the web process's lock, so later dispatches are skipped until the lock expires (`for`). hazejs logs a warning the first time this happens; set `store` in `config/queue.ts` to a shared store such as `redis`.
:::

## Job middleware {#job-middleware}

Middleware wraps a job's `handle`. Built-in middleware keeps its state in the queue's cache `store`:

```ts
import { defineJob, rateLimited, skipIf, throttlesExceptions, withoutOverlapping } from '@hazejs/core'

export default defineJob({
  tries: 5,
  middleware: [
    rateLimited('github', { max: 10, per: '1m' }),
    withoutOverlapping((payload: { userId: number }) => `user:${payload.userId}`, { releaseAfter: '10s', expireAfter: '5m' }),
    throttlesExceptions({ max: 3, per: '5m', backoff: '1m' }),
    skipIf(payload => payload.userId === 0),
  ],
  async handle(payload) { /* ... */ },
})
```

| Middleware | Behavior |
| --- | --- |
| `rateLimited(name, { max, per, key? })` | At most `max` runs per fixed window of `per`, shared by every job that uses the same name (`key` splits it further, for example per account). Jobs over the limit are released until the next window |
| `withoutOverlapping(key?, { releaseAfter?, expireAfter? })` | Only one job per key runs at a time (a cache lock that expires after `expireAfter`, default `'1h'`). Others are released for `releaseAfter` (default 1s), or dropped with `releaseAfter: false`. The default key is the job name |
| `throttlesExceptions({ max?, per?, backoff?, key?, when? })` | A circuit breaker. After `max` exceptions (default 10) within `per` (default `'10m'`), further runs are released until the window ends. Exceptions still count as failed attempts, `backoff` replaces the job's retry delay, and a success resets the count |
| `skipIf(predicate)` | Skip the run (it counts as done) when `predicate(payload, job)` is true |

Write your own as `(payload, job, next) => ...`. Call `next()` to continue. Return without calling it to skip the run, and call `job.release(delay)` first to retry later:

```ts
import type { JobMiddleware } from '@hazejs/core'

export const onlyDuringOfficeHours: JobMiddleware = async (_payload, job, next) => {
  const hour = new Date().getHours()
  if (hour < 9 || hour >= 18) {
    job.release('30m')
    return
  }
  return next()
}
```

`job.release()` works on every driver except `sync`, which cannot run a job later; there the released job is dropped with a warning. Global middleware from `config/queue.ts` runs before the job's own.

## Running workers

With the `redis` or `database` driver, run a consumer next to your web process:

```bash
npx haze queue:work                              # development, picks up code changes
npx haze queue:work --queue high,default --concurrency 5 --connection redis
node dist/server/worker.mjs queue --queue high,default --concurrency 5   # after build
```

`--queue` lists queues in priority order (default `default`). The template exposes `pnpm queue` as a shortcut for `haze queue:work`. The built `worker.mjs` (node, bun, deno and docker presets) waits for running jobs to finish when it receives `SIGTERM`.

A single-instance deployment (or development) can consume the queue inside the web process instead:

```ts
// config/queue.ts
export default defineQueueConfig({
  default: 'database',
  connections: { database: { driver: 'database' } },
  runInServer: true, // or { connection, queues: ['high', 'default'], concurrency: 2 }
})
```

The worker starts when the HTTP server starts listening (`haze dev`, `haze start`, the node and docker builds) and stops, after running jobs finish, when the application is disposed. Tests and console commands never start it. With several instances, keep `runInServer` off and run `queue:work` processes.

`runInServer` only matters for connections consumed by a worker. On a `memory` connection the web process already consumes the `default` queue, so no extra worker is started unless you list other `queues` or a `concurrency`; on `sync` there is nothing to consume, so it is skipped with a warning. `haze queue:work` refuses the `sync` connection with an error.

### Failed jobs

Jobs that exhaust their tries are kept so you can inspect and retry them:

```bash
npx haze queue:failed            # list
npx haze queue:retry             # retry all
npx haze queue:retry <id>        # retry one
npx haze queue:forget <id>       # delete one
npx haze queue:flush             # delete all
```

Each command accepts `--connection <name>`. A retried job that belonged to a chain continues the chain when it succeeds.

## Per-platform notes

| Platform | How jobs run |
| --- | --- |
| node / bun / deno / docker | `memory` in the web process for a single instance; `redis` or `database` plus `worker.mjs queue` for several |
| cloudflare | `driver: 'cloudflare'`; the generated Worker exports `queue()`, which acks on success and calls `message.retry({ delaySeconds })` for retries. A released job is sent again as a new message. `database` with D1 or Turso can dispatch, but its worker must run on a server |
| aws-lambda | There is no queue entry point; use `redis` or `database` with a separate long-running worker |
| vercel / netlify | Same as Lambda: point `redis` or `database` at a worker running elsewhere |

For Cloudflare, declare the producer and consumer in `haze.config.ts` so they are merged into `dist/wrangler.json`:

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  cloudflare: {
    wrangler: {
      queues: {
        producers: [{ binding: 'QUEUE', queue: 'my-app-jobs' }],
        consumers: [{ queue: 'my-app-jobs' }],
      },
    },
  },
})
```

See [Deployment](./deployment) for presets.

## Testing

`Queue.fake()` records dispatches instead of running them:

```ts
// tests/invoice.test.ts
import { Queue } from '@hazejs/core'
import { useTestApp } from '@hazejs/testing'
import { beforeEach, it } from 'vitest'
import SendInvoice from '~/app/job/SendInvoice'

const t = useTestApp()
let fake: ReturnType<typeof Queue.fake>
beforeEach(() => {
  fake = Queue.fake()
})

it('queues the invoice email', async () => {
  await t.post('/api/invoices', { amount: 100 })
  fake.assertDispatched(SendInvoice, payload => payload.invoiceId > 0)
  fake.assertNotDispatched('SendReminder')
  fake.assertCount(1)
  // Run the recorded jobs in order (delays are ignored)
  await fake.drain()
})
```

Chains, batches and unique jobs have their own assertions:

```ts
fake.assertChained([ProcessVideo, Publish.with({ id: 1 })]) // names, plus payloads for Job.with(...)
fake.assertBatched(batch => batch.name === 'import' && batch.jobs.length === 2)
fake.assertBatchCount(1)
fake.assertNothingBatched()
fake.assertPushedUnique(SyncFeed, payload => payload.feedId === 1) // pushed exactly once
fake.assertSkipped(SyncFeed) // a duplicate dispatch was skipped
```

`drain()` runs the recorded jobs through the real pipeline (middleware, `release()`, retries), which is the way to test delayed and released jobs; the `sync` connection ignores delays and drops releases. The fake simulates unique locks in memory and releases them when `drain()` runs the job. `drain()` also records what the drained jobs dispatch, such as the next job of a chain, so call it again to keep going. Batched jobs are recorded in `fake.batches` and are not run.

`Queue.restore()` switches back to the real connections. More in [Testing](./testing).
