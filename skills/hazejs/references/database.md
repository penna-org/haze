# Database (`@hazejs/orm`)

Active Record models, a ThinkPHP-style query builder and a migration runner on top of drizzle. Tables are plain drizzle schemas; models and queries take their column types from them.

Full guides: [Getting Started](../../../docs/guide/database.md) · [Models](../../../docs/guide/models.md) · [Query Builder](../../../docs/guide/query-builder.md) · [Relations](../../../docs/guide/relations.md) · [Transactions](../../../docs/guide/transactions.md) · [Factories](../../../docs/guide/factories.md) · [Deployment](../../../docs/guide/deployment.md)

## Setup and configuration

```ts
// app/provider/DatabaseProvider.ts  (already in the api template)
import { databaseProvider } from '@hazejs/orm'

export default databaseProvider() // reads config/database.ts, also registers the `database` queue driver
```

```ts
// config/database.ts
import { env } from '@hazejs/core'
import { defineDatabaseConfig } from '@hazejs/orm'

export default defineDatabaseConfig(() => ({
  default: 'main',
  connections: {
    main: { driver: 'sqlite', url: env('DATABASE_URL', 'file:./data/app.db'), logging: env('DB_LOGGING', false) },
    analytics: { driver: 'postgres', url: env('ANALYTICS_URL'), schema: 'database/analytics' },
  },
  factories: { locale: 'en' },                       // faker locale for defineFactory
  snowflake: { workerId: Number(env('SNOWFLAKE_WORKER_ID', '0')), datacenterId: Number(env('SNOWFLAKE_DATACENTER_ID', '0')) },
}))
```

Connections open lazily on the first query, survive dev hot reloads, and close on shutdown.

| Connection option | Description |
|---|---|
| `driver` | `sqlite`, `turso`, `d1`, `postgres`, `pglite`, `mysql`, `mongodb` |
| `url` | Connection URL. SQLite: `file:./data/app.db` (relative to project root, dir auto-created), `:memory:`, `libsql://…` |
| `authToken` | libSQL / Turso token |
| `binding` | D1 only: Workers binding name (default `DB`) or a `D1Database` |
| `pool` | `postgres` / `mysql` / `mongodb`: number (default `10`) or `{ max, idleTimeout, connectTimeout }` (timeouts: seconds or `'500ms'`/`'30s'`/`'5m'`) |
| `database` | MongoDB only: database name (defaults to the `url` path) |
| `logging` | Log every SQL statement at debug level |
| `schema` | Drizzle schema dir relative to srcDir (default `database/schema`) |
| `migrations` | Migrations dir (default `database/migrations`, or `database/migrations/<name>` for non-default connections) |
| `read` / `write` / `sticky` | Read/write splitting (below) |

| Driver | Package to install | Notes |
|---|---|---|
| `sqlite` | `@libsql/client` | file, `:memory:`, or `libsql://` |
| `turso` | `@libsql/client` | pure HTTP, edge/serverless friendly, SQLite dialect |
| `d1` | none | Cloudflare Workers binding, SQLite dialect |
| `postgres` | `postgres` | postgres-js |
| `pglite` | `@electric-sql/pglite` | embedded WASM Postgres; `url` is a data dir, omit for in-memory |
| `mysql` | `mysql2` | |
| `mongodb` | `mongodb` | used via `@hazejs/orm/mongo`, no SQL migrations |

Drivers are optional peer deps; a missing one fails on the first query with an install hint. Switching dialect means rewriting `database/schema/*` with `drizzle-orm/pg-core` / `mysql-core`.

### Read/write splitting

```ts
main: {
  driver: 'postgres', // also mysql, sqlite, turso, pglite
  url: env('DATABASE_URL'),
  write: { url: env('DB_WRITE_URL') },
  read: [{ url: env('DB_READ_URL_1') }, { url: env('DB_READ_URL_2') }], // random replica per read
  sticky: true, // after a write in this request, reads go to the primary
  pool: { max: 10, idleTimeout: '30s', connectTimeout: '5s' },
}
```

Primary: inserts/updates/deletes/upserts, `save()`, pivot writes, everything inside transactions, `lock()` reads, `Db.execute()`, `Db.drizzle()`, `model.refresh()`. Replica: `select`, `find`, `count`, `paginate`, `value`, `column`, `exists`, `chunk`, `cursor`, eager loading, `Db.drizzle({ read: true })`.

```ts
await User.onWriter().find(id)
await Db.table(users).useWriter().where('id', id).find()
await Db.useWriter(() => buildReport())              // all reads in callback hit primary
await Db.withinScope(async () => { await order.save(); await Order.find(order.id) }) // sticky scope for jobs/commands
```

## Schemas and migrations

```ts
// database/schema/posts.ts — drizzle only: no `~` alias, no app imports (drizzle-kit reads it directly)
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const posts = sqliteTable('posts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  userId: integer('user_id').notNull(),
  title: text('title').notNull(),
  published: integer('published', { mode: 'boolean' }).notNull().default(false),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
  deletedAt: integer('deleted_at', { mode: 'timestamp' }),
})
```

```bash
haze make:model Post                    # app/model/Post.ts + database/schema/posts.ts (dialect inferred from installed driver)
haze make:model Post --softDelete       # also --table, --dialect sqlite|postgres|mysql|mongodb, --module, --app, --force
haze db:generate --name create_posts    # drizzle-kit diff → database/migrations (--custom for empty SQL, -c <conn>, --module blog)
haze db:migrate                         # pending migrations (-c <conn>, --all)
haze db:seed                            # database/seeders/* in filename order (--file 01-users)
haze make:seeder Users / haze make:factory User
haze make:queue-tables / make:notifications-table / make:auth-tables   # schema files for ORM-backed stores
```

Template scripts: `pnpm db:generate`, `pnpm db:migrate`, `pnpm db:seed`. Migrations are tracked in `__drizzle_migrations` (compatible with `drizzle-kit migrate`).

**Module migrations**: for each connection, every enabled module's migrations run first (in enable order, each tracked in `__drizzle_migrations_<module_snake>`), then the app's. Applies to `db:migrate`, `refreshDatabase()` and production entries.

**Production** (migrations are bundled; no drizzle-kit needed):

| Preset | Command |
|---|---|
| node / bun | `node dist/migrate.mjs` (full-stack: `dist/server/migrate.mjs`), flags `--connection`, `--all` |
| deno | `deno run -A dist/server/migrate.mjs` |
| docker | `docker run --rm <image> node server/migrate.mjs` |
| aws-lambda | handler `index.migrate`, event `{ "connection"?, "all"? }` |
| vercel / netlify | `haze db:migrate` before build, with prod `DATABASE_URL` |
| cloudflare + D1 | `npx wrangler d1 migrations apply <db> --remote -c dist/wrangler.json` |
| cloudflare + Turso | `haze db:migrate` in CI |

**Snowflake IDs** (`@hazejs/orm/columns` is drizzle-only, safe in schema files): `pgSnowflake('id').primaryKey()`, `mysqlSnowflake`, `sqliteSnowflake` (stored as text). Pass `{ auto: false }` for foreign keys. Values are decimal **strings** in JS. `snowflakeId()` / `Snowflake.parse(id)` from `@hazejs/orm`.

## Models

```ts
// app/model/Post.ts
import type { ModelQuery } from '@hazejs/orm'
import { Model } from '@hazejs/orm'
import { posts } from '~/database/schema/posts'
import { Comment } from './Comment'
import { User } from './User'

export class Post extends Model.define(posts) {
  static override softDelete = true          // uses deletedAt
  static override hidden = ['deletedAt']
  static override append = ['excerpt']

  getExcerptAttr(_value: unknown, data: Record<string, unknown>) {   // accessor for appended field
    return String(data.title).slice(0, 20)
  }

  setTitleAttr(value: string) { return value.trim() }               // mutator

  static scopePublished(query: ModelQuery<Post>) { query.where('published', true) }
  static scopeOfAuthor(query: ModelQuery<Post>, userId: number) { query.where('userId', userId) }

  onBeforeDelete() { if (this.published) return false }             // false cancels the write

  author() { return this.belongsTo(User, 'userId') }
  comments() { return this.morphMany(Comment, 'commentable') }
}
```

| Static option | Default | Meaning |
|---|---|---|
| `connection` | default | Connection name |
| `hidden` / `visible` | `[]` | Serialization filter; dotted names (`'posts.title'`) reach into loaded relations |
| `append` | `[]` | Virtual fields (need `getXxxAttr`) |
| `softDelete` | `false` | `true` → `deletedAt`, or a column name |
| `timestamps` | `true` | Maintains `createdAt`/`updatedAt` if present; `{ createdAt: 'addedAt', updatedAt: false }` or `false` |
| `readonly` | `[]` | Written on insert, ignored by later `save()` |
| `optimLock` | `false` | `true` → integer `lockVersion` column; stale save throws `OptimisticLockException` (409) |
| `globalScope` | `[]` | Scope names applied to every query (AND-ed; `orWhere` can't escape) |
| `belongsToTenant` | `false` | Tenant column scope, see [tenancy](../../../docs/guide/tenancy.md) |

There is no `casts` option: value types come from drizzle column modes (`{ mode: 'timestamp' }`, `{ mode: 'boolean' }`, `{ mode: 'json' }`); use `getXxxAttr` / `setXxxAttr` for anything else. `getRaw(key)` bypasses the accessor.

### Active-record API

```ts
await User.find(1)                      // User | undefined
await User.findOrFail(1)                // ModelNotFoundException → 404; return it from a controller as-is
await User.findOrEmpty(id)              // never undefined; .isEmpty()
await User.all(); await User.count()
await User.where('role', 'admin').order('id', 'desc').paginate(1, 20) // { data, total, page, perPage, lastPage }

const user = await User.create({ name: 'Ada', email: 'ada@example.com' })   // events + timestamps
await User.create(input, ['name', 'email'])                                  // allow-list fields
user.name = 'Ada L.'; await user.save()                                      // only dirty columns
await user.save({ name: 'Ada' }); user.fill(data)                            // unknown keys ignored
await user.allowField(['name', 'bio']).save(input)
await user.force().save()                                                    // touch updatedAt with no changes
await post.inc('views').save()                                               // also dec()
await user.delete(); await User.destroy([1, 2, 3]); await User.destroy({ status: 0 })
await User.update({ status: 0 }, { role: 'guest' })   // loads + saves each model (events fire)
await User.saveAll([{ id: 1, name: 'Ada' }, { name: 'Bob' }])   // upsert-ish, in a transaction
user.isDirty('name'); user.getDirty(); user.getOriginal(); user.getData(); await user.refresh(); user.exists
```

Soft deletes: `post.delete()` sets `deletedAt`; `Post.withTrashed()`, `Post.onlyTrashed()`, `post.restore()`, `Post.whereIn('id', ids).restore()`, `post.forceDelete()`, `post.trashed()`.

Scopes: `Post.scope('published')`, `Post.scope('ofAuthor', userId)`, `Post.withoutGlobalScope(['tenant'])`, `Post.withoutGlobalScope()`.

Searchers: `User.withSearch(['name', 'status'], ctx.query())` calls `static searchNameAttr(query, value, data)` when defined, else adds equality for non-empty values.

Events (instance methods, may be async): `onBeforeWrite`, `onAfterWrite`, `onBeforeInsert`, `onAfterInsert`, `onBeforeUpdate`, `onAfterUpdate`, `onBeforeDelete`, `onAfterDelete`, `onBeforeRestore`, `onAfterRestore`. Before-hooks returning `false` cancel (`save()` returns without writing, `delete()` returns `false`). Extension packages can also register `observeModel(Model, (record, hook) => ...)` (runs after the model's own hooks; returns an unsubscribe fn).

Serialization: `toJSON()` / `toArray()` applies accessors, `hidden`, `visible`, `append`, and loaded relations. Per call: `user.hidden(['email'])`, `user.visible(['id', 'name', 'posts.title'])`, `user.append([...])`, `user.hidden(['phone'], true)` (merge). Per query: `User.query().visible(['id', 'name']).select()`.

Errors: `ModelNotFoundException` (404), `UniqueConstraintException` (409, all drivers), `OptimisticLockException` (409).

## Query builder (`Db`)

`Db.table(drizzleTable)` and model queries (`User.where()`, `User.query()`) share one builder; model queries return model instances.

```ts
import { Db } from '@hazejs/orm'
import { sql } from 'drizzle-orm'
import { posts } from '~/database/schema/posts'
import { users } from '~/database/schema/users'

await Db.table(users).where('status', 1).where('age', '>', 18).whereIn('id', [1, 2]).select()
await Db.table(users).where({ role: 'admin', email: null }).find()       // null → IS NULL, array → IN
await Db.table(users).where(q => q.where('a', 1).orWhere('b', 2)).select() // grouped
await Db.table(users).whereRaw('age > ? and status = ?', [18, 1]).select()
await Db.table(articles).where('meta->author->name', 'Ada').field('title', 'meta->city as city').select()
await Db.table(posts).whereTime('createdAt', 'today').count()             // whereDay/Week/Month/Year/BetweenTime
await Post.query().when(keyword, (q, v) => q.whereLike('title', `%${v}%`)).order('id', 'desc').paginate(page, 20)

await Db.table(posts).join(users, 'posts.userId', 'users.id').field('posts.title', 'users.name as author').select()
await Db.table(users).whereIn('id', Db.table(posts).field('userId').where('views', '>', 100)).select() // subquery
await Db.table(settings).cache('10m').select()                           // via the cache module

const id = await Db.table(users).insertGetId({ name: 'Bob', email: 'bob@example.com' })
await Db.table(users).upsert({ email: 'a@x.io', name: 'Ada' }, { target: 'email' })
await Db.table(posts).where('id', 1).inc('views').dec('stock', 2).update()
await Db.table(users).where('status', 0).delete()
await Db.table(logs).delete({ all: true })                                // unconditional writes need { all: true }
const rows = await Db.execute(sql`select count(*) as n from users`)       // always an array (alias Db.query)
const db = await Db.drizzle()                                             // raw drizzle (tx-aware)
await Db.connection('analytics').table(events).count()
```

| Retrieval | Returns |
|---|---|
| `select()` / `selectOrFail()` | rows (404 when empty for `OrFail`) |
| `find()` / `findOrFail()` | first row; models accept a PK |
| `value(col)` / `column(col, key?)` | scalar / array or keyed object |
| `count` `sum` `avg` `max` `min` `exists` | aggregates |
| `paginate(page, perPage = 15)` | `{ data, total, page, perPage, lastPage }` |
| `paginateX(perPage, { lastId, key, sort })` | `{ data, perPage, lastId, hasMore }` (no COUNT) |
| `chunk(size, rows => false?)` / `cursor(size)` / `lazy(size)` | batched processing / async iterator |
| `toSQL()` | SQL + params |

Insert helpers: `insert`, `insertAll`, `insertGetId`, `insertIgnore`, `upsert` (`update: ['col']` to restrict), `replace`, `save`, `selectInsert(table)`. Query `update()` / `delete()` are single statements: they respect soft deletes + global scopes but **skip model events and timestamps**.

## Relations

```ts
// app/model/User.ts
export class User extends Model.define(users) {
  static override hidden = ['password']
  profile() { return this.hasOne(Profile, 'userId').bind(['bio']) }
  posts() { return this.hasMany(Post, 'userId') }
  popularPosts() { return this.hasMany(Post, 'userId').where('views', '>=', 100).order('views', 'desc') }
  roles() { return this.belongsToMany(Role, userRoles, 'roleId', 'userId') } // pivot table, related FK, this FK
}
```

| Method | Signature |
|---|---|
| `hasOne` / `hasMany` | `(Related, foreignKeyOnRelated, localKey?)` |
| `belongsTo` | `(Related, foreignKeyOnThis, ownerKey?)`; `.withDefault({ ... })`, `.associate(m)`, `.dissociate()` |
| `belongsToMany` | `(Related, pivotTable, relatedPivotKey, thisPivotKey)`; `.wherePivot(col, v)` (SQL only) |
| `hasManyThrough` / `hasOneThrough` | `(Related, Through, throughFkToThis, relatedFkToThrough)` (SQL only) |
| `morphOne` / `morphMany` | `(Related, 'commentable', type?)` uses `commentableType` / `commentableId` |
| `morphTo` | `('commentable', { Post, Video })` |

```ts
await user.posts()                                                   // await to load
await user.posts().query().order('id', 'desc').limit(5).select()     // keep building
await User.with('posts', 'posts.comments', 'profile').paginate(1, 20) // eager (no N+1)
await User.with({ posts: q => q.where('status', 1) }).select()       // constraint limits the TOTAL, not per parent
await user.load('posts'); user.getRelation('posts')
await User.withCount('posts').withSum('posts', 'views').select()     // postsCount / postsSum (SQL only)
await User.has('posts', '>=', 3).select(); await User.hasWhere('posts', { status: 1 }).select() // EXISTS (SQL only)

await user.posts().save({ title: 'Hi' })            // sets userId; saveAll([...]); profile().create({...})
await user.roles().attach([1, 2], { grantedBy: admin.id })
await user.roles().detach(2)
const { attached, detached, updated } = await user.roles().sync([1, 3]) // in a transaction
roles[0].getRelation('pivot')
```

## Transactions

Transactions are tracked per connection in `AsyncLocalStorage`: every `Db` / `Model` query in the same async flow joins automatically — never pass a tx object.

```ts
const order = await Db.transaction(async (tx) => {      // tx = drizzle transaction if you need it
  const order = await Order.create({ userId, total })
  const stock = await Db.table(stocks).where('productId', pid).lock().find() // FOR UPDATE; lock('share')
  if (stock!.quantity < 1) throw new Error('Sold out')   // throw → rollback + rethrow
  await Db.table(stocks).where('productId', pid).dec('quantity').update()
  return order
}, { isolationLevel: 'serializable' })

await Db.startTrans()            // manual (ThinkPHP style) — start/commit/rollback in the SAME async function
try { /* ... */ await Db.commit() } catch (e) { await Db.rollback(); throw e }

await User.transaction(async () => { /* model's connection */ })
await Db.connection('analytics').transaction(async () => {})
Db.inTransaction()
```

Nested calls (either style, mixable) use savepoints: an inner failure only undoes inner work. Options (outermost only): `isolationLevel`, `accessMode` (PG/MySQL), `deferrable` (PG), `withConsistentSnapshot` (MySQL), `behavior: 'deferred' | 'immediate' | 'exclusive'` (SQLite).

## Factories

`@faker-js/faker` is an optional dev dependency (lazy-loaded). Factories live in `database/factories` (modules: `modules/<name>/database/factories`).

```ts
// database/factories/PostFactory.ts
import { defineFactory } from '@hazejs/orm'
import { Post } from '~/app/model/Post'
import UserFactory from './UserFactory'

export default defineFactory(Post, ({ faker, sequence }) => ({  // ctx also has n (global counter) and index (position in this call)
  userId: UserFactory,                                  // created + replaced by PK unless overridden / for()
  title: faker.lorem.sentence(),
  slug: attributes => String(attributes.title).toLowerCase().replace(/\W+/g, '-'), // fn runs after plain values
  status: sequence('draft', 'published'),               // cycles; sequence(n => `x${n}`) uses the counter
}))
  .state('published', { status: 'published' })
  .afterCreate(async post => { /* ... */ })             // also .afterMake()
```

```ts
await PostFactory.make() / .make({ title: 'x' }) / .raw()     // unsaved model / plain attributes
await PostFactory.create(); await PostFactory.count(3).create() // array after count()
await UserFactory.createMany([{ name: 'Ada' }, { name: 'Bob' }]); await UserFactory.makeMany(2)
await UserFactory.state('admin').create(); await UserFactory.state({ name: 'Ada' }).create()
await UserFactory.count(4).sequence({ role: 'admin' }, { role: 'member' }).create()
await PostFactory.for(user).create(); await PostFactory.for(UserFactory.state('admin'), 'author').count(3).create()
await CommentFactory.for(post, 'commentable').create()          // morphTo sets type + id
await UserFactory.has(PostFactory.count(3), 'posts').create()   // hasMany/hasOne/morph*/belongsToMany
await PostFactory.hasAttached(TagFactory.count(2), 'tags', { weight: 1 }).create()
await UserFactory.locale('ja').create()
```

Merge order: definition → states → `for()` FKs → overrides. Multi-model `create()` runs in a transaction. Chained methods return new factories.

## Seeders

```ts
// database/seeders/01-users.ts  — default export, runs inside the app
import { Hash } from '@hazejs/core'
import { User } from '~/app/model/User'
import PostFactory from '~/database/factories/PostFactory'
import UserFactory from '~/database/factories/UserFactory'

export default async function seed(): Promise<void> {
  if (!(await User.where('email', 'admin@example.com').exists()))
    await User.create({ name: 'Admin', email: 'admin@example.com', password: await Hash.make('password'), role: 'admin' })
  await UserFactory.count(10).has(PostFactory.count(3), 'posts').create()
}
```

## ORM-backed services

| Feature | Wiring |
|---|---|
| Queue driver | `haze make:queue-tables && haze db:migrate`, then `config/queue.ts`: `database: { driver: 'database', connection: 'main', table: 'jobs', failedTable: 'failed_jobs', retryAfter: '90s' }` (also `sleep`, `maxSleep`). Worker: `haze queue:work --connection database` |
| Notifications `database` channel | `haze make:notifications-table`; `channels: { database: { store: () => databaseNotificationStore(notifications) } }` in `config/notification.ts` |
| Auth stores | `haze make:auth-tables`; `databaseTokenStore(personalAccessTokens)`, `databasePasswordResetStore(...)`, `databaseTwoFactorStore(...)`, `databasePasskeyStore(...)` |
| User provider | `modelUserProvider(() => User, { username: 'email', password: 'password' })` in `config/auth.ts` |

## MongoDB

```ts
// app/model/Article.ts
import { MongoModel } from '@hazejs/orm/mongo'

export interface ArticleDoc { title: string, views: number }
export class Article extends MongoModel.define<ArticleDoc>('articles') {
  static override softDelete = true
}
```

```ts
import { Mongo } from '@hazejs/orm/mongo'
await Article.findOrFail('6650…')                     // string ids → ObjectId
await Article.where('views', '>', 100).paginate(1, 20)
await Mongo.collection('articles').aggregate([...])
await Mongo.transaction(async () => {})               // replica set required
```

No migrations (create indexes via `(await Mongo.db()).collection(...).createIndex()`). Replicas via `readPreference` in the URL.

## Gotchas

- **Schema files import only from `drizzle-orm`** (and `@hazejs/orm/columns`). No `~` alias, no models — drizzle-kit loads them outside Vite.
- **Model statics need `override`** (`static override hidden = [...]`) because they are declared on the base class.
- **Bulk query `update()`/`delete()` skip model events and timestamps**; static `User.update()` / `User.destroy()` / `saveAll()` load and save each model instead. Both refuse to run with no condition unless `{ all: true }`.
- **`find()` on a builder vs model**: `Db.table(t).find()` returns the first row; `User.find(1)` looks up by PK. `findOrFail` throws a 404 exception — fine in controllers, surprising in jobs.
- **Manual `startTrans()`** is bound to the async context of the calling function; calling `commit()` from a different call chain throws. Prefer `Db.transaction()`.
- **D1 has no interactive transactions**: `transaction()` / `startTrans()` throw; use `(await Db.drizzle()).batch([...])`. `saveAll()`, `relation.saveAll()` and `sync()` run without a transaction on D1. `read`/`write` on `d1` or `mongodb` throw.
- **SQLite ignores `lock()`** (no row locks).
- **Eager-load constraints apply to the single batch query** — `limit(3)` inside `with({ posts: q => q.limit(3) })` limits total rows, not per parent.
- `withCount`/`has`/`hasWhere`/`belongsToMany`/`*Through` are SQL-only; factories support `Model` only (not `MongoModel`) and `has()` does not handle `*Through`.
- Factory sequence numbers are process-wide and never reset between tests — use for uniqueness, not exact values. Relation names are guessed from class names; pass them explicitly if code is minified.
- `refreshDatabase()` closes and re-opens the connection, then migrates — it only yields an empty DB with `DATABASE_URL=:memory:` (the template `.env.test`). With read/write splitting it migrates only the writer.
- Snowflake IDs are strings in JS (`sqliteSnowflake` stored as text); never `Number()` them. Configure distinct `workerId`/`datacenterId` per instance.
- Writes do not invalidate `cache()`d queries; use an explicit key and `Cache.forget(key)`.
- `whereRaw`/`whereExp`/`orderRaw`/`fieldRaw` insert strings verbatim — bind values with `?` or `sql\`\``.
