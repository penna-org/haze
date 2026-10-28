# Modules

A module is a reusable feature unit — a blog, a CMS, a billing integration. Once a project enables it, the project gains the module's routes, middleware, config defaults, services, migrations, jobs, events, listeners, commands, schedules, policies, notifications and broadcast channels.

Modules come from two places, and both produce the same `defineModule()` shape:

- **Local modules** — folders in `modules/<name>/` inside your project (relative to `srcDir`), discovered automatically. They use the same layout as the app itself.
- **Module packages** — npm packages you install and enable explicitly in `config/modules.ts`. `pnpm create hazejs my-module --template module` scaffolds one.

## Modules vs. multiple apps

Modules merge into **one** application. They share the container, guards, the response formatter, the exception handler, logging and database connections. There is no per-module isolation — that is what [multiple apps](./multi-app) are for.

| | Modules | Multiple apps |
| --- | --- | --- |
| Purpose | Reuse a feature in this and other projects | Split one project into separately configured front doors (API, admin, mobile) |
| Location | `modules/<name>/` or an npm package | `app/<name>/` |
| Config | Defaults merged *under* the project config | Deep-merged *over* the global config, only for that app's requests |
| Middleware, exception handler, formatter | Shared; a module adds aliases, groups and global middleware | Per app |
| Providers, jobs, events, commands, migrations | Yes | Providers only |
| Routes | Mounted with a prefix and name prefix; optionally into one app | Per app, selected by prefix or domain |

The two combine: a module can be mounted into a single app with `app: 'admin'` (see [Enabling modules](#enabling-modules)).

## Local modules

A local module is a folder in `modules/` with the same internal layout as the app:

```
modules/
  blog/
    module.ts              # optional: defineModule() overrides (prefix, middleware, …)
    route/                 # route files (auto-loaded)
    config/                # config defaults, one file per key (auto-loaded)
      blog.ts              #   → config('blog.*'), overridable by the project's config/blog.ts
      middleware.ts        #   → the module's middleware aliases / groups / global
    app/
      controller/          # imported by the routes
      provider/            # service providers (auto-loaded)
      job/ event/ listener/ policy/ notification/ channel/   (auto-loaded)
      command/             # console commands, subdirectories allowed (auto-loaded)
      model/ service/ middleware/ …
    schedule/              # scheduled tasks (auto-loaded)
    database/
      schema/              # drizzle tables
      migrations/          # drizzle-kit output, run before the app's migrations
      seeders/             # run by haze db:seed before the app's seeders
    tests/                 # Vitest tests
```

Every local module is enabled by default. File-based names work exactly as in the app: `modules/blog/app/job/SendDigest.ts` is the job `SendDigest`, `modules/blog/app/command/db/Prune.ts` is the command `db:prune`, `modules/blog/app/event/PostPublished.ts` is the event `PostPublished`.

Generate a skeleton with:

```bash
haze make:module blog
```

```
modules/blog/module.ts
modules/blog/route/blog.ts
modules/blog/app/controller/BlogController.ts
modules/blog/config/blog.ts
modules/blog/tests/blog.test.ts
```

Every `make:*` generator accepts `--module <name>` (alias `-m`) to write into the module instead of the app:

```bash
haze make:controller Post --module blog     # modules/blog/app/controller/PostController.ts
haze make:model Post --module blog          # modules/blog/app/model/Post.ts + modules/blog/database/schema/posts.ts
haze make:job SendDigest --module blog      # modules/blog/app/job/SendDigest.ts
haze db:generate --module blog              # modules/blog/database/schema → modules/blog/database/migrations
```

### `module.ts`

Without `module.ts` the conventions apply: no URL prefix, route names prefixed with `blog.`. Add `modules/<name>/module.ts` to change that:

```ts
// modules/blog/module.ts
import { defineModule } from '@hazejs/core'

export default defineModule({
  prefix: '/api/blog',          // URL prefix for the module's routes
  as: 'blog.',                  // route name prefix (the default)
  routeMiddleware: ['throttle:60,60'],
  config: { blog: { perPage: 20 } },
})
```

Lists in `module.ts` (routes, providers, jobs, …) are added to the discovered ones, and config keys are deep-merged with `config/*.ts`. A local module is always named after its directory.

## Enabling modules

`config/modules.ts` enables module packages and configures local modules:

```ts
// config/modules.ts
import { defineModulesConfig } from '@hazejs/core'
import blog from '@acme/hazejs-blog'

export default defineModulesConfig({
  modules: [
    // used as is, or called with options
    blog({ prefix: '/api/blog', as: 'blog.', middleware: ['auth'], perPage: 10 }),
  ],
  // local modules are enabled by default: false disables one, an object configures it
  local: {
    shop: false,
    cms: { prefix: '/cms' },
  },
})
```

| Option | Description |
| --- | --- |
| `prefix` | URL prefix of the module's routes |
| `as` | Route name prefix. Defaults to `<module>.`; `''` keeps the module's own names |
| `middleware` | Extra middleware for all the module's routes, after the module's own `routeMiddleware` |
| `app` | Mount the routes into a [sub-app](./multi-app) only, e.g. `'admin'` → `/admin/<prefix>/…`, names `admin.<as>…` |
| `connection` | Database connection for the module's migrations. Defaults to the default connection |

A module package may accept its own typed options next to these (`perPage` above) — see [Typed options](#typed-options).

### Order and precedence

Modules are enabled in this order: modules passed to `createApplication({ modules })`, then `modules` in `config/modules.ts`, then local modules by directory name. Enabling two modules with the same name throws.

| What | How modules and the app combine |
| --- | --- |
| Config | Framework defaults → module defaults (in enable order) → the project's `config/*.ts`. Deep-merged: `config/blog.ts` only needs the keys it changes |
| Providers | Module providers `register()` before the app's providers, so the app can rebind a module's services |
| Middleware aliases and groups | Merged into the registry. A name defined by two modules — or by a module and a built-in middleware — throws an error naming both, unless the project's `config/middleware.ts` defines it too (an explicit override) |
| Global middleware | Run after the project's global middleware, in enable order |
| Routes | Loaded after the app's routes and compiled the same way. Duplicate route names throw with their sources: `Duplicate route name "blog.index" (the app and module "blog")` |
| Jobs, events, listeners, schedules, policies, commands | Registered before the app's. A job with the same name as one of the app's is replaced by the app's; duplicate command names throw |

## Writing a module package

Scaffold a publishable package:

```bash
pnpm create hazejs my-module --template module
```

It contains a `defineModule()` entry with a route, controller, middleware alias, config defaults, a migration and tests, built with tsdown. The entry looks like this:

```ts
// src/index.ts
import { defineModule } from '@hazejs/core'
import { defaults } from './config'
import { EnsureJson } from './middleware/EnsureJson'
import routes from './routes'

export default defineModule({
  name: 'myModule',
  prefix: '/api/my-module',
  config: { myModule: defaults },
  routes: [routes],
  middleware: {
    alias: { 'myModule.json': EnsureJson },
    // groups: { … }, global: [ … ]
  },
  providers: [MyModuleProvider],
  jobs: { SendDigest },                 // { name: definition } — packages have no file names
  events: { PostPublished },
  commands: [defineCommand({ name: 'my-module:sync', run })],
  migrations: new URL('../database/migrations', import.meta.url),
})
```

| Field | Description |
| --- | --- |
| `name` | Required for packages. Used as the default route name prefix, in errors, `module:list` and the migrations table |
| `prefix`, `as`, `routeMiddleware`, `app`, `connection` | Defaults for the [enable options](#enabling-modules) |
| `config` | Config defaults per key; values may be functions (evaluated after `.env` is loaded) |
| `routes` | `defineRoutes()` modules |
| `middleware` | `{ alias, groups, global }`, the same shape as `config/middleware.ts` |
| `providers` | Service providers |
| `jobs`, `events`, `listeners`, `schedules`, `policies`, `notifications`, `channels`, `commands`, `interceptors` | Arrays, or objects whose keys are the names (job name, event name, command name, notification type) |
| `discovered` | Other kinds read by extension packages, e.g. `{ sockets: [...] }` for Socket.IO, `{ messages: [...] }` for microservices |
| `migrations` | The drizzle-kit migrations folder. Use a literal `new URL('…', import.meta.url)` so production builds can bundle it |
| `options` | Typed enable options, see below |

`package.json` must mark the package as a module and publish the migrations:

```json
{
  "files": ["database", "dist"],
  "hazejs": { "module": true },
  "peerDependencies": { "@hazejs/core": "^0.2.0" }
}
```

`"hazejs": { "module": true }` lets the host's build find the package: it is always bundled (sharing the app's `@hazejs/core`), its migrations folder is embedded in the production build, and when it is linked it is processed by Vite in dev.

### Config typing

Ship the config type as a module augmentation. It is part of the package's declarations, so in the host project `config('myModule.perPage')` is typed without any typegen:

```ts
// src/config.ts
export interface MyModuleConfig {
  perPage: number
}

export const defaults: MyModuleConfig = { perPage: 20 }

declare module '@hazejs/core' {
  interface ConfigSchema {
    myModule: MyModuleConfig
  }
}
```

For local modules, typegen adds every `modules/<name>/config/*.ts` key that the project does not define itself to `.haze/types/haze.d.ts`. Module route names are generated like any other route.

### Typed options

`options` receives whatever was passed when enabling (besides the mount options) and returns definition fields to merge:

```ts
export default defineModule({
  name: 'myModule',
  config: { myModule: defaults },
  options: (options: { perPage?: number }) => options.perPage
    ? { config: { myModule: { perPage: options.perPage } } }
    : undefined,
})

// config/modules.ts — typed: prefix, as, middleware, app, connection + perPage
myModule({ prefix: '/blog', perPage: 10 })
```

Returned config is deep-merged with the module's defaults, and returned lists are appended.

## Migrations

`haze db:migrate`, `refreshDatabase()` and the production migration entries (`migrate.mjs`, Lambda `index.migrate`) run, for each connection:

1. every enabled module's migrations, in enable order;
2. the app's own migrations, last.

```
[main] module myModule: migrated: 1 of 1 applied (node_modules/my-module/database/migrations)
[main] module blog: migrated: 1 of 1 applied (modules/blog/database/migrations)
[main] migrated: 4 of 4 applied (database/migrations)
```

Each module records its migrations in its own table, `__drizzle_migrations_<module>` (`myModule` → `__drizzle_migrations_my_module`); the app keeps `__drizzle_migrations`. drizzle decides what to run by comparing timestamps with the **last** row of the table, so folders sharing one table would skip each other's migrations. Separate tables make every folder independent, re-running is idempotent, and the app's table stays compatible with `drizzle-kit migrate`.

- A module without a migrations folder (or with an empty one) is skipped.
- `connection` (in the definition or when enabling) runs the module's migrations on another connection; `haze db:migrate --all` covers every connection.
- `refreshDatabase({ modules: false })` runs only the app's migrations.
- `haze db:generate --module blog` reads `modules/blog/database/schema` and writes `modules/blog/database/migrations`. Module packages generate their own migrations with drizzle-kit (`pnpm db:generate` in the template).
- In production builds, local module migrations and the migrations of every `"hazejs": { "module": true }` dependency are bundled. Module code is bundled too, so `import.meta.url` no longer points into the package; the build rewrites `new URL('../database/migrations', import.meta.url)` to the embedded folder's key (`node_modules/<package>/database/migrations`).

## Testing a module

A local module is part of the app, so its tests use the app as usual. `haze make:module` creates one in `modules/<name>/tests/`:

```ts
import { useTestApp } from '@hazejs/testing'

const t = useTestApp()

it('serves the module routes', async () => {
  const res = await t.get('/api/blog')
  expect(res.status).toBe(200)
})
```

`refreshDatabase()` runs the enabled modules' migrations before the app's.

A module package is tested against a small host application. The template keeps it in `tests/app/`, with `config/modules.ts` enabling the module from source, and points the test config at it:

```ts
// vitest.config.ts
export default defineConfig(defineHazeTestConfig({
  haze: { srcDir: 'tests/app' },
}))
```

```ts
// tests/app/config/modules.ts
import { defineModulesConfig } from '@hazejs/core'
import myModule from '../../../src'

export default defineModulesConfig({ modules: [myModule({ perPage: 2 })] })
```

The host app has no migrations of its own; `refreshDatabase()` then only runs the module's.

## Development

- Local modules are part of the app's module graph: editing any file hot-reloads the app, and adding or removing a file updates the manifest.
- Module packages linked into the project (pnpm `workspace:` or `link:`) are processed by Vite instead of being loaded from `node_modules`, so editing them hot-reloads too. If the package's `exports` point at `dist/`, run `tsdown --watch` in the package (`pnpm dev` in the template).
- Published module packages in `node_modules` are loaded like any other dependency in dev; restart the dev server after upgrading them.

## Inspecting modules

```bash
haze module:list
```

```
NAME      SOURCE   PREFIX          ROUTE NAMES  ROUTES  MIGRATIONS
myModule  package  /api/my-module  myModule.*   2       /…/node_modules/my-module/database/migrations
blog      local    /api/blog       blog.*       1       modules/blog/database/migrations
```

`haze route:list` adds a MODULE column when modules register routes. Both accept `--json`.

## Limitations

- No isolation: a module's services, middleware aliases and global middleware affect the whole application. Use [multiple apps](./multi-app) for separately configured parts.
- Mounting into a sub-app (`app`) applies to routes only; aliases, providers and config stay global.
- A module cannot have its own exception handler or response formatter, and `lang/` folders inside modules are not discovered.
- Config typing for local modules comes from `modules/<name>/config/*.ts` files; config defaults declared inline in `module.ts` are not typed.
- Module packages have no file names, so jobs, events and commands need names (object keys or the `name` option).
- Module migrations run before the app's, so they cannot depend on tables created by the app's migrations.
- Production embedding needs a literal `new URL('…', import.meta.url)` for the migrations folder. To support several dialects, write one literal per folder and pick one in `options()`.
- Cloudflare D1: `wrangler d1 migrations apply` only reads the app's `database/migrations`; module migrations are not copied. Cron Triggers and the WebSocket Durable Object are detected from local modules only — set them in `cloudflare.wrangler` if a module package needs them.
- `haze db:seed` runs local modules' `database/seeders`, not seeders of module packages.
