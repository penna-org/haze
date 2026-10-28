# 队列

队列用来把耗时的工作（发邮件、生成报表、调用 Webhook）移出请求。在 hazejs 中，任务是用 `defineJob` 定义的普通对象：自动发现，用 `.dispatch()` 投递，由进程内队列、Redis 消费进程（BullMQ）或 Cloudflare Queues 执行。

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
| `handle(payload, job)` | 任务逻辑 |
| `failed(payload, error, job)` | 最后一次失败后调用 |

### 任务上下文

`handle` 的第二个参数、`failed` 的第三个参数是 `JobContext`：

| 字段 | 说明 |
| --- | --- |
| `id` | 任务 ID |
| `attempt` | 第几次执行，从 1 开始 |
| `queue` | 队列名 |
| `logger` | 带任务信息的日志实例 |
| `app` | 应用实例 |
| `signal` | 超时时触发的 `AbortSignal` |

## 投递任务

```ts
import SendInvoice from '~/app/job/SendInvoice'

await SendInvoice.dispatch({ invoiceId: 42 })
await SendInvoice.dispatch({ invoiceId: 42 }, { delay: '10m' })
await SendInvoice.dispatch({ invoiceId: 42 }, { queue: 'high', connection: 'redis' })
```

`dispatch()` 返回任务 ID。payload 以 JSON 传递，建议传 ID，不要传模型实例。

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
      url: env('REDIS_URL', 'redis://127.0.0.1:6379'),
      queues: ['default', 'emails'],
    },
    cloudflare: { driver: 'cloudflare', binding: 'QUEUE' },
  },
}))
```

| 驱动 | 行为 |
| --- | --- |
| `sync` | 在 `dispatch()` 中立即执行，失败直接抛给调用方，不重试 |
| `memory` | 进程内队列，由当前进程消费（`concurrency`，默认 1），用计时器处理延迟与退避；进程退出时任务丢失。没有 `config/queue.ts` 时的默认值 |
| `redis` | BullMQ（`pnpm add bullmq ioredis`）。选项：`url`、`prefix`（默认 `haze`）、`queues`（`queue:failed` / `queue:retry` 遍历的队列，默认 `['default']`）、`keepCompleted`（默认 1000）。需要单独的消费进程 |
| `cloudflare` | Cloudflare Queues 生产者绑定（`binding`，默认 `QUEUE`），由 Worker 的 `queue()` 消费。延迟上限 12 小时 |

## 运行消费进程

使用 `redis` 驱动时，需要在 Web 进程之外运行消费进程：

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

以上命令都支持 `--connection <name>`。

## 各平台说明

| 平台 | 任务如何执行 |
| --- | --- |
| node / bun / deno / docker | 单实例用 `memory`，在 Web 进程内消费；多实例用 `redis` 加 `worker.mjs queue` |
| cloudflare | `driver: 'cloudflare'`；生成的 Worker 导出 `queue()`：成功时 ack，需要重试时调用 `message.retry({ delaySeconds })` |
| aws-lambda | 没有队列入口，请使用 `redis` 加独立的常驻消费进程 |
| vercel / netlify | 与 Lambda 相同：`redis` 指向在别处运行的消费进程 |

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

`Queue.restore()` 恢复为真实连接。更多内容见 [测试](./testing)。
