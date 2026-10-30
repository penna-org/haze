# 服务容器

hazejs 内置一个 IoC 容器，负责创建控制器、服务、中间件以及框架自身的各种对象。依赖通过在类字段中调用 `inject()` 声明。它不依赖装饰器，也不需要 `emitDecoratorMetadata`，因此任何转译器都能直接运行，热更新也依然很快。

## 注入依赖

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
      throw new NotFoundException(`用户 ${id} 不存在`)
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

没有显式绑定过的类，在第一次解析时会被自动注册，所以普通的服务类无需任何配置。可以用 `npx haze make:service User` 生成。

`inject()` 可以在以下位置调用：

- 由容器实例化的类的字段初始化器或构造函数中；
- `container.call(() => ...)` 的回调中；
- 请求处理过程中的任意位置（自动使用当前请求的子容器）。

在其它地方调用（例如模块顶层）会抛出 `ContainerError`。

## 作用域

| 作用域 | 生命周期 | 典型对象 |
|--------|----------|----------|
| `Scope.Singleton` | 应用级，一个应用一个实例（热更新重载后重建） | 服务、仓储、各类客户端 |
| `Scope.Request` | 每个请求一个实例 | 控制器、当前用户、请求级缓存 |
| `Scope.Transient` | 每次解析都新建 | 轻量工具类 |

类默认是单例，控制器默认是请求作用域。在类上用 `static scope` 声明作用域：

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

容器会做以下安全检查，出错时给出完整的依赖链：

- 单例不能依赖请求作用域的对象，否则单例会“捕获”第一个请求的数据，此时抛出 `ScopeError`；
- 请求作用域的对象只能在请求内解析，在启动阶段、队列任务或命令中 `app.make(RequestInfo)` 会抛出 `ScopeError`；
- 循环依赖抛出 `CircularDependencyError`。

## 令牌（Token）

连接串、第三方客户端、接口这类不是类的依赖，用 `createToken()` 创建带类型的令牌：

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
  private redis = inject(RedisClient) // 类型为 Redis

  hit(key: string) {
    return this.redis.incr(key)
  }
}
```

令牌不会像类那样自动注册，没有绑定就解析会抛出 `ResolutionError`。

## 绑定

绑定写在服务提供者的 `register()` 中。容器的主要方法：

| 方法 | 说明 |
|------|------|
| `bind(key, provider?, { scope? })` | 绑定类或工厂函数；不指定作用域时，类读取 `static scope`，其余默认单例 |
| `singleton(key, provider?)` | 绑定为单例 |
| `scoped(key, provider?)` | 绑定为请求作用域 |
| `transient(key, provider?)` | 绑定为瞬态 |
| `instance(key, value)` | 注册一个已有的值 |
| `has(key)` / `make(key)` | 判断是否已绑定 / 解析 |
| `call(fn)` | 在该容器的注入上下文中执行 `fn` |
| `createChild()` | 创建子容器，框架为每个请求创建的就是它 |
| `bindings()` | 列出本容器的绑定（`key`、`scope`、`kind`、`resolved`），用于调试 |
| `dispose()` | 释放本容器创建的实例（见[释放资源](#释放资源)） |

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
    container.bind(Mailer, SmtpMailer) // 抽象类 → 实现
    container.singleton(RedisClient, () => new Redis(env('REDIS_URL', 'redis://127.0.0.1:6379'))) // 工厂函数
  },
})
```

工厂函数的参数是容器本身，并且同样运行在注入上下文中，可以在里面调用 `inject()`。

## 服务提供者

服务提供者放在 `app/provider/*.ts`，会被自动加载。每个提供者可以实现三个钩子：

1. `register(container, app)`：只做绑定，此时不要解析其它服务；
2. `boot(app)`：所有提供者 register 完成后执行，此时全部绑定都可用；
3. `shutdown(app)`：应用关闭时按注册顺序的逆序执行。

```ts
// app/provider/AppProvider.ts
import { defineProvider } from '@hazejs/core'
import { RedisClient } from '~/app/tokens'

export default defineProvider({
  register(container) {
    // ...绑定
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

提供者也可以写成实现了这些方法的类。框架直接用 `new` 创建它，而不是经由容器，所以在它的字段或构造函数中调用 `inject()` 会报错，请在 `boot(app)` 中用 `app.make()` 解析服务。用 `npx haze make:provider Redis` 生成。

提供者按顺序启动：先是[模块](./modules)的提供者，再是项目的。需要项目提供者在 `boot` 中准备好的资源（例如已建立的数据库连接）时，用 `app.onBooted(callback)` 等全部提供者启动完成后再执行；应用已经启动完成时立即执行：

```ts
// modules/shop/app/provider/ShopProvider.ts
export default defineProvider({
  boot: app => app.onBooted(() => app.make(OrderBinding).register()),
})
```

`onBooted` 回调按注册顺序执行，时机在所有 `boot()` 之后、路由编译**之前**，因此 `boot()` 和 `onBooted` 回调中都还不能使用 `app.router.url()` 或 `app.request()`。

### 从应用中解析

`app.make(key)` 从根容器解析，`ctx.make(key)` 从当前请求的子容器解析。框架已经绑定了核心对象，可以在任何地方注入：`Application`、`Container`、`Config`、`Logger`、`Router`、`ExceptionHandler`、`ResponseFormatter`，以及缓存、存储、队列、邮件、事件等管理器。

### 释放资源

应用关闭（或开发环境热重载）时，容器会释放由它创建的实例。在类上实现 `Symbol.asyncDispose` 或 `Symbol.dispose` 即可做清理：

```ts
// app/service/Reporter.ts
export class Reporter {
  async [Symbol.asyncDispose]() {
    await this.flush()
  }

  async flush() {}
}
```

请求作用域的实例在每个请求结束时释放。瞬态实例不被跟踪，也不会释放；通过 `instance()` 注册的值同样不由容器负责释放。

## 跨热更新的持久资源

开发环境中，每次修改代码都会在几毫秒内重建容器。这对服务类没有问题，但数据库连接池、Redis 客户端不应该每次保存都重新连接。`definePersistent()` 创建的值在进程内只创建一次，热更新时保留：

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

`dispose` 回调在应用真正释放时执行，热更新重载时不会执行。真正释放包括关闭进程，也包括 `useTestApp()` 中每个测试结束时。释放后这个值会被移除，下一次调用 `definePersistent()` 会重新创建。所以要像上面这样在每次启动时调用它，不要存进模块顶层的 `const`。那样同一进程中的下一个应用（例如下一个测试）拿到的仍是已经关闭的客户端。注册时用 `instance()`，不要用 `singleton()` 工厂。容器从不释放 `instance()` 注册的值，但会释放工厂创建的、实现了 `Symbol.asyncDispose` / `Symbol.dispose` 的对象，而且每次热重载都会这样做。

## 在测试中替换绑定

`@hazejs/testing` 的 `useTestApp()` 接受 `override` 回调。它在提供者 register 之后、boot 之前执行，因此可以用假实现替换真实绑定：

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

更底层的 `createApplication()` 的 `setup(app)` 选项在同一时机执行。`t.make(key)` 可以从测试应用的容器中解析依赖。详见 [测试](./testing)。
