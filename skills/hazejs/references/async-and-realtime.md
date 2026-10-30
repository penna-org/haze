# Async work and realtime: queues, events, scheduling, mail, notifications, broadcasting, sockets, commands

Paths use the API template layout (`app/...`, `config/...`, `schedule/...`, `route/...`). In a full-stack project they live under `server/`. `~/` is the project-root alias. Everything below is imported from `@hazejs/core` unless noted.

Full guides: [queues](../../../docs/guide/queues.md), [events](../../../docs/guide/events.md), [scheduling](../../../docs/guide/scheduling.md), [mail](../../../docs/guide/mail.md), [notifications](../../../docs/guide/notifications.md), [broadcasting](../../../docs/guide/broadcasting.md), [websocket](../../../docs/guide/websocket.md), [socket-io](../../../docs/guide/socket-io.md), [console](../../../docs/guide/console.md), [redis](../../../docs/guide/redis.md), [maintenance](../../../docs/guide/maintenance.md), [observability](../../../docs/guide/observability.md#queue-dashboard).

## Which mechanism?

| Need | Use | Where |
| --- | --- | --- |
| "X happened", several independent reactions | Event + listeners (`defineEvent` / `defineListener`) | `app/event`, `app/listener` |
| Slow or retryable work outside the request | Job (`defineJob`, `.dispatch()`) | `app/job` |
| Recurring work on a clock | Scheduled task (`defineSchedule`) | `schedule/*.ts` |
| Tell a *user* something over mail / inbox / chat robots | Notification (`defineNotification`, `notify`) | `app/notification` |
| An email with no per-user channel logic | Mail (`defineMail`, `Mail.to(...).send`) | `app/mail` |
| Push to browsers with private/presence auth (Echo API) | Broadcasting (`broadcast`, `defineChannels`) | `app/channel` |
| Raw bidirectional protocol you design yourself | `r.ws()` + `Socket.publish` | `route/*.ts` |
| Frontend uses `socket.io-client` | `@hazejs/socket.io` namespaces | `app/socket` |
| One-off / operator task from a shell | Console command (`defineCommand`) | `app/command` |

Auto-discovered directories (`app/job`, `app/event`, `app/listener`, `app/notification`, `app/channel`) only load the **first level**; `app/command` includes subdirectories.

## Queues

### Defining and dispatching jobs

`npx haze make:job SendInvoice`. File name = job name.

```ts
// app/job/SendInvoice.ts
import { defineJob } from '@hazejs/core'

export default defineJob({
  tries: 3, // total runs; default 1 (no retry)
  backoff: [10, 60], // seconds | '5m' | array by attempt (last repeats) | 'exponential'
  timeout: '30s', // aborts job.signal, counts as a failure
  queue: 'emails', // default 'default'
  // connection: 'redis', unique: ..., middleware: [...]
  async handle(payload: { invoiceId: number }, job) {
    job.logger.info(`attempt ${job.attempt}`)
    await sendInvoice(payload.invoiceId, { signal: job.signal })
  },
  async failed(payload, error, job) { /* after the final failure */ },
})
```

`JobContext`: `id`, `name`, `attempt`, `queue`, `logger`, `app`, `signal`, `release(delay?)` (requeue without using an attempt), `batch()`.

```ts
import { Queue } from '@hazejs/core'
import SendInvoice from '~/app/job/SendInvoice'

const id = await SendInvoice.dispatch({ invoiceId: 42 }) // resolves to job ID
await SendInvoice.dispatch({ invoiceId: 42 }, { delay: '10m', queue: 'high', connection: 'redis' })
const { id: jobId, skipped } = await SendInvoice.with({ invoiceId: 42 }).onQueue('high').delay('1m').dispatch()

await Queue.dispatch('SendInvoice', { invoiceId: 42 }) // by definition or registered name
await Queue.failed() // failed jobs (default connection)
await Queue.retry() // retry all (or pass an id)
await Queue.idle() // wait until the memory queue is empty
```

Payloads are JSON-serialized: pass IDs, not model instances.

### config/queue.ts

```ts
// config/queue.ts
import { defineQueueConfig, env } from '@hazejs/core'

export default defineQueueConfig(() => ({
  default: env('QUEUE_CONNECTION', 'memory'),
  connections: {
    sync: { driver: 'sync' },
    memory: { driver: 'memory', concurrency: 2 },
    redis: { driver: 'redis', connection: 'default', queues: ['default', 'emails'] },
    database: { driver: 'database', connection: 'main', retryAfter: '90s' },
    cloudflare: { driver: 'cloudflare', binding: 'QUEUE' },
  },
  store: 'redis', // cache store for unique locks + job middleware state (must be atomic)
  batches: { store: 'redis', ttl: '7d' },
  middleware: [], // global job middleware, runs before each job's own
}))
```

| Driver | Behaviour | Worker |
| --- | --- | --- |
| `sync` | Runs inside `dispatch()`, errors thrown to caller, no retries, delays ignored, `release()` drops the job, no failed-job store (test delays/releases with `Queue.fake()` + `drain()`) | none (`queue:work` refuses it) |
| `memory` | In-process, timers for delay/backoff, lost on exit. Default when `config/queue.ts` is missing | same process |
| `redis` | BullMQ (`pnpm add bullmq ioredis`). `connection` (from `config/redis.ts`), `url`, `prefix` (default `haze`), `queues`, `keepCompleted` | separate `queue:work` |
| `database` | SQL table via `@hazejs/orm` (`databaseProvider()`); `npx haze make:queue-tables && npx haze db:migrate`. Options `table`, `failedTable`, `retryAfter`, `sleep`, `maxSleep` | separate `queue:work --connection database` |
| `cloudflare` | Cloudflare Queues producer `binding`; the Worker's `queue()` consumes. Delays capped at 12 h | platform |

Chains, batches, unique jobs and middleware are implemented in the queue manager, so they work on every driver.

### Chains and batches

```ts
await Queue.chain([
  ProcessVideo.with({ id }),
  Publish.with({ id }),
  Notify.with({ id }).onQueue('emails'), // per-job options win over the chain's
]).onConnection('redis').onQueue('media')
  .catch(Cleanup.with({ id })) // job reference: works on every driver
  .dispatch() // { id, skipped, chainId }

const batch = await Queue.batch([ImportCsv.with({ file: 'a.csv' }), ImportCsv.with({ file: 'b.csv' })])
  .name('import')
  .allowFailures() // default: first failure cancels the batch
  .then(NotifyImported.with({ userId })) // all succeeded
  .catch(ReportImportError.with({ userId })) // first failure
  .finally(CleanupUploads.with({ userId })) // all finished
  .dispatch()

const state = await Queue.findBatch(batch.id) // { total, pending, processed, failed, progress, finished, cancelled, failedJobIds, ... }
await batch.cancel(); await batch.add([...]); await batch.fresh()
// inside a job: if ((await job.batch()?.fresh())?.cancelled) return
```

### Unique jobs and job middleware

```ts
import { defineJob, rateLimited, skipIf, throttlesExceptions, withoutOverlapping } from '@hazejs/core'

export default defineJob({
  unique: { key: (p: { feedId: number }) => String(p.feedId), for: '1h', until: 'processed' }, // or 'processing'
  tries: 5,
  middleware: [
    rateLimited('github', { max: 10, per: '1m' }), // released until next window
    withoutOverlapping((p: { feedId: number }) => `feed:${p.feedId}`, { releaseAfter: '10s', expireAfter: '5m' }),
    throttlesExceptions({ max: 3, per: '5m', backoff: '1m' }), // circuit breaker
    skipIf(p => p.feedId === 0), // counts as done
  ],
  async handle(payload) { /* ... */ },
})
```

A duplicate unique dispatch: `Job.with(p).dispatch()` returns `{ skipped: true }`; `Job.dispatch(p)` returns the ID of the job already holding the lock. Unique locks are taken by the dispatcher and released by the worker, so with remote workers set `store` in `config/queue.ts` to a shared store (a `memory` store logs a warning). Custom middleware is `JobMiddleware = (payload, job, next) => ...`; return without calling `next()` to skip, call `job.release('30m')` first to retry later.

- Jobs without a payload (`handle()` with no / `void` payload): `await PruneTokens.dispatch()`, `PruneTokens.with()`, `s.job(PruneTokens)`.
- Jobs, scheduled tasks and listeners run **in their application's context**: facades (`Queue`, `Events`, `Db`, `Cache`…), `useApp()`, `config()` and `inject()` resolve to the owning app — no `Db.withManager` job middleware needed; `runInApp(app, fn)` pins scripts.
- **After commit**: `defineJob({ afterCommit: true })`, `Job.with(p).afterCommit().dispatch()` (→ `{ deferred: true }`), `dispatch(p, { afterCommit: true })`, `defineEvent({ afterCommit: true })`, `afterCommit(fn)` (core) / `Db.afterCommit(fn)` (orm): deferred until the outermost transaction commits, dropped on rollback, immediate outside a transaction.
- Two different jobs (or listeners) with the same name — e.g. a module's `app/job/Cleanup.ts` and the project's — fail at boot naming both sources; rename one or set `name`.
- `database` driver `retryAfter` is per connection: keep it above the longest job `timeout`; put long jobs on their own connection.

### Workers, failed jobs, dashboard

```bash
npx haze queue:work                                    # dev (pnpm queue), reloads job code
npx haze queue:work --connection redis --queue high,default --concurrency 5
node dist/worker.mjs queue --queue high,default --concurrency 5   # after build (dist/server/worker.mjs in full-stack / deno / docker)
npx haze queue:failed | queue:retry [id] | queue:forget <id> | queue:flush   # all accept --connection
```

The built worker drains running jobs on `SIGTERM`.

**In-process worker** (dev, single-instance deployments) — consume the queue inside the web process instead of a separate `queue:work`:

```ts
// config/queue.ts
export default defineQueueConfig(() => ({
  default: env('QUEUE_CONNECTION', 'database'),
  connections: { database: { driver: 'database', retryAfter: '35m' }, sync: { driver: 'sync' } },
  runInServer: env('WORKER_IN_SERVER', false), // or { connection, queues: ['high', 'default'], concurrency: 2 }
}))
```

It starts when the HTTP server starts listening (`haze dev`, `haze start`, node/docker builds), stops after running jobs when the app is disposed, and never starts in tests or console commands. `sync` is skipped with a warning; `memory` already runs in-process (an extra worker only for other `queues` / `concurrency`). With several web instances keep it off and run `worker.mjs queue`.

The dev dashboard (`/__haze`) has a Queues tab; mount it in production behind your own middleware:

```ts
// route/admin.ts
import { defineRoutes, queueDashboard } from '@hazejs/core'

export default defineRoutes((r) => {
  r.group({ middleware: ['auth', 'can:viewQueues'] }, (r) => {
    queueDashboard(r, { path: '/admin/queues' }) // default path /__haze/queues
  })
})
```

Testing: `const fake = Queue.fake()` then `fake.assertDispatched(Job, p => ...)`, `assertNotDispatched`, `assertCount`, `assertChained`, `assertBatched`, `assertPushedUnique`, `assertSkipped`, `await fake.drain()`; `Queue.restore()`.

## Events

```ts
// app/event/OrderShipped.ts   (npx haze make:event OrderShipped; file name = event name)
import { defineEvent, privateChannel } from '@hazejs/core'

export default defineEvent<{ orderId: number, userId: number }>({
  // all optional; omit for a plain event: defineEvent<P>()
  broadcastOn: ({ orderId }) => privateChannel(`orders.${orderId}`),
  broadcastAs: 'order.shipped', // default: event name
  broadcastWith: ({ orderId }) => ({ orderId }), // default: payload
  broadcastWhen: ({ orderId }) => orderId > 0,
})
```

```ts
// app/listener/SyncCrm.ts   (npx haze make:listener SyncCrm)
import { defineListener } from '@hazejs/core'
import OrderShipped from '~/app/event/OrderShipped'

export default defineListener(OrderShipped, async ({ orderId }, ctx) => {
  ctx.logger.info(`${ctx.event} attempt ${ctx.attempt}`)
  await crm.markShipped(orderId)
}, {
  queue: { tries: 3, backoff: [10, 60], timeout: '30s', delay: '1m', queue: 'crm', connection: 'redis' }, // or true
})

// one listener, several events: defineListener([OrderPaid, OrderRefunded], (payload, ctx) => ...)
```

```ts
await OrderShipped.emit({ orderId: 1, userId: 2 })
await Events.emit(OrderShipped, { orderId: 1, userId: 2 }) // facade is `Events`, not `Event`
const off = Events.on(OrderShipped, p => { /* runtime sync listener, e.g. in a provider boot() */ })
```

- `emit()` resolves after sync listeners ran and queued listeners were dispatched. Listener errors are **isolated**: logged (`Listener "X" failed`), the others still run, `emit()` does not reject — don't wrap every listener in try/catch.
- Order: module listeners, then `app/listener` files sorted by path, then `Events.on()` ones; returning `false` stops the remaining sync listeners.
- **`return false` pitfall**: an expression-bodied listener `(e, { app }) => app.make(Svc).queueDelivery(e)` returns whatever the service returns — a boolean `false` silently stops the listeners after it. Use a block body (`async (e) => { await svc.handle(e) }`).
- Listener `ctx`: `app`, `logger`, `event`, `attempt`; resolve services with `ctx.app.make(Service)`. Listeners (and jobs) run in their app's context, also outside requests.
- `defineEvent({ afterCommit: true })` defers the whole emit until the transaction commits.
- With `broadcastOn`, `emit()` broadcasts *before* running listeners. `broadcast(OrderShipped, payload)` broadcasts without running listeners.
- Queued listeners become jobs named `listener:<name>` and run on your queue workers.
- Testing: `Events.fake([OrderShipped])` (list = fake only those) → `assertEmitted`, `assertNotEmitted`, `assertEmittedTimes`. Faked events neither run listeners nor broadcast.

## Scheduling

```ts
// schedule/app.ts
import { defineSchedule } from '@hazejs/core'
import PruneTokens from '~/app/job/PruneTokens'

export default defineSchedule((s) => {
  s.call('report', () => sendReport()).weekdays().at('09:00').timezone('Asia/Shanghai')
  s.job(PruneTokens, { days: 30 }).daily().onOneServer() // dispatches the job; name 'job:PruneTokens'
  s.cron('*/5 * * * *', 'sync', () => sync()).withoutOverlapping('1h')
  s.call('digest', () => sendDigest()).hourly()
    .when(() => featureOn('digest')).skip(() => isHoliday())
    .onSuccess(() => {}).onFailure(error => report(error))
})
```

- `s.call(name, fn)`, `s.cron(expr, name, fn)`, `s.job(Job, payload?, { delay?, queue?, connection?, afterCommit?, name? })`. Names must be unique; no frequency = every minute.
- `defineSchedule((s, app) => …)`: the callback gets the app (`skip(() => app.make(Flags).off)`); tasks run in the app's context.
- Frequencies: `cron(expr)` (5 fields, 6 with seconds), `everyMinute`, `everyTwoMinutes`, `everyFiveMinutes`, `everyTenMinutes`, `everyFifteenMinutes`, `everyThirtyMinutes`, `hourly`, `hourlyAt(17)`, `daily`, `dailyAt('13:30')`, `twiceDaily(1, 13)`, `weekly`, `weeklyOn(1, '08:00')`, `monthly`, `monthlyOn(15, '10:00')`. Modifiers: `at`, `weekdays`, `weekends`, `timezone`.
- `onOneServer()` (once per minute across instances) and `withoutOverlapping(ttl = '24h')` use `Cache.lock`: need an atomic shared store (`redis` / `upstash`; `memory` = one process only; `kv` throws).
- On `s.job()` tasks these only lock the **dispatch**; to stop job runs overlapping use the job middleware `withoutOverlapping()` or `unique`. `onOneServer()` still matters when several processes run the scheduler.
- `s.job()` only queues the job — its result is in the queue worker's log (`Job "X" done in …`), not the scheduler's (`Scheduled job dispatched to the queue`).

```ts
// config/schedule.ts
import { defineScheduleConfig } from '@hazejs/core'
export default defineScheduleConfig({ timezone: 'Asia/Shanghai', store: 'redis', runInServer: false }) // timezone default UTC
```

`runInServer: true` runs due tasks inside the web process (dev, single instance); it starts with the HTTP server and never in tests / console commands. With several instances keep it off and run one `worker.mjs schedule` (or `onOneServer()` with a shared store).

| Environment | Run with |
| --- | --- |
| Dev | `npx haze schedule:work` (`pnpm schedule`); `npx haze schedule:list` to inspect |
| node / bun / deno / docker | `node dist/worker.mjs schedule` (long-running), cron `* * * * * node dist/worker.mjs schedule:run`, or `runInServer: true` |
| cloudflare | Cron trigger `* * * * *` added automatically; Worker `scheduled()` runs due tasks |
| aws-lambda | handler `index.schedule`, EventBridge `rate(1 minute)` |
| vercel | Vercel Cron → `/__haze/schedule`; set `CRON_SECRET` |

## Mail

```ts
// config/mail.ts
import { defineMailConfig, env } from '@hazejs/core'

export default defineMailConfig(() => ({
  default: env('MAIL_MAILER', 'log'),
  from: { address: env('MAIL_FROM_ADDRESS', 'hello@example.com'), name: env('MAIL_FROM_NAME', 'My App') },
  mailers: {
    smtp: { driver: 'smtp', host: env('MAIL_HOST', '127.0.0.1'), port: env('MAIL_PORT', 1025) },
    resend: { driver: 'resend', key: env('RESEND_API_KEY', '') },
  },
  queue: { connection: 'redis', tries: 3, backoff: [10, 60] }, // for queue()/later()
  // replyTo, alwaysTo: ['dev@example.com'] (staging safety net)
}))
```

| Driver | Notes |
| --- | --- |
| `smtp` | `pnpm add nodemailer`; `url` or `host`/`port`/`secure`/`username`/`password`/`pool`/`options`. Not on Workers |
| `resend` / `postmark` / `mailgun` | HTTP via `fetch`; work on Workers. Keys: `key` / `token`,`messageStream` / `key`,`domain`,`region` |
| `ses` | `pnpm add @aws-sdk/client-sesv2`; `region`, keys optional |
| `log` (default), `array` | Always available; `Mail.transport('array').messages` |
| `custom` | `transport`: your `MailTransport` (`send(message)`, optional `close()`) |

```ts
// app/mail/WelcomeMail.ts   (npx haze make:mail Welcome → app/mail/WelcomeMail.ts)
import { button, defineMail, html, mailLayout } from '@hazejs/core'

export default defineMail((payload: { name: string, url: string }) => ({
  subject: `Welcome, ${payload.name}`,
  html: mailLayout({
    brand: 'My App',
    preheader: 'Thanks for signing up',
    body: html`<h1>Hi ${payload.name}</h1>${button('Get started', payload.url)}`,
    footer: 'Automated message.',
  }),
  // text (auto from html), from, replyTo, cc, bcc, attachments, headers, tags
}), { name: 'WelcomeMail' }) // { name?, mailer? }
```

Helpers: `` html`...` `` (escapes interpolations, joins arrays), `rawHtml(trusted)`, `escapeHtml`, `button(text, url, { color? })`, `mailLayout({ body, brand?, preheader?, footer?, color? })`, `htmlToText`. Attachments: `{ filename, content }` or `{ filename, disk, path, cid? }` (disk files read at send time).

```ts
await Mail.to(user.email).send(WelcomeMail, { name: user.name, url }) // { mailer, messageId? }
await Mail.to({ address: user.email, name: user.name }).cc('team@x.com').bcc(['audit@x.com'])
  .replyTo('support@x.com').from('Billing <billing@x.com>').mailer('resend').send(WelcomeMail, payload)
await Mail.to(user.email).queue(WelcomeMail, payload) // dispatches built-in 'mail:send' job
await Mail.to(user.email).later('10m', WelcomeMail, payload)
await Mail.send({ to: 'ops@x.com', subject: 'Report', text: 'All good.' }) // raw message
```

Queued mail is rendered at queue time (workers don't need the definition). Testing: `Mail.fake()` → `assertSent`, `assertNotSent`, `assertSentTimes`, `assertQueued`, `assertNothingSent`, `MailFake.hasRecipient(sent, addr)`.

## Notifications

```ts
// app/notification/InvoicePaid.ts   (file name = stored/broadcast type)
import type { User } from '~/app/model/User'
import { defineNotification, html, mailLayout } from '@hazejs/core'

export default defineNotification<{ amount: number }, User>({
  via: user => user.wantsSlack ? ['mail', 'database', 'slack'] : ['mail', 'database'],
  toMail: (user, { amount }) => ({ subject: 'Payment received', html: mailLayout({ body: html`<p>${amount}</p>` }) }),
  toDatabase: (user, { amount }) => ({ amount }), // toArray is the shared fallback for database + broadcast
  toSlack: (user, { amount }) => `${user.name} paid ${amount}`,
  queue: true, // or { connection, queue, delay }: one 'notification:send' job per channel
})
```

Channels and render methods: `mail`→`toMail`, `database`→`toDatabase`, `broadcast`→`toBroadcast`, `slack`→`toSlack`, `webhook`→`toWebhook`, `wecom`/`dingtalk`/`feishu`→`toWecom`/`toDingtalk`/`toFeishu` (`{ text | markdown, title?, atAll?, atUserIds?, atMobiles?, raw? }` or a string). A channel in `via` without its method throws.

```ts
import { markAllAsRead, markAsRead, notify, notifyNow, Notification, unreadNotifications } from '@hazejs/core'

await notify(user, InvoicePaid({ amount: 99 })) // = Notification.send; arrays allowed
await notifyNow(user, InvoicePaid({ amount: 99 }), ['database']) // ignore `queue`, optional channel subset
await Notification.route('mail', 'ops@x.com').route('dingtalk', { url, secret }).notify(ServerDown({ host }))

const unread = await unreadNotifications(user) // newest first
const page = await Notification.notifications(user, { limit: 20, offset: 0 }) // also unread, type
const count = await Notification.unreadCount(user)
await markAsRead(unread[0]) // record, id, or array
await markAllAsRead(user)
```

Notifiables: `routeNotificationFor(channel)`, `email`/`name`, `getKey()` or `id`, `notifiableType` (set it explicitly if production minifies class names). Database channel: `npx haze make:notifications-table && npx haze db:generate && npx haze db:migrate`, then:

```ts
// config/notification.ts
import { defineNotificationConfig, env } from '@hazejs/core'
import { databaseNotificationStore } from '@hazejs/orm'
import { notifications } from '../database/schema/notifications'

export default defineNotificationConfig(() => ({
  channels: {
    database: { store: () => databaseNotificationStore(notifications) },
    slack: { url: env('SLACK_WEBHOOK_URL', '') },
    webhook: { url: env('NOTIFY_WEBHOOK_URL', ''), secret: env('NOTIFY_WEBHOOK_SECRET', '') }, // HMAC; verifyWebhookSignature() on the receiver
    dingtalk: { key: env('DINGTALK_ACCESS_TOKEN', ''), secret: env('DINGTALK_SECRET', '') },
  },
  queue: { connection: 'redis', tries: 5, backoff: 'exponential' }, // default 3 tries, [10, 60]
}))
```

The `broadcast` channel pushes to `private-<type>.<id>` (e.g. `private-User.1`) as event `notification`; authorize `c.private('User.{id}', ...)` and listen with ``echo.private(`User.${id}`).notification(cb)``. Custom channel: `registerNotificationChannel('sms', { send({ route, message }, { config }) {...} })` in a provider's `register()`, then `toSms`. Testing: `Notification.fake()` → `assertSentTo`, `assertNotSentTo`, `assertSentOnDemand`, `assertSentTimes`, `assertCount`.

## Broadcasting

Enabled as soon as `app/channel/*` or `config/broadcasting.ts` exists. Endpoints: `POST /broadcasting/auth`, `GET /broadcasting/sse`, `/broadcasting/ws` (through global middleware; hidden from OpenAPI).

```ts
// config/broadcasting.ts
import { defineBroadcastingConfig, env } from '@hazejs/core'

export default defineBroadcastingConfig(() => ({
  middleware: ['throttle:120,60'],
  bus: env('BROADCAST_BUS', 'memory') === 'redis'
    ? { driver: 'redis', connection: 'default', prefix: 'my-app:broadcast' }
    : { driver: 'memory' },
  // path: '/broadcasting', routes: false, transports: { ws: true, sse: true }, heartbeat: 25, maxChannels: 100
}))
```

```ts
// app/channel/orders.ts   (npx haze make:channel Order)
import type { User } from '~/app/model/User'
import { defineChannels } from '@hazejs/core'
import { Order } from '~/app/model/Order'

export default defineChannels((c) => {
  c.private('orders.{id}', async (user: User, { id }) => (await Order.find(id))?.userId === user.id)
  c.presence('chat.{room}', (user: User, { room }) => room !== 'archived' && { id: user.id, name: user.name })
  c.private('admin', (user: User) => user.role === 'admin', { guards: ['web', 'api'] })
})
```

Names: public `news`, private `private-…`, presence `presence-…` — build with `privateChannel()` / `presenceChannel()`. Guests get 401; a throwing callback denies with 403. Params are strings.

```ts
import { broadcast, Broadcast, presenceChannel, privateChannel } from '@hazejs/core'

await broadcast({ channel: 'news', event: 'Published', data: { title } })
await broadcast({ channel: [privateChannel('orders.1'), privateChannel('orders.2')], event: 'OrderShipped', data })
await broadcast({ channel: presenceChannel('chat.lobby'), event: 'Message', data, toOthers: true }) // skips X-Socket-ID sender; or except: socketId
await Broadcast.members(presenceChannel('chat.lobby'))
```

Browser client (`@hazejs/core/echo`, zero deps, Laravel Echo-style):

```ts
import { createEcho } from '@hazejs/core/echo'
import { io } from 'socket.io-client' // only for transport 'socket.io'

export const echo = createEcho({
  transport: 'ws', // 'ws' (default) | 'sse' | 'socket.io' (+ io, namespace default '/broadcasting')
  headers: () => ({ authorization: `Bearer ${localStorage.getItem('token')}` }),
  // url, path, authEndpoint, credentials, reconnect
})

echo.channel('news').listen('Published', post => {})
echo.private('orders.1').listen('OrderShipped', o => {}).notification(n => {}).error(({ status }) => {})
echo.join('chat.lobby').here(ms => {}).joining(m => {}).leaving(m => {})
  .listenForWhisper('typing', e => {}).whisper('typing', { name: 'Ada' })
echo.leave('orders.1'); echo.socketId(); echo.disconnect()
```

Socket.IO transport: `defineSocketIOConfig({ broadcasting: true })` in `config/socketio.ts` (needs the Socket.IO provider). Testing: `Broadcast.fake()` → `assertBroadcast`, `assertBroadcastOn(channel, event?, pred?)`, `assertNotBroadcast`, `assertBroadcastTimes`, `assertNothingBroadcast`.

## WebSocket routes (`r.ws`, crossws)

```ts
// app/websocket/ChatSocket.ts   (any dir except app/socket, which is reserved for Socket.IO)
import { defineWebSocket } from '@hazejs/core'

export default defineWebSocket({
  // upgrade(request, ctx): return a Response to reject, or { headers }
  async open(peer, ctx) {
    const user = await ctx.auth.user()
    peer.context.userId = user?.id // capture now: request container is disposed after upgrade
    peer.subscribe('chat')
  },
  message(peer, message) { peer.publish('chat', message.text()) }, // to *other* subscribers
  close(peer, { code, reason }) {},
  error(peer, error) {},
})
```

```ts
// route/ws.ts
import { defineRoutes, Socket } from '@hazejs/core'
import ChatSocket from '~/app/websocket/ChatSocket'

export default defineRoutes((r) => {
  r.ws('/api/chat', ChatSocket).middleware('auth') // middleware runs on the upgrade; plain GET → 426
})

Socket.publish('chat', { type: 'hello' }) // from anywhere; non-strings JSON-encoded
Socket.connections() // open connections in this process
```

Multi-instance fan-out (`pnpm add ioredis`):

```ts
// config/websocket.ts
import { defineWebSocketConfig } from '@hazejs/core'
export default defineWebSocketConfig({ broadcast: { driver: 'redis', connection: 'default', channel: 'my-app:ws' } })
```

Runtimes: dev, node/bun/deno/docker, Cloudflare (auto Durable Object `HazeWebSocket`). Not vercel/netlify/aws-lambda (426).

## Socket.IO (`@hazejs/socket.io`)

```bash
pnpm add @hazejs/socket.io socket.io     # frontend: socket.io-client
```

```ts
// app/provider/SocketProvider.ts — REQUIRED, nothing is served without it
import { socketIoProvider } from '@hazejs/socket.io'
export default socketIoProvider() // serves /socket.io/ on the HTTP port, loads app/socket/*.ts
```

```ts
// app/socket/notifications.ts   (index.ts → '/', chat.ts → '/chat', ChatRoom.ts → '/chat-room')
import { authenticate, defineNamespace } from '@hazejs/socket.io'

export default defineNamespace({
  // name: '/admin',
  middleware: [authenticate()], // { guard: 'web' } | { optional: true }; reads auth.token / Authorization / cookies
  connection(socket, io, namespace) {
    socket.join(`user:${socket.data.user.id}`)
    socket.on('notice:ack', (id: string, ack?: (r: string) => void) => ack?.('ok'))
  },
})
```

```ts
import { inject } from '@hazejs/core'
import { SocketIO, SocketIOServer } from '@hazejs/socket.io'

SocketIO.to(`user:${userId}`).emit('notice', { text: 'Export ready' })
SocketIO.of('/chat').emit('chat:message', 'hi'); SocketIO.except('banned').emit('x'); SocketIO.emit('ping')
const io = inject(SocketIOServer) // underlying Server (also SocketIO.server)
```

```ts
// config/socketio.ts (optional)
import { defineSocketIOConfig } from '@hazejs/socket.io'
export default defineSocketIOConfig({
  adapter: { driver: 'redis', connection: 'default', key: 'my-app' }, // pnpm add @socket.io/redis-adapter ioredis
  // path: '/socket.io/', cors (defaults from config/cors.ts; false = same-origin), options, broadcasting
})
```

Runtimes: dev, node/docker, bun (`@socket.io/bun-engine`). Not deno, Cloudflare (provider warns and skips), or serverless.

## Server extensions

Attach another protocol to the framework's HTTP server (this is how Socket.IO is mounted). Matched paths bypass the app and `r.ws()`; Node gets the `http.Server`, Bun uses the optional `bun` handler. Re-registering the same `name` replaces the old one (hot reload).

```ts
// app/provider/LegacyProtocolProvider.ts
import { defineProvider, registerServerExtension } from '@hazejs/core'

export default defineProvider({
  register() {
    registerServerExtension({
      name: 'legacy',
      matches: pathname => pathname.startsWith('/legacy/'),
      node(server) { legacyEngine.attach(server) }, // your library's attach(http.Server)
    })
  },
})
// unregisterServerExtension('legacy') detaches it again
```

## Console commands

```ts
// app/command/SendReport.ts   (npx haze make:command SendReport → `send:report`)
import { defineCommand, Mail } from '@hazejs/core'
import ReportMail from '~/app/mail/ReportMail'

export default defineCommand({
  description: 'Email the daily report',
  // name: 'report:send',
  args: {
    to: { type: 'positional', description: 'Recipient' },
    format: { type: 'enum', options: ['html', 'text'], default: 'html' },
    dryRun: { type: 'boolean', alias: 'd' }, // --dry-run / --dryRun / -d / --no-dry-run
    since: { type: 'string' }, // undefined when omitted
  },
  async run(args, ctx) {
    if (args.dryRun) return ctx.logger.info(`would send to ${args.to}`)
    if (!(await ctx.confirm('Send now?'))) return 1 // returned number = exit code
    await Mail.to(args.to).send(ReportMail, {})
    ctx.logger.success('sent')
  },
})
```

Names: `Inspire.ts`→`inspire`, `SendReport.ts`→`send:report`, `SendDailyReport.ts`→`send:daily-report`, `db/PruneOld.ts`→`db:prune-old`; trailing `Command` dropped; clashes with built-ins are skipped with a warning. `ctx`: `app`, `logger`, `name`, `rawArgs`, `confirm`, `ask`, `choice`, `prompt`. Throw → exit 1. The app is booted (facades, models, `config()` work) and disposed afterwards.

```bash
npx haze send:report ops@example.com --dry-run
node dist/worker.mjs command send:report ops@example.com    # production (node/bun/deno/docker presets)
npx haze repl                       # booted app + facades + models; top-level await; .reload, .exit
npx haze repl -e "await User.count()"
```

## Gotchas

- **Function callbacks only on `sync` / `memory`.** `chain().catch(fn)` or `batch().then/catch/finally(fn)` with a function throws at `dispatch()` on `redis` / `database` / `cloudflare`; pass a job reference (`Cleanup.with({...})`).
- **`Queue.batch(...)` is not awaitable** — forgetting `.dispatch()` and writing `await Queue.batch([...])` rejects with a TypeError (its `.then()` is the batch success callback).
- **`memory` is the default** (no `config/queue.ts`): jobs run in the web process and are lost on restart; with several instances use `redis` or `database` plus a separate `queue:work` / `worker.mjs queue` (or `runInServer` for a single instance).
- **`sync`** runs in the caller's process and async context: throws job errors to the caller, ignores `delay`, never retries, keeps no failed jobs, and drops `job.release()` with a warning; `queue:work` refuses it. Test delays / releases / retries with `Queue.fake()` + `drain()` instead. Inside a transaction a `sync` job runs before COMMIT unless it is `afterCommit`.
- **Payloads are JSON.** Jobs and queued listeners receive plain objects, not model instances — pass IDs. (Queued notifications and mail are rendered at send time, so models in their payload are fine.)
- **Atomic stores required**: unique jobs, job middleware, batches, `onOneServer` / `withoutOverlapping` need `redis` (or `memory` single-process). `kv` logs a warning for queues and throws for the scheduler.
- **Database driver** `retryAfter` must exceed the job `timeout`, or a slow job runs twice. Consuming needs a long-running server process even if dispatching from D1/Turso on the edge.
- **Batch members ignore `unique`**; chains inside a batch are not supported.
- **Maintenance mode** (`haze down`, `pauseWorkers: true` default) pauses queue workers between jobs (including the in-process memory queue) and skips due scheduled tasks.
- **Scheduler triggers are per minute**: a platform cron firing less often (Vercel Hobby) silently skips tasks due in between.
- **Events facade is `Events`** (plural); `Events.fake()` also suppresses event broadcasting. Sync listener order: modules, then `app/listener` by path, then `Events.on()`.
- **Listener errors don't reach the caller** (logged, others continue). If a failure must abort the operation, call the code directly instead of emitting.
- **Write-backs that must share the caller's transaction stay in-process** (a direct call or a sync listener without `afterCommit`); only side effects that may happen after COMMIT become `afterCommit` events or jobs. `afterCommit` inside `Db.joinTransaction()` fires when the callback returns, *before* the outer library commits — wrap that library's commit instead.
- **Single-process by default**: `Socket.publish`, the broadcasting `memory` bus and Socket.IO without the Redis adapter only reach connections on the current process — so a job running in a separate `queue` container cannot reach browsers on the web container. Configure `config/websocket.ts` `broadcast`, `config/broadcasting.ts` `bus` (defaults to the websocket Redis settings), or `config/socketio.ts` `adapter: { driver: 'redis' }`. Socket.IO server state is also process-level: a second app instance in the same process (tests) reuses the first one's `io`.
- **Read request data in `upgrade`/`open`** and store it on `peer.context`; the request container is gone afterwards. Browsers can't send `Authorization` on `new WebSocket()` — prefer cookie/session guards.
- **`r.ws` ≠ Socket.IO**: `socket.io-client` cannot connect to `r.ws()` routes. Socket.IO needs `socketIoProvider()` in `app/provider`; `app/socket/` is reserved for namespaces.
- **Cloudflare**: `broadcast()` from the Worker does not reach the Durable Object WebSocket endpoint — use `Socket.publish()` there; Socket.IO and `nodemailer` (smtp) don't run on Workers.
- **Presence members** leak in the Redis hash if a process crashes (no expiry); clear `<prefix>:presence:*` on redeploy if needed.
- **Notifications**: a channel listed in `via` without its `to<Channel>` method throws; on-demand (`Notification.route`) skips `database`; robot rate limits aren't handled — queue with backoff.
- **Commands**: don't prompt in unattended runs (cron/CI) — Ctrl+C/cancel exits 1; offer a `--force` flag.
