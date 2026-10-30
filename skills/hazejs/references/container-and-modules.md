# Container, providers, modules and multi-app

Everything here is imported from `@hazejs/core`. Paths follow the API template (`app/...`, `config/*.ts`, `route/*.ts`, `modules/<name>/`, `~/` = `srcDir`); in full-stack templates the same tree lives under `server/`.

## Service container

Full guide: [container.md](../../../docs/guide/container.md)

No decorators, no `reflect-metadata`. Classes are created with `new Impl()` (**no constructor arguments**) and declare dependencies with `inject()` in field initializers or the constructor body.

```ts
// app/service/UserService.ts
import { inject, Logger, NotFoundException } from '@hazejs/core'
import { UserRepository } from '~/app/repository/UserRepository'

export class UserService {
  private repo = inject(UserRepository) // unbound class → auto-bound in the root container
  private logger = inject(Logger)

  async find(id: number) {
    const user = await this.repo.findById(id)
    if (!user)
      throw new NotFoundException(`User ${id} not found`)
    return user
  }
}
```

**Where `inject(key)` works** (else `ContainerError: inject(X) must be called during construction by the container, inside container.call(), or within a request`):

| Context | Container used |
|---|---|
| Field initializer / constructor of a class the container is building | The container that owns the binding (root for singletons, request child for request scope) |
| Synchronously inside `container.call(() => ...)` | That container |
| Anywhere during a request (AsyncLocalStorage) | The request's child container |
| Queue jobs, event listeners, scheduled tasks (framework wraps them in `runInApp(app, fn)`), or your own `runInApp(app, fn)` | `app.container` |

Not at module top level, not in a provider class's fields (providers are `new`-ed directly), not after an `await` inside `container.call()` unless you are also in a request/app context (`call()` sets a synchronous context only).

Other ways to resolve: `app.make(key)` (root container), `ctx.make(key)` (request container), `useApp().make(key)` outside DI, `t.make(key)` in tests, `useContext()` for the current `HttpContext` in deep code.

### Scopes

```ts
import { Scope } from '@hazejs/core' // Scope.Singleton = 'singleton', Scope.Request = 'request', Scope.Transient = 'transient'
```

| Scope | Lifetime | Default for |
|---|---|---|
| `Scope.Singleton` | One per application; cached in the container that owns the binding (root). Rebuilt on every HMR reload | Every class without `static scope`, every factory/token binding |
| `Scope.Request` | One per request child container; disposed at the end of the request | Controllers (router binds them with `scopeOf(Controller, Scope.Request)` unless already bound), `HttpContext` |
| `Scope.Transient` | New instance per resolve; **not tracked, never disposed** | — |

```ts
// app/service/CurrentUser.ts
import { HttpContext, inject, Scope } from '@hazejs/core'

export class CurrentUser {
  static scope = Scope.Request // read by bind()/auto-bind; scopeOf(Class, fallback) reads it
  private ctx = inject(HttpContext)
  user() { return this.ctx.auth.user() }
}
```

Errors (all extend `ContainerError`; `CircularDependencyError` always and `ResolutionError` when reached through dependencies include the chain `A -> B -> C`; `ScopeError` carries none):

| Error | When |
|---|---|
| `ScopeError` | A singleton (or a transient built inside a singleton's chain) resolves a request-scoped key: `Cache (singleton) cannot depend on Current (request-scoped)` |
| `ScopeError` | A request-scoped key is resolved from the root container, e.g. `app.make(CurrentUser)` at boot / in a job: `... is request-scoped and can only be resolved within a request` |
| `CircularDependencyError` | `A -> B -> A` |
| `ResolutionError` | A `Token` with no binding (tokens are never auto-bound) |
| `ContainerError` | `inject()` outside a context; resolving from a disposed container; `bind()` with a non-class, non-function provider |

### Tokens

```ts
// app/tokens.ts — export ONE token object; identity is the key, the description is only for messages
import type { Redis } from 'ioredis'
import { createToken } from '@hazejs/core'

export const RedisClient = createToken<Redis>('redis') // Token<Redis>; inject(RedisClient) is typed as Redis
```

`InjectionKey<T> = Token<T> | AbstractConstructor<T>`. `keyName(key)` → `'ClassName'` or `'Token(redis)'`.

### Binding API (`Container`)

| Method | Behaviour |
|---|---|
| `bind(key, provider?, { scope? })` | `provider` = class (`new provider()`) or factory `(container) => value`; omitted → `key` must be a class. Default scope: the class's `static scope` (implementation class when binding an abstract key), else `Singleton`. Rebinding replaces the binding and drops the cached instance. Returns `this` (chainable) |
| `singleton(key, provider?)` / `scoped(key, provider?)` / `transient(key, provider?)` | `bind` with `Scope.Singleton` / `Scope.Request` / `Scope.Transient` |
| `instance(key, value)` | Register an existing value (Singleton on root, Request on a child). **Never disposed** by the container |
| `make(key)` | Resolve: own binding → parent's → auto-bind class into root → `ResolutionError` for tokens |
| `has(key)` | Bound here or in a parent (auto-bound classes only after first `make`) |
| `call(fn)` | Run `fn` synchronously with this container as the injection context |
| `createChild()` | Request-style child container (`isRequestScope === true`) |
| `bindings()` | `BindingInfo[]` `{ key, scope, kind: 'class' \| 'factory' \| 'instance', resolved }` of this container only — for debugging |
| `dispose()` | Dispose owned instances in reverse creation order (`Symbol.asyncDispose` awaited, else `Symbol.dispose`); further `make()` throws |
| `parent`, `root`, `isRequestScope` | Hierarchy |

Factories run inside an injection context, so they may call `inject()`. Singleton factories run in the root context even if first resolved during a request.

Framework bindings available everywhere: `Application`, `Container`, `Config`, `Logger`, `Router` (instances), `ExceptionHandler`, `ResponseFormatter` (singletons, replaced per request in multi-app), `Observability`, `Gate`, `RedisManager`, `CacheManager`, `StorageManager`, `HttpManager`, `QueueManager`, `I18nManager`, `MailManager`, `Scheduler`, `EventManager`, `BroadcastManager`, `NotificationManager`, `MaintenanceManager`; `HttpContext` in requests.

## Service providers

Full guides: [container.md](../../../docs/guide/container.md#service-providers), [directory-structure.md](../../../docs/guide/directory-structure.md#app-provider)

`app/provider/*.ts` (first level only) default-exports a provider. `npx haze make:provider Redis` → `app/provider/RedisProvider.ts`.

```ts
// app/provider/AppProvider.ts
import { defineProvider, definePersistent, env } from '@hazejs/core'
import Redis from 'ioredis'
import { AuditSubscriber } from '~/app/service/AuditSubscriber'
import { Mailer, SmtpMailer } from '~/app/service/Mailer'
import { RedisClient } from '~/app/tokens'

export default defineProvider({ // identity helper; a class with the same methods also works (instantiated with `new`, no inject())
  register(container) { // (container, app); bindings only — do not resolve services here
    container.bind(Mailer, SmtpMailer) // abstract class → implementation
    container.instance(RedisClient, definePersistent('redis', () => new Redis(env('REDIS_URL', 'redis://127.0.0.1:6379')), {
      dispose: client => client.quit(), // runs only on real shutdown, never on HMR
    }))
  },
  async boot(app) { // all bindings from all providers exist now
    app.intercept(response => void response.headers.set('x-powered-by', 'hazejs'))
    await app.onBooted(() => app.make(AuditSubscriber)) // eager-create a side-effecting singleton after every boot()
  },
  async shutdown(app) {}, // reverse provider order on app.dispose()
})
```

`ServiceProvider` = `{ register?(container, app), boot?(app), shutdown?(app) }`, each may be async (awaited sequentially). `ProviderInput = ServiceProvider | (new () => ServiceProvider)`.

### `app.boot()` order

1. Env (`.env` files, or `options.env` object; `env: false` skips) → config: framework defaults → module config defaults (enable order) → module middleware aliases/groups → project `config/*.ts` → `configOverrides`.
2. Core bindings and managers (list above); interceptors, policies, jobs, schedules, events, listeners registered — module items first, then the app's.
3. `register(container, app)` of every provider, in this order: **module providers** (module enable order, file-name order inside a local module) → **project `app/provider/*.ts`** (alphabetical by path) → **sub-app providers `app/<name>/provider/*.ts`** (apps in `config/app.ts` `apps` declaration order, by path within an app). Later bindings win, so the app can rebind module services.
4. `options.setup(app)` — where `useTestApp({ override })` runs.
5. `boot(app)` of every provider, same order.
6. `app.onBooted(cb)` callbacks, FIFO, awaited; callbacks added by callbacks also run; a throw fails boot.
7. HTTP kernel built: global/module middleware, static, sub-apps, **routes loaded and compiled** (unknown middleware, duplicate route names, bad handlers fail here).
8. In-process workers registered (not in `test` mode); `app.booted === true`; `useApp()` now returns this app.

After boot, `app.onBooted(cb)` runs `cb` immediately (returns a Promise). `app.dispose({ reason?: 'hmr' | 'shutdown' })`: stop in-process workers → providers' `shutdown()` in reverse → close queue and mail connections → `container.dispose()` → close logger → `disposePersistent()` unless `reason: 'hmr'`. `app.serve()` calls it on SIGINT/SIGTERM after draining (`app.shutdownTimeout`, 10 s).

### Persistent resources (`definePersistent`)

```ts
definePersistent<T>(key: string, factory: () => T, options?: { dispose?: (value: T) => MaybePromise<void> }): T
disposePersistent(key?: string): Promise<void> // one key, or all in reverse creation order
```

Process-global store (on `globalThis`): the factory runs once per key, the value survives HMR container rebuilds. Every non-HMR `app.dispose()` (production shutdown, **each `useTestApp` test teardown**) disposes and forgets all entries. Call it lazily — inside `register()` / a factory / a function — not as a module-level `const`, or the next app in the same process (next test) keeps the disposed value. The framework's own memory stores (cache, throttle, session, queue) follow this pattern.

## Testing with the container

Full guide: [testing.md](../../../docs/guide/testing.md)

```ts
// tests/user.test.ts
import { useTestApp } from '@hazejs/testing'
import { expect, it } from 'vitest'
import { UserRepository } from '~/app/repository/UserRepository'

class FakeUserRepository extends UserRepository {
  override async findById(id: number) { return { id, name: 'Ada' } }
}

const t = useTestApp({
  override: container => container.singleton(UserRepository, FakeUserRepository), // after register, before boot
  configOverrides: { app: { name: 'Test' } }, // deep-merged over config/*.ts before providers register
})

it('uses the fake', async () => {
  expect((await t.get('/api/users/1')).body.data.name).toBe('Ada')
  expect(t.make(UserRepository)).toBeInstanceOf(FakeUserRepository)
})
```

- `useTestApp(options)` builds a fresh app per test (`beforeEach`) and disposes it (`afterEach`); options are `ApplicationOptions` + `override`. `createTestApp()` is the one-shot variant (call `close()` yourself).
- `container.instance(Key, fakeObject)` swaps in a ready-made object; `bind` on an already-resolved key drops the cached instance.
- Unit-test a class without the app: `const c = new Container().singleton(Repo, FakeRepo); c.make(Service)`; request scope: `c.createChild().make(PerRequest)`.
- Outside requests (scripts, tests with several apps), pin facades/`inject()` to an app with `runInApp(app, fn)`.

## Modules

Full guide: [modules.md](../../../docs/guide/modules.md)

A module merges into **one** application: shared container, guards, formatter, exception handler, logger, connections. No isolation (use multi-app for that).

### Local module layout

```
modules/blog/                      # name = directory (letters, digits, - and _)
  module.ts                        # optional defineModule() overrides; `name` must equal the dir or omitted
  route/*.ts                       # defineRoutes(), loaded after the app's routes
  config/<key>.ts                  # config defaults UNDER the project's config/<key>.ts
  config/middleware.ts             # the module's { alias, groups, global } (not a config key)
  schedule/*.ts
  app/{provider,interceptor,policy,job,event,listener,notification,channel,socket,message}/*.ts   # first level only
  app/command/**/*.ts              # recursive, lazy: db/Prune.ts → db:prune
  app/{controller,service,model,middleware,...}/  # plain code, imported
  database/{schema,migrations,seeders}/          # migrations default: modules/blog/database/migrations
  tests/
```

Not discovered in modules: `lang/`, `app/view`, `app/exception/Handler.ts`, `app/response/Formatter.ts`, `app/<name>/` sub-app folders. All local modules are enabled by default.

```bash
haze make:module blog                    # module.ts (prefix '/api/blog'), route/blog.ts, app/controller/BlogController.ts, config/blog.ts, tests/blog.test.ts
haze make:controller Post --module blog  # -m; every make:* accepts it
haze make:model Post -m blog             # model + modules/blog/database/schema/posts.ts
haze db:generate --module blog           # module schema → module migrations
```

```ts
// modules/blog/module.ts — without it: prefix '' (none), as 'blog.'
import { defineModule } from '@hazejs/core'

export default defineModule({
  prefix: '/api/blog',
  routeMiddleware: ['throttle:60,60'],
  config: { blog: { perPage: 20 } }, // deep-merged with config/blog.ts of the module (not typed by typegen)
})
```

### `config/modules.ts`

```ts
// config/modules.ts
import blog from '@acme/hazejs-blog'
import { defineModulesConfig } from '@hazejs/core'

export default defineModulesConfig({
  modules: [blog({ prefix: '/api/blog', middleware: ['auth'], perPage: 10 })], // packages: `blog` or `blog(options)`
  local: { shop: false, cms: { prefix: '/cms', app: 'admin' } }, // false = disable; unknown name throws
})
```

| Enable option (`ModuleOptions`) | Default | Effect |
|---|---|---|
| `prefix` | definition `prefix`, else `''` | URL prefix of the module's routes (slashes normalized) |
| `as` | definition `as`, else `'<name>.'` | Route name prefix; `''` keeps raw names |
| `middleware` | `[]` | Appended to every module route, after the definition's `routeMiddleware` |
| `app` | definition `app` | Mount routes into sub-app only: `/admin/<prefix>/…`, names `admin.<as>…`. Undeclared app throws at boot |
| `connection` | default connection | Connection for the module's migrations |

Enable order: `createApplication({ modules })` → `config/modules.ts` `modules` → local modules by directory name. Same name twice throws (`Module "blog" is enabled twice (a package and modules/blog)`).

### How module contributions combine

| Contribution | Rule |
|---|---|
| Config | Framework defaults → module defaults (enable order) → project `config/*.ts`, deep-merged |
| Providers | register/boot before the project's providers; project can rebind module services; use `app.onBooted()` in a module provider for anything an app provider prepares in `boot()` (DB connection, loaded settings) |
| Middleware aliases/groups | Merged into the registry. A name clashing with another module or a built-in (`auth`, `cors`, …) throws unless the project's `config/middleware.ts` defines it (explicit override) |
| Global middleware | After the project's global middleware, in enable order |
| Routes | Loaded after the app's routes; route middleware order per route: (global) → `routeMiddleware` + enable `middleware` → the route's own. Duplicate names throw with sources: `Duplicate route name "blog.index" (the app and module "blog")` |
| Jobs, events, listeners, schedules, policies, interceptors, notifications, channels | Registered before the app's. Two **different** jobs/listeners with one name throw `Duplicate job name …`; duplicate command names throw |
| Migrations | Each module's migrations (enable order) before the app's, per connection; table `__drizzle_migrations_<snake_name>`; `refreshDatabase({ modules: false })` skips them |

### Module packages

`pnpm create hazejs my-module --template module`. Entry `defineModule()` must have `name`; `package.json` needs `"hazejs": { "module": true }` (bundled with the host, migrations embedded) and `"files": ["database", "dist"]`.

```ts
// src/index.ts
import { defineCommand, defineModule } from '@hazejs/core'

export default defineModule<{ perPage?: number }>({
  name: 'myModule',
  prefix: '/api/my-module',
  config: { myModule: defaults },                 // values may be functions (evaluated after .env)
  routes: [routes],
  middleware: { alias: { 'myModule.json': EnsureJson }, groups: {}, global: [] },
  providers: [MyModuleProvider],
  jobs: { SendDigest },                           // packages have no file names: object keys are the names
  events: { PostPublished },
  commands: [defineCommand({ name: 'my-module:sync', run })],
  discovered: { sockets: [chatNamespace] },       // kinds read by extension packages
  migrations: new URL('../database/migrations', import.meta.url), // literal URL so builds can embed it; false = none
  options: opts => opts.perPage ? { config: { myModule: { perPage: opts.perPage } } } : undefined, // merged: config deep, lists appended
})
```

Other definition fields: `as`, `routeMiddleware`, `app`, `connection`, `listeners`, `schedules`, `policies`, `notifications`, `channels`, `interceptors` (arrays, `{ name: value }` objects, or glob records). Type config with `declare module '@hazejs/core' { interface ConfigSchema { myModule: MyModuleConfig } }`. Test a package against a host in `tests/app/` (`defineHazeTestConfig({ haze: { srcDir: 'tests/app' } })` + `tests/app/config/modules.ts`).

Inspect: `haze module:list [--json]` (NAME, SOURCE, PREFIX, ROUTE NAMES, ROUTES, MIGRATIONS); `haze route:list` adds a MODULE column; in code `app.modules()` returns `ResolvedModule[]`.

## Multiple apps

Full guide: [multi-app.md](../../../docs/guide/multi-app.md)

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  apps: {
    admin: { prefix: '/admin' },                      // /admin/** → app/admin
    api: { domain: 'api.example.com' },               // host match → app/api
    mobile: { domain: ['*.m.example.com'], prefix: '/v1' },
  },
}))
```

| `SubAppConfig` | Rules |
|---|---|
| `prefix?: string` | Normalized to `/x`; stripped before matching the app's routes; `'/'` = catch-all. Matches `path === prefix` or `prefix/…` |
| `domain?: string \| string[]` | Case-insensitive host; `*.example.com` matches any depth of subdomain but not `example.com` |

At least one of the two is required (`App "x" needs a prefix or a domain`); two apps with the same domain + prefix throw at boot. Matching: domain-bound apps win, then the longest prefix; no match → global `route/*.ts`.

```
app/admin/
  route/*.ts            # paths relative to the prefix; names auto-prefixed 'admin.'
  config/<key>.ts       # deep-merged OVER config/<key>.ts for this app's requests only
  config/middleware.ts  # app-only `global` + `alias`/`groups` (may override global aliases)
  provider/*.ts         # loaded only if declared; bindings are GLOBAL; boot after app/provider/*
  exception/Handler.ts  # extends ExceptionHandler; replaces the global one for this app (incl. its 404s)
  response/Formatter.ts # extends ResponseFormatter; same
  controller/ ...       # plain code (only route/config/provider/exception/response are discovered)
app/common/ ...         # not declared in apps → ignored by discovery, just shared code
```

```ts
// app/admin/route/web.ts
import { defineRoutes } from '@hazejs/core'
import { UserController } from '~/app/admin/controller/UserController'

export default defineRoutes((r) => {
  r.get('/users/:id', [UserController, 'show']).name('users.show') // GET /admin/users/:id, name admin.users.show
})

// router.url('admin.users.show', { id: 7 }) → '/admin/users/7'
```

```ts
// app/admin/config/app.ts — plain object or defineConfig(() => ({ … }))
export default { name: 'Admin Console', response: { envelope: false } }
```

Per-request effects when an app matches: `ctx.appName = 'admin'` (`undefined` for global routes), `ctx.config` and the request container's `Config` become the app config, `config('app.name')` returns the app value, the logger gets `{ app }`, and the app's `Handler`/`Formatter` are bound into the request container. Middleware order for `/admin/secure` with `.middleware('auth')`: global (+ module global) → admin `global` → `auth` (admin alias if defined, else global).

Generators: `--app admin` / `-a admin` (`make:controller`, `make:middleware`, `make:route web`, `make:config app`, `make:model` — schema still in `database/schema`). Domain apps in tests: `await t.get('http://api.example.com/users')`. `haze route:list` shows APP and DOMAIN columns; typegen covers prefixed names.

Modules vs apps: modules are reusable features merged into the shared app (config under the project's, shared middleware/handler/formatter, contribute providers/jobs/events/commands/migrations); apps are separately configured front doors in `app/<name>/` (config over global, own middleware/handler/formatter, providers only). Combine with `app: 'admin'` on a module.

## Discovery (`@hazejs/vite` manifest)

Full guide: [directory-structure.md](../../../docs/guide/directory-structure.md#what-is-auto-discovered)

`virtual:haze/app` `createApp(options)` calls `createApplication()` with `import.meta.glob` records (all relative to `srcDir`, extensions `ts/mts/js/mjs`; `app/view/**` also `tsx/jsx`, `lang/**` also `json`): `config/*`, `route/*`, `app/provider/*`, `app/exception/Handler`, `app/response/Formatter`, `app/interceptor/*`, `app/policy/*`, `app/job/*`, `schedule/*`, `app/event/*`, `app/listener/*`, `app/{socket,message,channel,notification}/*` (as `discovered`), `app/command/**` (lazy), `app/view/**` (lazy), `lang/**`, `app/*/{route,config,provider,exception,response}/*` (as `apps`), and local modules `modules/*/{module,{route,config,schedule}/*,app/<kind>/*,app/command/**}`. `*` = first level only; records are sorted by path, so file name = registration order. Adding/removing a file in dev regenerates the manifest without a restart. Anything passed to `createApp({...})` / `createApplication({...})` overrides the discovered value (e.g. `modules: [blog]`, `providers: [...]`, `setup`).

## Gotchas

- Classes are built with `new C()` — constructor parameters are never filled. Use `inject()` in fields, or bind a factory for classes that need arguments.
- An **unbound abstract class** is auto-bound and instantiated as-is (no error). Always `bind(Abstract, Impl)` in a provider.
- `inject()` only works synchronously in construction / `container.call()`, or in request / `runInApp` contexts. Module top level and provider class fields throw `ContainerError`.
- Singletons capture nothing per request: injecting `HttpContext` or any `Scope.Request` class into a singleton throws `ScopeError`; read per-request state at call time with `useContext()`.
- `inject(Config)` in a singleton is always the **global** config; in multi-app use `config('key')` / `ctx.config` at call time, or a request-scoped class.
- `app.make(RequestScopedClass)` outside a request throws `ScopeError`; in jobs/commands resolve singletons or use transient classes.
- Tokens are compared by identity — never call `createToken('x')` twice for the same dependency; export one constant.
- Transient instances are not disposed; `instance()` values are not disposed; request-scoped instances are disposed at the end of every request.
- Singletons are created lazily. A service with constructor side effects (event hooks, timers) is inert until resolved — create it in `boot()` via `app.onBooted(() => app.make(Service))`.
- `register()` must only bind; resolving there can build a singleton before a later provider (or the test `override`) rebinds its dependency.
- Providers run in file-name order (`app/provider/AppProvider.ts` before `DatabaseProvider.ts`). Anything needing another provider's `boot()` result goes in `app.onBooted()`.
- Routes are compiled **after** `boot()` and `onBooted` callbacks: `app.router.url()`, `app.request()` and `app.h3` are not usable there.
- `definePersistent` at module top level breaks across `app.dispose()` (every test teardown disposes all persistent values). Call it lazily, and register the value with `container.instance()` — if a `singleton` factory returns an object with `Symbol.asyncDispose`, the container disposes it on every HMR reload.
- Module packages need `name`; local module `module.ts` `name` must match the directory. Module middleware alias clashes (with built-ins like `auth` too) throw — namespace them (`'blog.owner'`).
- `app: 'admin'` on a module mounts **routes only**; its providers, aliases and config remain global. Modules cannot ship `lang/`, an exception handler or a formatter.
- Module migrations run before the app's, so they cannot reference app tables. `haze db:seed` runs local module seeders only; D1's `wrangler d1 migrations apply` ignores module migrations.
- Sub-app folders load only when declared in `config/app.ts` `apps`; their providers are global, not per-app. Global middleware and errors raised before dispatch use the global handler/formatter.
- Wildcard `*.example.com` does not match the apex; add `'example.com'` to the `domain` array if needed. Route groups have no `domain` option — use an app.
