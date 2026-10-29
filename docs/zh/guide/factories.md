# 模型工厂

模型工厂描述如何用假数据构造一个合法的模型。测试用它生成恰好需要的记录，数据填充用它给开发数据库填数据。

```ts
const user = await UserFactory.create()
const admins = await UserFactory.state('admin').count(3).create()
const post = await PostFactory.for(user).has(CommentFactory.count(5), 'comments').create()
```

## 安装

假数据来自 [`@faker-js/faker`](https://fakerjs.dev)，它是 `@hazejs/orm` 的可选依赖。模板中已经安装；其它项目作为开发依赖安装：

```bash
pnpm add -D @faker-js/faker
```

它在第一次使用时才加载，不会进入生产产物。没有安装时工厂照常可用，只有读取 `faker` 时才会抛出提示安装的错误。

## 定义工厂

工厂放在 `database/factories`（本地模块为 `modules/<name>/database/factories`），用命令生成：

```bash
haze make:factory User                 # database/factories/UserFactory.ts
haze make:factory Post --module blog   # modules/blog/database/factories/PostFactory.ts
```

工厂由模型和一个返回属性的函数组成：

```ts
// database/factories/UserFactory.ts
import { defineFactory } from '@hazejs/orm'
import { User } from '~/app/model/User'

export default defineFactory(User, ({ faker, sequence }) => ({
  name: faker.person.fullName(),
  email: sequence(n => `user${n}@example.com`),
}))
  .state('admin', { role: 'admin' })
  .state('unverified', { emailVerifiedAt: null })
```

属性的类型来自模型的表：覆盖值中写错的列名、类型不符的值都会在编译时报错，`state()` 也只接受已定义的状态名。

定义函数收到的上下文：

| 字段 | 说明 |
|------|------|
| `faker` | 按配置语言创建的 faker 实例 |
| `sequence(n => 值)` | 按模型序号生成的值；`sequence('a', 'b', 'c')` 轮流取值 |
| `n` | 序号：该工厂生成的第一个模型为 1，跨调用持续递增 |
| `index` | 本次调用中的位置（`count(3)` 时为 `0`、`1`、`2`） |

### 属性值

除了普通值，属性还可以是：

- **函数**：在普通值确定后调用，参数为这些值，可以是异步函数。
- **另一个工厂**：创建该模型并替换为它的主键。覆盖值、`for()` 或 `has()` 提供了该属性时不会创建。

```ts
export default defineFactory(Post, ({ faker }) => ({
  userId: UserFactory,                                     // 没有指定作者时创建一个
  title: faker.lorem.sentence(),
  slug: attributes => slugify(String(attributes.title)),
}))
```

## 使用工厂

```ts
import UserFactory from '~/database/factories/UserFactory'

await UserFactory.make()                       // 一个 User，未保存
await UserFactory.make({ name: 'Ada' })        // 带覆盖值
await UserFactory.create()                     // 保存（触发事件、维护时间戳）
await UserFactory.count(3).create()            // User[]
await UserFactory.createMany([{ name: 'Ada' }, { name: 'Bob' }])
await UserFactory.createMany(5)
await UserFactory.makeMany(2)
await UserFactory.raw()                        // 只返回属性，适合作为请求体
```

调用过 `count()` 后，`make()`、`create()`、`raw()` 返回数组，否则返回单个值。每个链式方法都返回新的工厂，`UserFactory` 本身不会改变。

`create()` 保存多个模型或带有关联模型时，在一个事务中执行：任何一步失败都不会留下数据。

### 状态

```ts
await UserFactory.state('admin').create()
await UserFactory.state({ name: 'Ada' }).create()
await UserFactory.state((attributes, { n }) => ({ email: `${attributes.name}.${n}@example.com` })).create()

// 同一次调用中轮流应用状态
await UserFactory.count(4).sequence({ role: 'admin' }, { role: 'member' }).create()
```

命名状态在 `defineFactory()` 之后用 `.state(name, value)` 定义，用 `.state(name)` 应用；值为对象，或函数 `(attributes, ctx) => 对象`。

属性按以下顺序合并：定义函数、状态（按应用顺序）、`for()` 填充的外键、传给 `make()` / `create()` 的覆盖值。

### 回调

```ts
export default defineFactory(User, ({ faker }) => ({ name: faker.person.fullName() }))
  .afterMake(user => user.hidden(['email']))
  .afterCreate(async (user) => {
    await user.profile().save({ bio: 'Hello' })
  })
```

`afterMake` 在 `make()` 时执行，`create()` 时也会在保存前执行；`afterCreate` 在模型及其 `has()` 子模型保存之后执行。

## 关联

工厂读取模型上定义的关联，自动填充外键与多态类型。

### 所属：`for()`

```ts
await PostFactory.for(UserFactory).create()              // 创建作者
await PostFactory.for(user).create()                     // 使用已有用户
await PostFactory.for(UserFactory.state('admin'), 'author').count(3).create()
await CommentFactory.for(post, 'commentable').create()   // morphTo：设置 commentableType 与 commentableId
```

关联名默认为父模型类名的小驼峰（`User` → `user`），关联叫别的名字时传入第二个参数。父模型工厂在一次调用中只创建一次，本次调用的所有模型共用它。`make()` 与 `raw()` 同样会创建父模型，因为外键需要真实的 id。

### 一对多 / 一对一：`has()`

```ts
await UserFactory.has(PostFactory.count(3), 'posts').create()
await UserFactory.count(2).has(PostFactory.count(2)).create()   // 由 Post 推断出 'posts'
await UserFactory.has(ProfileFactory, 'profile').create()
await PostFactory.has(ImageFactory.count(2), 'images').create() // morphMany：自动设置类型与 id
```

`has()` 支持 `hasMany`、`hasOne`、`morphMany`、`morphOne` 与 `belongsToMany`。关联名默认为子模型类名复数的小驼峰（`Post` → `posts`）。子模型在父模型之后创建，只有 `create()` 才会创建。

### 多对多：`hasAttached()`

```ts
await PostFactory.hasAttached(TagFactory.count(2), 'tags', { weight: 1 }).create()
await PostFactory.hasAttached(existingTags, 'tags').create()
await PostFactory.hasAttached(TagFactory.count(3), 'tags', tag => ({ weight: tag.id })).create()
```

第三个参数为中间表数据：对象，或以关联模型（及父模型）为参数的函数。

## 语言

在 `config/database.ts` 中统一设置 faker 的语言：

```ts
export default defineDatabaseConfig(() => ({
  default: 'main',
  connections: { /* ... */ },
  factories: {
    locale: 'zh_CN',
  },
}))
```

也可以按工厂设置：`UserFactory.locale('ja').create()`。语言名与 faker 的导出一致（`en`、`en_US`、`de`、`zh_CN`、`zh_TW`、`ja` 等），`zh-CN` 写法同样可用；未知的语言会报错。

## 在数据填充与测试中使用

数据填充在应用内执行，工厂的用法与测试中相同：

```ts
// database/seeders/02-demo.ts
import PostFactory from '~/database/factories/PostFactory'
import UserFactory from '~/database/factories/UserFactory'

export default async function seed(): Promise<void> {
  await UserFactory.count(10).has(PostFactory.count(3), 'posts').create()
}
```

测试中配合 `refreshDatabase()` 使用，见[测试](./testing#模型工厂)。

## 限制

- 工厂只用于 SQL 模型（`Model`），不支持 `MongoModel`。
- `has()` 不支持 `hasManyThrough` / `hasOneThrough`，请逐层用 `has()` 创建中间模型。
- 关联名按类名推断；打包后类名被压缩的代码中请显式传入关联名。
- 序号在进程内按工厂累计，测试之间不会重置；用它保证唯一性，不要依赖具体的值。
