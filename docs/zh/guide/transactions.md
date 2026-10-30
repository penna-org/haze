# 事务

事务把多次写入组合在一起，要么全部成功，要么全部回滚。`@hazejs/orm` 同时支持回调写法和 ThinkPHP 的手动 `startTrans()` / `commit()` / `rollback()` 写法。两种写法下，同一异步流程中的 `Db` 和 `Model` 查询都会自动加入事务，不需要到处传递事务对象。

## 回调事务

```ts
import { Db } from '@hazejs/orm'

const order = await Db.transaction(async () => {
  const order = await Order.create({ userId, total })
  await Db.table(stocks).where('productId', productId).dec('quantity').update()
  return order
})
```

- 回调的返回值就是 `Db.transaction()` 的返回值。
- 回调抛出异常时全部回滚，异常继续向外抛出。
- 回调参数是 drizzle 的事务对象，需要直接使用 drizzle 时可以用。

推荐使用这种写法：事务不会因为疏忽而一直处于打开状态。

## 手动事务

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

::: warning 在同一个异步函数中
事务绑定在调用 `startTrans()` 的函数的异步上下文上。`startTrans()`、`commit()` 和 `rollback()` 要在同一个函数中调用（该函数再调用的其他函数没有问题）。如果事务需要跨越几个互不相关的调用位置，请改用 `Db.transaction(callback)`。
:::

`Db.inTransaction()` 返回当前代码是否处于事务中。没有对应的 `startTrans()` 时调用 `commit()` / `rollback()` 会抛出异常。

## 嵌套

两种写法都可以嵌套。内层事务使用保存点：内层回滚只撤销内层自己的写入。

```ts
await Db.transaction(async () => {
  await User.create({ name: 'Ada' })
  try {
    await Db.transaction(async () => {
      await User.create({ name: 'Bob' })
      throw new Error('只撤销 Bob')
    })
  }
  catch {}
}) // Ada 已提交，Bob 没有
```

手动事务和回调事务可以混合使用。

## 事务选项

隔离级别等方言选项作为 `transaction()` 的第二个参数、`startTrans()` 的第一个参数传入：

```ts
await Db.transaction(async () => { /* ... */ }, { isolationLevel: 'serializable' })
await Db.startTrans({ isolationLevel: 'repeatable read' })
```

| 选项 | 方言 | 取值 |
|------|------|------|
| `isolationLevel` | PostgreSQL、MySQL | `read uncommitted`、`read committed`、`repeatable read`、`serializable` |
| `accessMode` | PostgreSQL、MySQL | `read only`、`read write` |
| `deferrable` | PostgreSQL | `boolean` |
| `withConsistentSnapshot` | MySQL | `boolean` |
| `behavior` | SQLite | `deferred`、`immediate`、`exclusive` |

选项只作用于最外层事务，保存点会忽略它们。

## 模型事务与多连接

`Model.transaction()` 在模型所用的连接上开启事务；其他连接使用 `Db.connection(name)`：

```ts
await User.transaction(async () => { /* ... */ })
await Db.connection('analytics').transaction(async () => { /* ... */ })
await Db.connection('analytics').startTrans()
await Db.connection('analytics').commit()
```

## 加入外部开启的事务

有的库会自己开启 drizzle 事务（`db.transaction(tx => …)`）并回调你的代码。用 `Db.joinTransaction(tx, fn)` 包住回调，其中的 `Db`、`Model` 与 `Db.drizzleSync()` 都使用这个事务，其中再开启的事务为保存点；提交与回滚仍由那个库负责：

```ts
await engine.run({
  // 由库在它自己的 db.transaction() 中调用
  onCommit: (tx, changes) => Db.joinTransaction(tx, async () => {
    await Order.where('id', changes.orderId).update({ status: 'approved' })
  }),
})
```

## 事务提交后执行 {#after-commit}

外部能观察到的副作用（队列任务、事件、邮件、清除缓存）应当在数据提交之后才发生。`Db.afterCommit(fn)` 把 `fn` 推迟到最外层事务提交之后执行，回滚时丢弃；不在事务中时立即执行：

```ts
await Db.transaction(async () => {
  const order = await Order.create({ userId, total })
  await Db.afterCommit(() => Cache.delete(`orders:${userId}`))

  await Db.transaction(async () => {
    await Db.afterCommit(() => audit('savepoint'))
    throw new Error('undo') // 保存点回滚：'savepoint' 被丢弃
  }).catch(() => {})
}) // 已提交：在 Db.transaction() 返回前删除缓存
```

- **嵌套**：在保存点中登记的回调，保存点提交后移交外层事务，保存点回滚时丢弃。回调在最外层 `COMMIT` 之后按登记顺序执行，且不在事务中（其中的查询看得到已提交的数据，也不属于这个事务）。
- **手动事务**：`Db.startTrans()` / `Db.commit()` / `Db.rollback()` 同样适用，回调在 `Db.commit()` 中执行。
- **多连接**：`Db.afterCommit()` 等待当前代码所处的所有连接的事务；`Db.connection('analytics').afterCommit()` 只看该连接。
- **错误**：回调抛错时记录日志，后续回调照常执行；事务已经提交，`Db.transaction()` / `Db.commit()` 不会因此失败。不在事务中时错误照常抛给调用方。
- **加入的外部事务**：`Db.joinTransaction(tx, fn)` 由外部库提交，hazejs 在 `fn` 成功返回时视为已提交，失败时视为回滚。
- 不适用于 MongoDB 事务（`Mongo.transaction()`）与 D1。

任务与事件可以声明式地使用：`defineJob({ afterCommit: true })`、`Job.with(payload).afterCommit().dispatch()` 与 `defineEvent({ afterCommit: true })`（见[队列](./queues#after-commit)与[事件](./events#after-commit)）。`@hazejs/core` 的 `afterCommit(fn)` 与 `Db.afterCommit(fn)` 相同，供不想依赖 ORM 的代码使用；`@hazejs/orm` 把自己注册为它背后的事务实现。

## 行锁

在事务中用 `lock()` 加上 `FOR UPDATE`，并发的事务会等待当前事务结束：

```ts
await Db.transaction(async () => {
  const stock = await Db.table(stocks).where('productId', id).lock().find()
  if (stock!.quantity < 1)
    throw new Error('已售罄')
  await Db.table(stocks).where('productId', id).dec('quantity').update()
})
```

其他锁模式与选项：

| 写法 | SQL | 数据库 |
|------|-----|--------|
| `lock()` / `lock('update')` | `FOR UPDATE` | PostgreSQL、MySQL |
| `lock('share')` | `FOR SHARE` | PostgreSQL、MySQL 8 |
| `lock('no key update')` | `FOR NO KEY UPDATE` | PostgreSQL |
| `lock('key share')` | `FOR KEY SHARE` | PostgreSQL |
| `lock('update', { skipLocked: true })` | `… SKIP LOCKED` | PostgreSQL、MySQL 8 |
| `lock('update', { noWait: true })` | `… NOWAIT` | PostgreSQL、MySQL 8 |

`skipLocked` 适合任务队列式的“领取下一条空闲记录”：

```ts
await Db.transaction(async () => {
  const job = await Db.table(jobs).where('status', 'pending').order('id').lock('update', { skipLocked: true }).find()
  if (job)
    await Db.table(jobs).where('id', job.id).update({ status: 'running' })
})
```

仅 PostgreSQL 支持的模式在 MySQL 上抛出 `DatabaseError`，同时使用 `skipLocked` 与 `noWait` 也会抛出。SQLite 没有行锁，会忽略 `lock()` 及其选项（写事务本身已经锁住整个数据库）。

在事务中，`paginate()` 的统计与取数据依次执行而不是并行，两者看到同一份快照，并共用事务的连接。

不持有锁、跨请求检测冲突的方式见[乐观锁](./models#乐观锁)。

## 限制

- **Cloudflare D1** 不支持交互式事务：在 `d1` 连接上调用 `transaction()` 和 `startTrans()` 会报错。原子写入请使用 drizzle 的 batch：`(await Db.drizzle()).batch([...])`。会写入多行的便捷方法（`Model.saveAll()`、关联的 `saveAll()`、`sync()`）在 D1 上不使用事务。
- **MongoDB** 使用自己的 `Mongo.transaction()`（需要副本集），见 [MongoDB](./models#mongodb)。
- 不支持分布式（XA）事务。
