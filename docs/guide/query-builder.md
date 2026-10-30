# Query Builder

`Db.table(table)` returns a chainable, ThinkPHP-style query builder over any drizzle table. Model queries (`User.where(...)`, `User.query()`) use the same builder and return models instead of plain rows, so everything on this page also works on models.

```ts
import { Db } from '@hazejs/orm'
import { users } from '~/database/schema/users'

const page = await Db.table(users).where('status', 1).order('id', 'desc').paginate(1, 20)
```

::: warning Builders are mutable
`where()`, `order()`, `join()` and the other chain methods change the builder and return the same object. Do not keep a base query in a variable and branch from it — the branches share state. Build a fresh one each time with a function (or call `clone()`):

```ts
const active = () => Db.table(users).where('status', 1)

const admins = await active().where('role', 'admin').select()
const total = await active().count()
```
:::

## Retrieving results

| Method | Returns |
|--------|---------|
| `select()` | All rows |
| `selectOrFail()` | All rows; throws `ModelNotFoundException` (404) when empty |
| `find()` / `findOrFail()` | The first row (`undefined` / 404 when missing). Model queries accept a primary key: `User.find(1)` |
| `findOrEmpty(id?)` | Model queries only: the model, or an empty model (`model.isEmpty()`) |
| `value('name')` | One column of the first row. Also a `field()` alias: `field({ total: count() }).value('total')` |
| `column('name')` | One column of every row: `['Ada', 'Bob']`. Also a `field()` alias |
| `column('name', 'id')` | Keyed by another column: `{ 1: 'Ada', 2: 'Bob' }` |
| `column('*', 'id')` | Whole rows keyed by a column |
| `count(column?)` / `sum` / `avg` / `max` / `min` | Aggregates (`count('email')` counts non-null values) |
| `exists()` | Whether any row matches (`select 1 … limit 1`, no row is read) |
| `paginate(page, perPage)` | `{ data, total, page, perPage, lastPage }` |
| `paginateX(perPage, { lastId, key, sort })` | Cursor pagination without counting: `{ data, perPage, lastId, hasMore }` |
| `chunk(size, rows => ...)` | Process rows in batches; return `false` to stop |
| `cursor(size)` / `lazy(size)` | Async iterator that fetches in batches: `for await (const row of query.cursor())` |
| `toSQL()` | The generated SQL and parameters (ThinkPHP's `fetchSql`). `toSQL('insert', values)`, `toSQL('update', values)` and `toSQL('delete', target?)` preview the write statements without running them |

`value()` and `column()` are typed like `field()`: the column's type on tables and models (`User.query().column('name')` is `string[]`), or the alias's type after `field({ ... })`.

`paginate()` runs the count and the page query in parallel. Inside a transaction it runs them one after the other and skips the page query when the count is `0`. The count never includes `order()`.

`paginateX()` pages by the primary key (or `key`), so it stays fast on large tables. `cursor()` does the same when the query has no `order()`; with an order it falls back to offsets.

## Where clauses

```ts
Db.table(users).where('status', 1)                         // =
Db.table(users).where('age', '>', 18)                      // operator
Db.table(users).where({ status: 1, email: null })          // object: null → IS NULL, array → IN
Db.table(users).where([['status', '=', 1], ['age', '>', 18]]) // array of conditions
Db.table(users).where('id', [1, 2, 3])                     // IN
Db.table(users).where(q => q.where('a', 1).orWhere('b', 2)) // grouped in parentheses
Db.table(users).where(eq(users.id, 1))                     // any drizzle expression
```

Operators: `=`, `!=`, `<>`, `>`, `>=`, `<`, `<=`, `like`, `not like`, `in`, `not in`, `between`, `not between`. Multiple `where` calls are joined by AND, `orWhere` / `whereOr` by OR, left to right.

`where()`, `orWhere()` and `whereNot()` ignore `undefined`, so drizzle's `and()` / `or()` (which return `SQL | undefined`) can be passed straight through:

```ts
Db.table(users).where(and(
  eq(users.tenantId, tenantId),
  keyword ? like(users.name, `%${keyword}%`) : undefined,
))
```

| Method | Description |
|--------|-------------|
| `orWhere` / `whereOr` | OR condition |
| `whereNot(condition)` | Negate a condition or group |
| `whereIn` / `whereNotIn` | A list or a [subquery](#subqueries) |
| `whereNull` / `whereNotNull` | `IS NULL` / `IS NOT NULL` |
| `whereBetween` / `whereNotBetween` | Range `[min, max]` |
| `whereLike` / `whereNotLike` | `LIKE` pattern |
| `whereColumn('updatedAt', '>', 'createdAt')` | Compare two columns |
| `whereExists` / `whereNotExists` | A [subquery](#subqueries) has rows |
| `whereRaw('age > ? and status = ?', [18, 1])` | Raw SQL with `?` bindings, or a drizzle `sql` template. `orWhereRaw` for OR |
| `whereExp('score', '> 10')` | A column followed by a raw expression |
| `whereFindInSet('tags', 'orm')` | Comma-separated column contains a value (`FIND_IN_SET` on MySQL) |
| `whereJsonContains('labels', 'orm')` | JSON array column contains a value. `orWhereJsonContains` for OR |
| `when(value, q => ..., q => ...)` | Apply the first callback when `value` is not empty, otherwise the optional second one |
| `whenDefined(value, q => ..., q => ...)` | Same, but only `undefined` and `null` count as empty |

`when()` skips `undefined`, `null`, `false` and `''`; `0` and empty arrays are applied. For a three-state boolean filter (`true` / `false` / not given) use `whenDefined()`, which only skips `undefined` and `null`:

```ts
// input.enabled: boolean | undefined (validated query string)
Db.table(users).whenDefined(input.enabled, (q, enabled) => q.where('enabled', enabled)) // false is applied too
```

::: warning Raw SQL
`whereRaw`, `whereExp`, `orderRaw` and `fieldRaw` insert strings verbatim. Never build them from user input; use `?` bindings or drizzle's `sql` template for values.
:::

### Time conditions

```ts
Db.table(posts).whereTime('createdAt', '>=', '2024-01-01')
Db.table(posts).whereTime('createdAt', 'today')           // also yesterday, week, last week, month, last month, year, last year
Db.table(posts).whereDay('createdAt')                     // today; or 'yesterday', or '2024-05-01'
Db.table(posts).whereWeek('createdAt', 'last week')       // weeks start on Monday
Db.table(posts).whereMonth('createdAt', '2024-05')        // or 'this month' / 'last month'
Db.table(posts).whereYear('createdAt', 2024)              // or 'this year' / 'last year'
Db.table(posts).whereBetweenTime('createdAt', '2024-01-01', '2024-06-30 23:59:59')
Db.table(posts).whereNotBetweenTime('createdAt', start, end)
Db.table(posts).whereTimeInterval('createdAt', '2024-05-01', 'day', 7) // 7 days from May 1st
```

Times are `Date`s, millisecond timestamps or date strings, interpreted in the server's local time zone. Values are converted to the column type (`Date`, ISO string or milliseconds), the same way timestamps are written.

## Fields and JSON paths

```ts
Db.table(users).field('id', 'name')                          // typed result: { id, name }
Db.table(users).withoutField('password')                     // every column except these
Db.table(users).field({ id: users.id, total: count() })      // drizzle expressions, keyed by alias
Db.table(logs).leftJoin(users, 'logs.userId', 'users.id')
  .field({ log: logs, userName: users.name })                // a whole table: `log` is a row object
Db.table(users).fieldRaw('age * 2', 'double')                // raw expression with an alias
Db.table(users).distinct().field('status')
```

Field names can point into a joined table (`'posts.title'`), rename the result (`'name as nickname'`) or read a JSON column path (`'meta->address->city'`). JSON paths work everywhere a field is accepted: `where`, `order`, `field`, `value`, `group`...

```ts
await Db.table(articles).where('meta->author->name', 'Ada').field('title', 'meta->city as city').select()
```

`withAttr('name', (value, row) => ...)` transforms a field in the results; on model queries it acts as a dynamic accessor.

## Ordering, grouping and limits

```ts
Db.table(users).order('id', 'desc')
Db.table(users).order({ status: 'asc', id: 'desc' })
Db.table(users).order(sql`length(${users.name})`, 'desc')    // drizzle expression with a direction
Db.table(users).orderRaw('length(name) desc')
Db.table(users).orderField('status', [2, 1, 0])  // custom order; others last
Db.table(users).orderRand()
Db.table(users).limit(10)                        // or limit(offset, length)
Db.table(users).page(2, 20)

Db.table(posts)
  .field({ userId: posts.userId, total: count() })
  .group('userId')
  .having('count(*) >= ?', [3])
  .order('total', 'desc')                        // order by a field alias
  .select()
```

`count()` on a grouped, distinct or union query counts the resulting rows.

## Joins

```ts
const rows = await Db.table(posts)
  .join(users, 'posts.userId', 'users.id')       // or join(users, eq(posts.userId, users.id))
  .field('posts.title', 'users.name as author')
  .where('users.status', 1)
  .select()
// [{ title: 'Hello', author: 'Ada' }, ...]
```

`join` (inner), `leftJoin`, `rightJoin` and `fullJoin` (not on MySQL) take a drizzle table, or `[table, alias]`. `alias('u')` names the main table, for self joins:

```ts
await Db.table(users).alias('u').leftJoin([users, 'parent'], 'u.parentId', 'parent.id').field('u.name', 'parent.name as parentName').select()
```

After `leftJoin()`, the joined table's columns are typed `T | null` in `field({ ... })` results; after `rightJoin()` the main table and the tables joined before it are, and after `fullJoin()` every table is. The join methods record this in the builder's type, so call `field()` in the same chain:

```ts
const rows = await Db.table(posts)
  .leftJoin(users, 'posts.userId', 'users.id')
  .field({ title: posts.title, author: users.name, editor: users })
  .select()
// { title: string, author: string | null, editor: User row | null }[]
```

Without `field()`, `Db.table()` returns rows grouped by **SQL table name**, as drizzle does: `{ posts: {...}, sys_users: {...} }` (the name passed to `pgTable()`, not your variable name). The result type does not reflect this grouping — it still claims the main table's row — so **always call `field()` when you join** with `Db.table()`. Model queries always return models built from the model's own columns (plus any extra `field()`s).

## Subqueries

Any query builder can be used as a subquery:

```ts
// IN (subquery)
await Db.table(users).whereIn('id', Db.table(posts).field('userId').where('views', '>', 100)).select()

// = (subquery)
await Db.table(users).where('id', '=', Db.table(posts).field('userId').where('id', 1)).find()

// EXISTS, correlated with a drizzle expression
await Db.table(users).whereExists(Db.table(posts).where(eq(posts.userId, users.id))).select()
```

For a derived table, `await query.subQuery('alias')` returns a drizzle subquery for use with `Db.drizzle()`. On models, [`has()` / `hasWhere()`](./relations#querying-relation-existence) build these subqueries from relations for you.

## Unions

```ts
await Db.table(users).field('name').unionAll(Db.table(admins).field('name')).select()
```

`union()` removes duplicates, `unionAll()` keeps them. The queries must select the same fields.

## Caching

`cache()` stores the result through the [cache](./cache) module:

```ts
await Db.table(settings).cache().select()                    // key derived from the SQL, no expiry
await Db.table(settings).cache('10m').select()               // ttl
await Db.table(users).where('id', 1).cache('user:1', 60).find()  // explicit key
await Cache.forget('user:1')                                 // invalidate after writes
```

Dates are restored when reading from the cache. Writes do not clear cached queries; use an explicit key when you need to invalidate.

## Inserting

```ts
await Db.table(users).insert({ name: 'Ada' })                 // returns the inserted rows
await Db.table(logs).insert(entries, { returning: false })    // returns the count only (hot paths)
await Db.table(users).insert({ name: 'Ada', code: sql`gen_code()` }) // values can be drizzle SQL
await Db.table(users).insertAll([{ name: 'Ada' }, { name: 'Bob' }])
const id = await Db.table(users).insertGetId({ name: 'Ada' })
await Db.table(users).insertIgnore(rows)                      // skip duplicates, returns inserted count
await Db.table(users).upsert({ email: 'ada@example.com', name: 'Ada' }, { target: 'email' })
await Db.table(users).replace({ id: 1, name: 'Ada' })         // upsert by primary key
await Db.table(users).save({ id: 1, name: 'Ada' })            // update when the key exists, otherwise insert

// INSERT INTO archive (userId, name) SELECT ...
await Db.table(users).where('status', 0).field({ userId: users.id, name: users.name }).selectInsert(archive)
await query.selectInsert(archive, { ignore: true })           // skip rows that violate a unique key
```

`upsert()` uses `ON CONFLICT ... DO UPDATE` (PostgreSQL / SQLite, `target` defaults to the primary key) or `ON DUPLICATE KEY UPDATE` (MySQL, any unique key). By default it updates every given column except the conflict target. `update` chooses what to write on conflict:

```ts
await Db.table(users).upsert(row, { target: 'email', update: ['name'] })   // these columns, from the new row
await Db.table(jobs).upsert(job, {
  target: 'key',
  update: { attempts: sql`${jobs.attempts} + 1`, status: 'queued' },  // values or expressions; columns refer to the existing row
  where: sql`${jobs.status} <> 'done'`,                                 // ON CONFLICT ... DO UPDATE ... WHERE (PostgreSQL / SQLite)
  returning: true,                                                       // inserted / updated rows (PostgreSQL / SQLite)
})
```

`where` and `returning` are not available on MySQL and throw a `DatabaseError` there. With `returning`, rows skipped by `where` are not returned.

`selectInsert(table, { ignore: true })` uses `ON CONFLICT DO NOTHING` on PostgreSQL / SQLite and `INSERT IGNORE` on MySQL. Insert values (`insert()`, `upsert()`, `Model.create()`) may be drizzle `sql` expressions.

## Updating and deleting

```ts
await Db.table(users).where('id', 1).update({ name: 'Ada' })
await Db.table(users).update({ id: 1, name: 'Ada' })          // no condition: uses the primary key in the data
const rows = await Db.table(users).where('id', 1).update({ name: 'Ada' }, { returning: true }) // updated rows (PostgreSQL / SQLite)
await Db.table(posts).where('id', 1).inc('views').dec('stock', 2).exp('title', sql`upper(${posts.title})`).update()
await Db.table(posts).where('id', 1).data({ title: 'New' }).update()
await Db.table(posts).where('id', 1).increment('views')        // immediate
await Db.table(users).where('status', 0).delete()
await Db.table(users).delete(1)                                // by primary key
await Db.table(users).delete([1, 2, 3])
```

`update()` and `delete()` return the affected row count and refuse to run without any condition unless you pass `{ all: true }`. `update(values, { returning: true })` returns the updated rows instead (plain rows, also on model queries; MySQL throws a `DatabaseError`). Keys whose value is `undefined` are dropped, so optional input can be passed as is; when nothing is left, `update()` throws `DatabaseError('update() called without data')`.

They are single statements: on model queries they respect soft deletes and global scopes, but do not fire model events or maintain the model's timestamps. Column-level `$onUpdate()` / `$onUpdateFn()` from the drizzle schema still apply — to `update()` and to the `DO UPDATE` part of `upsert()` — so a column defined as `updatedAt: timestamp().$onUpdate(() => new Date())` needs no manual value.

## Other helpers

- `removeOption('order')` removes a previously set option (`where`, `order`, `limit`, `field`, `join`, `group`, `having`, `distinct`, `lock`, `union`, `cache`, `data`), or all of them without an argument.
- `lock()` adds `FOR UPDATE`; `lock('share')`, `lock('no key update')`, `lock('key share')` and `{ skipLocked, noWait }` select other modes. See [Transactions](./transactions#row-locks).
- `Db.execute(sql\`...\`)` (alias `Db.query`) runs raw SQL and returns rows; `Db.raw('...')` makes a raw SQL fragment; `Db.drizzle()` gives you the drizzle instance for anything else.

## Not supported

A few ThinkPHP features have no equivalent here: table prefixes and string table names (tables are drizzle objects), XA transactions, `partition`, `force` (index hints) and `procedure`. Drop down to `Db.drizzle()` or raw SQL when you need them.
