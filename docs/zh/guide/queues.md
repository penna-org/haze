# 队列

队列用来把耗时的工作（发邮件、生成报表、调用 Webhook）移出请求。在 hazejs 中，任务是用 `defineJob` 定义的普通对象：自动发现，用 `.dispatch()` 投递，由进程内队列、Redis 消费进程（BullMQ）、数据库消费进程或 Cloudflare Queues 执行。在任何驱动之上，都可以组成任务链、批量执行并跟踪进度、声明唯一任务，以及用中间件包住任务（例如限流）。

::: tip 目录约定
本页示例使用 API 模板的目录结构（`app/...`、`config/...`）。全栈项目中这些目录位于 `server/` 下。
:::

## 定义任务

`app/job/*.ts` 中每个文件默认导出一个任务，文件名即任务名。用命令生成：

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
  tries: 3, // 最多执行 3 次
  backoff: [10, 60], // 第 2 次前等 10 秒，第 3 次前等 60 秒
  timeout: '30s',
  queue: 'emails',
  async handle(payload: SendInvoicePayload, job) {
    job.logger.info(`Sending invoice ${payload.invoiceId} (attempt ${job.attempt})`)
    await sendInvoice(payload.invoiceId, { signal: job.signal })
  },
  // 全部重试都失败后调用
  async failed(payload, error, job) {
    job.logger.error(`Invoice ${payload.invoiceId} failed`, error)
  },
})

export default SendInvoice
```

| 选项 | 说明 |
| --- | --- |
| `name` | 任务名，默认取文件名 |
| `tries` | 最多执行次数，默认 `1`（不重试） |
| `backoff` | 重试前等待：秒数、`'5m'`、按重试次数取值的数组（不足时取最后一个），或 `'exponential'`（2^n 秒）。默认 `0` |
| `timeout` | 秒数或 `'30s'`；超时视为失败，并中止 `job.signal` |
| `queue` | 队列名，默认 `default` |
| `connection` | `config/queue.ts` 中的连接，默认取其 `default` |
| `unique` | `true` 或 `{ key, for, until }`：同一任务已在队列中时跳过本次投递，见[唯一任务](#unique-jobs) |
| `middleware` | 任务中间件，例如 `rateLimited(...)`，见[任务中间件](#job-middleware) |
| `handle(payload, job)` | 任务逻辑 |
| `failed(payload, error, job)` | 最后一次失败后调用 |

### 任务上下文

`handle` 的第二个参数、`failed` 的第三个参数是 `JobContext`：

| 字段 | 说明 |
| --- | --- |
| `id` | 任务 ID |
| `name` | 任务名 |
| `attempt` | 第几次执行，从 1 开始 |
| `queue` | 队列名 |
| `logger` | 带任务信息的日志实例 |
| `app` | 应用实例 |
| `signal` | 超时时触发的 `AbortSignal` |
| `release(delay?)` | 放回队列，`delay`（秒数或 `'30s'`，默认 0）后再执行。不算失败，也不消耗执行次数 |
| `batch()` | 任务所属的[批次](#batches)（执行前读取的快照），不属于批次时为 `undefined` |

## 投递任务

```ts
import SendInvoice from '~/app/job/SendInvoice'

await SendInvoice.dispatch({ invoiceId: 42 })
await SendInvoice.dispatch({ invoiceId: 42 }, { delay: '10m' })
await SendInvoice.dispatch({ invoiceId: 42 }, { queue: 'high', connection: 'redis' })
```

`dispatch()` 返回任务 ID。payload 以 JSON 传递，建议传 ID，不要传模型实例。

`Job.with(payload)` 得到待投递的任务：任务链、批量与回调都用它，也可以直接投递。它的 `dispatch()` 返回 `{ id, skipped }`，`skipped` 表示[唯一任务](#unique-jobs)已在队列中：

```ts
const { id, skipped } = await SendInvoice.with({ invoiceId: 42 }).onQueue('high').delay('1m').dispatch()
```

`Queue` 门面可以按任务定义或已注册的名字投递，另外还有几个辅助方法：

```ts
import { Queue } from '@hazejs/core'

await Queue.dispatch(SendInvoice, { invoiceId: 42 }, { delay: 30 })
await Queue.dispatch('SendInvoice', { invoiceId: 42 })

await Queue.failed() // 默认连接上的失败任务
await Queue.retry() // 重新投递全部失败任务（也可传 id）
await Queue.idle() // 等待 memory 队列清空
```

## 连接

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
      // config/redis.ts 中的连接（默认为其 default 连接）
      connection: 'default',
      queues: ['default', 'emails'],
    },
    database: { driver: 'database', connection: 'main' },
    cloudflare: { driver: 'cloudflare', binding: 'QUEUE' },
  },
  // 唯一任务的锁与任务中间件使用的缓存存储（默认为默认存储）
  store: 'redis',
  // 批次状态的存储与保留时间
  batches: { store: 'redis', ttl: '7d' },
  // 包住每个任务的中间件
  middleware: [],
}))
```

| 驱动 | 行为 |
| --- | --- |
| `sync` | 在 `dispatch()` 中立即执行，失败直接抛给调用方，不重试 |
| `memory` | 进程内队列，由当前进程消费（`concurrency`，默认 1），用计时器处理延迟与退避；进程退出时任务丢失。没有 `config/queue.ts` 时的默认值 |
| `redis` | BullMQ（`pnpm add bullmq ioredis`）。选项：`connection`（[Redis 连接](./redis)，默认为 `default` 连接；BullMQ 拿到去掉 `keyPrefix` 的连接设置，自己建立连接）、`url`（内联地址，优先）、`prefix`（默认 `haze`，BullMQ 使用的键前缀）、`queues`（`queue:failed` / `queue:retry` 遍历的队列，默认 `['default']`）、`keepCompleted`（默认 1000）。需要单独的消费进程 |
| `database` | SQL 数据库中的一张表，由 `@hazejs/orm` 提供，见[数据库驱动](#database-driver)。需要单独的消费进程 |
| `cloudflare` | Cloudflare Queues 生产者绑定（`binding`，默认 `QUEUE`），由 Worker 的 `queue()` 消费。延迟上限 12 小时 |

顶层选项：

| 选项 | 说明 |
| --- | --- |
| `store` | 唯一任务的锁与任务中间件的状态使用的缓存存储（`config/cache.ts`），默认为默认存储。必须支持原子操作：使用 `redis`（单进程时也可以用 `memory`）；`kv` 这类非原子存储会记一条警告 |
| `batches.store` | 批次状态的缓存存储，默认为 `store` |
| `batches.ttl` | 批次状态的保留时间，默认 `'7d'` |
| `middleware` | 全局任务中间件，在各任务自己的 `middleware` 之前执行 |

任务链、批量、唯一任务与中间件都在队列管理器中实现，在所有驱动上的行为相同。

### 数据库驱动 {#database-driver}

`database` 驱动把任务存放在 SQL 数据库的一张表中（SQLite、libsql / Turso、D1、PostgreSQL 或 MySQL 8），适合已经有数据库、不想再部署 Redis 的项目。驱动由 `@hazejs/orm` 提供，`databaseProvider()` 负责注册。

1. 生成表结构：写入 `database/schema/queue.ts`（`jobs` 与 `failed_jobs`），并运行 `haze db:generate`：

   ```bash
   npx haze make:queue-tables
   npx haze db:migrate
   ```

2. 添加连接：

   ```ts
   // config/queue.ts
   connections: {
     database: {
       driver: 'database',
       connection: 'main', // config/database.ts 中的连接，默认为其 default 连接
       table: 'jobs',
       failedTable: 'failed_jobs',
       retryAfter: '90s',
     },
   }
   ```

3. 运行消费进程：`npx haze queue:work --connection database`（构建后为 `node dist/server/worker.mjs queue --connection database`）。

| 选项 | 说明 |
| --- | --- |
| `connection` | 数据库连接，默认为 `config/database.ts` 的 default 连接 |
| `table` / `failedTable` | 表名，默认 `jobs` / `failed_jobs` |
| `retryAfter` | 领取后超过这么久仍未完成的任务，视为 worker 已崩溃，可以被重新领取。默认 `'90s'`。要大于任务的 `timeout`，否则执行较慢的任务会被执行两次 |
| `sleep` | 空闲时的轮询间隔：秒数（可以是小数）或 `'1s'`，默认 1 秒。队列持续为空时间隔加倍，直到 `maxSleep` |
| `maxSleep` | 空闲轮询间隔的上限，默认为 `sleep` 的 5 倍 |

工作方式：

- **领取。** PostgreSQL 与 MySQL 8 上，worker 在事务中执行 `SELECT … FOR UPDATE SKIP LOCKED`，然后把这一行标记为已领取（写入 `reserved_at`，`attempts + 1`），并发的 worker 会跳过被锁住的行。SQLite、libsql、Turso 与 D1 上用一条原子的 `UPDATE … WHERE id = (SELECT … LIMIT 1) RETURNING *` 完成同样的事。
- **延迟与重试**都通过 `available_at` 实现。重试的行以更晚的 `available_at` 放回；`job.release()` 放回的任务重新插入一行，不消耗执行次数。
- **worker 崩溃。** 领取超过 `retryAfter` 的行会被重新领取。worker 只删除或放回仍带着自己 `reserved_at` 的行，执行较慢的 worker 不会删掉已被别人接手的行。已用完执行次数的任务直接移入 `failed_jobs`，不再执行。
- **失败任务**写入 `failed_jobs`（`uuid`、`connection`、`queue`、`payload`、`exception`、`failed_at`）。`queue:failed`、`queue:retry`、`queue:forget`、`queue:flush`、队列面板与 `queueCheck()` 的用法与 Redis 相同。
- **轮询。** 每个 worker 一个循环：执行中的任务少于 `concurrency` 时继续领取。同一进程内的投递会立即唤醒它。收到 `SIGTERM` 时停止领取，并等待执行中的任务完成。
- **多租户。** 所有查询都在中央（无租户）上下文中执行：即使每个租户有独立的数据库，队列表也位于中央库中。任务的租户照常由消息携带。

::: warning Edge 运行时
在 Cloudflare Workers 等 Serverless 平台上，可以通过 Turso 或 D1 投递任务；但消费需要常驻的 worker（在服务器上运行 `haze queue:work` 或 `worker.mjs queue`），Worker 的 `fetch` 无法持续轮询。需要由平台消费任务时，请在 Cloudflare 上使用 `cloudflare` 驱动。
:::

## 任务链

任务链依次执行任务：前一个任务成功（包括重试后成功）后才投递下一个。某个任务最终失败时，丢弃剩余的任务并执行 `catch` 回调。

```ts
import { Queue } from '@hazejs/core'

await Queue.chain([
  ProcessVideo.with({ id }),
  Publish.with({ id }),
  Notify.with({ id }).onQueue('emails'), // 任务自己的选项优先于链的默认值
])
  .onConnection('redis')
  .onQueue('media')
  .catch(Cleanup.with({ id }))
  .dispatch() // { id, skipped, chainId }
```

剩余的任务（任务名与 payload）随消息传递，因此任何驱动都可以使用，任何 worker 都能把链接着执行下去。任务链与批次的 ID 会显示在开发面板和失败任务中。

### 回调：任务或函数

`catch`（以及批次的 `then` / `finally`）接受两种回调：

- **任务引用**，例如 `Cleanup.with({ id })`：回调触发时投递该任务，所有连接都可以使用。
- **函数**，例如 `error => log(error)`：函数无法序列化进队列消息，只有投递任务链的进程同时也执行这些任务时才能使用，即 `sync` 与 `memory` 连接。其它连接上 `dispatch()` 会直接抛错，提示改用任务引用。这是有意为之：函数在远程 worker 上被悄悄丢掉，比在调用处报错更糟。

## 批量任务 {#batches}

批量任务一次投递多个任务，并把它们当作一组跟踪：

```ts
const batch = await Queue.batch([
  ImportCsv.with({ file: 'a.csv' }),
  ImportCsv.with({ file: 'b.csv' }),
])
  .name('import')
  .allowFailures()
  .then(NotifyImported.with({ userId })) // 全部成功
  .catch(ReportImportError.with({ userId })) // 第一个任务失败
  .finally(CleanupUploads.with({ userId })) // 全部执行完
  .dispatch()

batch.id
const current = await Queue.findBatch(batch.id)
// { total, pending, processed, failed, progress, finished, cancelled, createdAt, finishedAt, failedJobIds, ... }
```

| 字段 | 说明 |
| --- | --- |
| `total` | 任务总数，包括之后追加的 |
| `pending` | 尚未结束的任务数 |
| `processed` | 已结束且没有失败的任务数，包括取消后被跳过的 |
| `failed` | 最终失败的任务数，ID 在 `failedJobIds` 中 |
| `progress` | 已结束任务的百分比，0–100 |
| `finished` / `finishedAt` | 全部任务都已结束 |
| `cancelled` / `cancelledAt` | 批次已被取消 |
| `createdAt` | 投递时间 |

用 `await batch.cancel()` 取消批次，`await batch.add([...])` 追加任务（批次结束后调用会抛错），`await batch.fresh()` 重新读取状态。任务中 `job.batch()` 返回它所属的批次，可以追加任务或检查是否已取消：

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

规则：

- 默认第一个失败即取消批次，尚未开始的任务被跳过（计入 processed）。使用 `allowFailures()` 时每个任务都会执行。
- `catch` 在第一个任务失败时执行一次；`then` 在全部任务结束、没有失败也没有取消时执行一次；`finally` 在全部任务结束时执行一次，不论结果如何。
- 状态保存在 `batches.store` 的缓存存储中，计数使用存储的原子自增。让已结束计数达到总数的那个 worker 用 `add()` 写入“已完成”标记，只有写入成功的 worker 执行 `then` / `finally`，因此即使有很多 worker 并发，回调也只执行一次。
- 有多个进程时，存储必须是共享且支持原子操作的，请使用 `redis`；`memory` 与 `sync` 连接用默认的 `memory` 存储即可。存储不支持原子操作时（例如 `kv`）会记一条警告。
- 批次中的任务忽略 `unique`；暂不支持在批次中放入任务链。

## 唯一任务 {#unique-jobs}

同一任务（与键）已在队列中或正在执行时，唯一任务的投递会被跳过：

```ts
export default defineJob({
  unique: {
    key: (payload: { feedId: number }) => String(payload.feedId), // 默认：同一任务名只允许一个
    for: '1h', // 锁的有效期，默认 '1d'
    until: 'processed', // 或 'processing'
  },
  async handle(payload) { /* ... */ },
})

const { skipped } = await SyncFeed.with({ feedId: 1 }).dispatch()
await SyncFeed.dispatch({ feedId: 1 }) // 返回已在队列中的任务 ID
```

投递时，hazejs 以任务名与键为名在缓存中取锁（`config/queue.ts` 的 `store`），持有者为消息 ID。锁被占用时不会入队：`Job.with(...).dispatch()` 返回 `{ skipped: true }`，`Job.dispatch()` 返回持有锁的任务 ID。锁在以下时机释放：

- 任务开始执行时，`until: 'processing'`（“执行前唯一”）；
- 任务执行结束时，`until: 'processed'`（默认），包括最终失败，但不包括重试与 release；
- 超过 `for` 后自动过期；
- 投递本身失败时。

键按当前租户隔离。

## 任务中间件 {#job-middleware}

中间件包住任务的 `handle`。内置中间件的状态保存在队列的缓存 `store` 中：

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

| 中间件 | 行为 |
| --- | --- |
| `rateLimited(name, { max, per, key? })` | 每个长度为 `per` 的固定窗口内最多执行 `max` 次，所有使用同一名字的任务共用（`key` 可以进一步细分，例如按账号）。超出的任务被放回，到下一个窗口再执行 |
| `withoutOverlapping(key?, { releaseAfter?, expireAfter? })` | 同一个键同一时间只执行一个（缓存锁，`expireAfter` 后过期，默认 `'1h'`）。其余的放回 `releaseAfter`（默认 1 秒）后再试，`releaseAfter: false` 时直接丢弃。键默认为任务名 |
| `throttlesExceptions({ max?, per?, backoff?, key?, when? })` | 熔断：`per`（默认 `'10m'`）内抛出 `max` 次异常（默认 10）后，之后的执行被放回，直到窗口结束。异常本身仍计为失败的执行，`backoff` 替代任务的重试等待，成功一次即清零 |
| `skipIf(predicate)` | `predicate(payload, job)` 为真时跳过本次执行（视为完成） |

自定义中间件的形式为 `(payload, job, next) => ...`：调用 `next()` 继续；不调用就跳过本次执行，先调用 `job.release(delay)` 则稍后重试：

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

`job.release()` 在 `sync` 之外的所有驱动上可用。`sync` 无法延后执行任务，放回的任务会被丢弃，并记一条警告。`config/queue.ts` 中的全局中间件在任务自己的中间件之前执行。

## 运行消费进程

使用 `redis` 或 `database` 驱动时，需要在 Web 进程之外运行消费进程：

```bash
npx haze queue:work                              # 开发时使用，代码修改后自动生效
npx haze queue:work --queue high,default --concurrency 5 --connection redis
node dist/server/worker.mjs queue --queue high,default --concurrency 5   # 构建产物
```

`--queue` 按优先级列出队列（默认 `default`）。模板中的 `pnpm queue` 即 `haze queue:work`。构建产物中的 `worker.mjs`（node、bun、deno、docker 预设）收到 `SIGTERM` 后会等待执行中的任务完成再退出。

### 失败任务

用完重试次数的任务会被保留，方便排查和重试：

```bash
npx haze queue:failed            # 列出
npx haze queue:retry             # 全部重试
npx haze queue:retry <id>        # 重试一个
npx haze queue:forget <id>       # 删除一个
npx haze queue:flush             # 全部清空
```

以上命令都支持 `--connection <name>`。属于任务链的任务重试成功后，链会继续执行。

## 各平台说明

| 平台 | 任务如何执行 |
| --- | --- |
| node / bun / deno / docker | 单实例用 `memory`，在 Web 进程内消费；多实例用 `redis` 或 `database` 加 `worker.mjs queue` |
| cloudflare | `driver: 'cloudflare'`；生成的 Worker 导出 `queue()`：成功时 ack，需要重试时调用 `message.retry({ delaySeconds })`，放回的任务以新消息重新发送。`database` 配合 D1 或 Turso 可以投递，但消费进程必须运行在服务器上 |
| aws-lambda | 没有队列入口，请使用 `redis` 或 `database` 加独立的常驻消费进程 |
| vercel / netlify | 与 Lambda 相同：`redis` 或 `database` 配合在别处运行的消费进程 |

Cloudflare 上，在 `haze.config.ts` 中声明生产者与消费者，构建时会合并进 `dist/wrangler.json`：

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

各预设的说明见 [部署](./deployment)。

## 测试

`Queue.fake()` 只记录投递，不执行任务：

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
  // 按投递顺序执行已记录的任务（忽略延迟）
  await fake.drain()
})
```

任务链、批量与唯一任务有各自的断言：

```ts
fake.assertChained([ProcessVideo, Publish.with({ id: 1 })]) // 比较任务名；Job.with(...) 还比较 payload
fake.assertBatched(batch => batch.name === 'import' && batch.jobs.length === 2)
fake.assertBatchCount(1)
fake.assertNothingBatched()
fake.assertPushedUnique(SyncFeed, payload => payload.feedId === 1) // 恰好投递了一次
fake.assertSkipped(SyncFeed) // 有一次重复投递被跳过
```

fake 在内存中模拟唯一锁，`drain()` 执行该任务时释放。`drain()` 执行的任务再投递的任务（例如任务链的下一个）会再次被记录，再调用一次 `drain()` 即可继续。批量中的任务记录在 `fake.batches` 中，不会执行。

`Queue.restore()` 恢复为真实连接。更多内容见 [测试](./testing)。
