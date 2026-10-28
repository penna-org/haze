# Models

A model wraps one drizzle table. Its fields and their types come straight from the schema, so there is nothing to declare twice.

## Defining models

```ts
// app/model/User.ts
import { Model } from '@hazejs/orm'
import { users } from '~/database/schema/users'

export class User extends Model.define(users) {
  // Never include the password hash in responses
  static override hidden = ['password']
}
```

Instances expose every column as a property (`user.name`, `user.email`), typed from the table.

Generate a model and its schema with `haze make:model`:

```bash
haze make:model Post                     # app/model/Post.ts + database/schema/posts.ts
haze make:model OrderItem --table items  # custom table name (default: order_items)
haze make:model Post --softDelete        # enable soft deletes
haze make:model Article --dialect mongodb
```

| Flag | Description |
|------|-------------|
| `--table` | Table name. Defaults to the plural snake_case of the name |
| `--dialect` | `sqlite`, `postgres`, `mysql` or `mongodb`. Defaults to the driver installed in the project |
| `--softDelete` | Set `softDelete = true` on the model |
| `--app` / `-a` | Multi-app: write to `app/<app>/model` |
| `--force` | Overwrite existing files |

An existing schema file is never overwritten. After editing the schema, run `haze db:generate && haze db:migrate` (see [Getting Started](./database#migrations)).

## Model options

Configure a model with static properties:

| Property | Default | Description |
|----------|---------|-------------|
| `connection` | default connection | Connection name from `config/database.ts` |
| `hidden` | `[]` | Fields left out of `toJSON()`; `'posts.title'` hides a field of a loaded relation |
| `visible` | `[]` | When not empty, only these fields are serialized |
| `append` | `[]` | Virtual fields added to `toJSON()` (each needs a `getXxxAttr` accessor) |
| `softDelete` | `false` | `true` uses the `deletedAt` column; a string names another column |
| `timestamps` | `true` | Maintain `createdAt` / `updatedAt` when those columns exist. Pass `{ createdAt: 'addedAt', updatedAt: false }` to rename or disable one, or `false` to disable both |
| `readonly` | `[]` | Fields written on insert but never updated afterwards |
| `optimLock` | `false` | [Optimistic locking](#optimistic-locking): `true` uses the `lockVersion` column; a string names another column |
| `globalScope` | `[]` | [Global scopes](#global-scopes) applied to every query |

Timestamp values follow the column type: `Date`, string or milliseconds.

## Retrieving models

```ts
const user = await User.find(1)          // User | undefined
const user = await User.findOrFail(1)    // throws ModelNotFoundException (404)
const everyone = await User.all()
const total = await User.count()

const ada = await User.where('email', 'ada@example.com').find()
const admins = await User.where('role', 'admin').order('id', 'desc').select()
```

`findOrFail()` throws a `ModelNotFoundException`, which renders as a `404` response, so a controller can simply `return User.findOrFail(id)`.

### Pagination

```ts
const page = await User.where('role', 'member').order('id', 'desc').paginate(1, 20)
// { data: User[], total, page, perPage, lastPage }
```

`perPage` defaults to `15`. The result is a plain object you can return from a controller as is.

## Building queries

`Model.where()`, `Model.query()` and `Db.table()` all return the same chainable builder; the [Query Builder](./query-builder) page covers joins, subqueries, grouping, JSON fields, time conditions, caching and more. The basics:

```ts
User.where('role', 'admin')                        // =
User.where('id', '>', 10)                          // operator
User.where({ role: 'admin', email: null })         // object: null → IS NULL, array → IN
User.where('id', [1, 2, 3])                        // IN
User.where(q => q.where('role', 'admin').orWhere('id', 1)) // grouped in parentheses
User.where(eq(users.id, 1))                        // any drizzle expression
```

Supported operators: `=`, `!=`, `<>`, `>`, `>=`, `<`, `<=`, `like`, `not like`, `in`, `not in`, `between`, `not between`.

| Method | Description |
|--------|-------------|
| `where` / `orWhere` | Conditions. Multiple `where` calls are joined by AND, `orWhere` by OR, left to right |
| `whereIn` / `whereNotIn` | `IN` / `NOT IN` a list |
| `whereNull` / `whereNotNull` | `IS NULL` / `IS NOT NULL` |
| `whereBetween` / `whereNotBetween` | Range `[min, max]` |
| `whereLike` / `whereNotLike` | `LIKE` pattern |
| `when(value, q => ...)` | Apply the callback only when `value` is not empty |
| `order(column, 'asc' \| 'desc')` | Also `order({ role: 'asc', id: 'desc' })` or a drizzle expression |
| `limit` / `offset` / `page(page, perPage)` | Paging without counting |
| `select()` | Run the query and return all results |
| `find()` / `findOrFail()` | First result (with an id on model queries: find by primary key) |
| `value(column)` / `column(column)` | One value from the first row / all values of a column |
| `count` / `sum` / `avg` / `max` / `min` / `exists` | Aggregates |
| `paginate(page, perPage)` | Page of results plus totals |
| `chunk(size, rows => ...)` | Process large result sets in batches; return `false` to stop |
| `update(values)` / `delete()` | Bulk writes; return the affected row count |
| `increment(column, step)` / `decrement(column, step)` | Atomic counters |
| `toSQL()` | The generated SQL and parameters, for debugging |

See the [Query Builder](./query-builder) for the full list. `Db.table()` is where you would typically use `insert()` / `upsert()` for raw inserts that bypass model events.

A typical filter endpoint:

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

## Creating, updating and deleting

```ts
// Create and save in one step (fires events, sets timestamps)
const user = await User.create({ name: 'Ada', email: 'ada@example.com' })

// Change and save: only modified columns are written
user.name = 'Ada Lovelace'
await user.save()

// Mass assignment: unknown keys are ignored
user.fill({ name: 'Ada', unknown: 1 })
await user.save()

await user.delete()
await User.destroy([1, 2, 3]) // by primary key, returns how many were deleted
```

More ways to write:

```ts
await user.save({ name: 'Ada' })                        // fill and save
await User.create(input, ['name', 'email'])             // only these fields are taken from input
await user.allowField(['name', 'bio']).save(input)      // same, on an instance
await user.force().save()                               // update even if nothing changed (refreshes updatedAt)
await post.inc('views').save()                          // atomic views = views + 1 (also dec())

await User.update({ status: 0 }, { role: 'guest' })     // load matching models and save each one
await User.update({ id: 1, name: 'Ada' })               // by the primary key in the data
await User.saveAll([{ id: 1, name: 'Ada' }, { name: 'Bob' }]) // update or create, in a transaction
await User.destroy({ status: 0 })                       // or destroy(q => q.where('age', '<', 18))

const user = await User.findOrEmpty(id)                 // never undefined
if (user.isEmpty()) { /* ... */ }
```

Static `update()`, `saveAll()` and `destroy()` go through each model, so events, timestamps and soft deletes apply. Run several writes atomically with `User.transaction(...)`, see [Transactions](./transactions).

Other instance helpers: `isDirty(key?)`, `getDirty()`, `getOriginal(key?)`, `getData()`, `refresh()` (reload from the database) and the `exists` getter.

### Read-only fields

```ts
export class User extends Model.define(users) {
  static override readonly = ['email']
}
```

Read-only fields are written when the model is created and ignored by later `save()` calls.

### Optimistic locking

With `optimLock`, every update checks that the row has not changed since it was loaded, and increments a version column:

```ts
export class Article extends Model.define(articles) {
  static override optimLock = true // needs an integer lockVersion column (default 0)
}

const a = await Article.findOrFail(1)
const b = await Article.findOrFail(1)
a.title = 'One'
await a.save()      // lockVersion 0 → 1
b.title = 'Two'
await b.save()      // throws OptimisticLockException (409)
```

Bulk `update()` / `delete()` on a query run as a single statement. They skip model events and timestamps, and refuse to run without a condition unless you pass `{ all: true }`.

## Soft deletes

```ts
// app/model/Post.ts
export class Post extends Model.define(posts) {
  static override softDelete = true // needs a deletedAt column
}
```

```ts
await post.delete()                    // sets deletedAt
await Post.all()                       // excludes deleted rows
await Post.withTrashed().select()      // include them
await Post.onlyTrashed().select()      // only deleted ones
await post.restore()                   // clear deletedAt
await Post.whereIn('id', [1, 2]).restore()   // bulk restore
await post.forceDelete()               // really delete
post.trashed()                         // boolean
```

The schema stubs generated by `make:model` already include a `deletedAt` column.

## Accessors, mutators and appends

Define `getXxxAttr(value, data)` to transform a value when it is read, and `setXxxAttr(value, data)` when it is written:

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

Use `getRaw(key)` to read a value without its accessor. `withAttr('name', (value, data) => ...)` adds an accessor to one instance, or to every result of a query: `User.query().withAttr('name', ...)`.

## Serialization

`toJSON()` (alias `toArray()`) applies accessors, removes `hidden` fields, adds `append` fields and includes loaded relations. Returning a model or a paginated result from a controller serializes it automatically, so the template's `password` column never reaches clients.

Override the settings per instance or per query:

```ts
user.hidden(['email']).toJSON()
user.visible(['id', 'name', 'posts.title']).toJSON()   // dots reach into loaded relations
user.append(['initials']).toJSON()
user.hidden(['phone'], true)                            // true: merge with the model's hidden list

await User.query().visible(['id', 'name']).select()     // applied to every result
```

## Query scopes

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

Extra arguments are forwarded: `scope('ofAuthor', userId)` calls `scopeOfAuthor(query, userId)`.

## Global scopes

List scope names in `globalScope` to apply them to every query of the model, including relation queries:

```ts
export class Post extends Model.define(posts) {
  static override globalScope = ['tenant']

  static scopeTenant(query: ModelQuery<Post>) {
    query.where('tenantId', currentTenantId())
  }
}

await Post.all()                                    // WHERE tenant_id = ?
await Post.withoutGlobalScope(['tenant']).select()  // skip one
await Post.withoutGlobalScope().select()            // skip all
```

Global scopes are combined with your conditions using AND, so an `orWhere()` cannot escape them. They are meant for conditions; ordering or eager loading set in a global scope is ignored.

## Searchers

`withSearch(fields, data)` turns a filter form into conditions. For each field it calls `static searchXxxAttr(query, value, data)` when the model defines one, and otherwise adds an equality condition when the value is not empty:

```ts
export class User extends Model.define(users) {
  static searchNameAttr(query: ModelQuery<User>, value: string) {
    if (value)
      query.whereLike('name', `${value}%`)
  }

  static searchCreatedAtAttr(query: ModelQuery<User>, value: string | undefined) {
    if (value)
      query.whereDay('createdAt', value)
  }
}

// GET /users?name=Ad&status=1&createdAt=2024-05-01
await User.withSearch(['name', 'status', 'createdAt'], ctx.query()).paginate(1, 20)
```

## Model events

Define any of these instance methods (they may be async): `onBeforeWrite`, `onAfterWrite`, `onBeforeInsert`, `onAfterInsert`, `onBeforeUpdate`, `onAfterUpdate`, `onBeforeDelete`, `onAfterDelete`, `onBeforeRestore`, `onAfterRestore`.

```ts
export class Post extends Model.define(posts) {
  onBeforeInsert() {
    this.slug ??= slugify(this.title)
  }

  onBeforeDelete() {
    // Returning false from a before event cancels the write
    if (this.locked)
      return false
  }
}
```

When a before event returns `false`, `save()` returns without writing and `delete()` returns `false`.

## Relationships

Declare relations as methods. This section covers the basics; [Relations](./relations) covers many-to-many, has-many-through, polymorphic relations, eager loading constraints, relation counts and `has()` queries.

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
const posts = await user.posts()                 // await the relation directly
const recent = await user.posts().query().order('id', 'desc').limit(5).select()

// Eager loading avoids N+1 queries; nesting uses dots
const users = await User.with('posts', 'posts.author').paginate(1, 20)
await user.load('posts')
user.getRelation('posts')                        // already loaded result
```

The local / owner key defaults to the primary key and can be passed as the third argument.

```ts
await User.withCount('posts').has('posts', '>=', 3).select()   // see Relations
```

## Errors

- `ModelNotFoundException`: thrown by `findOrFail()`, rendered as `404`.
- `UniqueConstraintException`: duplicate keys on any driver, rendered as `409`.
- `OptimisticLockException`: a stale model was saved under [optimistic locking](#optimistic-locking), rendered as `409`.

## MongoDB

Install `mongodb`, add a connection `{ driver: 'mongodb', url: 'mongodb://…/app' }`, and define models with `@hazejs/orm/mongo`. The API mirrors SQL models:

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

const article = await Article.findOrFail('6650…')  // string ids become ObjectId
await Article.where('views', '>', 100).paginate(1, 20)
await Mongo.collection('articles').aggregate([{ $group: { _id: null, views: { $sum: '$views' } } }])
await Mongo.transaction(async () => { /* requires a replica set */ })
```

MongoDB has no migrations; manage indexes through `(await Mongo.db()).collection(...).createIndex()`. `haze make:model Article --dialect mongodb` generates a model with a document interface.

## Using models for authentication

`modelUserProvider(() => User, { username: 'email', password: 'password' })` lets `config/auth.ts` look users up through a model. See [Authentication](./authentication#user-providers).
