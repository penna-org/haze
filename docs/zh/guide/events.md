# 事件

事件把"发生了什么"和"接下来要做什么"解耦。控制器只负责触发 `UserRegistered`，发送欢迎邮件、推送通知、更新统计等工作交给彼此独立的监听器，其中一些还可以放到 [队列](./queues) 里执行。

::: tip 目录约定
本页示例使用 API 模板的目录结构（`app/...`）。全栈项目中这些目录位于 `server/` 下。
:::

## 定义事件

`app/event/*.ts` 中每个文件默认导出一个用 `defineEvent<Payload>()` 创建的事件，文件名即事件名。

```bash
npx haze make:event UserRegistered
```

```ts
// app/event/UserRegistered.ts
import { defineEvent } from '@hazejs/core'

const UserRegistered = defineEvent<{ userId: number, email: string }>()

export default UserRegistered
```

需要自定义事件名时传入 `{ name }`：`defineEvent<P>({ name: 'user.registered' })`。没有载荷的事件（`defineEvent()`，载荷类型为 `void`）调用 `.emit()` 时不传参数。

| 选项 | 说明 |
| --- | --- |
| `name` | 事件名，默认取文件名 |
| `afterCommit` | 在数据库事务中触发时，等最外层事务提交后再执行监听器（与广播），回滚时丢弃，见[事务提交后触发](#after-commit) |
| `broadcastOn` / `broadcastAs` / `broadcastWith` / `broadcastWhen` | 同时广播事件，见[广播](./broadcasting) |

## 触发事件

```ts
// app/controller/AuthController.ts
import UserRegistered from '~/app/event/UserRegistered'

// 在 register() 中
await UserRegistered.emit({ userId: user.id, email: user.email })
```

也可以用 `Events` 门面（命名为 `Events` 是为了避免与全局的 `Event` 类型重名）：

```ts
import { Events } from '@hazejs/core'

await Events.emit(UserRegistered, { userId: user.id, email: user.email })
```

`emit()` 会等到所有同步监听器执行完、排队监听器投递完才返回。

监听器之间相互隔离：某个同步监听器抛错（或排队监听器投递失败）时，以 `error` 级别记录日志（带事件名与监听器名，如 `Listener "SendWelcomeEmail" failed`），其余监听器照常执行，`emit()` 不会失败。需要让调用方失败的检查请放在触发之前，或者不经过事件直接调用。

监听器在触发事件的应用的上下文中执行：其中的门面、`useApp()`、`config()` 与 `inject()` 解析到这个应用，在请求之外也是如此。

### 事务提交后触发 {#after-commit}

在数据库事务中触发的事件，监听器通常在提交之前就执行了，事务回滚时也照样执行。给事件加上 `afterCommit`，整个触发（同步监听器、排队监听器与广播）推迟到最外层事务提交之后，回滚时丢弃；不在事务中时立即触发：

```ts
// app/event/OrderPlaced.ts
export default defineEvent<{ orderId: number }>({ afterCommit: true })

// 在服务中
await Db.transaction(async () => {
  const order = await Order.create({ ... })
  await OrderPlaced.emit({ orderId: order.id }) // COMMIT 之后才执行监听器
})
```

只需推迟某一次触发时，包一层即可：`await afterCommit(() => OrderPlaced.emit({ orderId }))`（`@hazejs/core` 的 `afterCommit`，或 `@hazejs/orm` 的 `Db.afterCommit`）。推迟执行的监听器出错只记录日志，事务已经提交。需要 `@hazejs/orm`（见[事务](./transactions#after-commit)）；没有数据库包时立即触发。

## 定义监听器

`app/listener/*.ts` 中每个文件默认导出一个监听器，自动注册。

```bash
npx haze make:listener SendWelcomeEmail
```

模板为 `UserRegistered` 自带了两个监听器：

```ts
// app/listener/QueueWelcomeEmail.ts
import { defineListener } from '@hazejs/core'
import UserRegistered from '~/app/event/UserRegistered'
import SendWelcomeEmail from '~/app/job/SendWelcomeEmail'

// 耗时操作放到队列，不阻塞注册响应
export default defineListener(UserRegistered, ({ userId }) => SendWelcomeEmail.dispatch({ userId }))
```

```ts
// app/listener/BroadcastRegistration.ts
import { defineListener, Socket } from '@hazejs/core'
import UserRegistered from '~/app/event/UserRegistered'

// 推送给订阅了 users 的 WebSocket 连接（见 WebSocket 一节）
export default defineListener(UserRegistered, ({ userId }) => {
  Socket.publish('users', { type: 'user.registered', userId })
})
```

处理函数接收 payload 与一个上下文对象：

| 字段 | 说明 |
| --- | --- |
| `event` | 事件名 |
| `app` | 应用实例 |
| `logger` | 日志实例 |
| `attempt` | 排队执行时为第几次执行；同步执行时为 `1` |

一个监听器可以监听多个事件，此时 payload 为联合类型：

```ts
// app/listener/AuditLog.ts
import { defineListener } from '@hazejs/core'
import OrderPaid from '~/app/event/OrderPaid'
import OrderRefunded from '~/app/event/OrderRefunded'

export default defineListener([OrderPaid, OrderRefunded], async (payload, ctx) => {
  ctx.logger.info(`${ctx.event}: order ${payload.orderId}`)
})
```

### 执行顺序与中止

同步监听器按注册顺序依次执行：

1. [模块](./modules)的监听器，按模块启用的顺序；
2. 项目 `app/listener` 下的文件，按路径排序（`app/listener/a/X.ts` 先于 `app/listener/b/Y.ts`，可以用 `01-` 这样的文件名前缀明确顺序）；
3. 运行时用 `Events.on()` 注册的监听器，按注册顺序。

排队监听器在同一顺序中的位置投递。两个同名的监听器文件（例如 `app/listener/Audit.ts` 与 `app/listener/admin/Audit.ts`）会在启动时报错并给出两个文件，因为排队监听器注册为任务 `listener:<名字>`；请重命名其中一个或传入 `{ name }`。

返回 `false` 时，本次触发不再执行后续的同步监听器：

```ts
// app/listener/BlockSpam.ts —— 文件名排在其他监听器之前
import { defineListener } from '@hazejs/core'
import UserRegistered from '~/app/event/UserRegistered'

export default defineListener(UserRegistered, ({ email }) => {
  if (email.endsWith('@spam.test'))
    return false
})
```

::: warning
写成 `event => service.handle(event)` 的监听器会返回 `handle()` 的返回值；它可能是 `false`（布尔结果）时，会意外地中止后续的监听器。用代码块（`event => { service.handle(event) }`）或只 `await` 不返回。
:::

## 排队监听器

加上 `queue` 选项后，监听器会作为后台任务执行，而不是在 `emit()` 中同步执行：

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

`queue: true` 表示使用默认值。选项与 `defineJob` 一致（`tries`、`backoff`、`timeout`、`queue`、`connection`），另外多一个 `delay`。每个排队监听器会注册为名为 `listener:<名字>` 的队列任务，由 [队列消费进程](./queues#运行消费进程) 执行。

::: warning payload 经过 JSON 序列化
排队监听器拿到的 payload 经过了一次 JSON 序列化，模型实例会变成普通对象。建议触发时传 ID，在监听器中重新查询。
:::

## 运行时注册

`Events.on()` 在运行时注册同步监听器，例如在 [服务提供者](./container) 中。它返回一个取消注册的函数：

```ts
// app/provider/AppProvider.ts
import { defineProvider, Events } from '@hazejs/core'
import UserRegistered from '~/app/event/UserRegistered'

export default defineProvider({
  boot() {
    const off = Events.on(UserRegistered, ({ email }) => {
      console.log(`new user ${email}`)
    })
    // 调用 off() 取消注册
  },
})
```

## 测试

`Events.fake()` 只记录触发，不执行任何监听器。传入事件列表时只 fake 这些事件，其他事件照常执行。

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
  // 事件被 fake，监听器没有执行，任务也不会投递
  queue.assertNotDispatched(SendWelcomeEmail)
})
```

| 断言 | 说明 |
| --- | --- |
| `assertEmitted(event, predicate?)` | 至少触发过一次匹配的事件 |
| `assertNotEmitted(event, predicate?)` | 没有触发匹配的事件 |
| `assertEmittedTimes(event, times)` | 触发次数恰好为 `times` |

`Events.restore()` 取消 fake。测试客户端的用法见 [测试](./testing)。
