# Task Scheduling

Instead of maintaining a crontab per server, declare recurring tasks in code. hazejs checks once a minute which tasks are due and runs them, whether the trigger is a long-running process, a system cron, Cloudflare Cron Triggers, an EventBridge rule or Vercel Cron.

::: tip Paths
Examples on this page use the API template layout (`schedule/...`, `config/...`). In a full-stack project these live under `server/`.
:::

## Defining schedules

Every file in `schedule/*.ts` default-exports `defineSchedule()`:

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

There are three ways to add a task:

| Method | Description |
| --- | --- |
| `s.call(name, fn)` | Run a function |
| `s.cron(expression, name, fn)` | Run a function on a cron expression |
| `s.job(Job, payload, options?)` | Dispatch a [queued job](./queues) when due. `options` accepts `delay`, `queue`, `connection` and `name` (default `job:<JobName>`) |

Task names must be unique. A task with no frequency runs every minute.

## Frequencies

| Method | Runs |
| --- | --- |
| `cron('0 */2 * * *')` | Custom expression (5 fields; 6 fields include seconds) |
| `everyMinute()` | Every minute |
| `everyTwoMinutes()` / `everyFiveMinutes()` / `everyTenMinutes()` | Every 2 / 5 / 10 minutes |
| `everyFifteenMinutes()` / `everyThirtyMinutes()` | Every 15 / 30 minutes |
| `hourly()` | At minute 0 of every hour |
| `hourlyAt(17)` | At minute 17 of every hour |
| `daily()` | At midnight |
| `dailyAt('13:30')` | Every day at 13:30 |
| `twiceDaily(1, 13)` | At 01:00 and 13:00 (these are the defaults) |
| `weekly()` | Sundays at midnight |
| `weeklyOn(1, '08:00')` | Mondays at 08:00 (0 is Sunday) |
| `monthly()` | On the 1st at midnight |
| `monthlyOn(15, '10:00')` | On the 15th at 10:00 |

Modifiers that combine with the above:

| Method | Effect |
| --- | --- |
| `at('09:00')` | Set hour and minute |
| `weekdays()` | Monday to Friday only |
| `weekends()` | Saturday and Sunday only |
| `timezone('Europe/Berlin')` | IANA time zone for this task |

The default time zone is `timezone` from `config/schedule.ts`, falling back to UTC:

```ts
// config/schedule.ts
import { defineScheduleConfig } from '@hazejs/core'

export default defineScheduleConfig({
  timezone: 'Asia/Shanghai',
  // Cache store for onOneServer / withoutOverlapping (must be atomic)
  store: 'redis',
})
```

## Constraints and hooks

```ts
s.call('digest', () => sendDigest())
  .hourly()
  .when(() => featureEnabled('digest')) // run only when true
  .skip(() => isMaintenance()) // skip when true
  .onSuccess(() => console.log('digest sent'))
  .onFailure(error => reportError(error))
```

### Running on one server

When several instances run the scheduler, `onOneServer()` makes sure a task runs only once per minute across all of them. `withoutOverlapping(ttl?)` skips a run while the previous one is still going (the lock expires after `ttl`, default `24h`).

```ts
s.job(PruneTokens, { days: 30 }).daily().onOneServer()
s.call('import', () => runImport()).everyFiveMinutes().withoutOverlapping('1h')
```

Both are built on [`Cache.lock`](./cache#atomic-locks), so they need an atomic, shared store: `redis` or `upstash` across instances (`memory` only works within one process). Using a `kv` store throws; set `store` in `config/schedule.ts` to pick another.

## Running the scheduler

| Environment | How |
| --- | --- |
| Development | `npx haze schedule:work` (the template's `pnpm schedule`); reloads with your code |
| Inspect | `npx haze schedule:list` prints each task's expression, time zone and next run |
| node / bun / deno / docker | `node dist/server/worker.mjs schedule` as a long-running process, or call `node dist/server/worker.mjs schedule:run` from system cron every minute |
| cloudflare | `wrangler.json` gets `triggers.crons: ['* * * * *']` automatically; the Worker's `scheduled()` runs due tasks |
| aws-lambda | Same bundle with the handler set to `index.schedule`, triggered by EventBridge `rate(1 minute)` |
| vercel | Vercel Cron calls `/__haze/schedule` (configured automatically); set `CRON_SECRET` |

`haze schedule:run` / `worker.mjs schedule:run` runs the tasks due in the current minute and exits, which is what a crontab entry needs:

```bash
* * * * * cd /srv/app && node dist/server/worker.mjs schedule:run
```

### Vercel

The function only accepts `/__haze/schedule` with `Authorization: Bearer $CRON_SECRET`, which Vercel Cron sends when the variable is set:

```bash
vercel env add CRON_SECRET
```

Hobby plans only allow daily crons. Change the trigger in `haze.config.ts`:

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  vercel: {
    cron: '0 3 * * *',
  },
})
```

::: warning Coarse triggers
Each trigger only runs the tasks due in *that* minute. If the platform fires less often than once a minute (Vercel Hobby, a slower EventBridge rule), tasks due in the minutes in between are skipped.
:::

See [Deployment](./deployment) for the presets and [CLI Reference](./cli) for all commands.
