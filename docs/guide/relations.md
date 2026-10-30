# Relations

Relations are model methods that return a relation object. Await the relation to load it, or call `.query()` to keep building.

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

## Defining relations

| Method | Example | Keys |
|--------|---------|------|
| `hasOne` | `this.hasOne(Profile, 'userId')` | foreign key on the related model; local key defaults to the primary key |
| `hasMany` | `this.hasMany(Post, 'userId')` | same as `hasOne` |
| `belongsTo` | `this.belongsTo(User, 'userId')` | foreign key on this model; owner key defaults to the related primary key |
| `belongsToMany` | `this.belongsToMany(Role, userRoles, 'roleId', 'userId')` | pivot table, then its columns pointing to the related model and to this model |
| `hasManyThrough` | `this.hasManyThrough(Post, User, 'countryId', 'userId')` | through model, its column pointing here, the related column pointing to it |
| `hasOneThrough` | `this.hasOneThrough(Passport, User, 'countryId', 'userId')` | same as `hasManyThrough` |
| `morphOne` / `morphMany` | `this.morphMany(Comment, 'commentable')` | uses `commentableType` / `commentableId` on the related model |
| `morphTo` | `this.morphTo('commentable', { Post, Video })` | maps stored type values to model classes |

`hasManyThrough` and `hasOneThrough` take two more optional keys: the key on this model that the through model's column points to, and the key on the through model that the related model's column points to, both defaulting to the primary key (`this.hasManyThrough(Post, User, 'countryId', 'userId', 'code', 'uuid')`).

`belongsToMany`, `hasManyThrough` and `hasOneThrough` are available on SQL models; the others work on MongoDB models too.

Relations can carry their own conditions, applied to every query of that relation:

```ts
popularPosts() {
  return this.hasMany(Post, 'userId').where('views', '>=', 100).order('views', 'desc')
}
```

`where`, `whereIn`, `order` and `tap(q => ...)` (anything else on the related query) are available.

## Eager loading

Eager loading fetches a relation for many models in one query, avoiding N+1 queries. A constraint applies to that single query, so `limit()` in it limits the total, not each parent:

```ts
await User.with('posts', 'posts.comments', 'profile').paginate(1, 20)

// With constraints
await User.with({ posts: q => q.where('status', 1).order('id', 'desc') }, 'profile').select()
await Post.with({ 'author': q => q.field('id', 'name') }, 'author.profile').select()

// On models you already have
await user.load('posts', { comments: q => q.where('approved', 1) })
user.getRelation('posts')
```

Loaded relations are included in `toJSON()`.

## Counting and aggregating relations

```ts
const users = await User.withCount('posts').withSum('posts', 'views').select()
users[0].getAttr('postsCount')
users[0].getAttr('postsSum')

// constraint and alias
await User.withCount('posts', q => q.where('status', 1), 'publishedCount').select()
await User.withMax('posts', 'views', undefined, 'topViews').select()
```

`withCount`, `withSum`, `withAvg`, `withMax` and `withMin` add a field named `<relation>Count`, `<relation>Sum`, ... (or your alias) to each model, included in `toJSON()`. Relations without rows give `0` for count and sum, `null` otherwise. SQL models only.

## Querying relation existence

```ts
await User.has('posts').select()                       // at least one post
await User.has('posts', '>=', 3).select()              // at least three
await User.has('posts', '=', 0).select()               // none
await User.query().hasNot('posts').select()            // none
await User.hasWhere('posts', { status: 1 }).select()   // a post matching the condition
await User.hasWhere('posts', q => q.where('views', '>', 100)).select()
await User.where('vip', 1).hasWhereOr('orders', { status: 'paid' }).select()
```

These compile to `EXISTS` / `COUNT` subqueries, so they combine freely with the rest of the query. SQL models only.

## Many-to-many

The pivot table is a regular drizzle table:

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
await user.roles().detach(2)                 // or detach() for all
const { attached, detached, updated } = await user.roles().sync([1, 3])
await user.roles().save({ name: 'editor' }, { grantedBy: 7 }) // create the role and attach it

await User.with('roles').withCount('roles').select()
```

Filter on pivot columns with `wherePivot()` in the relation definition:

```ts
activeRoles() {
  return this.belongsToMany(Role, userRoles, 'roleId', 'userId').wherePivot('active', 1)
}
```

`sync()` adds missing rows, removes the others (pass `false` as the second argument to keep them) and updates pivot data given as an object. It runs in a transaction.

## Writing through relations

```ts
await user.posts().save({ title: 'Hello' })          // sets userId
await user.posts().saveAll([{ title: 'A' }, { title: 'B' }])
await user.profile().create({ bio: '...' })
await post.images().save({ url: 'cover.png' })       // morphMany sets type and id

await post.author().associate(user)                  // sets post.userId and saves the post
await post.author().dissociate()
await comment.commentable().associate(video)         // morphTo
```

## Polymorphic relations

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

await Comment.with('commentable').select()           // each comment gets its Post or Video
```

The stored type defaults to the parent class name; pass a third argument (`this.morphMany(Comment, 'commentable', 'post')`) to store something else, and use the same keys in the `morphTo` map. Pass `['type', 'targetId']` instead of a name to use other columns.

## Binding fields and defaults

`bind()` is available on `hasOne`, `belongsTo`, `morphOne` and `morphTo`; `withDefault()` on those and `hasOneThrough`:

```ts
profile() {
  // Serialize profile.bio as user.bio instead of nesting the profile
  return this.hasOne(Profile, 'userId').bind(['bio'])          // or bind({ about: 'bio' })
}

author() {
  // An empty User (with defaults) instead of null
  return this.belongsTo(User, 'userId').withDefault({ name: 'Guest' })
}
```
