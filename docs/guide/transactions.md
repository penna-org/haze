# Transactions

A transaction groups several writes so they either all succeed or all roll back. `@hazejs/orm` supports the callback style and ThinkPHP's manual `startTrans()` / `commit()` / `rollback()` style. In both, every `Db` and `Model` query in the same async flow joins the transaction automatically, so you never pass a transaction object around.

## Callback transactions

```ts
import { Db } from '@hazejs/orm'

const order = await Db.transaction(async () => {
  const order = await Order.create({ userId, total })
  await Db.table(stocks).where('productId', productId).dec('quantity').update()
  return order
})
```

- The callback's return value is returned by `Db.transaction()`.
- If the callback throws, everything is rolled back and the error is rethrown.
- The callback receives the drizzle transaction object as its argument, in case you want to use drizzle directly.

This is the recommended form: the transaction cannot be left open by mistake.

## Manual transactions

```ts
await Db.startTrans()
try {
  await Order.create({ userId, total })
  await Db.table(stocks).where('productId', productId).dec('quantity').update()
  await Db.commit()
}
catch (error) {
  await Db.rollback()
  throw error
}
```

::: warning Same async function
The transaction is attached to the async context of the function that calls `startTrans()`. Call `startTrans()`, `commit()` and `rollback()` in the same function (functions it calls are fine). If the transaction has to span several independent call sites, use `Db.transaction(callback)` instead.
:::

`Db.inTransaction()` tells you whether the current code is inside a transaction. `commit()` / `rollback()` without a matching `startTrans()` throw.

## Nesting

Both styles nest. Inner transactions use savepoints: rolling back an inner transaction only undoes its own work.

```ts
await Db.transaction(async () => {
  await User.create({ name: 'Ada' })
  try {
    await Db.transaction(async () => {
      await User.create({ name: 'Bob' })
      throw new Error('undo Bob only')
    })
  }
  catch {}
}) // Ada is committed, Bob is not
```

Manual and callback transactions can be mixed.

## Options

Pass the isolation level (and other dialect options) as the second argument of `transaction()`, or the first of `startTrans()`:

```ts
await Db.transaction(async () => { /* ... */ }, { isolationLevel: 'serializable' })
await Db.startTrans({ isolationLevel: 'repeatable read' })
```

| Option | Dialect | Values |
|--------|---------|--------|
| `isolationLevel` | PostgreSQL, MySQL | `read uncommitted`, `read committed`, `repeatable read`, `serializable` |
| `accessMode` | PostgreSQL, MySQL | `read only`, `read write` |
| `deferrable` | PostgreSQL | `boolean` |
| `withConsistentSnapshot` | MySQL | `boolean` |
| `behavior` | SQLite | `deferred`, `immediate`, `exclusive` |

Options only apply to the outermost transaction; savepoints ignore them.

## Model transactions and connections

`Model.transaction()` runs on the model's connection. For other connections, use `Db.connection(name)`:

```ts
await User.transaction(async () => { /* ... */ })
await Db.connection('analytics').transaction(async () => { /* ... */ })
await Db.connection('analytics').startTrans()
await Db.connection('analytics').commit()
```

## Joining transactions started elsewhere

Some libraries open their own drizzle transaction (`db.transaction(tx => …)`) and call back into your code. Wrap the callback in `Db.joinTransaction(tx, fn)` so `Db`, `Model` and `Db.drizzleSync()` inside it use that transaction; transactions opened inside become savepoints. The library still commits or rolls back:

```ts
await engine.run({
  // the library calls this inside its own db.transaction()
  onCommit: (tx, changes) => Db.joinTransaction(tx, async () => {
    await Order.where('id', changes.orderId).update({ status: 'approved' })
  }),
})
```

## Running code after commit {#after-commit}

Side effects that other systems observe — queued jobs, events, emails, cache invalidation — should only happen once the data is committed. `Db.afterCommit(fn)` defers `fn` until the outermost transaction commits and drops it on rollback; outside a transaction it runs `fn` immediately:

```ts
await Db.transaction(async () => {
  const order = await Order.create({ userId, total })
  await Db.afterCommit(() => Cache.delete(`orders:${userId}`))

  await Db.transaction(async () => {
    await Db.afterCommit(() => audit('savepoint'))
    throw new Error('undo') // the savepoint rolls back: 'savepoint' is dropped
  }).catch(() => {})
}) // committed: the cache entry is deleted here, before Db.transaction() returns
```

- **Nesting.** A callback registered in a savepoint moves to the enclosing transaction when the savepoint is released and is dropped when the savepoint rolls back. Callbacks run in registration order after the outermost `COMMIT`, outside the transaction (queries in them see the committed data and are not part of it).
- **Manual transactions.** `Db.startTrans()` / `Db.commit()` / `Db.rollback()` work the same; the callbacks run inside `Db.commit()`.
- **Connections.** `Db.afterCommit()` waits for the transactions of every connection the current code is in; `Db.connection('analytics').afterCommit()` only looks at that connection.
- **Errors.** A callback that throws is logged and the next one still runs; the transaction has already committed, so `Db.transaction()` / `Db.commit()` does not reject. Outside a transaction the error is thrown to the caller as usual.
- **Joined transactions.** In `Db.joinTransaction(tx, fn)`, the outer library commits, so hazejs treats the transaction as committed when `fn` resolves and as rolled back when it rejects.
- MongoDB transactions (`Mongo.transaction()`) and D1 are not covered.

Jobs and events can do this declaratively: `defineJob({ afterCommit: true })`, `Job.with(payload).afterCommit().dispatch()` and `defineEvent({ afterCommit: true })` (see [Queues](./queues#after-commit) and [Events](./events#after-commit)). `afterCommit(fn)` from `@hazejs/core` is the same as `Db.afterCommit(fn)` for code that should not depend on the ORM; `@hazejs/orm` registers itself as the transaction implementation behind it.

## Row locks

Inside a transaction, `lock()` adds `FOR UPDATE` so concurrent transactions wait for yours:

```ts
await Db.transaction(async () => {
  const stock = await Db.table(stocks).where('productId', id).lock().find()
  if (stock!.quantity < 1)
    throw new Error('Sold out')
  await Db.table(stocks).where('productId', id).dec('quantity').update()
})
```

Other lock modes and options:

| Call | SQL | Databases |
|------|-----|-----------|
| `lock()` / `lock('update')` | `FOR UPDATE` | PostgreSQL, MySQL |
| `lock('share')` | `FOR SHARE` | PostgreSQL, MySQL 8 |
| `lock('no key update')` | `FOR NO KEY UPDATE` | PostgreSQL |
| `lock('key share')` | `FOR KEY SHARE` | PostgreSQL |
| `lock('update', { skipLocked: true })` | `… SKIP LOCKED` | PostgreSQL, MySQL 8 |
| `lock('update', { noWait: true })` | `… NOWAIT` | PostgreSQL, MySQL 8 |

`skipLocked` suits job-queue style "claim the next free row" queries:

```ts
await Db.transaction(async () => {
  const job = await Db.table(jobs).where('status', 'pending').order('id').lock('update', { skipLocked: true }).find()
  if (job)
    await Db.table(jobs).where('id', job.id).update({ status: 'running' })
})
```

The PostgreSQL-only modes throw a `DatabaseError` on MySQL, as does combining `skipLocked` with `noWait`. SQLite has no row locks and ignores `lock()` and its options (a write transaction already locks the whole database).

Inside a transaction, `paginate()` runs its count and page queries one after the other instead of in parallel, so they see the same snapshot and share the transaction's connection.

For conflicts across requests without holding locks, see [optimistic locking](./models#optimistic-locking).

## Limitations

- **Cloudflare D1** does not support interactive transactions: `transaction()` and `startTrans()` throw on a `d1` connection. Use drizzle's batch API for atomic writes: `(await Db.drizzle()).batch([...])`. Convenience methods that write several rows (`Model.saveAll()`, `relation.saveAll()`, `relation.sync()`) run without a transaction on D1.
- **MongoDB** uses its own `Mongo.transaction()` (requires a replica set). See [MongoDB](./models#mongodb).
- Distributed (XA) transactions are not supported.
