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

Pass `{ name }` to override the name: `defineEvent<P>({ name: 'user.registered' })`.

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

`emit()` resolves once all synchronous listeners have run and queued listeners have been dispatched. An error thrown by a synchronous listener propagates to the caller.

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

Synchronous listeners run one after another in file-name order. Returning `false` stops the remaining synchronous listeners for that emit:

```ts
// app/listener/BlockSpam.ts — sorts before the other listeners
import { defineListener } from '@hazejs/core'
import UserRegistered from '~/app/event/UserRegistered'

export default defineListener(UserRegistered, ({ email }) => {
  if (email.endsWith('@spam.test'))
    return false
})
```

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
