# 定时任务

不必在每台服务器上维护 crontab，直接在代码里声明周期性任务即可。hazejs 每分钟检查一次哪些任务到期并执行；触发方式可以是常驻进程、系统 cron、Cloudflare Cron Triggers、EventBridge 规则或 Vercel Cron。

::: tip 目录约定
本页示例使用 API 模板的目录结构（`schedule/...`、`config/...`）。全栈项目中这些目录位于 `server/` 下。
:::

## 定义定时任务

`schedule/*.ts` 中每个文件默认导出 `defineSchedule()`：

```ts
// schedule/app.ts
import { defineSchedule } from '@hazejs/core'
import PruneTokens from '~/app/job/PruneTokens'

export default defineSchedule((s) => {
  s.call('report', () => sendReport())
    .weekdays()
    .at('09:00')
    .timezone('Asia/Shanghai')

  s.job(PruneTokens, { days: 30 }).daily().onOneServer()

  s.cron('*/5 * * * *', 'sync', () => sync()).withoutOverlapping()
})
```

添加任务有三种方式：

| 方法 | 说明 |
| --- | --- |
| `s.call(name, fn)` | 执行一个函数 |
| `s.cron(expression, name, fn)` | 按 cron 表达式执行函数 |
| `s.job(Job, payload?, options?)` | 到期时投递 [队列任务](./queues)。没有载荷的任务可以省略 payload（`s.job(PruneTokens)`）。`options` 支持 `delay`、`queue`、`connection`、`afterCommit` 与 `name`（默认 `job:<任务名>`） |

任务名不能重复。没有设置频率的任务每分钟执行一次。

回调的第二个参数是所属应用，条件中可以直接取服务（这里的 `FeatureFlags` 是项目自己的类），不必借助全局：

```ts
export default defineSchedule((s, app) => {
  s.job(PruneTokens)
    .daily()
    .skip(() => app.make(FeatureFlags).isOff('pruning'))
})
```

定时任务在所属应用的上下文中执行：`s.call()` 的函数、`when()` / `skip()` 条件与钩子中的门面（`Queue`、`Events`、`Db`…）、`useApp()`、`config()` 与 `inject()` 都解析到定义它的应用，`s.job()` 投递到这个应用的队列。

`s.job()` 只负责**投递**，任务由队列 worker 执行。它的日志为 `Scheduled job dispatched to the queue`，任务本身的结果见队列日志（`Job "PruneTokens" done in …` 或失败信息）。

## 频率

| 方法 | 执行时间 |
| --- | --- |
| `cron('0 */2 * * *')` | 自定义表达式（5 位；6 位时包含秒） |
| `everyMinute()` | 每分钟 |
| `everyTwoMinutes()` / `everyFiveMinutes()` / `everyTenMinutes()` | 每 2 / 5 / 10 分钟 |
| `everyFifteenMinutes()` / `everyThirtyMinutes()` | 每 15 / 30 分钟 |
| `hourly()` | 每小时第 0 分 |
| `hourlyAt(17)` | 每小时第 17 分 |
| `daily()` | 每天零点 |
| `dailyAt('13:30')` | 每天 13:30 |
| `twiceDaily(1, 13)` | 每天 01:00 与 13:00（即默认值） |
| `weekly()` | 每周日零点 |
| `weeklyOn(1, '08:00')` | 每周一 08:00（0 为周日） |
| `monthly()` | 每月 1 日零点 |
| `monthlyOn(15, '10:00')` | 每月 15 日 10:00 |

可以与上面组合使用的修饰方法：

| 方法 | 作用 |
| --- | --- |
| `at('09:00')` | 设置时分 |
| `weekdays()` | 只在周一到周五执行 |
| `weekends()` | 只在周六、周日执行 |
| `timezone('Asia/Shanghai')` | 该任务使用的 IANA 时区 |

默认时区取 `config/schedule.ts` 的 `timezone`，未设置时为 UTC：

```ts
// config/schedule.ts
import { defineScheduleConfig } from '@hazejs/core'

export default defineScheduleConfig({
  timezone: 'Asia/Shanghai',
  // onOneServer / withoutOverlapping 使用的缓存存储（必须是原子存储）
  store: 'redis',
})
```

## 条件与钩子

```ts
s.call('digest', () => sendDigest())
  .hourly()
  .when(() => featureEnabled('digest')) // 返回 true 时才执行
  .skip(() => isMaintenance()) // 返回 true 时跳过
  .onSuccess(() => console.log('digest sent'))
  .onFailure(error => reportError(error))
```

### 多实例只执行一次

多个实例同时运行调度器时，`onOneServer()` 保证同一分钟内任务只在其中一个实例上执行。`withoutOverlapping(ttl?)` 在上一次还没结束时跳过本次（锁在 `ttl` 后过期，默认 `24h`）。

```ts
s.job(PruneTokens, { days: 30 }).daily().onOneServer()
s.call('import', () => runImport()).everyFiveMinutes().withoutOverlapping('1h')
```

两者都基于 [`Cache.lock`](./cache#原子锁)，因此需要一个原子且共享的存储：跨实例请用 `redis` 或 `upstash`（`memory` 只在单个进程内有效）。使用 `kv` 存储会直接报错；可以通过 `config/schedule.ts` 的 `store` 指定其他存储。

::: warning `s.job()` 只锁住投递
在 `s.job()` 任务上，`withoutOverlapping()` 与 `onOneServer()` 保护的是只需几毫秒的**投递**，而不是任务的执行：任务入队后锁就释放了。要防止任务本身的两次执行重叠（上一次导入还没结束，下一次又投递了），请使用任务中间件 [`withoutOverlapping`](./queues#job-middleware)，或把任务设为[唯一任务](./queues#unique-jobs)：

```ts
export default defineJob({
  middleware: [withoutOverlapping()], // 同一时间只执行一个 ImportFeeds，其余放回队列
  async handle() { /* ... */ },
})
```

`s.job()` 任务上的 `onOneServer()` 仍然有用：多个调度器实例不会各自投递一次。
:::

## 运行调度器

在 `config/schedule.ts` 中设置 `runInServer: true`，可以在 Web 进程中执行到期的任务，适合开发与单实例部署：HTTP 服务器开始监听时启动，应用释放时停止，测试与命令行不会启动。多实例部署请关闭它，另外运行一个 `schedule:work` 进程（或配合共享存储使用 `onOneServer()`）。

| 环境 | 运行方式 |
| --- | --- |
| 开发 | `npx haze schedule:work`（模板中的 `pnpm schedule`），代码修改后自动生效 |
| 查看 | `npx haze schedule:list` 列出每个任务的表达式、时区与下次执行时间 |
| node / bun / deno / docker | 常驻运行 `node dist/server/worker.mjs schedule`，或由系统 cron 每分钟调用 `node dist/server/worker.mjs schedule:run` |
| cloudflare | `wrangler.json` 自动加上 `triggers.crons: ['* * * * *']`，由 Worker 的 `scheduled()` 执行到期任务 |
| aws-lambda | 同一份产物，handler 设为 `index.schedule`，用 EventBridge `rate(1 minute)` 触发 |
| vercel | 自动配置 Vercel Cron 调用 `/__haze/schedule`，需要设置 `CRON_SECRET` |

`haze schedule:run` / `worker.mjs schedule:run` 执行当前这一分钟到期的任务后退出，正好适合放进 crontab：

```bash
* * * * * cd /srv/app && node dist/server/worker.mjs schedule:run
```

### Vercel

函数只接受带 `Authorization: Bearer $CRON_SECRET` 的 `/__haze/schedule` 请求；设置了该变量后，Vercel Cron 会自动带上：

```bash
vercel env add CRON_SECRET
```

Hobby 计划只允许每天触发一次，可以在 `haze.config.ts` 中调整频率：

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  vercel: {
    cron: '0 3 * * *',
  },
})
```

::: warning 触发间隔
每次触发只执行*当前这一分钟*到期的任务。如果平台的触发间隔大于 1 分钟（Vercel Hobby、频率更低的 EventBridge 规则），中间那些分钟到期的任务会被跳过。
:::

各预设的说明见 [部署](./deployment)，全部命令见 [命令行参考](./cli)。
