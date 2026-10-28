# CLI Reference

The `haze` command comes from `@hazejs/cli`, a dev dependency of every template. Run it through a package script (`pnpm dev`) or directly:

```sh
npx haze <command> [options]
npx haze --help              # list all commands
npx haze make:model --help   # options of one command
```

Every command accepts `--root <dir>` to run against a project other than the current directory (default `.`).

Commands that need the application — `route:list`, `typegen`, `db:*`, `queue:*`, `schedule:*` — boot it in the same Vite module graph as the dev server, without opening a port. They run your TypeScript source directly; no build is needed.

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

Print every route with its method, path, name, handler and middleware. With [multiple apps](./multi-app) the app and domain columns are added.

| Option | Description |
| --- | --- |
| `--json` | Print the routes as JSON |

### `haze typegen`

Write `.haze/types/haze.d.ts`: types for config keys, named routes and policy abilities. `haze dev` does this automatically (unless `typegen: false` in `haze.config.ts`); run it in CI before type checking.

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
Stub names: `controller`, `controller.resource`, `service`, `repository`, `middleware`, `interceptor`, `provider`, `event`, `listener`, `job`, `policy`, `validate`, `validate.zod`, `test`, `config`, `route`, `seeder`, `model`, `model.mongodb`, `schema.sqlite`, `schema.postgres`, `schema.mysql`. Stubs use `{{ placeholder }}` variables such as `{{ className }}`, `{{ camelName }}`, `{{ kebabName }}` and `{{ routePath }}`.
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

After generating, most commands print a hint — where to register the file, or how to use it.

### Naming

- Names are converted to the right case, and a redundant suffix is dropped: `user`, `User` and `UserController` all produce `UserController`.
- Names may include subdirectories, for example `make:controller admin/User` → `app/controller/admin/UserController.ts`.
- Auto-discovered kinds only load the first level of their directory, so `make:interceptor`, `make:event`, `make:listener`, `make:job`, `make:policy`, `make:config`, `make:route` and `make:seeder` reject subdirectories.

### Common options

All `make:*` commands accept:

| Option | Description |
| --- | --- |
| `<name>` | Required. Name, optionally with subdirectories |
| `--force` | Overwrite the file if it exists |
| `--app`, `-a` | [Multiple apps](./multi-app): generate into `app/<app>/…` (for example `app/admin/controller`). Ignored by `make:test` |

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
| `--force` | Overwrite the model if it exists |

With `--dialect mongodb` a `MongoModel` is generated and no schema file is written. For SQL dialects, run `haze db:generate` and `haze db:migrate` afterwards.

## Database

These commands read connections from `config/database.ts`. See [Database](./database).

### `haze db:generate`

Generate a migration from changes to the schema files, using drizzle-kit (it must be installed). The dialect comes from the connection's driver; schemas are read from `database/schema/*.ts`, and migrations are written to `database/migrations` (or `database/migrations/<connection>` for non-default connections). Both paths can be overridden per connection with `schema` and `migrations`.

| Option | Description |
| --- | --- |
| `--connection`, `-c` | Connection name. Defaults to `default` in `config/database.ts` |
| `--name` | Migration name, for example `create_posts` |
| `--custom` | Generate an empty migration to write SQL by hand |

MongoDB connections have no SQL schema or migrations.

### `haze db:migrate`

Run pending migrations. This is the same implementation as the production `migrate.mjs` entry, reading migrations from the source directory.

| Option | Description |
| --- | --- |
| `--connection`, `-c` | Connection name. Defaults to `default` |
| `--all` | Migrate every connection |

### `haze db:seed`

Run the files in `database/seeders` in file-name order. Each file must default-export a function; it receives the application.

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

## In production

The build output does not need the CLI or your source code. For process-based presets (`node`, `bun`, `deno`, `docker`) it contains standalone entries:

```sh
node dist/migrate.mjs [--connection <name>] [--all]            # haze db:migrate
node dist/worker.mjs queue [--queue a,b] [--concurrency 5]      # haze queue:work
node dist/worker.mjs schedule                                    # haze schedule:work
node dist/worker.mjs schedule:run                                # haze schedule:run
```

The paths above are for backend-only projects with the `node` or `bun` preset. Full-stack projects and the `deno` / `docker` presets put these files in `dist/server/`. `migrate.mjs` is only emitted when the project uses `@hazejs/orm`. See [Deployment](./deployment) for serverless and edge platforms.
