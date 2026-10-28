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

需要自定义事件名时传入 `{ name }`：`defineEvent<P>({ name: 'user.registered' })`。

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

`emit()` 会等到所有同步监听器执行完、排队监听器投递完才返回。同步监听器抛出的错误会传给触发方。

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

同步监听器按文件名顺序依次执行。返回 `false` 时，本次触发不再执行后续的同步监听器：

```ts
// app/listener/BlockSpam.ts —— 文件名排在其他监听器之前
import { defineListener } from '@hazejs/core'
import UserRegistered from '~/app/event/UserRegistered'

export default defineListener(UserRegistered, ({ email }) => {
  if (email.endsWith('@spam.test'))
    return false
})
```

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
