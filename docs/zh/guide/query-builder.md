# 查询构造器

`Db.table(table)` 返回一个 ThinkPHP 风格的链式查询构造器，可用于任意 drizzle 表。模型查询（`User.where(...)`、`User.query()`）使用同一个构造器，只是返回模型而不是普通对象，所以本页的内容同样适用于模型。

```ts
import { Db } from '@hazejs/orm'
import { users } from '~/database/schema/users'

const page = await Db.table(users).where('status', 1).order('id', 'desc').paginate(1, 20)
```

::: warning 构造器是可变的
`where()`、`order()`、`join()` 等链式方法会修改构造器本身并返回同一个对象。不要把基础查询存在变量里再分别追加条件——各分支共享同一份状态。每次用函数新建（或调用 `clone()`）：

```ts
const active = () => Db.table(users).where('status', 1)

const admins = await active().where('role', 'admin').select()
const total = await active().count()
```
:::

## 获取结果

| 方法 | 返回 |
|------|------|
| `select()` | 全部结果 |
| `selectOrFail()` | 全部结果，为空时抛出 `ModelNotFoundException`（404） |
| `find()` / `findOrFail()` | 第一条（不存在时为 `undefined` / 404）。模型查询可以传主键：`User.find(1)` |
| `findOrEmpty(id?)` | 仅模型查询：模型，或空模型（`model.isEmpty()`） |
| `value('name')` | 第一行的某个字段；也可以是 `field()` 的别名：`field({ total: count() }).value('total')` |
| `column('name')` | 每一行的某个字段：`['Ada', 'Bob']`；也可以是 `field()` 的别名 |
| `column('name', 'id')` | 以另一列为键：`{ 1: 'Ada', 2: 'Bob' }` |
| `column('*', 'id')` | 以某列为键的整行 |
| `count(column?)` / `sum` / `avg` / `max` / `min` | 聚合（`count('email')` 统计非空值） |
| `exists()` | 是否有匹配的数据（`select 1 … limit 1`，不读取整行） |
| `paginate(page, perPage)` | `{ data, total, page, perPage, lastPage }` |
| `paginateX(perPage, { lastId, key, sort })` | 不统计总数的游标分页：`{ data, perPage, lastId, hasMore }` |
| `chunk(size, rows => ...)` | 分批处理，回调返回 `false` 时停止 |
| `cursor(size)` / `lazy(size)` | 分批读取的异步迭代器：`for await (const row of query.cursor())` |
| `toSQL()` | 生成的 SQL 与参数（ThinkPHP 的 `fetchSql`）。`toSQL('insert', values)`、`toSQL('update', values)`、`toSQL('delete', target?)` 预览写操作的语句而不执行 |

`value()` 与 `column()` 的类型与 `field()` 一致：表与模型上为列的类型（`User.query().column('name')` 为 `string[]`），`field({ ... })` 之后为别名的类型。

`paginate()` 的统计与取数据并行执行；在事务中依次执行，统计为 `0` 时不再取数据。统计查询不带 `order()`。

`paginateX()` 按主键（或 `key`）翻页，数据量大时依然很快。`cursor()` 在没有 `order()` 时同样按主键分批，有排序时按 offset 分批。

## 查询条件

```ts
Db.table(users).where('status', 1)                         // 等于
Db.table(users).where('age', '>', 18)                      // 运算符
Db.table(users).where({ status: 1, email: null })          // 对象：null 为 IS NULL，数组为 IN
Db.table(users).where([['status', '=', 1], ['age', '>', 18]]) // 数组条件
Db.table(users).where('id', [1, 2, 3])                     // IN
Db.table(users).where(q => q.where('a', 1).orWhere('b', 2)) // 括号分组
Db.table(users).where(eq(users.id, 1))                     // 任意 drizzle 表达式
```

运算符：`=`、`!=`、`<>`、`>`、`>=`、`<`、`<=`、`like`、`not like`、`in`、`not in`、`between`、`not between`。多次 `where` 以 AND 连接，`orWhere` / `whereOr` 以 OR 连接，从左到右组合。

`where()`、`orWhere()` 与 `whereNot()` 忽略 `undefined`，drizzle 的 `and()` / `or()`（返回 `SQL | undefined`）可以直接传入：

```ts
Db.table(users).where(and(
  eq(users.tenantId, tenantId),
  keyword ? like(users.name, `%${keyword}%`) : undefined,
))
```

| 方法 | 说明 |
|------|------|
| `orWhere` / `whereOr` | OR 条件 |
| `whereNot(condition)` | 对条件或分组取反 |
| `whereIn` / `whereNotIn` | 列表或[子查询](#子查询) |
| `whereNull` / `whereNotNull` | `IS NULL` / `IS NOT NULL` |
| `whereBetween` / `whereNotBetween` | 区间 `[min, max]` |
| `whereLike` / `whereNotLike` | `LIKE` 匹配 |
| `whereColumn('updatedAt', '>', 'createdAt')` | 比较两个字段 |
| `whereExists` / `whereNotExists` | [子查询](#子查询)有结果 |
| `whereRaw('age > ? and status = ?', [18, 1])` | 原生 SQL，`?` 依次绑定参数，也可以传 drizzle 的 `sql` 模板；OR 用 `orWhereRaw` |
| `whereExp('score', '> 10')` | 字段 + 原生表达式 |
| `whereFindInSet('tags', 'orm')` | 逗号分隔的字段包含某个值（MySQL 为 `FIND_IN_SET`） |
| `whereJsonContains('labels', 'orm')` | JSON 数组字段包含某个值；OR 用 `orWhereJsonContains` |
| `when(value, q => ..., q => ...)` | `value` 非空时执行第一个回调，否则执行可选的第二个回调 |
| `whenDefined(value, q => ..., q => ...)` | 同上，但只把 `undefined` 与 `null` 视为空 |

`when()` 跳过的“空值”是 `undefined`、`null`、`false` 与 `''`，`0` 与空数组照常应用。三态布尔筛选（`true` / `false` / 未传）用 `whenDefined()`，它只跳过 `undefined` 与 `null`：

```ts
// input.enabled: boolean | undefined（校验后的查询参数）
Db.table(users).whenDefined(input.enabled, (q, enabled) => q.where('enabled', enabled)) // false 也会应用
```

::: warning 原生 SQL
`whereRaw`、`whereExp`、`orderRaw` 和 `fieldRaw` 会把字符串原样拼入 SQL，不要用用户输入拼接，值请用 `?` 绑定或 drizzle 的 `sql` 模板。
:::

### 时间条件

```ts
Db.table(posts).whereTime('createdAt', '>=', '2024-01-01')
Db.table(posts).whereTime('createdAt', 'today')           // 还有 yesterday、week、last week、month、last month、year、last year
Db.table(posts).whereDay('createdAt')                     // 今天；或 'yesterday'、'2024-05-01'
Db.table(posts).whereWeek('createdAt', 'last week')       // 每周从周一开始
Db.table(posts).whereMonth('createdAt', '2024-05')        // 或 'this month' / 'last month'
Db.table(posts).whereYear('createdAt', 2024)              // 或 'this year' / 'last year'
Db.table(posts).whereBetweenTime('createdAt', '2024-01-01', '2024-06-30 23:59:59')
Db.table(posts).whereNotBetweenTime('createdAt', start, end)
Db.table(posts).whereTimeInterval('createdAt', '2024-05-01', 'day', 7) // 从 5 月 1 日起 7 天
```

时间可以是 `Date`、毫秒时间戳或日期字符串，按服务器本地时区解析。比较值会按列的类型转换（`Date`、ISO 字符串或毫秒数），与写入时间戳的规则一致。

## 字段与 JSON 路径

```ts
Db.table(users).field('id', 'name')                          // 结果有类型：{ id, name }
Db.table(users).withoutField('password')                     // 除这些列以外的全部列
Db.table(users).field({ id: users.id, total: count() })      // drizzle 表达式，键为别名
Db.table(logs).leftJoin(users, 'logs.userId', 'users.id')
  .field({ log: logs, userName: users.name })                // 整张表：结果中 log 为行对象
Db.table(users).fieldRaw('age * 2', 'double')                // 带别名的原生表达式
Db.table(users).distinct().field('status')
```

字段名可以指向 join 的表（`'posts.title'`）、重命名结果（`'name as nickname'`），或读取 JSON 列中的路径（`'meta->address->city'`）。凡是接受字段的地方都可以使用 JSON 路径：`where`、`order`、`field`、`value`、`group` 等。

```ts
await Db.table(articles).where('meta->author->name', 'Ada').field('title', 'meta->city as city').select()
```

`withAttr('name', (value, row) => ...)` 转换结果中的字段；在模型查询上相当于动态访问器。

## 排序、分组与分页

```ts
Db.table(users).order('id', 'desc')
Db.table(users).order({ status: 'asc', id: 'desc' })
Db.table(users).order(sql`length(${users.name})`, 'desc')    // drizzle 表达式，可指定方向
Db.table(users).orderRaw('length(name) desc')
Db.table(users).orderField('status', [2, 1, 0])  // 按指定值的顺序，其余排在最后
Db.table(users).orderRand()
Db.table(users).limit(10)                        // 或 limit(offset, length)
Db.table(users).page(2, 20)

Db.table(posts)
  .field({ userId: posts.userId, total: count() })
  .group('userId')
  .having('count(*) >= ?', [3])
  .order('total', 'desc')                        // 按字段别名排序
  .select()
```

对分组、去重或合并（union）后的查询调用 `count()`，统计的是结果的行数。

## 连接查询

```ts
const rows = await Db.table(posts)
  .join(users, 'posts.userId', 'users.id')       // 或 join(users, eq(posts.userId, users.id))
  .field('posts.title', 'users.name as author')
  .where('users.status', 1)
  .select()
// [{ title: 'Hello', author: 'Ada' }, ...]
```

`join`（内连接）、`leftJoin`、`rightJoin` 和 `fullJoin`（MySQL 不支持）接受 drizzle 表或 `[表, 别名]`。`alias('u')` 给当前表起别名，用于自连接：

```ts
await Db.table(users).alias('u').leftJoin([users, 'parent'], 'u.parentId', 'parent.id').field('u.name', 'parent.name as parentName').select()
```

`leftJoin()` 之后，`field({ ... })` 结果中被连接表的列类型为 `T | null`；`rightJoin()` 之后主表与之前连接的表为可空，`fullJoin()` 之后全部可空。这记录在构造器的类型上，所以要在同一条链中调用 `field()`：

```ts
const rows = await Db.table(posts)
  .leftJoin(users, 'posts.userId', 'users.id')
  .field({ title: posts.title, author: users.name, editor: users })
  .select()
// { title: string, author: string | null, editor: users 的行 | null }[]
```

不指定 `field()` 时，`Db.table()` 与 drizzle 一样按 **SQL 表名**分组返回：`{ posts: {...}, sys_users: {...} }`（传给 `pgTable()` 的名称，不是变量名）。结果类型不反映这种分组（仍声明为主表的行），所以用 `Db.table()` 联表时**总是写 `field()`**。模型查询总是返回由模型自身的列（加上额外 `field()` 的字段）构造的模型。

## 子查询

任何查询构造器都可以作为子查询：

```ts
// IN (子查询)
await Db.table(users).whereIn('id', Db.table(posts).field('userId').where('views', '>', 100)).select()

// = (子查询)
await Db.table(users).where('id', '=', Db.table(posts).field('userId').where('id', 1)).find()

// EXISTS，用 drizzle 表达式关联外层查询
await Db.table(users).whereExists(Db.table(posts).where(eq(posts.userId, users.id))).select()
```

需要派生表时，`await query.subQuery('alias')` 返回 drizzle 子查询，配合 `Db.drizzle()` 使用。在模型上，[`has()` / `hasWhere()`](./relations#按关联筛选) 会根据关联自动生成这些子查询。

## 合并查询

```ts
await Db.table(users).field('name').unionAll(Db.table(admins).field('name')).select()
```

`union()` 去重，`unionAll()` 保留重复。各查询的字段需要一致。

## 查询缓存

`cache()` 通过[缓存](./cache)模块保存查询结果：

```ts
await Db.table(settings).cache().select()                    // 按 SQL 生成键，永久缓存
await Db.table(settings).cache('10m').select()               // 有效期
await Db.table(users).where('id', 1).cache('user:1', 60).find()  // 指定键
await Cache.forget('user:1')                                 // 写入后清除
```

从缓存读取时会还原日期字段。写入不会自动清除缓存，需要失效时请指定键。

## 新增

```ts
await Db.table(users).insert({ name: 'Ada' })                 // 返回插入的完整记录
await Db.table(logs).insert(entries, { returning: false })    // 只返回插入条数（日志等热路径）
await Db.table(users).insert({ name: 'Ada', code: sql`gen_code()` }) // 值可以是 drizzle SQL 表达式
await Db.table(users).insertAll([{ name: 'Ada' }, { name: 'Bob' }])
const id = await Db.table(users).insertGetId({ name: 'Ada' })
await Db.table(users).insertIgnore(rows)                      // 跳过重复数据，返回实际插入的行数
await Db.table(users).upsert({ email: 'ada@example.com', name: 'Ada' }, { target: 'email' })
await Db.table(users).replace({ id: 1, name: 'Ada' })         // 按主键 upsert
await Db.table(users).save({ id: 1, name: 'Ada' })            // 主键存在时更新，否则插入

// INSERT INTO archive (userId, name) SELECT ...
await Db.table(users).where('status', 0).field({ userId: users.id, name: users.name }).selectInsert(archive)
await query.selectInsert(archive, { ignore: true })           // 跳过违反唯一约束的行
```

`upsert()` 使用 `ON CONFLICT ... DO UPDATE`（PostgreSQL / SQLite，`target` 默认为主键）或 `ON DUPLICATE KEY UPDATE`（MySQL，任意唯一键）。默认更新传入数据中除冲突列以外的全部列，`update` 指定冲突时写入的内容：

```ts
await Db.table(users).upsert(row, { target: 'email', update: ['name'] })   // 这些列，取新数据的值
await Db.table(jobs).upsert(job, {
  target: 'key',
  update: { attempts: sql`${jobs.attempts} + 1`, status: 'queued' },  // 值或表达式；表达式中的列指已存在的行
  where: sql`${jobs.status} <> 'done'`,                                 // ON CONFLICT ... DO UPDATE ... WHERE（PostgreSQL / SQLite）
  returning: true,                                                       // 返回插入 / 更新后的行（PostgreSQL / SQLite）
})
```

MySQL 不支持 `where` 与 `returning`，会抛出 `DatabaseError`。使用 `returning` 时，被 `where` 跳过的行不会返回。

`selectInsert(table, { ignore: true })` 在 PostgreSQL / SQLite 上使用 `ON CONFLICT DO NOTHING`，在 MySQL 上使用 `INSERT IGNORE`。插入的值（`insert()`、`upsert()`、`Model.create()`）可以是 drizzle 的 `sql` 表达式。

## 更新与删除

```ts
await Db.table(users).where('id', 1).update({ name: 'Ada' })
await Db.table(users).update({ id: 1, name: 'Ada' })          // 没有条件时按数据中的主键更新
const rows = await Db.table(users).where('id', 1).update({ name: 'Ada' }, { returning: true }) // 更新后的行（PostgreSQL / SQLite）
await Db.table(posts).where('id', 1).inc('views').dec('stock', 2).exp('title', sql`upper(${posts.title})`).update()
await Db.table(posts).where('id', 1).data({ title: 'New' }).update()
await Db.table(posts).where('id', 1).increment('views')        // 立即执行
await Db.table(users).where('status', 0).delete()
await Db.table(users).delete(1)                                // 按主键
await Db.table(users).delete([1, 2, 3])
```

`update()` 和 `delete()` 返回影响行数，没有任何条件时拒绝执行，除非传入 `{ all: true }`。`update(values, { returning: true })` 改为返回更新后的行（普通对象，模型查询上也一样；MySQL 抛出 `DatabaseError`）。值为 `undefined` 的键会被去掉，可选的输入可以直接传入；去掉后没有数据时抛出 `DatabaseError('update() called without data')`。

它们是单条 SQL：在模型查询上会应用软删除与全局作用域，但不触发模型事件，也不维护模型的时间戳。drizzle 表定义中列级的 `$onUpdate()` / `$onUpdateFn()` 仍然生效——`update()` 与 `upsert()` 的 `DO UPDATE` 部分都会写入——所以定义了 `updatedAt: timestamp().$onUpdate(() => new Date())` 的列不需要手动赋值。

## 其他

- `removeOption('order')` 移除已设置的选项（`where`、`order`、`limit`、`field`、`join`、`group`、`having`、`distinct`、`lock`、`union`、`cache`、`data`），不传参数时全部移除。
- `lock()` 加上 `FOR UPDATE`；`lock('share')`、`lock('no key update')`、`lock('key share')` 与 `{ skipLocked, noWait }` 选择其他模式，见[事务](./transactions#行锁)。
- `Db.execute(sql\`...\`)`（别名 `Db.query`）执行原生 SQL 并返回行数组；`Db.raw('...')` 生成原生 SQL 片段；其他需求可以用 `Db.drizzle()` 拿到 drizzle 实例。

## 暂不支持

ThinkPHP 的少数功能没有对应实现：表前缀与字符串表名（表是 drizzle 对象）、XA 事务、`partition`、`force`（索引提示）和 `procedure`。需要时请使用 `Db.drizzle()` 或原生 SQL。
