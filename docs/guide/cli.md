# CLI Reference

The `haze` command comes from `@hazejs/cli`, a dev dependency of every template. Run it through a package script (`pnpm dev`) or directly:

```sh
npx haze <command> [options]
npx haze --help              # list all commands, including your own
npx haze make:model --help   # options of one command
```

Every command accepts `--root <dir>` to run against a project other than the current directory (default `.`).

Commands that need the application — `route:list`, `module:list`, `typegen`, `openapi`, `repl`, `db:*`, `queue:*`, `schedule:*`, `search:*`, `microservice:listen` and your own commands — boot it in the same Vite module graph as the dev server, without opening a port. They run your TypeScript source directly; no build is needed.

## Development and production

### `haze dev`

Start the development server. Code changes take effect on the next request; the process does not restart.

| Option | Description |
| --- | --- |
| `--port`, `-p` | Port. Defaults to `PORT`, then `port` in `haze.config.ts`, then `3000` |
| `--host` | Listen address |

If the project has a `vite.config.*`, `haze dev` starts Vite with that config instead (the `haze()` plugin mounts the backend), using Vite's port. See [Full-stack with Vite](./fullstack).

### `haze build`

Build for production. `NODE_ENV` defaults to `production`.

| Option | Description |
| --- | --- |
| `--preset`, `-p` | Deployment preset: `node`, `bun`, `deno`, `docker`, `cloudflare`, `vercel`, `netlify`, `aws-lambda`. Defaults to `preset` in `haze.config.ts`, then `node` |
| `--outDir` | Output directory (default `dist`). Backend-only projects |
| `--minify` | Minify the output (default `false`). Backend-only projects |

Full-stack projects are built by the project's Vite config, producing `dist/client` and `dist/server`; set minification and the output directory there or in `haze.config.ts`. After a build the CLI prints the entry file, the dependencies that stay in `node_modules`, and how to run or deploy the result. See [Deployment](./deployment).

### `haze start`

Run the production build: `dist/index.mjs` (backend-only) or `dist/server/index.mjs` (full-stack), from the `outDir` in `haze.config.ts`. It sets `NODE_ENV=production` and loads `.env` from the project root. Run `haze build` first.

| Option | Description |
| --- | --- |
| `--port`, `-p` | Sets `PORT` for the process |
| `--host` | Sets `HOST` for the process |

### `haze preview`

Run the build output locally the way its preset runs it — a child process for `node` / `bun` / `deno` / `docker`, an in-process function call for `aws-lambda` / `vercel` / `netlify`, Miniflare for `cloudflare`. Full-stack projects use their `vite.config.ts`, so this is the same as `vite preview`. Run `haze build` first.

| Option | Description |
| --- | --- |
| `--port`, `-p` | Port (default `4173`) |
| `--host` | Listen address |
| `--open` | Open the browser after starting |

### `haze test`

Run Vitest with `NODE_ENV=test`. Without arguments it runs `vitest run` once; any arguments replace `run` and are passed to Vitest unchanged:

```sh
npx haze test                    # vitest run
npx haze test --watch            # watch mode
npx haze test run tests/user     # run once, filtered
```

## Inspection

### `haze route:list`

Print every route with its method, path, name, handler and middleware. With [multiple apps](./multi-app) the app and domain columns are added, and a MODULE column shows routes registered by [modules](./modules).

| Option | Description |
| --- | --- |
| `--json` | Print the routes as JSON |

### `haze module:list`

List the enabled [modules](./modules) in enable order — the order their migrations run in — with their source (`package` or `local`), URL prefix, route name prefix, number of routes, migrations folder and, when mounted into a sub-app, the app.

| Option | Description |
| --- | --- |
| `--json` | Print the modules as JSON |

### `haze typegen`

Write the generated types and files in `.haze/`:

- `.haze/types/haze.d.ts` — config keys, named routes (with their inputs and outputs) and policy abilities;
- `.haze/types/i18n.d.ts` — translation keys from `lang/` ([Localization](./localization#typed-keys));
- `.haze/routes.ts` — the runtime route list used by the [typed client](./openapi#typed-client).

`haze dev` does this automatically (unless `typegen: false` in `haze.config.ts`); run it in CI before type checking.

### `haze openapi`

Print the [OpenAPI](./openapi) 3.1 document for the application to stdout. The docs do not need to be enabled for this, so you can export the document in CI.

| Option | Description |
| --- | --- |
| `--output`, `-o` | Write the document to a file instead, for example `-o openapi.json` |

### `haze repl`

Open an interactive shell with the booted application, `config`, `inject`, the facades (`Cache`, `Queue`, `Events`, `Storage`, `Mail`, plus `Db` when `@hazejs/orm` is installed) and every model in `app/model`. Top-level `await` works, and history is saved to `.haze/repl_history`. See [Console Commands](./console#repl).

| Option | Description |
| --- | --- |
| `--eval`, `-e` | Evaluate code, print the result and exit (non-interactive). Exits with code 1 if the code throws |

## Setup

### `haze key:generate`

Generate a 256-bit `APP_KEY` (base64url) and write it to `.env`.

| Option | Description |
| --- | --- |
| `--show` | Print the key without writing anything |
| `--force` | Replace an existing `APP_KEY`. Issued cookies, sessions and tokens become invalid |

Without `--force`, an existing key is kept and the command exits with code 1.

### `haze stub:publish`

Copy the built-in generator templates into `stubs/` so your team can customize what `make:*` generates. When `stubs/<name>.stub` exists, generators use it instead of the built-in one.

| Option | Description |
| --- | --- |
| `--force` | Overwrite stubs that already exist in `stubs/` |

::: v-pre
Stub names: `controller`, `controller.resource`, `service`, `repository`, `middleware`, `interceptor`, `provider`, `event`, `listener`, `job`, `policy`, `validate`, `validate.zod`, `test`, `config`, `route`, `seeder`, `command`, `mail`, `notification`, `channel`, `resource`, `model`, `model.mongodb`, `schema.sqlite`, `schema.postgres`, `schema.mysql`, `notifications.sqlite`, `notifications.postgres`, `notifications.mysql`, `auth-tables.sqlite`, `auth-tables.postgres`, `auth-tables.mysql`. Stubs use `{{ placeholder }}` variables such as `{{ className }}`, `{{ camelName }}`, `{{ kebabName }}`, `{{ routePath }}` and `{{ commandName }}`.
:::

## Code generation

```sh
npx haze make:<type> <name> [options]
```

Paths are relative to `srcDir` (except tests). Examples show the file generated for the given name.

| Command | Example | Generates |
| --- | --- | --- |
| `make:controller` | `User` | `app/controller/UserController.ts` |
| `make:service` | `User` | `app/service/UserService.ts` |
| `make:repository` | `User` | `app/repository/UserRepository.ts` |
| `make:model` | `Post` | `app/model/Post.ts` and `database/schema/posts.ts` |
| `make:middleware` | `Authenticate` | `app/middleware/Authenticate.ts` |
| `make:interceptor` | `AddHeader` | `app/interceptor/add-header.ts` |
| `make:provider` | `Payment` | `app/provider/PaymentProvider.ts` |
| `make:event` | `OrderPaid` | `app/event/OrderPaid.ts` |
| `make:listener` | `SendReceipt` | `app/listener/SendReceipt.ts` |
| `make:job` | `SendInvoice` | `app/job/SendInvoice.ts` |
| `make:policy` | `Post` | `app/policy/PostPolicy.ts` |
| `make:validate` | `User` | `app/validate/user.ts` |
| `make:test` | `user` | `tests/user.test.ts` (project root) |
| `make:config` | `payment` | `config/payment.ts` |
| `make:route` | `admin` | `route/admin.ts` |
| `make:seeder` | `Users` | `database/seeders/users.ts` |
| `make:factory` | `User` | `database/factories/UserFactory.ts` (imports `app/model/User`); see [Factories](./factories) |
| `make:command` | `SendReport` | `app/command/SendReport.ts` (runs as `haze send:report`) |
| `make:mail` | `Welcome` | `app/mail/WelcomeMail.ts` |
| `make:notification` | `InvoicePaid` | `app/notification/InvoicePaidNotification.ts` |
| `make:channel` | `Order` | `app/channel/order.ts` (authorizes `private-order.{id}`) |
| `make:resource` | `User` | `app/resource/UserResource.ts` |
| `make:notifications-table` | — | `database/schema/notifications.ts`; see [below](#make-notifications-table) |
| `make:auth-tables` | — | `database/schema/auth.ts`; see [below](#make-auth-tables) |
| `make:queue-tables` | — | `database/schema/queue.ts`, then `db:generate`; see [below](#make-queue-tables) |
| `make:module` | `blog` | `modules/blog/` with `module.ts`, a route, a controller, `config/blog.ts` and a test; see [Modules](./modules) |

After generating, most commands print a hint — where to register the file, or how to use it.

### Naming

- Names are converted to the right case, and a redundant suffix is dropped: `user`, `User` and `UserController` all produce `UserController`.
- Names may include subdirectories, for example `make:controller admin/User` → `app/controller/admin/UserController.ts`.
- Auto-discovered kinds only load the first level of their directory, so `make:interceptor`, `make:event`, `make:listener`, `make:job`, `make:policy`, `make:notification`, `make:channel`, `make:config`, `make:route` and `make:seeder` reject subdirectories.
- The notification type is the file name, so `make:notification InvoicePaid` creates the type `InvoicePaidNotification`. Rename the file if you want a shorter type.

### Common options

All `make:*` commands that take a name accept:

| Option | Description |
| --- | --- |
| `<name>` | Required. Name, optionally with subdirectories |
| `--force` | Overwrite the file if it exists |
| `--app`, `-a` | [Multiple apps](./multi-app): generate into `app/<app>/…` (for example `app/admin/controller`). Ignored by `make:test`; not supported by `make:command` and `make:factory`. Per app, only `route`, `config`, `provider`, `exception` and `response` are discovered, so keep jobs, events, listeners, policies, notifications and channels in the shared `app/` folders |
| `--module`, `-m` | [Local module](./modules): generate into `modules/<module>/…` with the same layout as the app (`make:test` writes `modules/<module>/tests/`). The module must exist (`haze make:module <name>`); cannot be combined with `--app` |

### `make:controller`

| Option | Description |
| --- | --- |
| `--resource`, `-r` | Generate a RESTful resource controller with `index`, `show`, `store`, `update` and `destroy`, ready for `r.resource()` |

### `make:validate`

Generates a valibot schema. If the project depends on zod but not valibot, a zod schema is generated instead.

### `make:model`

Generates a model in `app/model` and its drizzle table in `database/schema`. An existing schema file is left untouched.

| Option | Description |
| --- | --- |
| `--table` | Table name. Defaults to the plural snake case of the name (`OrderItem` → `order_items`) |
| `--dialect` | `sqlite`, `postgres`, `mysql` or `mongodb`. Inferred from the installed driver: `mysql2` → mysql, `postgres` or `@electric-sql/pglite` → postgres, only `mongodb` → mongodb, otherwise sqlite |
| `--soft-delete` | Enable soft deletes on the model |
| `--app`, `-a` | Generate the model into `app/<app>/model` |
| `--module`, `-m` | Generate the model and table into `modules/<module>/app/model` and `modules/<module>/database/schema` |
| `--force` | Overwrite the model if it exists |

With `--dialect mongodb` a `MongoModel` is generated and no schema file is written. For SQL dialects, run `haze db:generate` and `haze db:migrate` afterwards.

### `make:notifications-table` {#make-notifications-table}

Write `database/schema/notifications.ts`, the table used by the `database` channel of [notifications](./notifications). Then run `haze db:generate` and `haze db:migrate`, and point `channels.database.store` in `config/notification.ts` at `databaseNotificationStore(notifications)`.

### `make:auth-tables` {#make-auth-tables}

Write `database/schema/auth.ts` with the tables for [API tokens](./api-tokens), password resets, [two-factor secrets and passkeys](./two-factor). Delete the tables you don't need, then run `haze db:generate` and `haze db:migrate`. The templates already contain a trimmed version (tokens and password resets).

### `make:queue-tables` {#make-queue-tables}

Write `database/schema/queue.ts` with the `jobs` and `failed_jobs` tables used by the [database queue driver](./queues#database-driver), then run `haze db:generate` to create the migration (pass `--no-generate` to skip it). Apply it with `haze db:migrate` and add a `driver: 'database'` connection to `config/queue.ts`.

These commands take no name and accept:

| Option | Description |
| --- | --- |
| `--dialect` | `sqlite`, `postgres` or `mysql`. Inferred from the installed driver like `make:model`; MongoDB is not supported |
| `--force` | Overwrite the schema file if it exists |
| `--no-generate` | `make:queue-tables` only: don't run `db:generate` afterwards |

## Database

These commands read connections from `config/database.ts`. See [Database](./database).

### `haze db:generate`

Generate a migration from changes to the schema files, using drizzle-kit (it must be installed). The dialect comes from the connection's driver; schemas are read from `database/schema/*.ts`, and migrations are written to `database/migrations` (or `database/migrations/<connection>` for non-default connections). Both paths can be overridden per connection with `schema` and `migrations`.

| Option | Description |
| --- | --- |
| `--connection`, `-c` | Connection name. Defaults to `default` in `config/database.ts` (with `--module`, the module's connection) |
| `--module`, `-m` | Local module: read `modules/<module>/database/schema` and write `modules/<module>/database/migrations` |
| `--name` | Migration name, for example `create_posts` |
| `--custom` | Generate an empty migration to write SQL by hand |

MongoDB connections have no SQL schema or migrations.

### `haze db:migrate`

Run pending migrations. This is the same implementation as the production `migrate.mjs` entry, reading migrations from the source directory. For each connection, the enabled [modules'](./modules#migrations) migrations run first, in enable order and each tracked in its own table; the app's migrations run last.

| Option | Description |
| --- | --- |
| `--connection`, `-c` | Connection name. Defaults to `default` |
| `--all` | Migrate every connection |

### `haze db:seed`

Run the files in `database/seeders` in file-name order, after the seeders of enabled local modules (`modules/<name>/database/seeders`). Each file must default-export a function; it receives the application. Seeders can use [model factories](./factories) (`await UserFactory.count(10).create()`).

| Option | Description |
| --- | --- |
| `--file` | Only run this file (name without extension) |

## Queues

These commands work with the connections in `config/queue.ts`. See [Queues](./queues).

### `haze queue:work`

Consume queued jobs until stopped with Ctrl+C. Edits to job code take effect without restarting the worker.

| Option | Description |
| --- | --- |
| `--connection` | Queue connection. Defaults to `default` in `config/queue.ts` |
| `--queue`, `-q` | Queue names, comma-separated in priority order (default `default`) |
| `--concurrency`, `-c` | Jobs processed in parallel (default `1`) |

### `haze queue:failed`

List failed jobs with their ID, job name, queue, failure time, attempts and error. Accepts `--connection`.

### `haze queue:retry [id]`

Push a failed job back onto its queue. Without an `id`, every failed job is retried. Accepts `--connection`.

### `haze queue:forget <id>`

Delete one failed job. Accepts `--connection`.

### `haze queue:flush`

Delete all failed jobs. Accepts `--connection`.

## Scheduling

These commands run the tasks defined in `schedule/*.ts`. See [Task Scheduling](./scheduling).

### `haze schedule:list`

List tasks with their cron expression, timezone, next run time and flags (`onOneServer`, `withoutOverlapping`).

### `haze schedule:run`

Run the tasks due in the current minute, then exit. Call it from the system cron every minute. Exits with code 1 if any task failed.

### `haze schedule:work`

Keep running and check for due tasks at the start of every minute. Edits to `schedule/*.ts` take effect on the next minute.

## Search

These commands work with the searchable models of [`@hazejs/search`](./search) (it must be installed). They load the files in `app/model` and `app/<app>/model`, so call `searchable()` in the model's own file. The model argument is the class name or the index name.

### `haze search:import <model>`

Write every record of the model to its search index, in batches. Skips soft-deleted records and those `shouldBeSearchable` rejects.

| Option | Description |
| --- | --- |
| `--chunk` | Records read per batch. Defaults to `chunk` in `config/search.ts` (500) |

### `haze search:flush <model>`

Remove every document from the model's index.

### `haze search:sync-settings [model]`

Create the indexes and apply their settings (searchable, filterable and sortable fields); for the database engine, create the full-text index. Without a model, every searchable model is synced.

## Microservices

### `haze microservice:listen`

Listen for [microservice](./microservices) messages without opening an HTTP port. Requires `@hazejs/microservices`. Handler changes apply without a restart; new message patterns need one.

| Option | Description |
| --- | --- |
| `--transport`, `-t` | Transports to listen on, comma-separated, for example `nats,grpc`. Default: `listen` or `default` in `config/microservices.ts` |

## Your own commands

Every file in `app/command` (subdirectories included) that default-exports `defineCommand()` becomes a command: `app/command/SendReport.ts` runs as `haze send:report`, `app/command/db/Cleanup.ts` as `haze db:cleanup`. They are listed in `haze --help`, accept `--help` and `--root` like built-in commands, and exit with the code their `run()` returns. See [Console Commands](./console).

```sh
npx haze make:command SendReport
npx haze send:report ops@example.com --dry-run
```

## In production

The build output does not need the CLI or your source code. For process-based presets (`node`, `bun`, `deno`, `docker`) it contains standalone entries:

```sh
node dist/migrate.mjs [--connection <name>] [--all]            # haze db:migrate
node dist/worker.mjs queue [--queue a,b] [--concurrency 5]      # haze queue:work
node dist/worker.mjs schedule                                    # haze schedule:work
node dist/worker.mjs schedule:run                                # haze schedule:run
node dist/worker.mjs command <name> [args]                       # haze <name> (app/command)
```

The paths above are for backend-only projects with the `node` or `bun` preset. Full-stack projects and the `deno` / `docker` presets put these files in `dist/server/`. `migrate.mjs` is only emitted when the project uses `@hazejs/orm`. See [Deployment](./deployment) for serverless and edge platforms.

`search:*`, `microservice:listen`, `openapi`, `typegen` and `repl` have no production entry. For search, call `importSearchable()` / `syncSearchSettings()` from one of your commands and run it with `worker.mjs command`; for microservices, see [Deployment](./deployment#microservice-listeners).
