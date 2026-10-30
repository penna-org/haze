# 快速开始

`@hazejs/orm` 是 hazejs 的数据库层：Active Record 风格的 `Model`、链式查询构造器和迁移执行器，底层是 [drizzle](https://orm.drizzle.team)。表结构就是普通的 drizzle 定义，列类型会自动带到模型和查询里，不需要再声明一遍。

api 模板已经配好了一整套：SQLite（`data/app.db`）、`users` 表、`User` 模型、迁移、数据填充和测试。

## 注册

ORM 通过服务提供者注册，模板中已经有了：

```ts
// app/provider/DatabaseProvider.ts
import { databaseProvider } from '@hazejs/orm'

// 读取 config/database.ts，Db / Model 自动使用该配置
export default databaseProvider()
```

连接在第一次查询时才建立；开发时跨热更新复用，应用关闭时释放。

## 配置

连接配置在 `config/database.ts`：

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

`default` 是未指定连接时使用的连接名。每个连接支持以下选项：

| 选项 | 说明 |
|------|------|
| `driver` | 驱动，见下表 |
| `url` | 连接地址。`sqlite` 的 `file:` 相对路径按项目根目录解析，目录不存在时自动创建 |
| `authToken` | libSQL / Turso 的认证令牌 |
| `binding` | 仅 D1：Workers 绑定名（默认 `DB`），也可以直接传入 `D1Database` 对象 |
| `pool` | `postgres` / `node-postgres` / `mysql` / `mongodb` 的连接池大小（默认 `10`），或 `{ max, idleTimeout, connectTimeout }` |
| `database` | 仅 MongoDB：数据库名（默认取 `url` 中的路径） |
| `logging` | 以 debug 级别输出每条 SQL |
| `schema` | drizzle 表结构目录，相对源码目录（默认 `database/schema`） |
| `migrations` | 迁移目录（默认连接为 `database/migrations`，其他连接为 `database/migrations/<name>`） |
| `read` / `write` / `sticky` | 读取走只读副本，见[读写分离](#读写分离) |
| `casing` | `'snake_case'` 或 `'camelCase'`：表定义中没有写列名的字段按它生成列名（`createdAt` → `created_at`）。需与生成迁移时的 casing 一致，`haze db:generate` 会传给 drizzle-kit |
| `timezone` | PostgreSQL 的会话时区（`postgres`、`node-postgres`、`pglite`），如 `'Asia/Shanghai'`；影响 `::date`、`date_trunc` 与不带时区的时间戳的输出 |
| `client` | 使用自己创建的客户端：`PGlite` 实例（`pglite`）、`pg.Pool` / `pg.Client`（`node-postgres`）或 postgres-js 实例（`postgres`）。由你负责关闭，应用关闭时不会关闭它 |

### 驱动

| 驱动 | 数据库 | 需要安装 |
|------|--------|----------|
| `sqlite` | SQLite / libSQL：`file:./data/app.db`、`:memory:` 或 `libsql://…` | `@libsql/client` |
| `turso` | 纯 HTTP 访问 Turso / sqld（`libsql://`、`https://`），不含原生二进制，可运行在 Edge 和 Serverless | `@libsql/client` |
| `d1` | 通过 Workers 绑定访问 Cloudflare D1 | 无 |
| `postgres` | PostgreSQL（postgres-js） | `postgres` |
| `node-postgres` | PostgreSQL（node-postgres，即 `pg`，drizzle 默认的 PostgreSQL 驱动） | `pg` |
| `pglite` | 嵌入式 PostgreSQL（WASM），适合本地开发和测试；`url` 为数据目录，省略时为内存库 | `@electric-sql/pglite` |
| `mysql` | MySQL（mysql2） | `mysql2` |
| `mongodb` | MongoDB，通过 `@hazejs/orm/mongo` 使用（见[模型](./models#mongodb)） | `mongodb` |

驱动都是可选的 peer 依赖，只有连接用到时才加载。按需安装：

::: code-group

```bash [SQLite / Turso]
pnpm add @libsql/client
```

```bash [PostgreSQL]
pnpm add postgres   # 或 pnpm add pg（driver: 'node-postgres'）
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

没装驱动时，第一次查询会报错，并提示应该安装哪个包。

::: tip 从 SQLite 切换
把模板切到 PostgreSQL 或 MySQL：安装驱动，修改 `driver` 和 `url`，再把 `database/schema` 里的表改用 `drizzle-orm/pg-core` 或 `drizzle-orm/mysql-core` 定义。`turso` 和 `d1` 的方言都是 SQLite，与 `sqlite` 共用同一套表结构和迁移。
:::

## 表结构

每张表是 `database/schema/*.ts` 中的一个 drizzle 定义：

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
表结构文件会被 drizzle-kit 直接读取：只从 `drizzle-orm` 导入，不要使用 `~` 别名。
:::

`haze make:model Post` 会同时生成 `app/model/Post.ts` 和对应方言的 `database/schema/posts.ts`，详见[模型](./models)。

### 雪花 ID

分布式系统，或者与 Java 服务共用的表，可以用 64 位[雪花算法](https://en.wikipedia.org/wiki/Snowflake_ID) ID 代替自增 ID：

```ts
// database/schema/orders.ts
import { pgSnowflake } from '@hazejs/orm/columns'
import { pgTable, text } from 'drizzle-orm/pg-core'

export const orders = pgTable('orders', {
  id: pgSnowflake('id').primaryKey(),                       // 插入时自动生成
  userId: pgSnowflake('user_id', { auto: false }).notNull(), // 外键：不自动生成
  title: text('title').notNull(),
})
```

| 列 | 存储类型 |
|----|----------|
| `pgSnowflake(name)` | `bigint` |
| `mysqlSnowflake(name)` | `bigint` |
| `sqliteSnowflake(name)` | `text`：Cloudflare D1 读取超过 2^53 的整数会丢失精度，文本在所有 SQLite 驱动上都是精确的。雪花 ID 在几十年内都是 19 位，文本排序与数值排序一致 |

`@hazejs/orm/columns` 只依赖 drizzle，可以在表结构文件中直接导入。

在应用代码中，雪花 ID 是**十进制字符串**（`'1849302746129387521'`）。JavaScript 的 `number` 只能精确表示 2^53 以内的整数，装不下 64 位整数，所以 ID 全程不经过 `number`。字符串也可以直接作为 JSON 返回，这和 Java 服务把 `Long` 序列化为字符串、避免前端丢失精度的做法一致。

```ts
const order = await Order.create({ userId, title: 'Hello' })
order.id                              // '1849302746129387521'
await Order.findOrFail(ctx.param('id')) // URL、请求体中的 ID 本来就是字符串

import { Snowflake, snowflakeId } from '@hazejs/orm'
snowflakeId()                         // 手动生成
Snowflake.parse(order.id)             // { time, datacenterId, workerId, sequence }
```

位布局（41 位时间戳、5 位数据中心、5 位机器、12 位序列号）和默认纪元（`1288834974657`）与 MyBatis-Plus 的 `IdType.ASSIGN_ID`、Hutool 的 `Snowflake` 相同。只要 workerId / datacenterId 不重复，Node 和 Java 服务就可以写同一张表。按实例配置：

```ts
// config/database.ts
export default defineDatabaseConfig(() => ({
  default: 'main',
  connections: { /* ... */ },
  snowflake: {
    workerId: Number(env('SNOWFLAKE_WORKER_ID', '0')),
    datacenterId: Number(env('SNOWFLAKE_DATACENTER_ID', '0')),
    // epoch: new Date('2024-01-01'), // 仅当 Java 服务使用了自定义纪元时设置
  },
}))
```

没有配置时，生成器读取环境变量 `SNOWFLAKE_WORKER_ID` / `SNOWFLAKE_DATACENTER_ID`，都没有则随机选取。随机值在多个实例之间可能重复，部署多个实例时请显式配置。

::: tip 其他 64 位整数
也可以使用 drizzle 的 `bigint('id', { mode: 'bigint' })` 列，值为 `BigInt`。除 D1 外，所有驱动读取 64 位整数都不会丢失精度：MySQL 连接开启了 `supportBigNumbers`；SQLite / Turso 中超过 2^53 的整数返回 `BigInt`，普通整数仍是 `number`。hazejs 输出 JSON 的地方（响应、`toJSON()`、日志、缓存、队列、WebSocket）都会把 `BigInt` 写成字符串。
:::

## 迁移

修改表结构后，生成迁移并执行：

```bash
haze db:generate --name create_posts   # 生成 SQL 到 database/migrations
haze db:migrate                        # 执行尚未运行的迁移
```

模板里也可以用 `pnpm db:generate`、`pnpm db:migrate`、`pnpm db:seed`。

- `db:generate` 按连接的方言、表结构目录和迁移目录调用 drizzle-kit（模板已装为开发依赖）。加 `--custom` 生成空白迁移，用来手写 SQL。
- `db:migrate` 执行还没跑过的迁移。`--connection <name>` 指定连接，`--all` 对所有 SQL 连接执行。
- 两个命令都支持 `--connection`（`-c`）。MongoDB 连接没有 SQL 迁移，会被跳过。

迁移记录写在 drizzle 自己使用的 `__drizzle_migrations` 表中，需要的话可以和 `drizzle-kit migrate` 混用。

## 数据填充

数据填充文件放在 `database/seeders`，默认导出一个函数。`haze db:seed` 在应用内按文件名顺序执行它们，因此可以直接使用模型和配置：

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

只执行某一个文件：`haze db:seed --file 01-users`。新建数据填充：`haze make:seeder`。

批量的演示数据用[模型工厂](./factories)生成：`await UserFactory.count(50).create()`。

## 生产环境迁移

迁移文件会打包进构建产物，生产环境既不需要源码，也不需要 drizzle-kit：

| 预设 | 执行迁移 |
|------|----------|
| node | `node dist/migrate.mjs`（全栈项目为 `node dist/server/migrate.mjs`） |
| bun | `bun dist/migrate.mjs`（全栈项目为 `bun dist/server/migrate.mjs`） |
| deno | `deno run -A dist/server/migrate.mjs` |
| docker | `docker run --rm <镜像> node server/migrate.mjs` |
| aws-lambda | 用同一份产物，把 handler 设为 `index.migrate` 调用一次（事件 `{ "connection"?, "all"? }`） |
| vercel / netlify | 在构建命令前执行 `haze db:migrate`（使用生产库的 `DATABASE_URL`） |
| cloudflare + D1 | `npx wrangler d1 migrations apply <库名> --remote -c dist/wrangler.json` |
| cloudflare + Turso | 在 CI 中执行 `haze db:migrate` |

`migrate.mjs` 和 `haze db:migrate` 一样支持 `--connection <name>` 与 `--all`。更多内容见[部署](./deployment)。

### Cloudflare D1 与 Turso

常见做法是本地开发用 SQLite 文件，部署到 Workers 后切换为 D1：

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
    // Turso：{ driver: 'turso', url: env('DATABASE_URL'), authToken: env('DATABASE_AUTH_TOKEN') }
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

## 执行查询

大多数场景用模型就够了（见[模型](./models)）。需要直接按表操作时，用 `Db` 门面配合任意 drizzle 表：

```ts
import { Db } from '@hazejs/orm'
import { sql } from 'drizzle-orm'
import { users } from '~/database/schema/users'

const ada = await Db.table(users).where('email', 'ada@example.com').find()
const page = await Db.table(users).where('role', 'admin').order('id', 'desc').paginate(1, 20)
const id = await Db.table(users).insertGetId({ name: 'Bob', email: 'bob@example.com' })
await Db.table(users).where('id', id).update({ name: 'Bobby' })

// 原生 SQL：统一返回行数组
const rows = await Db.execute(sql`select count(*) as n from users`)

// 底层 drizzle 实例：join 等复杂查询直接用 drizzle
const db = await Db.drizzle()
```

不能 `await` 的代码（例如在 Repository 类里用 `db` 属性写 drizzle 查询）可以在连接建立后同步取得当前的实例，处于事务中时返回事务对象：

```ts
await Db.connect()      // 如在服务提供者的 boot() 中

export class OrderRepository {
  protected get db() {
    return Db.drizzleSync()   // 连接还没建立时抛错
  }

  findByNo(orderNo: string) {
    return this.db.select().from(orders).where(eq(orders.orderNo, orderNo))
  }
}
```

`Db.table()` 返回的查询构造器与模型使用的是同一个，支持 `where`、`order`、`paginate`、`count`、`insert`、`update`、`delete` 等，连接查询、子查询、分组、JSON 字段、upsert 以及完整的方法列表见[查询构造器](./query-builder)。

::: tip 防误操作
- 不带任何条件的 `update()` / `delete()` 会直接报错，确实要改整张表时传 `{ all: true }`。模型自动附加的过滤（软删除、多租户、全局作用域）不算条件。
- 各数据库的唯一约束冲突都会统一转换为 `UniqueConstraintException`，响应 `409`，`code` 为 `'unique_violation'`；异常带有驱动给出的 `constraint`、`table`、`columns` 与 `detail`（见[模型 → 异常](./models#异常)）。
- 查询构造器是可变的：每次查询新建一个，不要从共用的基础查询上分支（见[查询构造器](./query-builder)）。
:::

## 事务

```ts
await Db.transaction(async () => {
  const user = await User.create({ name: 'Ada', email: 'ada@example.com' })
  await Db.table(profiles).insert({ userId: user.id })
})
```

回调内通过 `Db` 和 `Model` 发起的查询都会自动加入这个事务。手动的 `Db.startTrans()` / `Db.commit()` / `Db.rollback()`、嵌套事务（保存点）、隔离级别、行锁与 `Db.afterCommit()`（提交后再执行代码、投递任务或触发事件）见[事务](./transactions)。

## 多个连接

在 `connections` 中添加更多连接，按查询或按模型选择：

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

非默认连接的迁移默认放在 `database/migrations/<name>`（可用 `migrations` 修改）。生成和执行时指定连接：`haze db:generate --connection analytics`、`haze db:migrate --connection analytics`（或 `--all`）。

### 同一进程中的多个应用

每个应用由 `databaseProvider()` 创建自己的 `DatabaseManager`。请求内的 `Db` 与模型使用处理该请求的应用的连接；队列任务、定时任务与事件监听器同样在所属应用的上下文中执行，其中的 `Db` 无需任何设置即使用该应用的连接。其它请求之外的代码（定时器、脚本）使用最近启动的应用，应用关闭后恢复为之前的应用。多个应用同时运行时（通常是测试），用 `@hazejs/core` 的 `runInApp(app, fn)`（同时固定其它门面、`useApp()` 与 `config()`）或 `Db.withManager()` 把这类代码固定到某个应用：回调中的一切（包括其中创建的定时器与 Promise）都使用这个 DatabaseManager，事务也按 DatabaseManager 区分，两个应用的同名连接不会共用一个事务：

```ts
import { DatabaseManager, Db } from '@hazejs/orm'

await Db.withManager(app.make(DatabaseManager), () => startBackgroundWork())
```

## 读写分离

在连接上加 `write` 与 `read`，读取走只读副本，其余走主库。未写的字段继承连接本身的配置，因此副本通常只需写 `url`：

```ts
// config/database.ts
export default defineDatabaseConfig(() => ({
  default: 'main',
  connections: {
    main: {
      driver: 'postgres', // node-postgres、mysql、sqlite、turso、pglite 同样支持
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

| 选项 | 说明 |
|------|------|
| `write` | 主库：`url`、`authToken`、`pool`、`logging`，默认为连接本身的配置 |
| `read` | 一个副本或副本列表，每次读取随机选择一个 |
| `sticky` | 当前请求中写入过之后，该请求后续的读取走主库，避免因复制延迟读不到刚写入的数据 |
| `pool` | 数字（最大连接数）或 `{ max, idleTimeout, connectTimeout }`；超时为秒数或 `'500ms'` / `'30s'` / `'5m'`；作用于 `postgres`、`mysql`、`mongodb` |

每一端都是独立的客户端与连接池。没有 `read` / `write` 的连接行为不变。

### 查询走哪一端

| 走主库 | 走副本 |
|--------|--------|
| `insert`、`update`、`delete`、`upsert`、`increment`、模型的 `save()` / `delete()`、中间表写入 | `select`、`find`、`count`、`paginate`、`value`、`column`、`exists`、`chunk`、`cursor`、预加载 |
| `Db.transaction()`、`Db.startTrans()`、`Model.transaction()` 中的全部查询 | |
| 带 `lock()`、`useWriter()`、`Model.onWriter()` 的读取，或 `Db.useWriter(fn)` 回调中的读取 | |
| `Db.execute()` 与 `Db.drizzle()`（原生 SQL 可能写入） | `Db.drizzle({ read: true })` |
| `model.refresh()`（通常紧跟在写入之后） | |
| 开启 `sticky` 后，同一请求中写入之后的读取 | |

```ts
await User.onWriter().find(id)                       // 读主库
await Db.table(users).useWriter().where('id', id).find()
const report = await Db.useWriter(() => buildReport()) // 回调内的所有读取
```

### 请求之外的 sticky 作用域

HTTP 请求中，sticky 以请求为作用域。队列任务、命令和脚本没有请求，用 `Db.withinScope()` 包住一段工作即可得到相同的行为：

```ts
await Db.withinScope(async () => {
  await order.save()
  await Order.find(order.id) // 本作用域写入过该连接，读主库
})
```

写入在主库连接上识别，因此 `Db.execute()` 的原生语句和通过 `Db.drizzle()` 的写入同样计入；只有 `select` 一类的只读语句不会让作用域切到主库。

### 与其它功能

- **多租户**：每租户独立连接（`main@acme`）可以在 `config/tenancy.ts` 的 `database.config` 中返回自己的 `read` / `write`；sticky 按租户连接分别记录。
- **模块**：模块的 `connection` 选项只是连接名，使用该连接的读写分离。
- **查询缓存**：`cache()` 的键与走哪一端无关，缓存结果共用。
- **雪花 ID**：每个客户端都使用同样的无损整数处理。
- **可观测性**：副本上的查询在开发面板中标注 `replica`，OpenTelemetry span 带有 `db.replica: true`。
- **迁移**、`refreshDatabase()` 与 `haze db:seed` 在主库上执行。

::: warning 不在范围内
- **Cloudflare D1** 的读复制通过 D1 的 Sessions API 实现，hazejs 没有封装；`d1` 连接配置 `read` / `write` 会报错。需要时请自行调用绑定的 `withSession()`（`@hazejs/core` 的 `usePlatformBinding('DB')`）。
- **MongoDB** 的副本由驱动处理：在连接 `url` 中设置 `readPreference`（例如 `?readPreference=secondaryPreferred`）。`mongodb` 连接配置 `read` / `write` 会报错。
:::

## 测试

`refreshDatabase()` 会重建连接并执行迁移。配合 `.env.test` 中的 `DATABASE_URL=:memory:`，每个用例都从一个全新的数据库开始：

```ts
// tests/user.test.ts
import { refreshDatabase } from '@hazejs/orm'
import { useTestApp } from '@hazejs/testing'
import { beforeEach } from 'vitest'

const t = useTestApp()
beforeEach(() => refreshDatabase({ migrations: 'database/migrations' }))
```

对 MongoDB 连接则是清空整个数据库。更多内容见[测试](./testing)。
