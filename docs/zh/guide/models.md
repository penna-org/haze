# 模型与查询

一个模型对应一张 drizzle 表，字段和类型直接来自表结构，不需要重复声明。

## 定义模型

```ts
// app/model/User.ts
import { Model } from '@hazejs/orm'
import { users } from '~/database/schema/users'

export class User extends Model.define(users) {
  // 序列化（接口返回）时隐藏密码哈希
  static override hidden = ['password']
}
```

实例上可以直接访问每一列（`user.name`、`user.email`），类型由表结构推导。

用 `haze make:model` 同时生成模型和表结构：

```bash
haze make:model Post                     # app/model/Post.ts + database/schema/posts.ts
haze make:model OrderItem --table items  # 自定义表名（默认 order_items）
haze make:model Post --softDelete        # 启用软删除
haze make:model Article --dialect mongodb
```

| 参数 | 说明 |
|------|------|
| `--table` | 表名，默认为名称的复数下划线形式 |
| `--dialect` | `sqlite`、`postgres`、`mysql` 或 `mongodb`，默认按项目已安装的驱动推断 |
| `--softDelete` | 在模型上设置 `softDelete = true` |
| `--app` / `-a` | 多应用：生成到 `app/<app>/model` |
| `--force` | 文件已存在时覆盖 |

已存在的表结构文件不会被覆盖。修改表结构后执行 `haze db:generate && haze db:migrate`（见[快速开始](./database#迁移)）。

## 模型配置

通过静态属性配置模型：

| 属性 | 默认值 | 说明 |
|------|--------|------|
| `connection` | 默认连接 | `config/database.ts` 中的连接名 |
| `hidden` | `[]` | `toJSON()` 时隐藏的字段 |
| `append` | `[]` | `toJSON()` 时追加的虚拟字段（需要定义对应的 `getXxxAttr`） |
| `softDelete` | `false` | `true` 使用 `deletedAt` 列，传字符串则使用指定列 |
| `timestamps` | `true` | 列存在时自动维护 `createdAt` / `updatedAt`。`{ createdAt: 'addedAt', updatedAt: false }` 可改名或关闭其中一个，`false` 全部关闭 |

时间戳按列类型写入 `Date`、字符串或毫秒数。

## 查询模型

```ts
const user = await User.find(1)          // User | undefined
const user = await User.findOrFail(1)    // 不存在时抛出 ModelNotFoundException（404）
const everyone = await User.all()
const total = await User.count()

const ada = await User.where('email', 'ada@example.com').find()
const admins = await User.where('role', 'admin').order('id', 'desc').select()
```

`findOrFail()` 抛出的 `ModelNotFoundException` 会渲染为 `404`，所以控制器里直接 `return User.findOrFail(id)` 即可。

### 分页

```ts
const page = await User.where('role', 'member').order('id', 'desc').paginate(1, 20)
// { data: User[], total, page, perPage, lastPage }
```

`perPage` 默认为 `15`。返回值是普通对象，可以直接作为控制器的返回值。

## 构造查询

`Model.where()`、`Model.query()` 和 `Db.table()` 返回的是同一个链式查询构造器。条件写法：

```ts
User.where('role', 'admin')                        // 等于
User.where('id', '>', 10)                          // 运算符
User.where({ role: 'admin', email: null })         // 对象：null 为 IS NULL，数组为 IN
User.where('id', [1, 2, 3])                        // IN
User.where(q => q.where('role', 'admin').orWhere('id', 1)) // 括号分组
User.where(eq(users.id, 1))                        // 任意 drizzle 表达式
```

支持的运算符：`=`、`!=`、`<>`、`>`、`>=`、`<`、`<=`、`like`、`not like`、`in`、`not in`、`between`、`not between`。

| 方法 | 说明 |
|------|------|
| `where` / `orWhere` | 条件。多次 `where` 以 AND 连接，`orWhere` 以 OR 连接，从左到右组合 |
| `whereIn` / `whereNotIn` | `IN` / `NOT IN` 列表 |
| `whereNull` / `whereNotNull` | `IS NULL` / `IS NOT NULL` |
| `whereBetween` / `whereNotBetween` | 区间 `[min, max]` |
| `whereLike` / `whereNotLike` | `LIKE` 匹配 |
| `when(value, q => ...)` | `value` 非空时才执行回调 |
| `order(column, 'asc' \| 'desc')` | 也可以 `order({ role: 'asc', id: 'desc' })` 或传 drizzle 表达式 |
| `limit` / `offset` / `page(page, perPage)` | 不统计总数的分页 |
| `select()` | 执行查询，返回全部结果 |
| `find()` / `findOrFail()` | 第一条结果（模型查询传入 id 时按主键查找） |
| `value(column)` / `column(column)` | 第一行的某个值 / 某一列的全部值 |
| `count` / `sum` / `avg` / `max` / `min` / `exists` | 聚合 |
| `paginate(page, perPage)` | 分页结果与总数 |
| `chunk(size, rows => ...)` | 分批处理大量数据，回调返回 `false` 时停止 |
| `update(values)` / `delete()` | 批量写入，返回影响行数 |
| `increment(column, step)` / `decrement(column, step)` | 原子自增 / 自减 |
| `toSQL()` | 生成的 SQL 与参数，调试用 |

`field(...columns)`（只查询指定列）以及 `insert()` / `insertGetId()`（不经过模型事件的插入）通常配合 `Db.table()` 使用。

一个典型的筛选接口：

```ts
// app/controller/PostController.ts
index(ctx: HttpContext) {
  const keyword = ctx.query('q')
  return Post.query()
    .when(keyword, (q, value) => q.whereLike('title', `%${value}%`))
    .order('id', 'desc')
    .paginate(Number(ctx.query('page') ?? 1), 20)
}
```

## 新增、修改与删除

```ts
// 创建并保存（触发事件、写入时间戳）
const user = await User.create({ name: 'Ada', email: 'ada@example.com' })

// 修改后保存：只更新修改过的列
user.name = 'Ada Lovelace'
await user.save()

// 批量赋值：表中不存在的字段会被忽略
user.fill({ name: 'Ada', unknown: 1 })
await user.save()

await user.delete()
await User.destroy([1, 2, 3]) // 按主键删除，返回删除数量
```

其他实例方法：`isDirty(key?)`、`getDirty()`、`getOriginal(key?)`、`refresh()`（从数据库重新读取），以及 `exists` 属性。

查询上的批量 `update()` / `delete()` 是一条 SQL 语句：不触发模型事件、不维护时间戳；没有任何条件时会拒绝执行，除非传入 `{ all: true }`。

## 软删除

```ts
// app/model/Post.ts
export class Post extends Model.define(posts) {
  static override softDelete = true // 需要 deletedAt 列
}
```

```ts
await post.delete()                    // 写入 deletedAt
await Post.all()                       // 自动排除已删除的数据
await Post.withTrashed().select()      // 包含已删除的数据
await Post.onlyTrashed().select()      // 只查已删除的数据
await post.restore()                   // 清空 deletedAt
await Post.whereIn('id', [1, 2]).restore()   // 批量恢复
await post.forceDelete()               // 物理删除
post.trashed()                         // boolean
```

`make:model` 生成的表结构已经带有 `deletedAt` 列。

## 访问器、修改器与追加字段

定义 `getXxxAttr(value, data)` 在读取时转换值，定义 `setXxxAttr(value, data)` 在写入时转换值：

```ts
// app/model/User.ts
export class User extends Model.define(users) {
  static override hidden = ['password']
  static override append = ['initials']

  setEmailAttr(value: string) {
    return value.trim().toLowerCase()
  }

  getInitialsAttr(_value: unknown, data: Record<string, unknown>) {
    return String(data.name).split(' ').map(part => part[0]).join('')
  }
}
```

需要跳过访问器读取原始值时用 `getRaw(key)`。

## 序列化

`toJSON()` 会应用访问器、去掉 `hidden` 字段、加上 `append` 字段，并包含已加载的关联。控制器返回模型或分页结果时会自动序列化，所以模板中的 `password` 列不会出现在响应里。

## 查询作用域

```ts
// app/model/Post.ts
import type { ModelQuery } from '@hazejs/orm'

export class Post extends Model.define(posts) {
  static scopePublished(query: ModelQuery<Post>) {
    query.where('published', true)
  }
}

await Post.scope('published').order('id', 'desc').paginate(1, 20)
```

多余的参数会透传：`scope('ofAuthor', userId)` 调用 `scopeOfAuthor(query, userId)`。

## 模型事件

在模型上定义以下实例方法即可（可以是异步的）：`onBeforeWrite`、`onAfterWrite`、`onBeforeInsert`、`onAfterInsert`、`onBeforeUpdate`、`onAfterUpdate`、`onBeforeDelete`、`onAfterDelete`、`onBeforeRestore`、`onAfterRestore`。

```ts
export class Post extends Model.define(posts) {
  onBeforeInsert() {
    this.slug ??= slugify(this.title)
  }
}
```

## 关联

关联定义为返回 `hasMany`、`hasOne` 或 `belongsTo` 的方法：

```ts
// app/model/User.ts
export class User extends Model.define(users) {
  posts() {
    return this.hasMany(Post, 'userId')
  }
}

// app/model/Post.ts
export class Post extends Model.define(posts) {
  author() {
    return this.belongsTo(User, 'userId')
  }
}
```

```ts
const posts = await user.posts()                 // 直接 await 关联
const recent = await user.posts().query().order('id', 'desc').limit(5).select()

// 预加载，避免 N+1 查询；用点号嵌套
const users = await User.with('posts', 'posts.author').paginate(1, 20)
await user.load('posts')
user.getRelation('posts')                        // 已加载的结果
```

本地键 / 所属键默认为主键，可以通过第三个参数指定。

## 异常

- `ModelNotFoundException`：`findOrFail()` 抛出，渲染为 `404`。
- `UniqueConstraintException`：任意驱动的唯一键冲突，渲染为 `409`。

## MongoDB

安装 `mongodb`，添加连接 `{ driver: 'mongodb', url: 'mongodb://…/app' }`，然后用 `@hazejs/orm/mongo` 定义模型，API 与 SQL 模型一致：

```ts
// app/model/Article.ts
import { MongoModel } from '@hazejs/orm/mongo'

export interface ArticleDoc {
  title: string
  views: number
}

export class Article extends MongoModel.define<ArticleDoc>('articles') {
  static override softDelete = true
}
```

```ts
import { Mongo } from '@hazejs/orm/mongo'

const article = await Article.findOrFail('6650…')  // 字符串 id 自动转为 ObjectId
await Article.where('views', '>', 100).paginate(1, 20)
await Mongo.collection('articles').aggregate([{ $group: { _id: null, views: { $sum: '$views' } } }])
await Mongo.transaction(async () => { /* 需要副本集 */ })
```

MongoDB 没有迁移，索引通过 `(await Mongo.db()).collection(...).createIndex()` 管理。`haze make:model Article --dialect mongodb` 会生成带文档接口的模型。

## 用模型做认证

`modelUserProvider(() => User, { username: 'email', password: 'password' })` 让 `config/auth.ts` 通过模型查找用户，见[认证](./authentication#用户来源)。
