---
'@hazejs/core': minor
'@hazejs/orm': minor
'@hazejs/cli': minor
---

Queue enhancements that work on every driver:

- **Chains.** `Queue.chain([A.with(p), B.with(p)]).onConnection().onQueue().catch(Cleanup.with(p)).dispatch()` runs jobs in order. A job that fails for good drops the rest and runs `catch`.
- **Batches.** `Queue.batch([...]).name().allowFailures().then().catch().finally().dispatch()` tracks progress (`total`, `pending`, `processed`, `failed`, `progress`, `finished`, `cancelled`). It supports `batch.cancel()`, `batch.add()`, `Queue.findBatch(id)` and `job.batch()`. State lives in a cache store (`config/queue.ts` `batches: { store, ttl }`), and `then` / `finally` run exactly once.
- **Unique jobs.** `defineJob({ unique: { key, for, until } })` takes a cache lock on dispatch and skips duplicates. `Job.with(p).dispatch()` returns `{ id, skipped }`.
- **Job middleware.** `defineJob({ middleware: [...] })` and the global `config/queue.ts` `middleware` wrap jobs. Built in: `rateLimited`, `withoutOverlapping`, `throttlesExceptions` and `skipIf`. Use `job.release(delay)` to put a job back without counting an attempt.
- **Callbacks.** Chain and batch callbacks are job references (`Job.with(payload)`) or, on `sync` / `memory` connections, functions.
- **Driver registry.** Other packages register queue drivers with `registerQueueDriver(name, factory)`.
- **Fakes.** `Queue.fake()` adds `assertChained`, `assertBatched`, `assertBatchCount`, `assertNothingBatched`, `assertPushedUnique` and `assertSkipped`.

`@hazejs/orm` adds the `database` queue driver (`driver: 'database'`, registered by `databaseProvider()`). It claims jobs with `FOR UPDATE SKIP LOCKED` on PostgreSQL and MySQL 8, and with an atomic `UPDATE … RETURNING` on SQLite, libsql, Turso and D1. It also supports delays, retries, release of stale reservations and the `failed_jobs` table.

`@hazejs/cli` adds `haze make:queue-tables`, which writes the drizzle schema for the `jobs` and `failed_jobs` tables and runs `db:generate`.
