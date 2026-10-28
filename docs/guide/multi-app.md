# Multiple Apps

A single hazejs project can host several applications — say a public API, an admin console and a mobile backend — each with its own routes, config, middleware, exception handler and response format, while sharing models, services and the deployment. Apps are directory-based and selected per request by URL prefix or domain.

::: tip Modules vs. apps
Apps split one project into separately configured front doors. To package a feature — routes, config, migrations, jobs — for reuse in this or other projects, use a [module](./modules) instead. Modules merge into the shared application (no per-module config, middleware or exception handler), and a module can be mounted into a single app with `app: 'admin'`.
:::

## Declaring apps

List the apps in `config/app.ts` (in full-stack projects, `server/config/app.ts`). Each app needs a `prefix`, a `domain`, or both:

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  apps: {
    admin: { prefix: '/admin' }, // /admin/** → app/admin
    api: { domain: 'api.example.com' }, // requests for api.example.com → app/api
    mobile: { domain: '*.m.example.com', prefix: '/v1' },
  },
}))
```

| Option | Description |
|--------|-------------|
| `prefix` | URL prefix such as `/admin`. The prefix is stripped before the app's routes are matched. `/` makes a catch-all app. |
| `domain` | A host name or an array of them. `*.example.com` matches any subdomain (but not `example.com` itself). |

When several apps match a request, apps bound to a domain win, then the longest prefix. Requests that match no app go to the global routes in `route/`. The framework checks at boot that every app has a prefix or domain and that no two apps claim the same domain + prefix.

## Directory layout

The code for an app lives in `app/<name>/`. Only directories of apps declared in `config/app.ts` are loaded — a folder like `app/common/` is just shared code.

```
app/
  admin/
    controller/     # imported by the app's routes
    route/          # route files for this app (auto-loaded)
    config/         # app-level config, deep-merged over config/ (auto-loaded)
    provider/       # providers, loaded only when the app is enabled
    exception/
      Handler.ts    # exception handler for this app
    response/
      Formatter.ts  # response formatter for this app
  api/
    ...
  model/            # shared by all apps
  service/
```

The auto-discovered folders are `route`, `config`, `provider`, `exception` (`Handler.ts`) and `response` (`Formatter.ts`). Everything else — controllers, services, validation schemas — is regular code you import.

## Routes

Route files in `app/<name>/route/*.ts` use the normal [routing](./routing) API. Paths are relative to the app's prefix:

```ts
// app/admin/route/web.ts
import { defineRoutes } from '@hazejs/core'
import { UserController } from '~/app/admin/controller/UserController'

export default defineRoutes((r) => {
  r.get('/users', [UserController, 'index']).name('users.index') // GET /admin/users
  r.get('/users/:id', [UserController, 'show']).name('users.show')
})
```

Route names are prefixed with the app name automatically:

```ts
router.url('admin.users.show', { id: 7 }) // /admin/users/7
```

`haze route:list` shows every app's routes with APP and DOMAIN columns, and typegen covers the prefixed names. Because each app has its own router, apps on different domains can use the same paths.

## Configuration

Files in `app/<name>/config/*.ts` are deep-merged over the global config with the same name, for that app only:

```ts
// app/admin/config/app.ts
export default {
  name: 'Admin Console',
  response: { envelope: false },
}
```

Inside a request that belongs to the app, `config('app.name')` and `ctx.config.get('app.name')` return `'Admin Console'`; everywhere else the global value stays untouched. `inject(Config)` returns the app config in request-scoped services, while singletons always receive the global config.

## Middleware

Global middleware from `config/middleware.ts` runs for every request, before the app is selected. An app can add its own global middleware and aliases in `app/<name>/config/middleware.ts`; they only apply inside that app, and aliases may override global ones:

```ts
// app/admin/config/middleware.ts
import { defineMiddlewareConfig } from '@hazejs/core'
import { AdminAudit } from '~/app/admin/middleware/AdminAudit'

export default defineMiddlewareConfig({
  // Runs for every request to the admin app
  global: ['audit'],
  alias: {
    audit: AdminAudit,
  },
})
```

For an `/admin/secure` route with `.middleware('auth')`, the order is: global middleware → admin's global middleware → `auth` (admin's alias if it defines one, otherwise the global alias). See [Middleware](./middleware).

## Exception handler and response format

An app can provide `app/<name>/exception/Handler.ts` and `app/<name>/response/Formatter.ts`. They replace the global ones for requests to that app — including 404s for unknown paths under the app — while logging, interceptors and the error pipeline stay shared.

```ts
// app/api/response/Formatter.ts
import type { NormalizedError } from '@hazejs/core'
import { ResponseFormatter } from '@hazejs/core'

export default class Formatter extends ResponseFormatter {
  override success(data: unknown) {
    return { ok: true, result: data }
  }

  override error(error: NormalizedError) {
    return { ok: false, error: error.message }
  }
}
```

See [Responses](./responses) and [Errors & Logging](./errors) for the base classes.

## Providers

Providers in `app/<name>/provider/*.ts` are loaded when the app is declared, alongside the global `app/provider/*.ts`:

```ts
// app/admin/provider/AdminProvider.ts
import { defineProvider } from '@hazejs/core'

export default defineProvider({
  boot() {
    // runs once at application boot
  },
})
```

## Knowing the current app

`ctx.appName` holds the name of the app handling the request, or `undefined` for global routes. The request logger is also tagged with the app name.

```ts
r.get('/ping', ctx => ({ app: ctx.appName }))
```

## Generators

Code generators accept `--app <name>` (alias `-a`) and write into `app/<name>/` instead of `app/`:

```bash
haze make:controller User --app admin   # app/admin/controller/UserController.ts
haze make:middleware AdminAudit --app admin   # app/admin/middleware/AdminAudit.ts
haze make:route web --app admin         # app/admin/route/web.ts
haze make:config app --app admin        # app/admin/config/app.ts
haze make:model Post --app admin        # app/admin/model/Post.ts (the table schema still goes to database/schema)
```

See the [CLI Reference](./cli) for all generators.
