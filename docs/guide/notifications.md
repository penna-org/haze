# Notifications

A notification is a short message to a user — "your invoice was paid", "the deploy failed" — that you define once and deliver over several channels: mail, the database (for an in-app inbox), [broadcasting](./broadcasting), Slack, a generic webhook, and the WeCom, DingTalk and Feishu chat robots. Notifications can be sent immediately or through the [queue](./queues), and `Notification.fake()` makes them easy to test.

```ts
await notify(user, InvoicePaid({ amount: 99 }))
```

::: tip Paths
Examples on this page use the API template layout (`app/...`, `config/...`). In a full-stack project these live under `server/`.
:::

## Defining notifications

Put notifications in `app/notification/*.ts`. `haze make:notification InvoicePaid` generates `app/notification/InvoicePaidNotification.ts` (type `InvoicePaidNotification`); the example below is written by hand:

```ts
// app/notification/InvoicePaid.ts
import type { User } from '~/app/model/User'
import { defineNotification, html, mailLayout } from '@hazejs/core'

export default defineNotification<{ amount: number }, User>({
  via: user => user.wantsSlack ? ['mail', 'database', 'slack'] : ['mail', 'database'],
  toMail: (user, { amount }) => ({
    subject: 'Payment received',
    html: mailLayout({ body: html`<p>Hi ${user.name}, we received ${amount}.</p>` }),
  }),
  toDatabase: (user, { amount }) => ({ amount }),
  toSlack: (user, { amount }) => `${user.name} paid ${amount}`,
})
```

- The type parameters are the payload and the notifiable (usually your `User` model).
- `via(notifiable, payload)` returns the channels to use. Each channel calls the matching `to<Channel>(notifiable, payload)` method: `toMail`, `toDatabase`, `toBroadcast`, `toSlack`, `toWebhook`, `toWecom`, `toDingtalk`, `toFeishu`, or `toSms` for a custom `sms` channel.
- `toArray` is shared by `database` and `broadcast` when they have no method of their own.
- The file name is the notification's **type** (`InvoicePaid`), stored in the database and sent to the browser. Pass `name` to override it.

A notification sent over a channel that has no matching method throws an error, so a typo shows up the first time you send it.

## Sending

Call the definition with its payload, then send it:

```ts
import { notify, Notification } from '@hazejs/core'
import InvoicePaid from '~/app/notification/InvoicePaid'

await notify(user, InvoicePaid({ amount: 99 }))
await Notification.send([ada, bob], InvoicePaid({ amount: 99 })) // several notifiables
await Notification.sendNow(user, InvoicePaid({ amount: 99 })) // ignore `queue`
await Notification.sendNow(user, InvoicePaid({ amount: 99 }), ['database']) // only these channels
```

Each notifiable gets its own notification ID, shared by all its channels.

### On-demand notifications

To notify someone who is not a user — an operations mailbox, a team chat — give the routes directly:

```ts
await Notification.route('mail', 'ops@example.com')
  .route('dingtalk', { url: env('DINGTALK_WEBHOOK'), secret: env('DINGTALK_SECRET') })
  .notify(ServerDown({ host: 'web-1' }))
```

Channels without a route are skipped, and the database channel is skipped because there is no notifiable ID.

### Notifiables

Any object can receive notifications. hazejs looks for:

| Member | Used for |
|--------|----------|
| `routeNotificationFor(channel, notification)` | The address for a channel: an email, a webhook URL, a broadcast channel name… Return `undefined` to use the default. |
| `email` / `name` | The default mail recipient. |
| `getKey()` or `id` | The notifiable ID (database and broadcast channels). |
| `notifiableType` (instance or static) | The notifiable type. Defaults to the class name (`User`); plain objects default to `User`. |

With [models](./models), add `routeNotificationFor` to the class when a user has their own webhook:

```ts
// app/model/User.ts
export class User extends Model.define(users) {
  routeNotificationFor(channel: string) {
    if (channel === 'slack')
      return this.slackWebhookUrl ?? undefined
  }
}
```

Class names are read at runtime, so keep `notifiableType` explicit (`static notifiableType = 'User'`) if your production build minifies class names.

## Queued notifications

Set `queue` to deliver through the queue. Each channel becomes its own job (`notification:send`), so a failing Slack call is retried without sending the mail twice:

```ts
export default defineNotification<{ amount: number }>({
  via: () => ['mail', 'slack'],
  queue: true, // or { connection: 'redis', queue: 'notifications', delay: '1m' }
  // ...
})
```

The content of every channel is rendered when you send, and the job carries the rendered message and address as JSON. The worker therefore does not need the notification definition, and models in the payload can be passed directly. Retries use `queue` in `config/notification.ts` (3 tries, `[10, 60]` seconds backoff by default).

## Configuration

`config/notification.ts` holds channel defaults: shared webhook URLs, signing secrets, the database store.

```ts
// config/notification.ts
import { databaseNotificationStore } from '@hazejs/orm'
import { defineNotificationConfig, env } from '@hazejs/core'
import { notifications } from '../database/schema/notifications'

export default defineNotificationConfig(() => ({
  channels: {
    database: { store: () => databaseNotificationStore(notifications) },
    slack: { url: env('SLACK_WEBHOOK_URL', '') },
    webhook: { url: env('NOTIFY_WEBHOOK_URL', ''), secret: env('NOTIFY_WEBHOOK_SECRET', '') },
    wecom: { key: env('WECOM_ROBOT_KEY', '') },
    dingtalk: { key: env('DINGTALK_ACCESS_TOKEN', ''), secret: env('DINGTALK_SECRET', '') },
    feishu: { key: env('FEISHU_HOOK_ID', ''), secret: env('FEISHU_SECRET', '') },
  },
  queue: { connection: 'redis', tries: 5, backoff: 'exponential' },
}))
```

| Option | Description |
|--------|-------------|
| `channels.<name>` | Defaults for a channel. A notifiable's own route always wins. |
| `channels.mail.mailer` | Mailer used for notification mail. |
| `channels.database.store` | The store, or a function returning it. |
| `channels.broadcast.event` | Event name in the browser, `notification` by default. |
| `channels.<webhook>.timeout` | Request timeout in milliseconds, 10 000 by default. |
| `queue` | `{ connection?, queue?, tries?, backoff? }` for queued notifications. |

## Channels

### Mail

`toMail` returns the same object as a [mail definition](./mail#defining-mails) (`subject`, `html`, `text`, `attachments`, …), plus optional `to` and `mailer`. The recipient defaults to `routeNotificationFor('mail')`, then the notifiable's `email` and `name`. To reuse an existing mail, render it: `toMail: user => WelcomeMail.render({ name: user.name })`. Mail goes through the configured mailer, so `Mail.fake()` records it too.

### Database

The database channel stores notifications for an in-app inbox. Generate the table, then migrate:

```sh
npx haze make:notifications-table   # database/schema/notifications.ts (sqlite, postgres or mysql)
npx haze db:generate && npx haze db:migrate
```

Point `channels.database.store` at the table (see [Configuration](#configuration)) and read notifications with:

```ts
import { markAllAsRead, markAsRead, Notification, unreadNotifications } from '@hazejs/core'

const unread = await unreadNotifications(user) // newest first
const page = await Notification.notifications(user, { limit: 20, offset: 0 })
const count = await Notification.unreadCount(user)
await markAsRead(unread[0]) // a record, an ID, or an array of them
await markAllAsRead(user)
```

Each record is `{ id, type, notifiableType, notifiableId, data, readAt, createdAt }`, where `data` is what `toDatabase` returned. Query options are `unread`, `type`, `limit` and `offset`. A store is a small interface (`insert`, `list`, `count`, `markAsRead`, `markAsUnread`, `markAllAsRead`, `delete`), so you can implement your own; `memoryNotificationStore()` is handy in tests.

### Broadcast

The broadcast channel pushes the notification to the notifiable's private channel, `private-<type>.<id>` (for example `private-User.1`), as an event named `notification`. The data is `toBroadcast` (or `toArray` / `toDatabase`) plus `id` and `type`:

```ts
// app/channel/user.ts
export default defineChannels((c) => {
  c.private('User.{id}', (user: User, { id }) => user.id === Number(id))
})

// Browser
echo.private(`User.${user.id}`).notification(({ type, id, ...data }) => showToast(data))
```

Return a channel name (or several) from `routeNotificationFor('broadcast')` to use other channels. See [Broadcasting](./broadcasting) for the client.

### Slack

Posts to a Slack [incoming webhook](https://api.slack.com/messaging/webhooks). `toSlack` returns a string (the `text`) or a message object with `text`, `blocks`, `attachments`, `thread_ts` and so on. The URL comes from `routeNotificationFor('slack')` or `channels.slack.url`.

### Webhook

Posts `toWebhook`'s return value as a JSON body to any URL. The route is a URL or `{ url, secret?, headers? }`; the defaults come from `channels.webhook`. Each request carries `X-Haze-Notification` (the type) and `X-Haze-Notification-Id`. With a `secret`, it is signed:

```
X-Haze-Timestamp: 1767225600
X-Haze-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
```

On the receiving side, `verifyWebhookSignature()` checks the signature and rejects timestamps more than five minutes old:

```ts
import { verifyWebhookSignature } from '@hazejs/core'

r.post('/hooks/haze', async (ctx) => {
  const body = await ctx.req.text()
  const valid = await verifyWebhookSignature({
    body,
    signature: ctx.header('x-haze-signature'),
    timestamp: ctx.header('x-haze-timestamp'),
    secret: env('NOTIFY_WEBHOOK_SECRET'),
  })
  // ...
})
```

`signatureHeader` and `timestampHeader` in `channels.webhook` rename the headers.

### WeCom, DingTalk and Feishu

`wecom` (WeCom group robot), `dingtalk` (DingTalk custom robot) and `feishu` (Feishu / Lark custom bot) share one message format:

```ts
toDingtalk: (_, { host }) => `${host} is down`, // text
toWecom: (_, { host }) => ({ text: `${host} is down`, atAll: true, atMobiles: ['13800000000'] }),
toFeishu: (_, { host }) => ({ markdown: `**${host}** is down`, title: 'Alert', atUserIds: ['ou_xxx'] }),
toDingtalk: () => ({ raw: { msgtype: 'actionCard', actionCard: { /* … */ } } }), // vendor payload as is
```

| Field | WeCom | DingTalk | Feishu |
|-------|-------|----------|--------|
| `text` | `text` message | `text` message | `text` message |
| `markdown` | `markdown` message | `markdown` message (`title` defaults to the first line) | Message card with a `markdown` element (`title` becomes the header) |
| `atAll` | `mentioned_list: ['@all']` | `at.isAtAll` | `<at user_id="all">` |
| `atUserIds` | `mentioned_list` | `at.atUserIds` | `<at user_id="…">` (open_id) |
| `atMobiles` | `mentioned_mobile_list` | `at.atMobiles` | — |
| `raw` | Sent as is | Sent as is | Sent as is |

The route is the robot's full webhook URL, or only its key (WeCom `key`, DingTalk `access_token`, Feishu hook ID), as a string or `{ url, secret? }`. Signing follows each vendor's documentation:

- **DingTalk** with a `secret` ("加签"): adds `timestamp` (milliseconds) and `sign` = URL-encoded Base64 of HMAC-SHA256 over `"<timestamp>\n<secret>"` to the URL.
- **Feishu** with a `secret` ("签名校验"): adds `timestamp` (seconds) and `sign` = Base64 of HMAC-SHA256 keyed with `"<timestamp>\n<secret>"` over an empty string to the body.
- **WeCom** robots have no signing; keep the key secret.

The robots answer HTTP 200 even for errors, so a non-zero `errcode` / `code` is turned into an exception (and retried when queued).

### Custom channels

Register a channel once, for example in a provider:

```ts
// app/provider/AppProvider.ts
import { defineProvider, registerNotificationChannel } from '@hazejs/core'

export default defineProvider({
  register() {
    registerNotificationChannel('sms', {
      async send({ route, message }, { config }) {
        await smsClient.send({ to: route, text: message, from: config.from })
      },
    })
  },
})
```

The notification then uses `via: () => ['sms']` and `toSms(user, payload)`. By default the message is the return value of `to<Channel>()` and the route comes from `routeNotificationFor(channel)`; implement `prepare(ctx)` to change that. `send` runs in the worker for queued notifications, so it receives only JSON data. `app.make(NotificationManager).extend(name, channel)` registers a channel for one application.

## Testing

`Notification.fake()` records notifications instead of sending them:

```ts
import { Notification } from '@hazejs/core'
import InvoicePaid from '~/app/notification/InvoicePaid'

it('notifies the customer', async () => {
  const notifications = Notification.fake()
  await t.post('/api/invoices/1/pay')

  notifications.assertSentTo(ada, InvoicePaid, sent => sent.payload.amount === 99 && sent.channels.includes('mail'))
  const [sent] = notifications.sentTo(ada, InvoicePaid)
  expect(await sent.message('mail')).toMatchObject({ subject: 'Payment received' })
})
```

| Assertion | Description |
|-----------|-------------|
| `assertSentTo(notifiable, definition, predicate?)` | Sent to this notifiable (or each one of an array). Objects with the same type and ID count as the same notifiable. |
| `assertNotSentTo(notifiable, definition, predicate?)` | Not sent to this notifiable. |
| `assertSentOnDemand(definition, predicate?)` | Sent with `Notification.route()`; `sent.notifiable.routes` holds the routes. |
| `assertSentTimes(definition, n)` | Sent exactly `n` times in total. |
| `assertNothingSentTo(notifiable)` / `assertNothingSent()` | Nothing was sent. |
| `assertCount(n)` | `n` notifications in total. |

Each record has `notifiable`, `payload`, `channels`, `queued` and `message(channel)`, which renders a channel's content. `Notification.restore()` removes the fake. To exercise real delivery, use `Mail.fake()`, `Broadcast.fake()` and `memoryNotificationStore()` instead.

## Limitations

- The database channel needs `@hazejs/orm` (or your own store). MongoDB has no store yet.
- Queued notifications render their content when sent; data that changes before the job runs is not re-read.
- Robot rate limits (for example 20 messages per minute for DingTalk and WeCom) are not handled; use queued notifications with backoff for bursts.
