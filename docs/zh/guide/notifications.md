# 通知

通知是发给用户的一条简短消息，比如"账单已支付""部署失败了"。它只需定义一次，就能经多个渠道发送：邮件、数据库（站内信）、[广播](./broadcasting)、Slack、通用 Webhook，以及企业微信、钉钉、飞书的群机器人。通知可以立即发送，也可以经[队列](./queues)发送；测试时用 `Notification.fake()` 断言即可。

```ts
await notify(user, InvoicePaid({ amount: 99 }))
```

::: tip 路径
本页示例使用 API 模板的目录结构（`app/...`、`config/...`）。全栈项目中这些目录位于 `server/` 下。
:::

## 定义通知

通知放在 `app/notification/*.ts`，也可以用 `haze make:notification InvoicePaid` 生成：

```ts
// app/notification/InvoicePaid.ts
import type { User } from '~/app/model/User'
import { defineNotification, html, mailLayout } from '@hazejs/core'

export default defineNotification<{ amount: number }, User>({
  via: user => user.wantsSlack ? ['mail', 'database', 'slack'] : ['mail', 'database'],
  toMail: (user, { amount }) => ({
    subject: '已收到付款',
    html: mailLayout({ body: html`<p>${user.name}，你好：已收到 ${amount} 元。</p>` }),
  }),
  toDatabase: (user, { amount }) => ({ amount }),
  toSlack: (user, { amount }) => `${user.name} 支付了 ${amount} 元`,
})
```

- 两个类型参数分别是数据（payload）和通知对象（通常是 `User` 模型）。
- `via(notifiable, payload)` 返回要使用的渠道。每个渠道调用对应的 `to<渠道>(notifiable, payload)`：`toMail`、`toDatabase`、`toBroadcast`、`toSlack`、`toWebhook`、`toWecom`、`toDingtalk`、`toFeishu`，自定义的 `sms` 渠道则是 `toSms`。
- `database` 与 `broadcast` 没有各自的方法时，共用 `toArray`。
- 文件名就是通知的**类型**（`InvoicePaid`），会写入数据库、推送到浏览器。用 `name` 选项可以改名。

经某个渠道发送、却没有定义对应方法时会直接报错，拼写错误在第一次发送时就能发现。

## 发送

带上数据调用通知定义，再发送：

```ts
import { notify, Notification } from '@hazejs/core'
import InvoicePaid from '~/app/notification/InvoicePaid'

await notify(user, InvoicePaid({ amount: 99 }))
await Notification.send([ada, bob], InvoicePaid({ amount: 99 })) // 多个通知对象
await Notification.sendNow(user, InvoicePaid({ amount: 99 })) // 忽略 queue 设置
await Notification.sendNow(user, InvoicePaid({ amount: 99 }), ['database']) // 只发这些渠道
```

每个通知对象有自己的通知 ID，它的各个渠道共用这个 ID。

### 按需发送

通知的对象不是用户时（运维邮箱、团队群聊），直接给出地址：

```ts
await Notification.route('mail', 'ops@example.com')
  .route('dingtalk', { url: env('DINGTALK_WEBHOOK'), secret: env('DINGTALK_SECRET') })
  .notify(ServerDown({ host: 'web-1' }))
```

没有地址的渠道会被跳过；数据库渠道也会跳过，因为没有通知对象的 ID。

### 通知对象

任何对象都可以接收通知。hazejs 会读取：

| 成员 | 用途 |
|------|------|
| `routeNotificationFor(channel, notification)` | 某个渠道的地址：邮箱、Webhook URL、广播频道名……返回 `undefined` 时使用默认值。 |
| `email` / `name` | 默认的邮件收件人。 |
| `getKey()` 或 `id` | 通知对象的 ID（数据库与广播渠道使用）。 |
| `notifiableType`（实例或静态属性） | 通知对象的类型，默认为类名（`User`）；普通对象默认为 `User`。 |

对于[模型](./models)，用户有自己的 Webhook 时，在类中加上 `routeNotificationFor`：

```ts
// app/model/User.ts
export class User extends Model.define(users) {
  routeNotificationFor(channel: string) {
    if (channel === 'slack')
      return this.slackWebhookUrl ?? undefined
  }
}
```

类名在运行时读取，如果生产构建会压缩类名，请显式写上 `notifiableType`（`static notifiableType = 'User'`）。

## 排队发送

设置 `queue` 后经队列发送。每个渠道是一个独立的任务（`notification:send`），Slack 调用失败重试时不会把邮件再发一遍：

```ts
export default defineNotification<{ amount: number }>({
  via: () => ['mail', 'slack'],
  queue: true, // 或 { connection: 'redis', queue: 'notifications', delay: '1m' }
  // ...
})
```

各渠道的内容在发送时就渲染好，任务以 JSON 携带渲染后的内容与地址。因此 worker 端不需要通知定义，payload 中也可以直接传模型。重试使用 `config/notification.ts` 的 `queue` 设置（默认 3 次，退避 `[10, 60]` 秒）。

## 配置

`config/notification.ts` 中放各渠道的默认值：共用的 Webhook 地址、签名密钥、数据库存储。

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

| 选项 | 说明 |
|------|------|
| `channels.<name>` | 渠道的默认值。通知对象自己的地址始终优先。 |
| `channels.mail.mailer` | 通知邮件使用的邮件驱动。 |
| `channels.database.store` | 存储，或返回存储的函数。 |
| `channels.broadcast.event` | 浏览器收到的事件名，默认 `notification`。 |
| `channels.<webhook>.timeout` | 请求超时（毫秒），默认 10 000。 |
| `queue` | 排队发送使用的 `{ connection?, queue?, tries?, backoff? }`。 |

## 渠道

### 邮件

`toMail` 的返回值与[邮件定义](./mail#定义邮件)相同（`subject`、`html`、`text`、`attachments` 等），另外可以指定 `to` 与 `mailer`。收件人默认取 `routeNotificationFor('mail')`，其次是通知对象的 `email` 与 `name`。想复用已有的邮件，渲染它即可：`toMail: user => WelcomeMail.render({ name: user.name })`。邮件经配置的邮件驱动发送，`Mail.fake()` 同样会记录。

### 数据库

数据库渠道把通知存下来，用作站内信。先生成表结构，再执行迁移：

```sh
npx haze make:notifications-table   # database/schema/notifications.ts（sqlite、postgres 或 mysql）
npx haze db:generate && npx haze db:migrate
```

把 `channels.database.store` 指向这张表（见[配置](#配置)），然后这样读取：

```ts
import { markAllAsRead, markAsRead, Notification, unreadNotifications } from '@hazejs/core'

const unread = await unreadNotifications(user) // 最新的在前
const page = await Notification.notifications(user, { limit: 20, offset: 0 })
const count = await Notification.unreadCount(user)
await markAsRead(unread[0]) // 记录、ID 或它们的数组
await markAllAsRead(user)
```

每条记录为 `{ id, type, notifiableType, notifiableId, data, readAt, createdAt }`，`data` 即 `toDatabase` 的返回值。查询选项有 `unread`、`type`、`limit` 和 `offset`。存储只是一个很小的接口（`insert`、`list`、`count`、`markAsRead`、`markAsUnread`、`markAllAsRead`、`delete`），也可以自己实现；测试中用 `memoryNotificationStore()` 很方便。

### 广播

广播渠道把通知推送到通知对象的私有频道 `private-<类型>.<ID>`（例如 `private-User.1`），事件名为 `notification`。数据为 `toBroadcast`（或 `toArray` / `toDatabase`）的返回值，再加上 `id` 与 `type`：

```ts
// app/channel/user.ts
export default defineChannels((c) => {
  c.private('User.{id}', (user: User, { id }) => user.id === Number(id))
})

// 浏览器
echo.private(`User.${user.id}`).notification(({ type, id, ...data }) => showToast(data))
```

想推送到其他频道，在 `routeNotificationFor('broadcast')` 中返回频道名（可以是多个）。客户端用法见[广播](./broadcasting)。

### Slack

发到 Slack 的 [Incoming Webhook](https://api.slack.com/messaging/webhooks)。`toSlack` 返回字符串（即 `text`），或者包含 `text`、`blocks`、`attachments`、`thread_ts` 等字段的消息对象。地址取 `routeNotificationFor('slack')` 或 `channels.slack.url`。

### Webhook

把 `toWebhook` 的返回值作为 JSON 请求体 POST 到任意地址。地址可以是 URL，也可以是 `{ url, secret?, headers? }`，默认值取 `channels.webhook`。每个请求都带有 `X-Haze-Notification`（类型）与 `X-Haze-Notification-Id`。设置了 `secret` 时附带签名：

```
X-Haze-Timestamp: 1767225600
X-Haze-Signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<body>")>
```

接收方用 `verifyWebhookSignature()` 校验签名，时间戳相差超过五分钟的请求会被拒绝：

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

`channels.webhook` 中的 `signatureHeader` 与 `timestampHeader` 可以修改这两个请求头的名字。

### 企业微信、钉钉与飞书

`wecom`（企业微信群机器人）、`dingtalk`（钉钉自定义机器人）和 `feishu`（飞书自定义机器人）使用同一种消息格式：

```ts
toDingtalk: (_, { host }) => `${host} 宕机了`, // 文本
toWecom: (_, { host }) => ({ text: `${host} 宕机了`, atAll: true, atMobiles: ['13800000000'] }),
toFeishu: (_, { host }) => ({ markdown: `**${host}** 宕机了`, title: '告警', atUserIds: ['ou_xxx'] }),
toDingtalk: () => ({ raw: { msgtype: 'actionCard', actionCard: { /* … */ } } }), // 原样发送厂商的消息体
```

| 字段 | 企业微信 | 钉钉 | 飞书 |
|------|----------|------|------|
| `text` | `text` 消息 | `text` 消息 | `text` 消息 |
| `markdown` | `markdown` 消息 | `markdown` 消息（`title` 默认取第一行） | 带 `markdown` 元素的消息卡片（`title` 作为卡片标题） |
| `atAll` | `mentioned_list: ['@all']` | `at.isAtAll` | `<at user_id="all">` |
| `atUserIds` | `mentioned_list` | `at.atUserIds` | `<at user_id="…">`（open_id） |
| `atMobiles` | `mentioned_mobile_list` | `at.atMobiles` | — |
| `raw` | 原样发送 | 原样发送 | 原样发送 |

地址可以是机器人完整的 Webhook URL，也可以只给 key（企业微信的 `key`、钉钉的 `access_token`、飞书的 hook ID），写成字符串或 `{ url, secret? }`。签名按各厂商的文档实现：

- **钉钉**设置了 `secret`（加签）时：在 URL 上附加 `timestamp`（毫秒）与 `sign`，`sign` 为对 `"<timestamp>\n<secret>"` 做 HMAC-SHA256 后的 Base64，再经 URL 编码。
- **飞书**设置了 `secret`（签名校验）时：在请求体中附加 `timestamp`（秒）与 `sign`，`sign` 为以 `"<timestamp>\n<secret>"` 为密钥、对空字符串做 HMAC-SHA256 后的 Base64。
- **企业微信**机器人没有签名机制，请妥善保管 key。

机器人出错时也返回 HTTP 200，所以 `errcode` / `code` 不为 0 时会转为异常（排队发送时会重试）。

### 自定义渠道

注册一次渠道即可，例如在服务提供者中：

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

之后在通知中使用 `via: () => ['sms']` 和 `toSms(user, payload)`。默认情况下，内容为 `to<渠道>()` 的返回值，地址取 `routeNotificationFor(channel)`；实现 `prepare(ctx)` 可以改变这一行为。排队发送时 `send` 在 worker 中执行，只能拿到 JSON 数据。`app.make(NotificationManager).extend(name, channel)` 只为当前应用注册渠道。

## 测试

`Notification.fake()` 只记录通知，不实际发送：

```ts
import { Notification } from '@hazejs/core'
import InvoicePaid from '~/app/notification/InvoicePaid'

it('notifies the customer', async () => {
  const notifications = Notification.fake()
  await t.post('/api/invoices/1/pay')

  notifications.assertSentTo(ada, InvoicePaid, sent => sent.payload.amount === 99 && sent.channels.includes('mail'))
  const [sent] = notifications.sentTo(ada, InvoicePaid)
  expect(await sent.message('mail')).toMatchObject({ subject: '已收到付款' })
})
```

| 断言 | 说明 |
|------|------|
| `assertSentTo(notifiable, definition, predicate?)` | 发给了这个通知对象（数组时为每一个）。类型与 ID 相同的对象视为同一个通知对象。 |
| `assertNotSentTo(notifiable, definition, predicate?)` | 没有发给这个通知对象。 |
| `assertSentOnDemand(definition, predicate?)` | 经 `Notification.route()` 按需发送过；`sent.notifiable.routes` 为各渠道的地址。 |
| `assertSentTimes(definition, n)` | 总共恰好发送了 `n` 次。 |
| `assertNothingSentTo(notifiable)` / `assertNothingSent()` | 没有发送任何通知。 |
| `assertCount(n)` | 总共 `n` 条通知。 |

每条记录包含 `notifiable`、`payload`、`channels`、`queued`，以及渲染某个渠道内容的 `message(channel)`。`Notification.restore()` 取消 fake。想测试真实的投递，可以改用 `Mail.fake()`、`Broadcast.fake()` 和 `memoryNotificationStore()`。

## 限制

- 数据库渠道需要 `@hazejs/orm`（或自己实现的存储），暂不支持 MongoDB。
- 排队发送的内容在发送时渲染，任务执行前数据发生的变化不会体现。
- 不处理机器人的频率限制（例如钉钉、企业微信每个机器人每分钟 20 条），突发消息请使用排队发送并设置退避。
