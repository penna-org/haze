# Getting Started

`@hazejs/orm` is the database layer of hazejs. It gives you an Active Record style `Model`, a fluent query builder and a migration runner, all on top of [drizzle](https://orm.drizzle.team). Tables are plain drizzle schemas, so column types flow into your models and queries without being declared twice.

The api template ships with everything wired up: SQLite in `data/app.db`, a `users` table, a `User` model, migrations, a seeder and tests.

## Setup

The ORM is registered by a service provider. The template already contains it:

```ts
// app/provider/DatabaseProvider.ts
import { databaseProvider } from '@hazejs/orm'

// Reads config/database.ts; Db and Model use it automatically
export default databaseProvider()
```

Connections are opened lazily on the first query, reused across hot reloads in development, and closed when the application shuts down.

## Configuration

Connections live in `config/database.ts`:

```ts
// config/database.ts
import { env } from '@hazejs/core'
import { defineDatabaseConfig } from '@hazejs/orm'

export default defineDatabaseConfig(() => ({
  default: 'main',
  connections: {
    main: {
      driver: 'sqlite',
      url: env('DATABASE_URL', 'file:./data/app.db'),
      logging: env('DB_LOGGING', false),
    },
  },
}))
```

`default` names the connection used when none is specified. Each connection accepts:

| Option | Description |
|--------|-------------|
| `driver` | One of the drivers below |
| `url` | Connection URL. For `sqlite`, relative `file:` paths resolve against the project root and the directory is created for you |
| `authToken` | libSQL / Turso auth token |
| `binding` | D1 only: the Workers binding name (default `DB`), or a `D1Database` object |
| `pool` | Pool size for `postgres` / `node-postgres` / `mysql` / `mongodb` (default `10`), or `{ max, idleTimeout, connectTimeout }` |
| `database` | MongoDB only: database name (defaults to the path in `url`) |
| `logging` | Log every SQL statement at debug level |
| `schema` | Drizzle schema directory, relative to the source dir (default `database/schema`) |
| `migrations` | Migrations directory (default `database/migrations`, or `database/migrations/<name>` for non-default connections) |
| `read` / `write` / `sticky` | Send reads to replicas; see [Read/write splitting](#read-write-splitting) |
| `casing` | `'snake_case'` or `'camelCase'`: derive column names for columns declared without one (`createdAt` → `created_at`). Must match the casing your migrations were generated with; `haze db:generate` passes it to drizzle-kit |
| `timezone` | PostgreSQL session time zone (`postgres`, `node-postgres`, `pglite`), e.g. `'Asia/Shanghai'`. Affects `::date`, `date_trunc` and `timestamp without time zone` output |
| `client` | Use a client you created: a `PGlite` instance (`pglite`), a `pg.Pool` / `pg.Client` (`node-postgres`) or a postgres-js instance (`postgres`). You own it — closing the app does not close it |

### Drivers

| Driver | Database | Package |
|--------|----------|---------|
| `sqlite` | SQLite / libSQL: `file:./data/app.db`, `:memory:`, or `libsql://…` | `@libsql/client` |
| `turso` | Turso / sqld over pure HTTP (`libsql://`, `https://`). No native binary, so it runs on the edge and serverless | `@libsql/client` |
| `d1` | Cloudflare D1 through a Workers binding | none |
| `postgres` | PostgreSQL via postgres-js | `postgres` |
| `node-postgres` | PostgreSQL via node-postgres (`pg`), drizzle's default PostgreSQL driver | `pg` |
| `pglite` | Embedded PostgreSQL (WASM) for local development and tests. `url` is a data directory; omit it for an in-memory database | `@electric-sql/pglite` |
| `mysql` | MySQL via mysql2 | `mysql2` |
| `mongodb` | MongoDB, used through `@hazejs/orm/mongo` (see [Models](./models#mongodb)) | `mongodb` |

Drivers are optional peer dependencies and load only when a connection uses them. Install the one you need:

::: code-group

```bash [SQLite / Turso]
pnpm add @libsql/client
```

```bash [PostgreSQL]
pnpm add postgres   # or: pnpm add pg (driver: 'node-postgres')
```

```bash [PGlite]
pnpm add @electric-sql/pglite
```

```bash [MySQL]
pnpm add mysql2
```

```bash [MongoDB]
pnpm add mongodb
```

:::

If a driver is missing, the first query fails with a message that tells you which package to install.

::: tip Switching from SQLite
To move the template to PostgreSQL or MySQL, install the driver, change `driver` and `url`, and rewrite the tables in `database/schema` with `drizzle-orm/pg-core` or `drizzle-orm/mysql-core`. `turso` and `d1` use the SQLite dialect, so they share the same schema and migrations as `sqlite`.
:::

## Schema

Each table is a drizzle definition in `database/schema/*.ts`:

```ts
// database/schema/users.ts
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  password: text('password'),
  role: text('role', { enum: ['member', 'admin'] }).notNull().default('member'),
  createdAt: integer('created_at', { mode: 'timestamp' }),
  updatedAt: integer('updated_at', { mode: 'timestamp' }),
})
```

::: warning
Schema files are read directly by drizzle-kit. Import only from `drizzle-orm` here and do not use the `~` alias.
:::

`haze make:model Post` creates both `app/model/Post.ts` and a matching `database/schema/posts.ts` for your dialect. See [Models](./models).

### Snowflake IDs

For distributed systems, or tables shared with Java services, use 64-bit [snowflake](https://en.wikipedia.org/wiki/Snowflake_ID) ids instead of auto-increment ids:

```ts
// database/schema/orders.ts
import { pgSnowflake } from '@hazejs/orm/columns'
import { pgTable, text } from 'drizzle-orm/pg-core'

export const orders = pgTable('orders', {
  id: pgSnowflake('id').primaryKey(),                       // generated on insert
  userId: pgSnowflake('user_id', { auto: false }).notNull(), // foreign key: no generation
  title: text('title').notNull(),
})
```

| Helper | Stored as |
|--------|-----------|
| `pgSnowflake(name)` | `bigint` |
| `mysqlSnowflake(name)` | `bigint` |
| `sqliteSnowflake(name)` | `text`: Cloudflare D1 rounds integers above 2^53, while text is exact on every SQLite driver. Snowflake ids are 19 digits for decades, so text order equals numeric order |

`@hazejs/orm/columns` depends only on drizzle, so it is safe to import from schema files.

In application code a snowflake id is a **decimal string** (`'1849302746129387521'`). A 64-bit integer does not fit in a JavaScript `number`, which is exact only up to 2^53, so the id never passes through one. Strings also go straight into JSON responses, the same way Java services serialize `Long` ids to avoid precision loss in the browser.

```ts
const order = await Order.create({ userId, title: 'Hello' })
order.id                              // '1849302746129387521'
await Order.findOrFail(ctx.param('id')) // ids from URLs and request bodies are strings already

import { Snowflake, snowflakeId } from '@hazejs/orm'
snowflakeId()                         // generate one yourself
Snowflake.parse(order.id)             // { time, datacenterId, workerId, sequence }
```

The bit layout (41-bit time, 5-bit datacenter, 5-bit worker, 12-bit sequence) and the default epoch (`1288834974657`) match MyBatis-Plus `IdType.ASSIGN_ID` and Hutool's `Snowflake`, so Node and Java services can write to the same table as long as their worker / datacenter ids differ. Set them per instance:

```ts
// config/database.ts
export default defineDatabaseConfig(() => ({
  default: 'main',
  connections: { /* ... */ },
  snowflake: {
    workerId: Number(env('SNOWFLAKE_WORKER_ID', '0')),
    datacenterId: Number(env('SNOWFLAKE_DATACENTER_ID', '0')),
    // epoch: new Date('2024-01-01'), // only if your Java services use a custom epoch
  },
}))
```

Without configuration, the generator reads the `SNOWFLAKE_WORKER_ID` / `SNOWFLAKE_DATACENTER_ID` environment variables, or picks random ids. Random ids can collide across instances, so configure them explicitly when you run more than one.

::: tip Other 64-bit integers
You can also use drizzle's `bigint('id', { mode: 'bigint' })` columns, whose values are `BigInt`s. 64-bit integers are read without precision loss on every driver except D1: MySQL connections enable `supportBigNumbers`, and SQLite / Turso return integers beyond 2^53 as `BigInt` while ordinary integers stay `number`. Anywhere hazejs writes JSON (responses, `toJSON()`, logs, cache, queues, WebSocket), `BigInt` values are written as strings.
:::

## Migrations

After changing a schema, generate a migration and apply it:

```bash
haze db:generate --name create_posts   # writes SQL to database/migrations
haze db:migrate                        # runs pending migrations
```

The template exposes the same commands as `pnpm db:generate`, `pnpm db:migrate` and `pnpm db:seed`.

- `db:generate` runs drizzle-kit (a dev dependency of the template) with the right dialect, schema and output paths. Pass `--custom` to create an empty migration for hand-written SQL.
- `db:migrate` applies migrations that have not run yet. Pass `--connection <name>` to target one connection, or `--all` for every SQL connection.
- Both commands accept `--connection` (`-c`). MongoDB connections are skipped, since they have no SQL migrations.

Migrations are recorded in the same `__drizzle_migrations` table drizzle uses, so you can mix in `drizzle-kit migrate` if you want.

## Seeding

Seeders are files in `database/seeders` that export a default function. `haze db:seed` runs them in filename order inside your application, so models and config are available:

```ts
// database/seeders/01-users.ts
import { Hash } from '@hazejs/core'
import { User } from '~/app/model/User'

export default async function seed(): Promise<void> {
  if (await User.where('email', 'admin@example.com').exists())
    return
  await User.create({
    name: 'Admin',
    email: 'admin@example.com',
    password: await Hash.make('password'),
    role: 'admin',
  })
}
```

Run a single file with `haze db:seed --file 01-users`. `haze make:seeder` creates a new seeder.

For bulk demo data, use [model factories](./factories): `await UserFactory.count(50).create()`.

## Production migrations

Migration files are bundled into the build output, so production needs neither the source code nor drizzle-kit:

| Preset | How to migrate |
|--------|----------------|
| node | `node dist/migrate.mjs` (full-stack projects: `node dist/server/migrate.mjs`) |
| bun | `bun dist/migrate.mjs` (full-stack projects: `bun dist/server/migrate.mjs`) |
| deno | `deno run -A dist/server/migrate.mjs` |
| docker | `docker run --rm <image> node server/migrate.mjs` |
| aws-lambda | Invoke the same bundle once with handler `index.migrate` (event `{ "connection"?, "all"? }`) |
| vercel / netlify | Run `haze db:migrate` before the build, with the production `DATABASE_URL` |
| cloudflare + D1 | `npx wrangler d1 migrations apply <database> --remote -c dist/wrangler.json` |
| cloudflare + Turso | Run `haze db:migrate` in CI |

The `migrate.mjs` script accepts `--connection <name>` and `--all`, like `haze db:migrate`. More in [Deployment](./deployment).

### Cloudflare D1 and Turso

A common setup is a local SQLite file during development and D1 once deployed:

```ts
// config/database.ts
import { env } from '@hazejs/core'
import { defineDatabaseConfig } from '@hazejs/orm'

export default defineDatabaseConfig(() => ({
  default: 'main',
  connections: {
    main: env('DB_DRIVER', 'sqlite') === 'd1'
      ? { driver: 'd1', binding: 'DB' }
      : { driver: 'sqlite', url: env('DATABASE_URL', 'file:./data/app.db') },
    // Turso: { driver: 'turso', url: env('DATABASE_URL'), authToken: env('DATABASE_AUTH_TOKEN') }
  },
}))
```

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  cloudflare: {
    wrangler: {
      vars: { DB_DRIVER: 'd1' },
      d1_databases: [
        { binding: 'DB', database_name: 'my-db', database_id: '<id>' },
      ],
    },
  },
})
```

## Running queries

Models cover most needs (see [Models](./models)). For table-level access, use the `Db` facade with any drizzle table:

```ts
import { Db } from '@hazejs/orm'
import { sql } from 'drizzle-orm'
import { users } from '~/database/schema/users'

const ada = await Db.table(users).where('email', 'ada@example.com').find()
const page = await Db.table(users).where('role', 'admin').order('id', 'desc').paginate(1, 20)
const id = await Db.table(users).insertGetId({ name: 'Bob', email: 'bob@example.com' })
await Db.table(users).where('id', id).update({ name: 'Bobby' })

// Raw SQL always returns an array of rows
const rows = await Db.execute(sql`select count(*) as n from users`)

// The underlying drizzle instance, for joins and anything else drizzle can do
const db = await Db.drizzle()
```

Code that cannot `await` — for example a repository class exposing a `db` getter over hand-written drizzle queries — can read the current instance synchronously once the connection is open. Inside a transaction it returns the transaction object:

```ts
await Db.connect()      // e.g. in a provider's boot()

export class OrderRepository {
  protected get db() {
    return Db.drizzleSync()   // throws if the connection is not open yet
  }

  findByNo(orderNo: string) {
    return this.db.select().from(orders).where(eq(orders.orderNo, orderNo))
  }
}
```

`Db.table()` returns the same query builder that models use, with `where`, `order`, `paginate`, `count`, `insert`, `update`, `delete` and more. Joins, subqueries, grouping, JSON fields, upserts and the full list of methods are in [Query Builder](./query-builder).

::: tip Safety nets
- `update()` and `delete()` without any condition throw. Pass `{ all: true }` to really touch every row. A model's automatic filters (soft deletes, tenant, global scopes) do not count as a condition.
- Unique constraint violations on every driver become a `UniqueConstraintException`, rendered as `409` with `code: 'unique_violation'`; it carries the `constraint`, `table`, `columns` and `detail` the driver reported ([Models → Errors](./models#errors)).
- Query builders are mutable: build a fresh one per query instead of branching from a shared base ([Query Builder](./query-builder)).
:::

## Transactions

```ts
await Db.transaction(async () => {
  const user = await User.create({ name: 'Ada', email: 'ada@example.com' })
  await Db.table(profiles).insert({ userId: user.id })
})
```

Every `Db` and `Model` query inside the callback joins the transaction automatically. Manual `Db.startTrans()` / `Db.commit()` / `Db.rollback()`, nesting with savepoints, isolation levels, row locks and `Db.afterCommit()` (run code, dispatch jobs or emit events only after the commit) are covered in [Transactions](./transactions).

## Multiple connections

Add more entries under `connections` and pick one per query or per model:

```ts
// config/database.ts
export default defineDatabaseConfig(() => ({
  default: 'main',
  connections: {
    main: { driver: 'sqlite', url: env('DATABASE_URL', 'file:./data/app.db') },
    analytics: { driver: 'postgres', url: env('ANALYTICS_URL'), schema: 'database/analytics' },
  },
}))
```

```ts
await Db.connection('analytics').table(events).where('type', 'signup').count()
await Db.connection('analytics').transaction(async () => { /* ... */ })
```

```ts
// app/model/Event.ts
export class Event extends Model.define(events) {
  static override connection = 'analytics'
}
```

Non-default connections keep their migrations in `database/migrations/<name>` unless you set `migrations`. Use `haze db:generate --connection analytics` and `haze db:migrate --connection analytics` (or `--all`).

### Several applications in one process

Each application gets its own `DatabaseManager` from `databaseProvider()`. Inside a request, `Db` and models use the manager of the application handling it. Queued jobs, scheduled tasks and event listeners run in the context of their application too, so `Db` inside them uses that application's manager without any setup. Elsewhere outside requests (timers, scripts) they use the most recently booted application, and closing an application restores the previous one. When several applications run side by side — typically in tests — pin such code to one of them with `runInApp(app, fn)` from `@hazejs/core` (which also pins the other facades, `useApp()` and `config()`) or with `Db.withManager()`. Everything inside the callback, including timers and promises it creates, uses that manager, and transactions are tracked per manager, so two apps' `main` connections never share a transaction:

```ts
import { DatabaseManager, Db } from '@hazejs/orm'

await Db.withManager(app.make(DatabaseManager), () => startBackgroundWork())
```

## Read/write splitting

Send reads to replicas and everything else to the primary by adding `write` and `read` to a connection. Fields you leave out are inherited from the connection itself, so a replica entry often only needs a `url`:

```ts
// config/database.ts
export default defineDatabaseConfig(() => ({
  default: 'main',
  connections: {
    main: {
      driver: 'postgres', // also node-postgres, mysql, sqlite, turso and pglite
      url: env('DATABASE_URL'),
      write: { url: env('DB_WRITE_URL') },
      read: [
        { url: env('DB_READ_URL_1') },
        { url: env('DB_READ_URL_2') },
      ],
      sticky: true,
      pool: { max: 10, idleTimeout: '30s', connectTimeout: '5s' },
    },
  },
}))
```

| Option | Description |
|--------|-------------|
| `write` | The primary: `url`, `authToken`, `pool`, `logging`. Defaults to the connection's own settings |
| `read` | One replica or a list of them. Each read picks one at random |
| `sticky` | After a write in the current request, later reads in that request use the primary, so you read your own writes despite replication lag |
| `pool` | A number (max connections) or `{ max, idleTimeout, connectTimeout }`. Timeouts take seconds or `'500ms'` / `'30s'` / `'5m'`. Applies to `postgres`, `mysql` and `mongodb` |

Each side is a separate client with its own pool. A connection without `read` and `write` works as before.

### Which side runs a query

| Goes to the primary | Goes to a replica |
|---------------------|-------------------|
| `insert`, `update`, `delete`, `upsert`, `increment`, model `save()` / `delete()`, pivot writes | `select`, `find`, `count`, `paginate`, `value`, `column`, `exists`, `chunk`, `cursor`, eager loading |
| Everything inside `Db.transaction()`, `Db.startTrans()` and `Model.transaction()` | |
| Reads with `lock()`, `useWriter()`, `Model.onWriter()`, or inside `Db.useWriter(fn)` | |
| `Db.execute()` and `Db.drizzle()` (raw SQL may write) | `Db.drizzle({ read: true })` |
| `model.refresh()`, which usually follows a write | |
| Reads after a write in the same request, when `sticky` is on | |

```ts
await User.onWriter().find(id)                       // read the primary
await Db.table(users).useWriter().where('id', id).find()
const report = await Db.useWriter(() => buildReport()) // every read in the callback
```

### Sticky scopes outside requests

Inside an HTTP request, the request is the sticky scope. Queue jobs, commands and scripts have no request, so wrap the unit of work in `Db.withinScope()` to get the same behavior:

```ts
await Db.withinScope(async () => {
  await order.save()
  await Order.find(order.id) // primary, because this scope wrote to the connection
})
```

Writes are detected on the primary connection itself, so raw `Db.execute()` statements and writes through `Db.drizzle()` count too. Only `select`-style statements leave the scope on the replicas.

### Works with

- **Tenancy**: a per-tenant connection (`main@acme`) can return its own `read` / `write` from `database.config` in `config/tenancy.ts`; stickiness is tracked per tenant connection.
- **Modules**: a module's `connection` option is just a connection name, so it gets the splitting of that connection.
- **Query cache**: `cache()` keys do not depend on the side; a cached result is shared.
- **Snowflake IDs**: every client uses the same lossless integer handling.
- **Observability**: queries on a replica carry `replica: true` in the dev dashboard and `db.replica: true` on OpenTelemetry spans.
- **Migrations**, `refreshDatabase()` and `haze db:seed` run on the primary.

::: warning Not covered
- **Cloudflare D1** read replication goes through D1's Sessions API, which hazejs does not wrap; `read` / `write` on a `d1` connection throw. If you need it, call `withSession()` on the binding yourself (`usePlatformBinding('DB')` from `@hazejs/core`).
- **MongoDB** handles replicas in the driver: set `readPreference` in the connection `url` (for example `?readPreference=secondaryPreferred`). `read` / `write` on a `mongodb` connection throw.
:::

## Testing

`refreshDatabase()` reconnects and runs your migrations. Together with `DATABASE_URL=:memory:` in `.env.test`, every test starts with a fresh database:

```ts
// tests/user.test.ts
import { refreshDatabase } from '@hazejs/orm'
import { useTestApp } from '@hazejs/testing'
import { beforeEach } from 'vitest'

const t = useTestApp()
beforeEach(() => refreshDatabase({ migrations: 'database/migrations' }))
```

For MongoDB connections it drops the database instead. More in [Testing](./testing).
