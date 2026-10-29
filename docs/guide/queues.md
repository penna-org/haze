# Queues

Queues move slow work (emails, reports, webhooks) out of the request. In hazejs a job is a plain object defined with `defineJob`; it is discovered automatically, dispatched with `.dispatch()`, and consumed by an in-process queue, a Redis worker (BullMQ) or Cloudflare Queues.

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
| `name` | Job name; defaults to the file name |
| `tries` | Maximum number of runs. Default `1` (no retry) |
| `backoff` | Wait before a retry: seconds, `'5m'`, an array indexed by attempt (the last entry repeats), or `'exponential'` (2^n seconds). Default `0` |
| `timeout` | Seconds or `'30s'`; a timed-out run counts as a failure and aborts `job.signal` |
| `queue` | Queue name. Default `default` |
| `connection` | Connection from `config/queue.ts`. Default: its `default` |
| `handle(payload, job)` | The work |
| `failed(payload, error, job)` | Called after the final failure |

### Job context

The second argument to `handle` and the third to `failed` is a `JobContext`:

| Field | Description |
| --- | --- |
| `id` | Job ID |
| `attempt` | Current attempt, starting at 1 |
| `queue` | Queue name |
| `logger` | Logger scoped to this job |
| `app` | The application |
| `signal` | `AbortSignal` that fires on timeout |

## Dispatching

```ts
import SendInvoice from '~/app/job/SendInvoice'

await SendInvoice.dispatch({ invoiceId: 42 })
await SendInvoice.dispatch({ invoiceId: 42 }, { delay: '10m' })
await SendInvoice.dispatch({ invoiceId: 42 }, { queue: 'high', connection: 'redis' })
```

`dispatch()` resolves to the job ID. The payload is serialized as JSON, so pass IDs rather than model instances.

The `Queue` facade offers the same thing by definition or by registered name, plus a few helpers:

```ts
import { Queue } from '@hazejs/core'

await Queue.dispatch(SendInvoice, { invoiceId: 42 }, { delay: 30 })
await Queue.dispatch('SendInvoice', { invoiceId: 42 })

await Queue.failed() // failed jobs on the default connection
await Queue.retry() // re-dispatch all failed jobs (or pass an id)
await Queue.idle() // wait until the memory queue is empty
```

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
    cloudflare: { driver: 'cloudflare', binding: 'QUEUE' },
  },
}))
```

| Driver | Behavior |
| --- | --- |
| `sync` | Runs the job during `dispatch()`; errors are thrown to the caller, no retries |
| `memory` | In-process queue consumed by the same process (`concurrency`, default 1). Handles delay and backoff with timers. Jobs are lost when the process exits. The default when `config/queue.ts` is missing |
| `redis` | BullMQ (`pnpm add bullmq ioredis`). Options: `connection` (a [Redis connection](./redis), default: the `default` one; BullMQ gets its settings without `keyPrefix` and opens its own connections), `url` (inline, takes precedence), `prefix` (default `haze`; the key prefix BullMQ uses), `queues` (managed by `queue:failed` / `queue:retry`, default `['default']`), `keepCompleted` (default 1000). Needs a separate worker process |
| `cloudflare` | Cloudflare Queues producer binding (`binding`, default `QUEUE`); the Worker's `queue()` handler consumes it. Delays are capped at 12 hours |

## Running workers

With the `redis` driver, run a consumer next to your web process:

```bash
npx haze queue:work                              # development, picks up code changes
npx haze queue:work --queue high,default --concurrency 5 --connection redis
node dist/server/worker.mjs queue --queue high,default --concurrency 5   # after build
```

`--queue` lists queues in priority order (default `default`). The template exposes `pnpm queue` as a shortcut for `haze queue:work`. The built `worker.mjs` (node, bun, deno and docker presets) waits for running jobs to finish when it receives `SIGTERM`.

### Failed jobs

Jobs that exhaust their tries are kept so you can inspect and retry them:

```bash
npx haze queue:failed            # list
npx haze queue:retry             # retry all
npx haze queue:retry <id>        # retry one
npx haze queue:forget <id>       # delete one
npx haze queue:flush             # delete all
```

Each command accepts `--connection <name>`.

## Per-platform notes

| Platform | How jobs run |
| --- | --- |
| node / bun / deno / docker | `memory` in the web process for a single instance; `redis` plus `worker.mjs queue` for several |
| cloudflare | `driver: 'cloudflare'`; the generated Worker exports `queue()`, which acks on success and calls `message.retry({ delaySeconds })` for retries |
| aws-lambda | There is no queue entry point; use `redis` with a separate long-running worker |
| vercel / netlify | Same as Lambda: point `redis` at a worker running elsewhere |

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

`Queue.restore()` switches back to the real connections. More in [Testing](./testing).
