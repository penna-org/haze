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

`lock('share')` takes a shared lock. SQLite has no row locks and ignores `lock()` (a write transaction already locks the whole database).

For conflicts across requests without holding locks, see [optimistic locking](./models#optimistic-locking).

## Limitations

- **Cloudflare D1** does not support interactive transactions: `transaction()` and `startTrans()` throw on a `d1` connection. Use drizzle's batch API for atomic writes: `(await Db.drizzle()).batch([...])`. Convenience methods that write several rows (`Model.saveAll()`, `relation.saveAll()`, `relation.sync()`) run without a transaction on D1.
- **MongoDB** uses its own `Mongo.transaction()` (requires a replica set). See [MongoDB](./models#mongodb).
- Distributed (XA) transactions are not supported.
