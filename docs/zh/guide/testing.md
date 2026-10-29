# 测试

`@hazejs/testing` 让应用直接在 [Vitest](https://vitest.dev) 中运行，不监听端口。每个用例都会得到一个全新的应用（与 `haze dev` 使用同一套 `config/`、`route/`、`app/`），一个用来发请求的客户端，以及队列、事件、邮件、存储、通知、广播、全文搜索和 AI 的 fake。

## 配置

新建的项目已经配置好测试，涉及的文件如下：

```ts
// vitest.config.ts
import { defineHazeTestConfig } from '@hazejs/testing/config'
import { defineConfig } from 'vitest/config'

export default defineConfig(defineHazeTestConfig())
```

`defineHazeTestConfig()` 注册 hazejs 的 Vite 插件（提供 `~` 别名与应用的模块图），并设置 Node 测试环境；传入的其它 Vitest 配置会被合并进去。插件会读取 `haze.config.ts`，所以 `srcDir: 'server'` 的全栈项目无需额外配置；需要给插件传参时放在 `haze` 字段下：

```ts
// vitest.config.ts（全栈项目）
import { defineHazeTestConfig } from '@hazejs/testing/config'
import { defineConfig } from 'vitest/config'

export default defineConfig(defineHazeTestConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
}))
```

### 环境变量

测试以 `test` 模式运行，环境文件按 `.env` → `.env.test` → `.env.test.local` 的顺序加载，后者覆盖前者。为了保证结果可复现，test 模式下不加载 `.env.local`。已经存在于真实环境中的变量始终优先。

模板自带的 `.env.test` 把数据库切换为内存中的 SQLite：

```ini
# .env.test
DATABASE_URL=:memory:
```

## 运行测试

```bash
haze test          # vitest run
pnpm test          # 同上，经 package.json 调用
haze test watch    # 参数原样透传给 Vitest
haze test run tests/auth.test.ts
```

`haze test` 设置 `NODE_ENV=test` 并运行项目中的 Vitest。不带参数时执行 `vitest run`，带参数时由这些参数替代默认的 `run`。

生成测试文件：

```bash
haze make:test user   # tests/user.test.ts
```

## 发送请求

`useTestApp()` 在每个用例前创建新应用、用例结束后释放。在文件顶部调用一次，然后在用例中使用返回的客户端：

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

客户端提供 `get(path, init?)`、`delete(path, init?)`、`post(path, body?, init?)`、`put(path, body?, init?)` 与 `patch(path, body?, init?)`：

- 对象以 JSON 发送，并带上 `content-type: application/json`；字符串、`FormData`、`URLSearchParams` 与 `Blob` 原样发送，上传文件用 `FormData`；
- `init` 是普通的 `RequestInit`，另外支持 `query`：`t.get('/api/users', { query: { page: 2 } })`；
- `withHeaders(headers)` 返回一个每次请求都带上这些请求头的新客户端。

每次调用都返回如下结构：

| 字段 | 说明 |
|------|------|
| `status` | HTTP 状态码 |
| `ok` | 2xx 时为 `true` |
| `headers` | `Headers` |
| `body` | 响应为 JSON 时是解析后的对象，否则为文本 |
| `text` | 原始响应文本 |

```ts
const me = await t.withHeaders({ authorization: `Bearer ${token}` }).get('/api/auth/me')
```

`useTestApp()` 返回的对象还提供 `t.app`（`Application` 实例）、`t.make(key)`（从容器解析服务），以及 `t.request(input, init?)`（fetch 风格的原始请求，返回 `Response`）。

### 替换服务

`override` 在提供者注册完成之后、应用启动之前执行，用来替换绑定：

```ts
const t = useTestApp({
  override: c => c.instance(PaymentGateway, new FakePaymentGateway()),
})
```

`createTestApp(options)` 是不依赖钩子的版本：返回同样的对象，但只对应一个应用，用完后需要自己调用它的 `close()` 释放。

## 认证

`actingAs(user, guard?)` 返回以 `user` 身份登录的客户端：JWT Guard 签发真实的令牌（放在 `Authorization` 头），Session Guard 生成真实的会话 Cookie。不指定 Guard 时使用 `config/auth.ts` 中的默认 Guard。

```ts
it('lets users update themselves', async () => {
  const ada = await User.create({ name: 'Ada', email: 'ada@example.com' })
  const asAda = await t.actingAs(ada)

  const res = await asAda.patch(`/api/users/${ada.id}`, { name: 'Ada Lovelace' })
  expect(res.body.data.name).toBe('Ada Lovelace')
})
```

使用 [API 令牌](./api-tokens)的 `token` Guard 时，`actingAs(user, 'token')` 会签发一个真实的个人访问令牌，拥有全部能力（`*`）。要测试能力检查，可以用 `issueTestCredentials()`（`actingAs()` 就是基于它实现的）签发只带指定能力的令牌：

```ts
import { issueTestCredentials } from '@hazejs/core'

it('rejects tokens without posts:write', async () => {
  const headers = await issueTestCredentials(t.app, ada, 'token', { abilities: ['posts:read'] })
  const res = await t.withHeaders(headers).post('/api/posts', { title: 'Hi' })
  expect(res.status).toBe(403)
})
```

Guard 的说明见[认证](./authentication)。

## 数据库

`@hazejs/orm` 的 `refreshDatabase()` 重建连接并执行迁移。配合 `.env.test` 中的 `DATABASE_URL=:memory:`，每个用例都从一个执行过迁移的全新数据库开始：

```ts
// tests/user.test.ts
import { refreshDatabase } from '@hazejs/orm'
import { useTestApp } from '@hazejs/testing'
import { beforeEach } from 'vitest'

const t = useTestApp()
beforeEach(() => refreshDatabase({ migrations: 'database/migrations' }))
```

选项有 `migrations`（相对工作目录，默认 `database/migrations`，全栈项目为 `server/database/migrations`）与 `connection`。MongoDB 连接没有迁移，会直接清空数据库。更多内容见[数据库](./database)。

### 模型工厂

`database/factories` 中的[模型工厂](./factories)生成带有逼真数据的测试数据，用例中只需写出关心的字段：

```ts
import UserFactory from '~/database/factories/UserFactory'

it('only lets users change themselves, unless they are admins', async () => {
  const [ada, bob] = await UserFactory.createMany([{ name: 'Ada' }, { name: 'Bob' }])
  const admin = await UserFactory.state('admin').create()
  // ...
})
```

`UserFactory.raw()` 只返回属性对象，适合作为请求体：`await t.post('/api/users', await UserFactory.raw())`。假数据来自 `@faker-js/faker`（模板中已作为开发依赖安装）。

::: tip 测试中的读写分离
`refreshDatabase()` 只对写库执行迁移。测试连接不要配置 `read` / `write`（`.env.test` 通常把 `DATABASE_URL` 设为 `:memory:`），或者让副本指向同一个数据库。
:::

## Fake

fake 只记录代码做了什么，而不真正执行。fake 属于当前应用，而 `useTestApp()` 每个用例都会创建新应用，因此不会泄漏到其它用例。请在用例内创建 fake，或者放在 `useTestApp()` 之后注册的 `beforeEach` 中。

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

    // 执行记录下来的任务；Mail.fake() 只记录邮件、不投递
    const mail = Mail.fake()
    await queue.drain()
    mail.assertSent(WelcomeMail, sent => MailFake.hasRecipient(sent, ada.email))
  })

  it('emits UserRegistered', async () => {
    const events = Events.fake([UserRegistered])
    const res = await t.post('/api/auth/register', ada)
    events.assertEmitted(UserRegistered, payload => payload.userId === res.body.data.user.id)
    // 事件被 fake 后监听器不执行，任务也不会投递
    queue.assertNotDispatched(SendWelcomeEmail)
  })
})
```

| Fake | 断言与辅助方法 |
|------|----------------|
| `Queue.fake()` | `assertDispatched(job, predicate?)`、`assertNotDispatched(job, predicate?)`、`assertCount(n)`；`drain()` 按投递顺序执行已记录的任务（忽略延迟）；`dispatched` |
| `Events.fake(events?)` | `assertEmitted(event, predicate?)`、`assertNotEmitted(event, predicate?)`、`assertEmittedTimes(event, n)`；`emitted`。传入列表时只 fake 这些事件 |
| `Mail.fake()` | `assertSent`、`assertNotSent`、`assertSentTimes`、`assertQueued`、`assertNotQueued`、`assertNothingSent`、`assertNothingQueued`；`MailFake.hasRecipient(mail, address)` |
| `Storage.fake(disk?)` | `assertExists`、`assertMissing`、`assertCount`、`assertDirectoryEmpty`（均为异步）；上传示例见[文件存储](./storage#测试) |
| `Notification.fake()` | `assertSentTo(notifiable, notification, predicate?)`、`assertNotSentTo`、`assertSentOnDemand`、`assertSentTimes`、`assertNothingSentTo`、`assertNothingSent`、`assertCount`；`sentTo(notifiable, notification)` 返回发送记录，记录的 `message(channel)` 可以渲染出各渠道的内容 |
| `Broadcast.fake()` | `assertBroadcast(event, predicate?)`、`assertBroadcastOn(channel, event?, predicate?)`、`assertNotBroadcast`、`assertBroadcastTimes`、`assertNothingBroadcast`；`broadcasts` |

任务既可以按定义匹配，也可以按名称匹配，例如 `queue.assertDispatched('mail:send')`。每个门面都有对应的 `restore()`（`Queue.restore()`、`Events.restore()`、`Mail.restore()`、`Storage.restore()`、`Notification.restore()`、`Broadcast.restore()`）。各功能页面有更详细的说明：[队列](./queues)、[事件](./events)、[邮件](./mail#测试)、[文件存储](./storage#测试)、[通知](./notifications#测试)、[广播](./broadcasting#测试)。

### 其它扩展包

可选的扩展包也提供了类似的测试手段：

- **全文搜索**：`@hazejs/search` 的 `Search.fake()` 把所有引擎替换为同一个内存引擎，同步时也不经过队列。返回的引擎可以读取已写入的文档：`engine.documents('posts')`。详见[全文搜索](./search#测试)。
- **AI**：`@hazejs/ai` 的 `AI.fake(replies)` 按顺序返回预设的回复，请求不会离开进程；模板中的 `tests/chat.test.ts` 就是这样写的。详见 [AI](./ai#测试)。
- **微服务**：没有 fake，改用进程内的 `memory` 传输即可（例如配置文件读取 `MICROSERVICE_TRANSPORT` 时，在 `.env.test` 中设为 `memory`），在用例中调用 `listenMicroservices(t.app)`，再通过 `t.make(MicroserviceManager).client()` 发送消息。详见[微服务](./microservices#测试)。
- **第三方登录**：把 OAuth 配置的 `fetch` 选项换成进程内的假实现，测试时就不会访问真实的平台。详见[第三方登录](./oauth#测试)。

## 连接真实服务测试

fake 与内存驱动让默认的测试套件既快又不依赖网络。需要针对真实的 Redis、S3、SMTP 等做集成测试时，可以利用“真实环境变量优先于 `.env.test`”这一点：在 CI 中启动服务并导出配置读取的变量，本地没有这些变量时跳过对应用例。

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
# .github/workflows/test.yml（节选）
services:
  redis:
    image: redis:7
    ports: ['6379:6379']
env:
  QUEUE_CONNECTION: redis
  REDIS_URL: redis://localhost:6379
```

上面的变量名来自项目模板的 `config/*.ts`，请以自己配置文件中读取的变量为准。
