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
| `driver` | `sqlite`, `turso`, `d1`, `postgres`, `node-postgres`, `pglite`, `mysql`, `mongodb` |
| `url` | Connection URL. SQLite: `file:./data/app.db` (relative to project root, dir auto-created), `:memory:`, `libsql://…` |
| `authToken` | libSQL / Turso token |
| `binding` | D1 only: Workers binding name (default `DB`) or a `D1Database` |
| `pool` | `postgres` / `mysql` / `mongodb`: number (default `10`) or `{ max, idleTimeout, connectTimeout }` (timeouts: seconds or `'500ms'`/`'30s'`/`'5m'`) |
| `database` | MongoDB only: database name (defaults to the `url` path) |
| `logging` | Log every SQL statement at debug level |
| `schema` | Drizzle schema dir relative to srcDir (default `database/schema`) |
| `migrations` | Migrations dir (default `database/migrations`, or `database/migrations/<name>` for non-default connections) |
| `read` / `write` / `sticky` | Read/write splitting (below) |
| `casing` | `'snake_case'` / `'camelCase'` for columns declared without a name; must match migration generation (`haze db:generate` passes it) |
| `timezone` | PostgreSQL session time zone (`postgres`, `node-postgres`, `pglite`) |
| `client` | An existing `PGlite` / `pg.Pool` / postgres-js instance; the app never closes it (share one in-memory DB between test apps) |

| Driver | Package to install | Notes |
|---|---|---|
| `sqlite` | `@libsql/client` | file, `:memory:`, or `libsql://` |
| `turso` | `@libsql/client` | pure HTTP, edge/serverless friendly, SQLite dialect |
| `d1` | none | Cloudflare Workers binding, SQLite dialect |
| `postgres` | `postgres` | postgres-js |
| `node-postgres` | `pg` | node-postgres (drizzle's default PG driver) |
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
await Db.table(users).useWriter().where('id', id).find()   // useWriter(false) undoes it
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

Template scripts: `pnpm db:generate`, `pnpm db:migrate`, `pnpm db:seed`. Migrations are tracked in `__drizzle_migrations` (compatible with `drizzle-kit migrate`). `make:model` never overwrites an existing schema file; `--table` defaults to plural snake_case (`OrderItem` → `order_items`).

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
| `hidden` / `visible` | `[]` | Serialization filter; dotted names (`'posts.title'`) reach into loaded relations. Non-empty `visible` = allow-list |
| `append` | `[]` | Virtual fields (need `getXxxAttr`) |
| `softDelete` | `false` | `true` → `deletedAt`, or a column name (must exist, else throws) |
| `timestamps` | `true` | Maintains `createdAt`/`updatedAt` if present (missing columns silently ignored); `{ createdAt: 'addedAt', updatedAt: false }` or `false` |
| `readonly` | `[]` | Written on insert, ignored by later `save()` (in-memory change reverted after save) |
| `optimLock` | `false` | `true` → integer `lockVersion` column, or a column name; stale save throws `OptimisticLockException` (409) |
| `globalScope` | `[]` | Scope names applied to every query incl. relation queries (AND-ed; `orWhere` can't escape; order/eager-load inside a global scope is ignored) |
| `belongsToTenant` | `false` | `true` → `tenantId` column, or a name: global scope `'tenant'` + filled on create, see [tenancy](../../../docs/guide/tenancy.md) |

There is no `casts` option: value types come from drizzle column modes (`{ mode: 'timestamp' }`, `{ mode: 'boolean' }`, `{ mode: 'json' }`); use `getXxxAttr` / `setXxxAttr` for anything else. Column properties (`post.title`) go **through** the accessor/mutator (they call `getAttr`/`setAttr`); `getRaw(key)` bypasses the accessor. Timestamps are written in the column's type (`Date`, string or ms). `bigint` values serialize as strings in `toJSON()`.

### Static entry points

`Model.query()` returns a `ModelQuery<M>` (the full builder below, results are models). Statics that start one: `where(...)` (own column keys only — no `'posts.x'` / `'meta->x'` paths), `whereIn(col, list)`, `order(col, dir = 'asc')` (single column), `with`, `withCount`, `has`, `hasWhere`, `scope`, `withSearch`, `withoutGlobalScope`, `withTrashed`, `onlyTrashed`, `onWriter`. Terminal statics: `find/findOrFail/findOrEmpty(id)`, `all()`, `paginate(page?, perPage?)`, `count()` (no column), `transaction(fn, config?)`, `create`, `update`, `updateById`, `saveAll`, `destroy`. Anything else (`field`, `lock`, `max`, `withSum`, `hasNot`, `hasWhereOr`, `visible`, `whereLike`, …) → start with `Model.query()`.

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
await post.inc('views').save()                                               // also dec(); views = views + 1 in SQL
await user.delete(); await User.destroy([1, 2, 3]); await User.destroy({ status: 0 })
await User.destroy(q => q.where('age', '<', 18))                             // returns count deleted
await User.update({ status: 0 }, { role: 'guest' })   // loads + saves each model (events fire; N+1, not atomic)
await User.update({ id: 1, name: 'Ada' })             // no condition: PK taken from the data
await User.updateById(id, { body: bigJson })          // one UPDATE by PK: updatedAt + lock version, no events, no select
await User.updateById([1, 2], { status: 0 })
await User.saveAll([{ id: 1, name: 'Ada' }, { name: 'Bob' }])   // upsert-ish, in a transaction; returns models
user.isDirty('name'); user.getDirty(); user.getOriginal(); user.getData(); await user.refresh(); user.exists
```

| Pick the write | Events | Timestamps / readonly | Statements |
|---|---|---|---|
| `model.save()` / `Model.create()` | yes | yes | 1 |
| `Model.update(data, where)` / `Model.destroy(ids)` / `saveAll` | yes | yes | select + 1 per row |
| `Model.updateById(id \| ids, data)` | no | `updatedAt` set, readonly dropped, lock version +1 (not checked) | 1 |
| `Model.where(...).update(data)` / `.delete()` | no | no (drizzle `$onUpdate` still applies) | 1, returns affected count |

| Instance member | Notes |
|---|---|
| `exists` (getter) / `isEmpty()` | persisted? / blank model from `findOrEmpty()` |
| `getKey()` | PK value |
| `getAttr(key)` / `setAttr(key, v)` | through accessor / mutator; use `getAttr('postsCount')` for query-added fields (no typed property) |
| `getRaw(key)` / `getData()` | raw value / all raw attributes (typed as table row, includes extra selected fields) |
| `fill(data)` | mass-assign; ignores non-columns and keys outside `allowField()` |
| `isDirty(key?)` / `getDirty()` / `getOriginal(key?)` | change tracking since load/last save (shallow: mutating a JSON object in place is **not** dirty — assign a new object) |
| `withAttr(name, (v, data) => …)` / `withAttr({ … })` | per-instance dynamic accessor (wins over `getXxxAttr`) |
| `refresh()` | reload from primary; throws `DatabaseError` if the row is gone |
| `delete()` → `boolean` / `forceDelete()` / `restore()` / `trashed()` | soft-delete aware |
| `load(...)` / `getRelation(name)` / `hasRelation(name)` / `setRelation(name, v)` | relations |
| `hidden(f, merge?)` / `visible(f, merge?)` / `append(f, merge?)` / `toJSON()` (= `toArray()`) | serialization |

**`save()` details**: new model → `onBeforeWrite` → tenant id filled → `onBeforeInsert` → `createdAt`/`updatedAt` filled if null (app clock) → `optimLock` column set to `0` only if it has no DB default → INSERT (returned row merged back) → `onAfterInsert` → `onAfterWrite`. Existing model → `onBeforeWrite` → if dirty / `inc()` / `force()`: `onBeforeUpdate` → `updatedAt` → `UPDATE … WHERE pk = ? [AND lockVersion = old]` → 0 rows with optimLock throws → `onAfterUpdate`; then `onAfterWrite` (runs even when nothing changed). `delete()`: `onBeforeDelete` → soft (sets column) or hard → `onAfterDelete`; `forceDelete()` fires the same delete hooks. `restore()`: `onBeforeRestore` / `onAfterRestore`.

**Soft deletes**: `post.delete()` sets `deletedAt`; default queries add `deletedAt IS NULL`. `Post.withTrashed()`, `Post.onlyTrashed()`, `post.restore()`, `post.forceDelete()`, `post.trashed()`. Bulk: `Post.whereIn('id', ids).restore()` / `.restore({ all: true })` (returns count, `0` if model has no soft delete), `Post.query().delete([1, 2])` (soft), `Post.withTrashed().forceDelete(ids | { all: true })` (hard; without `withTrashed()` already-trashed rows are skipped). `delete()` on an `onlyTrashed()` query is a hard delete.

**Scopes**: `Post.scope('published')`, `Post.scope('ofAuthor', userId)` → `static scopeOfAuthor(query, userId)` (unknown name throws `TypeError`). `Post.withoutGlobalScope(['tenant'])`, `Post.withoutGlobalScope()` (all, including tenant).

**Searchers**: `User.withSearch(['name', 'status'], ctx.query())` calls `static searchNameAttr(query, value, data)` when defined, else adds equality for values other than `undefined`/`null`/`''`.

```ts
static searchNameAttr(query: ModelQuery<User>, value: string | undefined) { if (value) query.whereLike('name', `${value}%`) }
static searchCreatedAtAttr(query: ModelQuery<User>, value: string | undefined) { if (value) query.whereDay('createdAt', value) }
```

**Events** (instance methods, may be async): `onBeforeWrite`, `onAfterWrite`, `onBeforeInsert`, `onAfterInsert`, `onBeforeUpdate`, `onAfterUpdate`, `onBeforeDelete`, `onAfterDelete`, `onBeforeRestore`, `onAfterRestore`. Before-hooks returning `false` cancel (`save()` returns without writing, `delete()` returns `false`). Extension packages can also register `observeModel(Model, (record, hook) => ...)` (runs after the model's own hook, applies to subclasses, returning `false` from a before-hook cancels too; returns an unsubscribe fn). No events from query-level `update()`/`delete()`/`insert()` or `updateById()`.

**Serialization**: `toJSON()` / `toArray()` applies accessors, `hidden`, `visible`, `append`, and loaded relations (and `bind()`-flattened fields). Per call: `user.hidden(['email'])`, `user.visible(['id', 'name', 'posts.title'])`, `user.append([...])`, `user.hidden(['phone'], true)` (merge with static list). Per query: `User.query().visible(['id', 'name']).select()` (also `.hidden()`, `.append()`, `.withAttr()`). Returning a model / array / paginate result from a controller serializes it.

`user.getData()` is typed as the table row. `Model.create()` / `insert()` values may be drizzle `sql` expressions (the returned model holds stored values). `optimLock` leaves the version column to its DB default on create.

Errors: `ModelNotFoundException` (404), `UniqueConstraintException` (409, `code: 'unique_violation'`, all drivers; carries `constraint` / `table` / `columns` / `detail` from the driver; message translated via `http.unique_violation`), `OptimisticLockException` (409), `DatabaseError` (misuse: no condition, no data, unsupported dialect feature).

```ts
try { await User.create(input) }
catch (error) {
  if (error instanceof UniqueConstraintException && error.columns?.includes('email'))
    throw new ValidationException([{ path: 'email', message: 'Email already registered' }])
  throw error
}
```

## Query builder (`Db`)

`Db.table(drizzleTable)` and model queries (`User.where()`, `User.query()`) share one builder (`QueryBuilder` / `ModelQuery`); model queries return model instances.

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
await Db.table(users).where(and(eq(users.tenantId, t), kw ? like(users.name, kw) : undefined)).select() // where(undefined) is ignored
await Db.table(users).whenDefined(enabled, (q, v) => q.where('enabled', v)).select() // skips only undefined/null (when() also skips false/'')

await Db.table(posts).join(users, 'posts.userId', 'users.id').field('posts.title', 'users.name as author').select()
await Db.table(logs).leftJoin(users, 'logs.userId', 'users.id').field({ log: logs, name: users.name }).select() // { log: row, name: string | null }
await Db.table(users).whereIn('id', Db.table(posts).field('userId').where('views', '>', 100)).select() // subquery
await Db.table(settings).cache('10m').select()                           // via the cache module

const id = await Db.table(users).insertGetId({ name: 'Bob', email: 'bob@example.com' })
await Db.table(users).upsert({ email: 'a@x.io', name: 'Ada' }, { target: 'email' })
await Db.table(jobs).upsert(job, { target: 'key', update: { attempts: sql`${jobs.attempts} + 1` }, where: sql`...`, returning: true }) // PG/SQLite
const rows = await Db.table(users).where('id', 1).update({ name: 'Ada', bio: undefined }, { returning: true }) // undefined keys dropped; PG/SQLite
await Db.table(logs).insert(entries, { returning: false })                // count only
await Db.table(posts).where('id', 1).inc('views').dec('stock', 2).update()
await Db.table(users).where('status', 0).delete()
await Db.table(logs).delete({ all: true })                                // unconditional writes need { all: true }
const rows = await Db.execute(sql`select count(*) as n from users`)       // always an array (alias Db.query)
const db = await Db.drizzle()                                             // raw drizzle (tx-aware)
await Db.connect(); Db.drizzleSync()                                      // sync access once connected (e.g. repository `get db()`)
await Db.withManager(app.make(DatabaseManager), () => work())            // pin code outside requests to one app (several apps per process, e.g. tests); jobs / listeners / scheduled tasks already use their own app; runInApp(app, fn) from core pins every facade
await Db.connection('analytics').table(events).count()
```

### Where clauses

`where(col, value)` / `where(col, op, value)` / `where({ … })` / `where([[col, op, v], [col, v]])` / `where(q => …)` / `where(drizzleSQL | undefined)`. Operators: `=` `!=` `<>` `>` `>=` `<` `<=` `like` `not like` `in` `not in` `between` `not between` (`where('age', 'between', [18, 30])`). Value may be a subquery builder: `where('id', '=', Db.table(posts).field('userId').where('id', 1))`. `!=`/`<>` with `null` → `IS NOT NULL`, with an array → `NOT IN`. Calls chain left to right: `where` = AND, `orWhere`/`whereOr` = OR.

| Method | Signature / notes |
|---|---|
| `orWhere` / `whereOr` | same overloads as `where`, OR-joined |
| `whereNot(cond)` | `NOT (…)`; accepts any `where` condition form, ignores `undefined` |
| `whereIn` / `whereNotIn` | `(col, array \| subqueryBuilder \| drizzleSQL)` |
| `whereNull` / `whereNotNull` | `(col)` |
| `whereBetween` / `whereNotBetween` | `(col, [min, max])` |
| `whereLike` / `whereNotLike` | `(col, pattern)` — you supply `%` |
| `whereColumn` | `(left, right)` or `(left, op, right)`; both are column names / paths |
| `whereExists` / `whereNotExists` | `(subqueryBuilder \| drizzleSQL)`; correlate with `where(eq(posts.userId, users.id))` |
| `whereRaw` / `orWhereRaw` | `(string, bindings[])` (`?` count must match, else throws) or `(sql\`…\`)` |
| `whereExp` | `(col, '> 10' \| sql\`> ${min}\`)` |
| `whereFindInSet` | `(col, value)` comma-separated list contains (`FIND_IN_SET` on MySQL, `LIKE` elsewhere) |
| `whereJsonContains` / `orWhereJsonContains` | `(col, value)` JSON array contains (PG `@>`, MySQL `json_contains`, SQLite `json_each`) |
| `when(v, (q, v) => …, otherwise?)` | skips `undefined`/`null`/`false`/`''` (applies `0`, `[]`) |
| `whenDefined(v, (q, v) => …, otherwise?)` | skips only `undefined`/`null` |

Time conditions (`TimeInput` = `Date | ms | 'YYYY-MM-DD[ HH:mm[:ss]]'`, local server time zone; values converted to the column's type):

| Method | Default / values |
|---|---|
| `whereTime(col, op, time)` / `whereTime(col, keyword)` | keywords `today` `yesterday` `week` `last week` `month` `last month` `year` `last year` |
| `whereDay(col, day = 'today')` | `'today'` / `'yesterday'` / a date |
| `whereWeek(col, week = 'this week')` | `'last week'` / a date; weeks start Monday |
| `whereMonth(col, month = 'this month')` | `'last month'` / `'2024-05'` |
| `whereYear(col, year = 'this year')` | `'last year'` / `2024` |
| `whereBetweenTime` / `whereNotBetweenTime` | `(col, start, end)` |
| `whereTimeInterval(col, start, unit = 'day', step = 1)` | units `second` `minute` `hour` `day` `week` `month` `year`; negative step goes back |

### Fields, joins and nested rows

| Method | Notes |
|---|---|
| `field('id', 'name')` | typed `Pick<Row, …>`; strings may be `'posts.title'`, `'name as nick'`, `'meta->a->b'`, or comma-separated |
| `field({ alias: column \| sql \| table })` | typed by alias; a **whole table** value gives a nested row object (`{ log: Row<logs> }`); `sql` values get `.as(alias)` |
| `withoutField('password', …)` | every column except these; typed `Omit<Row, …>` |
| `fieldRaw<V>('age * 2', 'double')` | raw expression + alias (string verbatim, or `sql`) |
| `distinct(value = true)` | |
| `alias('u')` | name the main table (self joins); then use `'u.col'` |
| `join` / `leftJoin` / `rightJoin` / `fullJoin` | `(table \| [table, alias], 'a.col', 'b.col')`, `(…, 'a.col', op, 'b.col')`, or `(table, sqlCondition)`; `fullJoin` not on MySQL |

Nullability after joins is tracked in the builder type and applied by `field({ … })` **in the same chain**: `leftJoin` → joined table nullable; `rightJoin` → main table and earlier joins nullable; `fullJoin` → all nullable; inner `join` unchanged.

```ts
const rows = await Db.table(posts)
  .leftJoin(users, 'posts.userId', 'users.id')
  .field({ title: posts.title, author: users.name, editor: users })
  .select()          // Array<{ title: string, author: string | null, editor: Row<typeof users> | null }>
await Db.table(users).alias('u').leftJoin([users, 'parent'], 'u.parentId', 'parent.id').field('u.name', 'parent.name as parentName').select()
await User.query().leftJoin(posts, 'users.id', 'posts.userId').where('posts.views', '>', 10).select() // still User[], own columns only
```

`withAttr('name', (value, row) => …)` (or `withAttr({ … })`) transforms a result field; on model queries it becomes a per-instance accessor.

### Ordering, grouping, limits, unions

```ts
Db.table(users).order('id', 'desc')                            // direction defaults to asc
Db.table(users).order({ status: 'asc', id: 'desc' })
Db.table(users).order(sql`length(${users.name})`, 'desc')
Db.table(users).orderRaw('length(name) desc')                  // orderRaw(str, bindings?)
Db.table(users).orderField('status', [2, 1, 0], 'asc')         // custom order, unlisted values last
Db.table(users).orderRand()
Db.table(users).limit(10); Db.table(users).limit(20, 10)       // limit(offset, length); also offset(n)
Db.table(users).page(2, 20)                                     // perPage default 15; no count
Db.table(posts).field({ userId: posts.userId, total: count() }).group('userId').having('count(*) >= ?', [3]).order('total', 'desc') // order by alias
Db.table(users).field('name').union(Db.table(admins).field('name'))  // unionAll() keeps duplicates
const hot = await Db.table(posts).where('views', '>', 10).subQuery('hot') // derived table
await (await Db.drizzle()).select().from(hot)
```

`count()` on a grouped / distinct / union query counts the result rows. `removeOption(name?)` clears `'where' | 'order' | 'limit' | 'field' | 'join' | 'group' | 'having' | 'distinct' | 'lock' | 'union' | 'cache' | 'data'` (no arg: all). `clone()` copies the builder. `connection(name)` switches connection on an existing builder.

### Retrieval

| Method | Returns |
|---|---|
| `select()` / `selectOrFail()` | rows (404 when empty for `OrFail`) |
| `selectRows()` | raw row objects even on model queries |
| `find()` / `findOrFail()` | first row; model queries accept a PK `find(id)` |
| `findOrEmpty(id?)` | model queries only: model or empty model |
| `value(col)` | `Row[col] \| undefined` (or a `field()` alias type) |
| `column(col)` / `column(col, keyCol)` / `column('*', keyCol)` | `T[]` / `Record<string, T>` / `Record<string, Row>` |
| `count(col?)` | `number` (`count('email')` = non-null) |
| `sum(col)` | `number` (`0` when empty) |
| `avg(col)` | `number \| null` |
| `max(col)` / `min(col)` | column type `\| null` |
| `exists()` | `boolean` (`select 1 … limit 1`) |
| `paginate(page = 1, perPage = 15)` | `{ data, total, page, perPage, lastPage }` (`page` floored, min 1; `lastPage` min 1) |
| `paginateX(perPage = 15, { lastId?, key = PK, sort = 'desc' })` | `{ data, perPage, lastId, hasMore }` — keyset, no COUNT; ignores existing `order()` |
| `chunk(size, (rows, page) => false \| void)` | offset batches; return `false` to stop |
| `cursor(size = 200)` / `lazy(size = 200)` | async iterator; PK keyset when no `order`/`group`/`union`, else offsets |
| `toSQL()` / `toSQL('insert', values)` / `toSQL('update', values?)` / `toSQL('delete', target?)` | `{ sql, params }`, not executed |

```ts
let page = await Db.table(logs).where('level', 'error').paginateX(50)
while (page.hasMore) page = await Db.table(logs).where('level', 'error').paginateX(50, { lastId: page.lastId })
for await (const user of User.query().where('status', 1).cursor(500)) await sync(user)
await Order.where('status', 'pending').chunk(100, async (orders, page) => { /* ... */ })
```

`paginate()` runs count + page in parallel outside transactions; inside one it runs sequentially and skips the page query when `total` is 0. The count ignores `order()`.

### Caching

`cache()` (key from SQL, no expiry), `cache(60)` / `cache('10m')` (ttl), `cache('users:active', '10m')` (explicit key), `cache(key, ttl, store)` (named cache store), `cache(false)` (off). Dates are revived from the cache. Writes never invalidate: use an explicit key + `Cache.forget(key)`.

### Writes

| Method | Returns / notes |
|---|---|
| `insert(row \| rows)` | inserted rows (MySQL: re-selected by PK); `{ returning: false }` → count |
| `insertAll(rows)` | alias of `insert(rows)` |
| `insertGetId(row)` | PK value |
| `insertIgnore(row \| rows)` | inserted count; duplicates skipped (`ON CONFLICT DO NOTHING` / `INSERT IGNORE`) |
| `upsert(row \| rows, opts?)` | affected count, or rows with `returning: true` (PG/SQLite) |
| `replace(row \| rows)` | `upsert` on PK |
| `save(row)` | update when PK present and row exists, else insert; returns count |
| `selectInsert(table, { ignore? })` | `INSERT INTO table (…) SELECT …`; needs `field()` keys = target column names |
| `update(values?, { all?, returning? })` | affected count / rows; without conditions uses PK from `values` |
| `delete()` / `delete(id \| ids)` / `delete({ all: true })` | affected count |
| `inc(col, step = 1)` / `dec(col, step = 1)` / `exp(col, sql \| 'raw')` / `data({ … })` | queue values for the next `update()` |
| `increment(col, step = 1)` / `decrement(col, step = 1)` | immediate atomic update, count |

| `upsert` option | Default | Notes |
|---|---|---|
| `target` | PK | conflict column(s), needs a unique index on PG/SQLite; ignored on MySQL (any unique key) |
| `update` | all given columns except `target` | `['col']` (take new values) or `{ col: value \| sql }` (`sql` columns refer to the existing row) |
| `where` | — | `DO UPDATE … WHERE` (PG/SQLite; `DatabaseError` on MySQL) |
| `returning` | `false` | rows (PG/SQLite; rows skipped by `where` not returned; `DatabaseError` on MySQL) |

`update()` drops `undefined` keys; nothing left → `DatabaseError('update() called without data')`. Query `update()` / `delete()` are single statements: they respect soft deletes + global scopes + tenant scope but **skip model events and timestamps** (drizzle `$onUpdate` / `$onUpdateFn` columns still apply, also in `upsert`'s DO UPDATE). `update(…, { returning: true })` returns plain rows, even on model queries. Write errors are translated (`UniqueConstraintException`).

### Raw SQL and drizzle

`Db.execute<R>(sql\`…\`)` / `Db.query` → `R[]` on every dialect. `Db.raw('count(*)')` → verbatim `SQL` fragment (no escaping; use `sql\`\`` for values). `await Db.drizzle()` → drizzle instance, the transaction object when inside one, writer by default (`{ read: true }` for a replica). `Db.drizzleSync()` (after `await Db.connect()`) → same, sync, always writer. Not supported: table prefixes / string table names, XA, `partition`, index hints (`force`), `procedure` — drop to drizzle.

### Row locks

`lock(mode = 'update', { skipLocked?, noWait? })`; `lock(false)` removes it. Use inside a transaction.

| Call | SQL | Databases |
|---|---|---|
| `lock()` / `lock('update')` | `FOR UPDATE` | PG, MySQL |
| `lock('share')` | `FOR SHARE` | PG, MySQL 8 |
| `lock('no key update')` / `lock('key share')` | `FOR NO KEY UPDATE` / `FOR KEY SHARE` | PG only (`DatabaseError` on MySQL) |
| `lock('update', { skipLocked: true })` | `… SKIP LOCKED` | PG, MySQL 8 |
| `lock('update', { noWait: true })` | `… NOWAIT` | PG, MySQL 8 (not combinable with `skipLocked`) |

SQLite ignores `lock()` and its options.

## Relations

```ts
// app/model/User.ts
export class User extends Model.define(users) {
  static override hidden = ['password']
  profile() { return this.hasOne(Profile, 'userId').bind(['bio']) }
  posts() { return this.hasMany(Post, 'userId') }
  popularPosts() { return this.hasMany(Post, 'userId').where('views', '>=', 100).order('views', 'desc') }
  roles() { return this.belongsToMany(Role, userRoles, 'roleId', 'userId') } // pivot table, related FK, this FK
  activeRoles() { return this.belongsToMany(Role, userRoles, 'roleId', 'userId').wherePivot('active', 1) }
  author() { return this.belongsTo(User, 'userId').withDefault({ name: 'Guest' }) } // empty model instead of null
}
```

| Method | Signature | Await result |
|---|---|---|
| `hasOne` | `(Related, foreignKeyOnRelated, localKey = PK)` | `R \| null` |
| `hasMany` | same | `R[]` |
| `belongsTo` | `(Related, foreignKeyOnThis, ownerKey = Related PK)`; `.associate(m)`, `.dissociate()` (both save the parent) | `R \| null` |
| `belongsToMany` | `(Related, pivotTable, pivotColToRelated, pivotColToThis)`; `.wherePivot(col, [op,] v)` (SQL only) | `R[]` + `getRelation('pivot')` on each |
| `hasManyThrough` / `hasOneThrough` | `(Related, Through, throughColToThis, relatedColToThrough, localKey?, throughKey?)` (SQL only) | `R[]` / `R \| null` |
| `morphOne` / `morphMany` | `(Related, 'commentable' \| ['typeCol', 'idCol'], type = this class name)` | `R \| null` / `R[]` |
| `morphTo` | `('commentable' \| ['typeCol', 'idCol'], { Post, Video })` — keys = stored type values; `.associate(m)`, `.dissociate()` | `R \| null` |

Morph name `'commentable'` means columns `commentableType` / `commentableId`; unknown stored type throws on lazy load. Relation definitions can chain `where(...)`, `whereIn(col, list)`, `order(...)`, `tap(q => q.withTrashed())` (any related-query call); these apply to lazy, eager and `has()` queries. `bind(['bio'] | { about: 'bio' })` (hasOne, belongsTo, morphOne, morphTo) flattens related fields into the parent's JSON instead of nesting; `withDefault(data = {})` (those + hasOneThrough) returns a filled unsaved model instead of `null`.

```ts
await user.posts()                                                   // await to load (lazy, not cached)
await user.posts().query().order('id', 'desc').limit(5).select()     // keep building (relation constraints applied)
await User.with('posts', 'posts.comments', 'profile').paginate(1, 20) // eager (no N+1)
await User.with({ posts: q => q.where('status', 1).order('id', 'desc') }, 'profile').select() // constraint limits the TOTAL, not per parent
await Post.with({ author: q => q.field('id', 'name') }, 'author.profile').select()
await User.with({ 'posts.comments': q => q.where('approved', 1) }).select() // constraint on a nested level
await user.load('posts', { comments: q => q.where('approved', 1) }); user.getRelation('posts'); user.hasRelation('posts')
await Comment.with('commentable').select()                           // morphTo: one query per type
```

Relation aggregates (SQL only; result in `getAttr(alias)` and in `toJSON()`):

| Method | Default alias | Empty value |
|---|---|---|
| `withCount(rel \| rels[], constraint?, alias?)` | `<rel>Count` | `0` |
| `withSum(rel, col, constraint?, alias?)` | `<rel>Sum` | `0` |
| `withAvg` / `withMax` / `withMin` (same args) | `<rel>Avg` / `<rel>Max` / `<rel>Min` | `null` |

```ts
await User.withCount('posts', q => q.where('status', 1), 'publishedCount').select()
await User.query().withMax('posts', 'views', undefined, 'topViews').select()   // only withCount is a static
```

Existence filters (SQL only; correlated `EXISTS` / `COUNT` subqueries, relation's `order`/`limit` stripped):

| Method | Meaning |
|---|---|
| `has(rel, op = '>=', n = 1)` | count compare; `('=', 0)` / `('<', 1)` → `NOT EXISTS` |
| `hasNot(rel, cond?)` | `NOT EXISTS` (query only) |
| `hasWhere(rel, cond?)` | `EXISTS` with `cond` = object / drizzle SQL / `q => …` |
| `hasWhereOr(rel, cond?)` | OR-joined `hasWhere` (query only) |

Writing through relations:

```ts
await user.posts().save({ title: 'Hi' })            // sets userId (also accepts a model); create() = save()
await user.posts().saveAll([{ title: 'A' }, { title: 'B' }])   // in a transaction
await post.images().save({ url: 'cover.png' })      // morphOne/morphMany set type + id
await post.author().associate(user); await post.author().dissociate()
await comment.commentable().associate(video)        // morphTo sets type key from the map + id

await user.roles().attach(1)                        // also attach(role), attach([1, 2], pivotData)
await user.roles().attach({ 1: { grantedBy: 7 }, 2: { grantedBy: 8 } })
await user.roles().detach(2); await user.roles().detach()      // returns deleted count; no arg = all
const { attached, detached, updated } = await user.roles().sync([1, 3])  // in a transaction
await user.roles().sync({ 1: { grantedBy: 7 } }, false)       // false: keep extra rows; object updates pivot data
await user.roles().save({ name: 'editor' }, { grantedBy: 7 }) // create Role + attach; saveAll(list, pivot)
roles[0].getRelation('pivot')                                   // { userId, roleId, grantedBy }
```

## Transactions

Transactions are tracked per connection in `AsyncLocalStorage`: every `Db` / `Model` query in the same async flow joins automatically — never pass a tx object.

```ts
const order = await Db.transaction(async (tx) => {      // tx = drizzle transaction if you need it
  const order = await Order.create({ userId, total })
  const stock = await Db.table(stocks).where('productId', pid).lock().find() // FOR UPDATE; lock('share')
  if (stock!.quantity < 1) throw new Error('Sold out')   // throw → rollback + rethrow
  await Db.table(stocks).where('productId', pid).dec('quantity').update()
  return order                                          // returned from Db.transaction()
}, { isolationLevel: 'serializable' })

await Db.startTrans()            // manual (ThinkPHP style) — start/commit/rollback in the SAME async function
try { /* ... */ await Db.commit() } catch (e) { await Db.rollback(); throw e }
await Db.startTrans({ isolationLevel: 'repeatable read' })

await User.transaction(async () => { /* model's connection */ })
await Db.connection('analytics').transaction(async () => {})   // also .startTrans() / .commit() / .rollback()
Db.inTransaction(); Db.connection('analytics').inTransaction()

// a library that opens its own drizzle transaction: make Db / Model calls inside it join that tx
await db.transaction(tx => Db.joinTransaction(tx, () => Order.create({ total })))
// (afterCommit callbacks registered inside run when this callback resolves — before the library's real COMMIT)

// side effects only after COMMIT (dropped on rollback, immediate outside a tx; savepoints hand over to the outer tx)
await Db.afterCommit(() => OrderPlaced.emit({ id })) // Db.connection('x').afterCommit() = that connection only
```

| API | Notes |
|---|---|
| `Db.transaction(fn, config?)` | commits on resolve, rolls back + rethrows on throw; nested call = savepoint |
| `Db.startTrans(config?)` / `commit()` / `rollback()` | manual; nested `startTrans()` = savepoint; `commit()`/`rollback()` without a matching `startTrans()` throw `DatabaseError` |
| `Model.transaction(fn, config?)` | on `Model.connection` |
| `Db.inTransaction()` | for the default connection (or `Db.connection(n)`) |
| `Db.joinTransaction(tx, fn)` | adopt an external drizzle tx; inner `transaction()` calls become savepoints; the library still commits/rolls back |
| `Db.afterCommit(fn)` / `afterCommit(fn)` from `@hazejs/core` | defer until outermost COMMIT |

Nested calls (either style, mixable) use savepoints: an inner failure only undoes inner work (catch it to keep the outer tx). Options apply to the outermost transaction only:

| Option | Dialect | Values |
|---|---|---|
| `isolationLevel` | PG, MySQL | `'read uncommitted' \| 'read committed' \| 'repeatable read' \| 'serializable'` |
| `accessMode` | PG, MySQL | `'read only' \| 'read write'` |
| `deferrable` | PG | `boolean` |
| `withConsistentSnapshot` | MySQL | `boolean` |
| `behavior` | SQLite | `'deferred' \| 'immediate' \| 'exclusive'` |

There is no built-in retry / deadlock-retry option: wrap `Db.transaction()` in your own loop if you need it (e.g. on serialization failures).

**afterCommit semantics**: callbacks run in registration order after the outermost COMMIT, outside the transaction, before `Db.transaction()` / `Db.commit()` returns. A savepoint's callbacks move to the parent on release and are dropped on its rollback. `Db.afterCommit()` waits for every connection the current code is in a transaction on. A throwing callback is logged and the rest still run (the transaction already committed); outside a transaction the error propagates. Declarative variants: `defineJob({ afterCommit: true })`, `Job.with(p).afterCommit().dispatch()`, `defineEvent({ afterCommit: true })`. Not covered: `Mongo.transaction()` and D1.

Inside a transaction `paginate()` runs count then page sequentially (same snapshot). Multi-row helpers (`Model.saveAll()`, `relation.saveAll()`, `sync()`, multi-model factory `create()`) open a transaction only when not already in one.

## Factories

`@faker-js/faker` is an optional dev dependency (lazy-loaded; only reading `ctx.faker` throws when missing). Factories live in `database/factories` (modules: `modules/<name>/database/factories`; `haze make:factory Post --module blog`).

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
  .state('recent', (attributes, { n }) => ({ title: `${attributes.title} #${n}` }))
  .afterMake(post => post.hidden(['userId']))           // also runs on create(), before save
  .afterCreate(async post => { /* after the model and its has() children are saved */ })
```

| Context field | Meaning |
|---|---|
| `faker` | faker in `config.factories.locale` or `.locale()` |
| `n` | per-factory sequence number, starts at 1, keeps counting across calls and clones (process-wide) |
| `index` | position in the current call (`0..count-1`) |
| `sequence(n => v)` / `sequence(a, b, c)` | computed from `n` / cycles by `n` |

Attribute values: plain value; function `(attrs) => v` (may be async; evaluated after plain values, sees them); another factory (created, replaced by its PK — skipped when an override / `for()` provides the key).

```ts
await PostFactory.make() / .make({ title: 'x' }) / .raw()     // unsaved model / plain attributes (FactoryAttributes)
await PostFactory.create(); await PostFactory.count(3).create() // array after count()
await UserFactory.createMany([{ name: 'Ada' }, { name: 'Bob' }]); await UserFactory.createMany(5); await UserFactory.makeMany(2)
await UserFactory.state('admin').create(); await UserFactory.state({ name: 'Ada' }).create()
await UserFactory.state((attrs, { n }) => ({ email: `${attrs.name}.${n}@example.com` })).create()
await UserFactory.count(4).sequence({ role: 'admin' }, { role: 'member' }).create() // by index; items may be (ctx) => attrs
await PostFactory.for(user).create(); await PostFactory.for(UserFactory.state('admin'), 'author').count(3).create()
await CommentFactory.for(post, 'commentable').create()          // morphTo sets type + id
await UserFactory.has(PostFactory.count(3), 'posts').create()   // hasMany/hasOne/morph*/belongsToMany
await UserFactory.count(2).has(PostFactory.count(2)).create()   // relation name guessed: Post → posts
await PostFactory.hasAttached(TagFactory.count(2), 'tags', { weight: 1 }).create()
await PostFactory.hasAttached(existingTags, 'tags').create()
await PostFactory.hasAttached(TagFactory.count(3), 'tags', (tag, post) => ({ weight: tag.id })).create()
await UserFactory.locale('ja').create()                         // en, en_US, zh_CN (or zh-CN), ja, de…; unknown throws
```

| Method | Notes |
|---|---|
| `count(n)` | `make`/`create`/`raw` return arrays |
| `state(name)` / `state(name, value)` / `state(value \| (attrs, ctx) => value)` | apply named / define named / apply anonymous; unknown name is a type error and throws |
| `sequence(...states)` | alternate states by `index` |
| `for(parentFactory \| model, relation?)` | belongsTo / morphTo; default relation = parent class camelCase (`User` → `user`); parent factory created **once per call**, also by `make()`/`raw()` |
| `has(childFactory, relation?)` | after parent save; default = plural camelCase (`posts`, `categories`); only `create()` |
| `hasAttached(factory \| models, relation?, pivot?)` | belongsToMany; `pivot` object or `(related, parent) => object` |
| `afterMake(fn)` / `afterCreate(fn)` / `locale(code)` | |
| `raw` / `make` / `create(overrides?)`, `makeMany` / `createMany(n \| overrides[])` | |

Merge order: definition → states (in order applied; each state fn sees prior result) → `for()` FKs → overrides. `create()` runs in a transaction when it saves more than one model or has `for(factory)` / `has()` relations. Chained methods return new factories (the exported one never changes). Overrides and states are type-checked against the table (`make({ nope: 1 })` is a compile error).

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

No migrations (create indexes via `(await Mongo.db()).collection(...).createIndex()`). Replicas via `readPreference` in the URL. Mongo models support `hasOne`/`hasMany`/`belongsTo`/`morph*` relations; not `belongsToMany`, `*Through`, `withCount`/`has`, factories.

## Gotchas

- **Schema files import only from `drizzle-orm`** (and `@hazejs/orm/columns`). No `~` alias, no models — drizzle-kit loads them outside Vite.
- **Model statics need `override`** (`static override hidden = [...]`) because they are declared on the base class.
- **Bulk query `update()`/`delete()` skip model events and timestamps**; static `User.update()` / `User.destroy()` / `saveAll()` load and save each model instead (N+1, not atomic). Both refuse to run with no condition unless `{ all: true }`; the automatic soft-delete / tenant / global-scope filters are not a condition, so `Post.query().delete()`, `forceDelete()` and `restore()` on such models throw too (MongoDB: the soft-delete filter). For a conditional atomic write, check the count from `User.where(...).update()`.
- **Model queries are fully typed**: `User.where('typo', 1)` is a compile error and `User.query().column('name')` is `string[]`. If an older codebase compiled only because keys were `string`, fix the column names rather than casting.
- **Static `Model.where()` takes only own column keys** — dotted (`'posts.views'`) or JSON (`'meta->a'`) paths need `Model.query().where(...)`. Likewise `withSum`/`hasNot`/`field`/`lock`/`max` etc. exist only on the query, not as statics.
- **`join(table, condition)` needs a definite `SQL`** — unlike `where()`, it does not accept `undefined`, and drizzle's `and()` / `or()` are typed `SQL | undefined`; assert (`and(a, b)!`) or build the condition from parts you know exist.
- **Builders are mutable** (`where()` returns `this`): wrap a reusable base query in a function (or `clone()`), don't branch from a shared variable.
- **Joins without `field()`** return rows grouped by SQL table name (`{ sys_users: {...} }`) while the type still says main-table row — always `field()` when joining with `Db.table()`. Nullable typing after `leftJoin` only works when `field()` is in the same chain.
- **Accessors apply to column properties too**: `getNameAttr` changes what `user.name` returns and what `toJSON()` emits; read the stored value with `getRaw('name')`. Query-added fields (`postsCount`, `field()` extras) have no typed property — use `getAttr()`.
- **In-place JSON mutation is not dirty** (`user.meta.x = 1; save()` writes nothing) — assign a new object.
- **Composite primary keys** are not supported by models (`find(id)`, `save()` updates, `destroy`, `updateById`, `insertGetId`, `paginateX`/`replace` defaults); use `Db.table()` and pass `upsert({ target: [...] })`.
- `create()` timestamps come from the app clock, not the column's `defaultNow()`.
- **`find()` on a builder vs model**: `Db.table(t).find()` returns the first row; `User.find(1)` looks up by PK. `findOrFail` throws a 404 exception — fine in controllers, surprising in jobs.
- **Manual `startTrans()`** is bound to the async context of the calling function; calling `commit()` from a different call chain throws. Prefer `Db.transaction()`.
- **D1 has no interactive transactions**: `transaction()` / `startTrans()` throw; use `(await Db.drizzle()).batch([...])`. `saveAll()`, `relation.saveAll()` and `sync()` run without a transaction on D1. `read`/`write` on `d1` or `mongodb` throw. `Db.transaction()` on a `mongodb` connection throws — use `Mongo.transaction()`.
- **SQLite ignores `lock()`** (no row locks).
- **Eager-load constraints apply to the single batch query** — `limit(3)` inside `with({ posts: q => q.limit(3) })` limits total rows, not per parent. Awaiting `user.posts()` always queries; use `load()` + `getRelation()` to reuse.
- `withCount`/`has`/`hasWhere`/`belongsToMany`/`*Through` are SQL-only; factories support `Model` only (not `MongoModel`) and `has()` does not handle `*Through`.
- **Factories hit the DB on `make()`/`raw()`** when the definition has a factory-valued attribute (`userId: UserFactory`) or `for(factory)` is used — the parent is created to get a real id.
- Factory sequence numbers are process-wide and never reset between tests — use for uniqueness, not exact values. Relation names are guessed from class names; pass them explicitly if code is minified.
- `refreshDatabase()` closes and re-opens the connection, then migrates — it only yields an empty DB with `DATABASE_URL=:memory:` (the template `.env.test`). With read/write splitting it migrates only the writer.
- Snowflake IDs are strings in JS (`sqliteSnowflake` stored as text); never `Number()` them. Configure distinct `workerId`/`datacenterId` per instance.
- Writes do not invalidate `cache()`d queries; use an explicit key and `Cache.forget(key)`.
- `whereRaw`/`whereExp`/`orderRaw`/`fieldRaw`/`Db.raw`/`exp(col, 'string')` insert strings verbatim — bind values with `?` or `sql\`\``.
- MySQL: no `returning` on `update`/`upsert`, no `upsert({ where })`, no `fullJoin`, no PG-only lock modes — each throws `DatabaseError`.
