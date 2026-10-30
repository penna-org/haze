# Events

Events decouple "something happened" from "what to do about it". A controller emits `UserRegistered`; independent listeners send the welcome email, push a notification and update statistics, some of them on the [queue](./queues).

::: tip Paths
Examples on this page use the API template layout (`app/...`). In a full-stack project these live under `server/`.
:::

## Defining events

Each file in `app/event/*.ts` default-exports an event created with `defineEvent<Payload>()`. The file name is the event name.

```bash
npx haze make:event UserRegistered
```

```ts
// app/event/UserRegistered.ts
import { defineEvent } from '@hazejs/core'

const UserRegistered = defineEvent<{ userId: number, email: string }>()

export default UserRegistered
```

Pass `{ name }` to override the name: `defineEvent<P>({ name: 'user.registered' })`. An event without a payload (`defineEvent()`, payload type `void`) is emitted with `.emit()` and no argument.

| Option | Description |
| --- | --- |
| `name` | Event name; defaults to the file name |
| `afterCommit` | Emitted inside a database transaction, run the listeners (and the broadcast) only after the outermost transaction commits; dropped on rollback. See [Emitting after commit](#after-commit) |
| `broadcastOn` / `broadcastAs` / `broadcastWith` / `broadcastWhen` | Also broadcast the event. See [Broadcasting](./broadcasting) |

## Emitting events

```ts
// app/controller/AuthController.ts
import UserRegistered from '~/app/event/UserRegistered'

// inside register()
await UserRegistered.emit({ userId: user.id, email: user.email })
```

The `Events` facade does the same (it is called `Events` to avoid clashing with the global `Event` type):

```ts
import { Events } from '@hazejs/core'

await Events.emit(UserRegistered, { userId: user.id, email: user.email })
```

`emit()` resolves once all synchronous listeners have run and queued listeners have been dispatched.

Listeners are isolated from each other: when a synchronous listener throws (or a queued listener cannot be dispatched), the error is logged at `error` level with the event and listener names (`Listener "SendWelcomeEmail" failed`), the remaining listeners still run, and `emit()` does not reject. A listener that must stop the caller should do its check before emitting, or the caller should call the code directly instead of going through an event.

Listeners run in the context of the application that emitted the event: the facades, `useApp()`, `config()` and `inject()` inside a listener resolve to that application, also outside a request.

### Emitting after commit {#after-commit}

An event emitted inside a database transaction would normally run its listeners before the commit, and even if the transaction later rolls back. Mark the event with `afterCommit` to defer the whole emit (listeners, queued listeners and the broadcast) until the outermost transaction commits; it is dropped on rollback, and outside a transaction it is emitted immediately:

```ts
// app/event/OrderPlaced.ts
export default defineEvent<{ orderId: number }>({ afterCommit: true })

// in a service
await Db.transaction(async () => {
  const order = await Order.create({ ... })
  await OrderPlaced.emit({ orderId: order.id }) // listeners run after COMMIT
})
```

For a one-off, wrap the emit: `await afterCommit(() => OrderPlaced.emit({ orderId }))` (`afterCommit` from `@hazejs/core`, or `Db.afterCommit` from `@hazejs/orm`). Errors from deferred listeners are logged; the transaction has already committed. This needs `@hazejs/orm` (see [Transactions](./transactions#after-commit)); without a database package the event is emitted immediately.

## Defining listeners

Each file in `app/listener/*.ts` default-exports a listener; they are registered automatically.

```bash
npx haze make:listener SendWelcomeEmail
```

The template ships two listeners for `UserRegistered`:

```ts
// app/listener/QueueWelcomeEmail.ts
import { defineListener } from '@hazejs/core'
import UserRegistered from '~/app/event/UserRegistered'
import SendWelcomeEmail from '~/app/job/SendWelcomeEmail'

// Hand the slow part to the queue so the registration response is not delayed
export default defineListener(UserRegistered, ({ userId }) => SendWelcomeEmail.dispatch({ userId }))
```

```ts
// app/listener/BroadcastRegistration.ts
import { defineListener, Socket } from '@hazejs/core'
import UserRegistered from '~/app/event/UserRegistered'

// Push to WebSocket clients subscribed to "users" (see the WebSocket page)
export default defineListener(UserRegistered, ({ userId }) => {
  Socket.publish('users', { type: 'user.registered', userId })
})
```

A handler receives the payload and a context:

| Field | Description |
| --- | --- |
| `event` | Event name |
| `app` | The application |
| `logger` | Logger |
| `attempt` | Attempt number for queued listeners; `1` for synchronous ones |

One listener can handle several events; the payload type is then the union:

```ts
// app/listener/AuditLog.ts
import { defineListener } from '@hazejs/core'
import OrderPaid from '~/app/event/OrderPaid'
import OrderRefunded from '~/app/event/OrderRefunded'

export default defineListener([OrderPaid, OrderRefunded], async (payload, ctx) => {
  ctx.logger.info(`${ctx.event}: order ${payload.orderId}`)
})
```

### Order and stopping propagation

Synchronous listeners run one after another, in registration order:

1. listeners of [modules](./modules), in the order the modules are enabled;
2. the project's `app/listener` files, sorted by their path (so `app/listener/a/X.ts` runs before `app/listener/b/Y.ts`, and a file name prefix such as `01-` makes the order explicit);
3. listeners added at runtime with `Events.on()`, in the order they were added.

Queued listeners are dispatched at their place in the same order. Two listener files with the same name (for example `app/listener/Audit.ts` and `app/listener/admin/Audit.ts`) fail at boot with an error naming both, because a queued listener is registered as the job `listener:<name>`; rename one or pass `{ name }`.

Returning `false` stops the remaining synchronous listeners for that emit:

```ts
// app/listener/BlockSpam.ts — sorts before the other listeners
import { defineListener } from '@hazejs/core'
import UserRegistered from '~/app/event/UserRegistered'

export default defineListener(UserRegistered, ({ email }) => {
  if (email.endsWith('@spam.test'))
    return false
})
```

::: warning
A listener written as `event => service.handle(event)` returns whatever `handle()` returns. If that can be `false` (a boolean result), it stops the remaining listeners by accident; use a block body (`event => { service.handle(event) }`) or `await` without returning.
:::

## Queued listeners

Add `queue` to run a listener as a background job instead of during `emit()`:

```ts
// app/listener/SyncCrm.ts
import { defineListener } from '@hazejs/core'
import UserRegistered from '~/app/event/UserRegistered'

export default defineListener(UserRegistered, async ({ userId }, ctx) => {
  ctx.logger.info(`Syncing user ${userId} (attempt ${ctx.attempt})`)
  await crm.upsert(userId)
}, {
  queue: { tries: 3, backoff: [10, 60], timeout: '30s', delay: '1m', queue: 'crm', connection: 'redis' },
})
```

`queue: true` uses the defaults. The options mirror `defineJob` (`tries`, `backoff`, `timeout`, `queue`, `connection`) plus `delay`. Each queued listener is registered as a job named `listener:<name>` and is processed by whatever runs your [queue workers](./queues#running-workers).

::: warning JSON payloads
Queued listeners receive the payload after a JSON round-trip, so a model instance arrives as a plain object. Emit IDs and load fresh data in the listener.
:::

## Runtime listeners

`Events.on()` registers a synchronous listener at runtime, for example from a [service provider](./container). It returns a function that removes it:

```ts
// app/provider/AppProvider.ts
import { defineProvider, Events } from '@hazejs/core'
import UserRegistered from '~/app/event/UserRegistered'

export default defineProvider({
  boot() {
    const off = Events.on(UserRegistered, ({ email }) => {
      console.log(`new user ${email}`)
    })
    // call off() to unregister
  },
})
```

## Testing

`Events.fake()` records emits without running any listener. Pass a list to fake only those events; everything else keeps working normally.

```ts
// tests/auth.test.ts
import { Events, Queue } from '@hazejs/core'
import { useTestApp } from '@hazejs/testing'
import { it } from 'vitest'
import UserRegistered from '~/app/event/UserRegistered'
import SendWelcomeEmail from '~/app/job/SendWelcomeEmail'

const t = useTestApp()

it('emits UserRegistered on registration', async () => {
  const queue = Queue.fake()
  const events = Events.fake([UserRegistered])
  const res = await t.post('/api/auth/register', { name: 'Ada', email: 'ada@example.com', password: 'correct horse' })

  events.assertEmitted(UserRegistered, p => p.userId === res.body.data.user.id)
  events.assertEmittedTimes(UserRegistered, 1)
  // The event was faked, so its listeners did not run
  queue.assertNotDispatched(SendWelcomeEmail)
})
```

| Assertion | Description |
| --- | --- |
| `assertEmitted(event, predicate?)` | At least one matching emit |
| `assertNotEmitted(event, predicate?)` | No matching emit |
| `assertEmittedTimes(event, times)` | Exact count |

`Events.restore()` removes the fake. See [Testing](./testing) for the test client.
