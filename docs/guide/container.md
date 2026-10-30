# Service Container

hazejs ships with an IoC container that creates your controllers, services, middleware and framework objects. Dependencies are declared with `inject()` in class fields. There are no decorators or `emitDecoratorMetadata`, so it works with any transpiler and stays fast under HMR.

## Injecting dependencies

```ts
// app/service/UserService.ts
import { inject, Logger, NotFoundException } from '@hazejs/core'
import { UserRepository } from '~/app/repository/UserRepository'

export class UserService {
  private repo = inject(UserRepository)
  private logger = inject(Logger)

  async find(id: number) {
    const user = await this.repo.findById(id)
    if (!user)
      throw new NotFoundException(`User ${id} not found`)
    return user
  }
}
```

```ts
// app/controller/UserController.ts
import type { HttpContext } from '@hazejs/core'
import { inject } from '@hazejs/core'
import { UserService } from '~/app/service/UserService'

export class UserController {
  private users = inject(UserService)

  show(ctx: HttpContext) {
    return this.users.find(Number(ctx.param('id')))
  }
}
```

A class that has never been bound is registered automatically the first time it is resolved, so plain service classes need no setup. Generate one with `npx haze make:service User`.

`inject()` can be called:

- in field initializers or constructors of a class the container is creating;
- inside `container.call(() => ...)`;
- anywhere during a request (it uses the current request's container).

Calling it elsewhere, such as at module top level, throws a `ContainerError`.

## Scopes

| Scope | Lifetime | Typical use |
|-------|----------|-------------|
| `Scope.Singleton` | One instance per application (rebuilt on HMR reload) | Services, repositories, clients |
| `Scope.Request` | One instance per request | Controllers, current-user helpers, per-request caches |
| `Scope.Transient` | A new instance on every resolve | Lightweight helpers |

Classes are singletons unless they declare otherwise. Controllers default to request scope. Declare the scope on the class with `static scope`:

```ts
// app/service/RequestInfo.ts
import { HttpContext, inject, Scope } from '@hazejs/core'

export class RequestInfo {
  static scope = Scope.Request
  private ctx = inject(HttpContext)

  get path() {
    return this.ctx.path
  }
}
```

The container enforces these safety rules and gives you the full dependency chain when one fails:

- A singleton cannot depend on a request-scoped object. It would capture the first request's data, so a `ScopeError` is thrown.
- A request-scoped object can only be resolved within a request. `app.make(RequestInfo)` at boot, in a job or in a command throws a `ScopeError`.
- Circular dependencies throw `CircularDependencyError`.

## Tokens

For values that are not classes, such as connection strings, third-party clients or interfaces, create a typed token with `createToken()`:

```ts
// app/tokens.ts
import type { Redis } from 'ioredis'
import { createToken } from '@hazejs/core'

export const RedisClient = createToken<Redis>('redis')
```

```ts
// app/service/CounterService.ts
import { inject } from '@hazejs/core'
import { RedisClient } from '~/app/tokens'

export class CounterService {
  private redis = inject(RedisClient) // typed as Redis

  hit(key: string) {
    return this.redis.incr(key)
  }
}
```

Unlike classes, tokens are never auto-bound. Resolving a token without a binding throws `ResolutionError`.

## Binding

Register bindings in a provider's `register()` hook. The container API:

| Method | Description |
|--------|-------------|
| `bind(key, provider?, { scope? })` | Bind a class or factory. Without a scope, classes use their `static scope`, everything else is a singleton |
| `singleton(key, provider?)` | Bind as singleton |
| `scoped(key, provider?)` | Bind as request-scoped |
| `transient(key, provider?)` | Bind as transient |
| `instance(key, value)` | Register an existing value |
| `has(key)` / `make(key)` | Check / resolve |
| `call(fn)` | Run `fn` in this container's injection context |
| `createChild()` | Create a child container, as the framework does for each request |
| `bindings()` | List this container's bindings (`key`, `scope`, `kind`, `resolved`), for debugging |
| `dispose()` | Dispose the instances this container created (see [Disposal](#disposal)) |

```ts
// app/provider/AppProvider.ts
import { defineProvider, env } from '@hazejs/core'
import Redis from 'ioredis'
import { GreetingService } from '~/app/service/GreetingService'
import { Mailer, SmtpMailer } from '~/app/service/Mailer'
import { RedisClient } from '~/app/tokens'

export default defineProvider({
  register(container) {
    container.singleton(GreetingService)
    container.bind(Mailer, SmtpMailer) // abstract class → implementation
    container.singleton(RedisClient, () => new Redis(env('REDIS_URL', 'redis://127.0.0.1:6379'))) // factory
  },
})
```

Factories receive the container as their argument and also run in an injection context, so they can call `inject()`.

## Service providers

Providers live in `app/provider/*.ts` and are loaded automatically. Each one can implement three hooks:

1. `register(container, app)`: only create bindings here. Do not resolve other services yet.
2. `boot(app)`: runs after every provider has registered, so all bindings are available.
3. `shutdown(app)`: runs in reverse order when the application is disposed.

```ts
// app/provider/AppProvider.ts
import { defineProvider } from '@hazejs/core'
import { RedisClient } from '~/app/tokens'

export default defineProvider({
  register(container) {
    // ...bindings
  },
  async boot(app) {
    app.logger.info(`Booted ${app.config.get('app.name')}`)
    app.intercept((response) => {
      response.headers.set('x-powered-by', 'hazejs')
    })
  },
  async shutdown(app) {
    await app.make(RedisClient).quit()
  },
})
```

A provider can also be a class with these methods. The framework creates it with `new`, not through the container, so calling `inject()` in its fields or constructor throws; resolve services in `boot(app)` with `app.make()` instead. Generate one with `npx haze make:provider Redis`.

Providers boot in order: [module](./modules) providers first, then the app's. Work that needs something an app provider prepares in its `boot` (an open database connection, say) can wait for all providers with `app.onBooted(callback)`; it runs right away once the application has booted:

```ts
// modules/shop/app/provider/ShopProvider.ts
export default defineProvider({
  boot: app => app.onBooted(() => app.make(OrderBinding).register()),
})
```

`onBooted` callbacks run in the order they were added, after every `boot()` and **before** the routes are compiled. Neither `boot()` nor an `onBooted` callback can use `app.router.url()` or `app.request()` yet.

### Resolving from the application

`app.make(key)` resolves from the root container, and `ctx.make(key)` from the current request's container. The framework binds its core objects, so you can inject them anywhere: `Application`, `Container`, `Config`, `Logger`, `Router`, `ExceptionHandler`, `ResponseFormatter`, plus the managers for cache, storage, queue, mail and events.

### Disposal

When the application shuts down (or reloads in dev), the container disposes the instances it created. Implement `Symbol.asyncDispose` or `Symbol.dispose` on a class to clean up:

```ts
// app/service/Reporter.ts
export class Reporter {
  async [Symbol.asyncDispose]() {
    await this.flush()
  }

  async flush() {}
}
```

Request-scoped instances are disposed at the end of every request. Transient instances are not tracked and never disposed, and values registered with `instance()` are not disposed by the container.

## Persistent resources across HMR

In development, every code change rebuilds the container in milliseconds. That is fine for services, but database pools or Redis clients should not reconnect on every save. `definePersistent()` creates a value once per process and keeps it across reloads:

```ts
// app/provider/RedisProvider.ts
import { definePersistent, defineProvider, env } from '@hazejs/core'
import Redis from 'ioredis'
import { RedisClient } from '~/app/tokens'

export default defineProvider({
  register(container) {
    container.instance(RedisClient, definePersistent('redis', () => new Redis(env('REDIS_URL', 'redis://127.0.0.1:6379')), {
      dispose: client => client.quit(),
    }))
  },
})
```

The `dispose` callback runs whenever the application is really disposed, never on an HMR reload. That covers process shutdown, and also the end of every test with `useTestApp()`. Afterwards the value is forgotten, and the next `definePersistent()` call creates a new one. So call it on each boot, as above, rather than storing it in a module-level `const`. A constant would keep the disposed client for the next application in the same process, such as the next test. Register the value with `instance()`, not with a `singleton()` factory. The container never disposes `instance()` values. It does dispose factory results that implement `Symbol.asyncDispose` / `Symbol.dispose`, and it would do that on every reload.

## Overriding bindings in tests

`useTestApp()` from `@hazejs/testing` accepts an `override` callback. It runs after providers register and before they boot, so your fakes replace the real bindings:

```ts
// tests/user.test.ts
import { useTestApp } from '@hazejs/testing'
import { expect, it } from 'vitest'
import { UserRepository } from '~/app/repository/UserRepository'

class FakeUserRepository extends UserRepository {
  override async findById(id: number) {
    return { id, name: 'Ada' }
  }
}

const t = useTestApp({
  override: c => c.singleton(UserRepository, FakeUserRepository),
})

it('uses the fake repository', async () => {
  const res = await t.get('/api/users/1')
  expect(res.body.data.name).toBe('Ada')
})
```

The lower-level `setup(app)` option of `createApplication()` runs at the same point. `t.make(key)` resolves from the test app's container. See [Testing](./testing).
