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

`lock('share')` 为共享锁。SQLite 没有行锁，会忽略 `lock()`（写事务本身已经锁住整个数据库）。

不持有锁、跨请求检测冲突的方式见[乐观锁](./models#乐观锁)。

## 限制

- **Cloudflare D1** 不支持交互式事务：在 `d1` 连接上调用 `transaction()` 和 `startTrans()` 会报错。原子写入请使用 drizzle 的 batch：`(await Db.drizzle()).batch([...])`。会写入多行的便捷方法（`Model.saveAll()`、关联的 `saveAll()`、`sync()`）在 D1 上不使用事务。
- **MongoDB** 使用自己的 `Mongo.transaction()`（需要副本集），见 [MongoDB](./models#mongodb)。
- 不支持分布式（XA）事务。
