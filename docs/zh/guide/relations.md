# 模型关联

关联是返回关联对象的模型方法。直接 `await` 关联即可得到结果，也可以调用 `.query()` 继续构造查询。

```ts
// app/model/User.ts
export class User extends Model.define(users) {
  posts() {
    return this.hasMany(Post, 'userId')
  }
}

const posts = await user.posts()
const recent = await user.posts().query().order('id', 'desc').limit(5).select()
```

## 定义关联

| 方法 | 示例 | 键 |
|------|------|----|
| `hasOne` | `this.hasOne(Profile, 'userId')` | 关联模型上的外键；本地键默认为主键 |
| `hasMany` | `this.hasMany(Post, 'userId')` | 同 `hasOne` |
| `belongsTo` | `this.belongsTo(User, 'userId')` | 当前模型上的外键；所属键默认为关联模型的主键 |
| `belongsToMany` | `this.belongsToMany(Role, userRoles, 'roleId', 'userId')` | 中间表，以及中间表中指向关联模型、指向当前模型的列 |
| `hasManyThrough` | `this.hasManyThrough(Post, User, 'countryId', 'userId')` | 中间模型、中间模型上指向当前模型的列、关联模型上指向中间模型的列 |
| `hasOneThrough` | `this.hasOneThrough(Passport, User, 'countryId', 'userId')` | 同 `hasManyThrough` |
| `morphOne` / `morphMany` | `this.morphMany(Comment, 'commentable')` | 使用关联模型的 `commentableType` / `commentableId` |
| `morphTo` | `this.morphTo('commentable', { Post, Video })` | 类型字段的值 → 模型类 |

`hasManyThrough` 和 `hasOneThrough` 还可以再传两个可选的键：当前模型上被中间模型的列所指向的键，以及中间模型上被关联模型的列所指向的键，默认都是主键（`this.hasManyThrough(Post, User, 'countryId', 'userId', 'code', 'uuid')`）。

`belongsToMany`、`hasManyThrough` 和 `hasOneThrough` 只用于 SQL 模型，其余也可以用于 MongoDB 模型。

关联可以带上自己的条件，作用于该关联的所有查询：

```ts
popularPosts() {
  return this.hasMany(Post, 'userId').where('views', '>=', 100).order('views', 'desc')
}
```

可用的方法有 `where`、`whereIn`、`order`，以及 `tap(q => ...)`（对关联查询做任意设置）。

## 预加载

预加载用一条查询为一批模型加载关联，避免 N+1 查询。约束作用于这一条查询，所以其中的 `limit()` 限制的是总数，而不是每个父模型各自的数量：

```ts
await User.with('posts', 'posts.comments', 'profile').paginate(1, 20)

// 带约束
await User.with({ posts: q => q.where('status', 1).order('id', 'desc') }, 'profile').select()
await Post.with({ 'author': q => q.field('id', 'name') }, 'author.profile').select()

// 对已有的模型
await user.load('posts', { comments: q => q.where('approved', 1) })
user.getRelation('posts')
```

已加载的关联会包含在 `toJSON()` 中。

## 关联统计

```ts
const users = await User.withCount('posts').withSum('posts', 'views').select()
users[0].getAttr('postsCount')
users[0].getAttr('postsSum')

// 约束与别名
await User.withCount('posts', q => q.where('status', 1), 'publishedCount').select()
await User.withMax('posts', 'views', undefined, 'topViews').select()
```

`withCount`、`withSum`、`withAvg`、`withMax` 和 `withMin` 在每个模型上添加名为 `<关联名>Count`、`<关联名>Sum` 等（或指定别名）的字段，并包含在 `toJSON()` 中。没有关联数据时，count 与 sum 为 `0`，其余为 `null`。仅支持 SQL 模型。

## 按关联筛选

```ts
await User.has('posts').select()                       // 至少一篇文章
await User.has('posts', '>=', 3).select()              // 至少三篇
await User.has('posts', '=', 0).select()               // 没有文章
await User.query().hasNot('posts').select()            // 没有文章
await User.hasWhere('posts', { status: 1 }).select()   // 有满足条件的文章
await User.hasWhere('posts', q => q.where('views', '>', 100)).select()
await User.where('vip', 1).hasWhereOr('orders', { status: 'paid' }).select()
```

它们生成 `EXISTS` / `COUNT` 子查询，可以与其他条件任意组合。仅支持 SQL 模型。

## 多对多

中间表是普通的 drizzle 表：

```ts
// database/schema/userRoles.ts
export const userRoles = sqliteTable('user_roles', {
  userId: integer('user_id').notNull(),
  roleId: integer('role_id').notNull(),
  grantedBy: integer('granted_by'),
}, table => [primaryKey({ columns: [table.userId, table.roleId] })])

// app/model/User.ts
roles() {
  return this.belongsToMany(Role, userRoles, 'roleId', 'userId')
}
```

```ts
const roles = await user.roles()
roles[0].getRelation('pivot')               // { userId, roleId, grantedBy }

await user.roles().attach(1)
await user.roles().attach([1, 2], { grantedBy: admin.id })
await user.roles().attach({ 1: { grantedBy: 7 } })
await user.roles().detach(2)                 // detach() 移除全部
const { attached, detached, updated } = await user.roles().sync([1, 3])
await user.roles().save({ name: 'editor' }, { grantedBy: 7 }) // 创建角色并关联

await User.with('roles').withCount('roles').select()
```

在关联定义中用 `wherePivot()` 按中间表字段过滤：

```ts
activeRoles() {
  return this.belongsToMany(Role, userRoles, 'roleId', 'userId').wherePivot('active', 1)
}
```

`sync()` 添加缺少的关联、移除多余的关联（第二个参数传 `false` 时保留），并更新以对象形式传入的中间表数据，整个过程在事务中执行。

## 通过关联写入

```ts
await user.posts().save({ title: 'Hello' })          // 自动设置 userId
await user.posts().saveAll([{ title: 'A' }, { title: 'B' }])
await user.profile().create({ bio: '...' })
await post.images().save({ url: 'cover.png' })       // morphMany 自动设置类型与 id

await post.author().associate(user)                  // 设置 post.userId 并保存 post
await post.author().dissociate()
await comment.commentable().associate(video)         // morphTo
```

## 多态关联

```ts
// comments: id, body, commentableType, commentableId
export class Post extends Model.define(posts) {
  comments() {
    return this.morphMany(Comment, 'commentable')     // commentableType = 'Post'
  }
}

export class Comment extends Model.define(comments) {
  commentable() {
    return this.morphTo('commentable', { Post, Video })
  }
}

await Comment.with('commentable').select()           // 每条评论得到对应的 Post 或 Video
```

类型字段默认保存父模型的类名；需要保存其他值时传第三个参数（`this.morphMany(Comment, 'commentable', 'post')`），并在 `morphTo` 的映射中使用相同的键。字段名不是 `xxxType` / `xxxId` 时传 `['type', 'targetId']`。

## 绑定字段与默认值

`bind()` 用于 `hasOne`、`belongsTo`、`morphOne` 和 `morphTo`；`withDefault()` 用于这些关联以及 `hasOneThrough`：

```ts
profile() {
  // 序列化时把 profile.bio 输出为 user.bio，而不是嵌套 profile
  return this.hasOne(Profile, 'userId').bind(['bio'])          // 或 bind({ about: 'bio' })
}

author() {
  // 关联不存在时返回一个空的 User（带默认数据），而不是 null
  return this.belongsTo(User, 'userId').withDefault({ name: 'Guest' })
}
```
