# think-h3 框架设计与实现方案

> 状态：草案 v0.1（2026-10-26）
> 命令名暂定 `think-h3`，包名暂定 `@think-h3/*`。产品名定下来后只需改一处常量和包 scope。

---

## 1. 目标与定位

做一套**基于 h3 v2 的、约定优于配置的 Node 服务端框架**，设计思路参考 ThinkPHP（容器、服务提供者、中间件、集中路由、统一异常处理、分层目录），但用 TypeScript + Vite 生态来实现。

核心诉求：

| # | 诉求 | 方案要点 |
|---|------|----------|
| 1 | 脚手架一条命令启动项目 | `think-h3 dev / build / start / test / make:*`，`create-think-h3` 初始化项目 |
| 2 | 热更新，不重启进程 | Vite Environment API + ModuleRunner 重新加载应用，**外层 HTTP 监听不变，只热替换 fetch handler** |
| 3 | 依赖注入 | 自研轻量 IoC 容器，`inject()` 函数式注入，支持 singleton / request / transient 三种作用域 |
| 4 | 中间件 | 全局 / 分组 / 路由 / 别名中间件，类中间件可注入依赖，底层映射到 h3 的 `(event, next)` |
| 5 | 集中错误处理 | `HttpException` 体系 + `app/exception/Handler.ts`（report / render），统一响应格式 |
| 6 | 路由统一管理 | `route/*.ts` 集中定义，支持 group / resource / 中间件 / 校验 / 命名路由，`route:list` 查看 |
| 7 | 分层 | Controller → Service → Repository/Model，DTO/Validate、Provider、Event/Listener |
| 8 | 集成 Vitest | `@think-h3/testing`：`createTestApp()` 免监听端口测试，支持替换容器绑定 |
| 9 | 作为 Vite 插件服务 Vue 项目 | `@think-h3/vite`：开发时挂到 Vite dev server 的 `/api/**`，构建时同时产出 client + server |

非目标（第一期不做）：ORM 本体、前端 UI、多运行时部署预设（先只保证 Node，h3 本身跨运行时，后续可扩展）。

---

## 2. 为什么以 h3 v2 为底座

h3 v2（当前 `latest` 为 2.0.8）的特性与我们的设计很契合：

- **基于 Web 标准**：`event.req` 是 Web `Request`，`app.fetch(req)` 返回 `Response`。这意味着：
  - 热替换只需要换一个 `fetch` 函数引用；
  - 测试直接 `app.request('/path')`，不需要起端口；
  - 挂到 Vite（Node connect 中间件）只需一层 Node ↔ Web 适配。
- **中间件模型** `(event, next) => value`：洋葱模型，返回非 `undefined` 即短路，正好承载我们的中间件管线和异常捕获。
- **路由级中间件** `app.get(path, handler, { middleware: [...] })`、`app.use(path, mw, { method })`：集中路由编译后可以直接落到 h3 路由表上，不必自写路由匹配。
- **全局钩子** `onRequest / onResponse / onError`、`HTTPError`：用于统一异常处理与日志。
- **工具函数可 tree-shake**（`readBody`、`getQuery`、`serveStatic`、`basicAuth` 等），我们的上层 API 可以直接复用。
- `serve()` 基于 srvx，跨 Node / Bun / Deno。

**结论：h3 负责“HTTP 内核”（匹配、请求/响应、工具），我们负责“应用层”（容器、约定、生命周期、工具链）。** 关系类似 ThinkPHP 之于 PHP-FPM，或 NestJS 之于 Express/Fastify。

### 2.1 备选方案：基于 Nitro 二次封装？

Nitro 同样基于 h3，并自带 dev/build/HMR/部署预设。但它的约定是**文件路由 + 函数式 handler**，和我们想要的“集中路由 + 类控制器 + 容器注入 + ThinkPHP 式目录”存在冲突，二次封装会处处绕开它的约定。

**建议：直接基于 Vite Environment API 自建工具链**（控制力完整），在部署预设、存储抽象等方面借鉴 Nitro / unjs 生态（`unstorage`、`c12`、`citty`、`consola`）。

---

## 3. 整体架构

```
┌────────────────────────────────────────────────────────────────┐
│                        开发者项目 (my-app)                      │
│  app/ controller service repository middleware exception ...   │
│  route/  config/  tests/  .env  think.config.ts                │
└──────────────┬───────────────────────────────┬─────────────────┘
               │ think-h3 dev/build/test       │ vite.config.ts 中 thinkH3()
┌──────────────▼──────────────┐  ┌─────────────▼──────────────────┐
│ @think-h3/cli               │  │ @think-h3/vite                 │
│ citty 命令 / make:* 生成器   │──▶ Vite 插件：虚拟模块、dev 挂载、 │
│ route:list / typegen        │  │ 热替换 runner、client+server 构建│
└──────────────┬──────────────┘  └─────────────┬──────────────────┘
               │                               │
┌──────────────▼───────────────────────────────▼─────────────────┐
│ @think-h3/core                                                  │
│  Application(生命周期) · Container(DI) · Config/Env             │
│  Router(集中路由→h3) · Middleware 管线 · HttpContext            │
│  Exception(Handler/HttpException) · Validation · Event · Logger │
└──────────────┬──────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────┐      ┌─────────────────────────────┐
│ h3 v2 (H3 / HTTPError /     │      │ @think-h3/testing (vitest)   │
│ utils / serve via srvx)     │      │ createTestApp / 容器 override │
└─────────────────────────────┘      └─────────────────────────────┘
```

### 3.1 框架仓库（monorepo）结构

```
think-h3/
├─ packages/
│  ├─ core/            # @think-h3/core       运行时内核
│  ├─ vite/            # @think-h3/vite       Vite 插件 + dev 运行时
│  ├─ cli/             # @think-h3/cli        bin: think-h3
│  ├─ testing/         # @think-h3/testing    vitest 集成
│  └─ create/          # create-think-h3      项目初始化
├─ templates/
│  ├─ api/             # 纯后端模板
│  └─ fullstack-vue/   # Vue + 后端一体模板
├─ playground/         # 本地联调
├─ docs/               # 设计文档 / 后续 VitePress 文档站
├─ pnpm-workspace.yaml # 使用 catalog 统一依赖版本
└─ vitest.config.ts    # projects 模式跑所有包的测试
```

工具链：pnpm workspace（catalogs）+ tsdown 打包各包 + Vitest + `@antfu/eslint-config` + changesets 发版。

> ⚠️ 环境要求：Vite 7/8 需要 Node `^20.19 || >=22.12`，当前机器是 **Node 20.16，需要升级**（建议直接用 Node 22 LTS）。

### 3.2 用户项目目录约定（ThinkPHP 风格）

```
my-app/
├─ app/
│  ├─ controller/        # 控制器：只做参数接收、调用服务、返回结果
│  │   └─ UserController.ts
│  ├─ service/           # 业务服务：核心业务逻辑（默认单例）
│  ├─ repository/        # 数据访问层（或 model/，对接 drizzle/prisma 等）
│  ├─ validate/          # 校验 schema / DTO（Standard Schema：zod/valibot/arktype）
│  ├─ middleware/        # 类中间件或函数中间件
│  ├─ provider/          # 服务提供者：注册绑定、启动钩子
│  ├─ event/ listener/   # 事件与监听器
│  └─ exception/
│      └─ Handler.ts     # 全局异常处理器
├─ config/               # app.ts database.ts middleware.ts logger.ts ...
├─ route/                # api.ts web.ts ... 集中路由
├─ tests/
├─ .env / .env.development / .env.production
└─ think.config.ts       # 框架/工具链配置（目录、端口、前缀等）
```

全栈 Vue 项目时，后端整体放在 `server/` 下（`server/app`、`server/route`、`server/config`），前端仍是标准 Vue 项目 `src/`。

### 3.3 ThinkPHP 概念映射

| ThinkPHP | think-h3 | 说明 |
|----------|----------|------|
| 容器 Container `bind/make/invoke` | `Container` `bind/singleton/make/call` | 自研，见 §4 |
| 服务 Service（系统服务） | `ServiceProvider` `register()/boot()` | 生命周期两阶段 |
| 门面 Facade | `use*()` 辅助函数 / `app.make()` | 不做静态门面，TS 下用函数更安全 |
| 路由 `Route::get/group/resource` | `defineRoutes(r => r.get/group/resource)` | 见 §5 |
| 中间件（全局/应用/路由/控制器） | 全局 / 分组 / 路由 / 控制器级 | 见 §6 |
| `ExceptionHandle` report/render | `app/exception/Handler.ts` | 见 §7 |
| 验证器 `validate` | `validate/` + Standard Schema | 路由声明式校验 |
| 配置 `config()` / `env()` | `config('db.host')` / `env('DB_HOST')` | 类型安全 |
| 事件 Event | `EventBus` + listener 自动发现 | 第二期 |
| 命令行 `php think make:controller` | `think-h3 make:controller` | 见 §9 |

---

## 4. 依赖注入（DI）设计

### 4.1 关键决策：不依赖装饰器元数据

NestJS 风格的“构造函数参数自动注入”依赖 `emitDecoratorMetadata`，而 Vite 使用的 esbuild/oxc 转译器**不保证支持装饰器元数据**（esbuild 明确不支持）。如果把 DI 建立在元数据上，就会被迫引入 SWC/tsc 转译，拖慢 HMR，也让配置复杂化。

因此采用 **`inject()` 函数式注入**（与 Angular 新 API 同思路）：在容器实例化类时设置“注入上下文”，类字段初始化器里调用 `inject(Token)` 即可拿到依赖。

- 任何转译器都能跑，零配置；
- 类型由 Token 推导，完全类型安全；
- 对 HMR 友好（每次重载新建容器即可）；
- 装饰器（`@Controller`、`@Get`）作为**可选语法糖**放到后期，不作为核心依赖。

### 4.2 API 草图

```ts
// app/service/UserService.ts
import { inject, Scope } from '@think-h3/core'
import { UserRepository } from '../repository/UserRepository'
import { Logger } from '@think-h3/core'

export class UserService {
  static scope = Scope.Singleton            // 默认 Singleton，可省略
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
// 非类依赖使用 Token
export const DB = createToken<Database>('db')

// app/provider/AppProvider.ts
export default defineProvider({
  register(c) {
    c.singleton(DB, () => createDatabase(config('database')))
    c.bind(Mailer, SmtpMailer)               // 接口 → 实现
  },
  async boot(app) { /* 所有 register 完成后执行 */ },
  async shutdown(app) { await app.make(DB).close() },
})
```

### 4.3 作用域

| 作用域 | 生命周期 | 典型对象 |
|--------|----------|----------|
| `Singleton` | 应用级（每次 HMR 重载后重建） | Service、Repository、Config、Logger |
| `Request` | 每个请求一个实例 | Controller、当前用户、请求级缓存 |
| `Transient` | 每次 `make` 新建 | 工具类 |

实现：每个请求进入时用 `AsyncLocalStorage` 创建子容器（child container），Request 作用域实例挂在子容器上；`useEvent()`、`useContext()` 也基于同一个 ALS 实现，在 Service 深处也能拿到当前请求。

**作用域校验**：Singleton 依赖 Request 作用域对象时直接抛错（避免“单例捕获了第一个请求的用户”这类隐蔽 bug）。另外做循环依赖检测，报出完整依赖链。

### 4.4 跨 HMR 的持久资源

数据库连接池、Redis 客户端等**不能每次热更新都重建**。提供：

```ts
export const pool = definePersistent('db-pool', () => createPool(...))
```

实现上挂在 `globalThis.__THINK_PERSIST__`（同一进程内跨重载存活），仅在真正退出或配置变更时销毁。

---

## 5. 路由设计（集中管理）

### 5.1 路由文件

```ts
// route/api.ts
import { defineRoutes } from '@think-h3/core'
import { HomeController } from '~/app/controller/HomeController'
import { UserController } from '~/app/controller/UserController'
import { CreateUserSchema } from '~/app/validate/user'

export default defineRoutes((r) => {
  r.get('/', [HomeController, 'index']).name('home')

  r.group({ prefix: '/api/v1', middleware: ['api'] }, (r) => {
    r.post('/login', [AuthController, 'login'])

    r.group({ middleware: ['auth'] }, (r) => {
      r.resource('/users', UserController)        // index/show/store/update/destroy
      r.post('/users/:id/avatar', [UserController, 'avatar'])
        .validate({ params: IdSchema })
        .middleware(['throttle:10,60'])
    })
  })
})
```

- 处理器引用使用 `[Class, 'method']` 元组：**可跳转、可重构、类型检查方法名**；同时支持直接写函数 `(ctx) => ...`。
- 可选兼容 ThinkPHP 风格字符串 `'user/index'`（通过 `import.meta.glob` 扫描 `app/controller` 建立注册表）。

### 5.2 编译过程

`defineRoutes` 只**收集路由定义**（纯数据），由 `Router` 在启动时编译到 h3：

```
RouteDefinition[] ──► 展开 group(前缀/中间件合并) ──► 解析中间件别名
  ──► 生成 h3 handler: (event) => runInRequestScope(event, () => controller[method](ctx))
  ──► app.on(method, path, handler, { middleware: [...resolved] })
```

好处：路由表是数据，因此可以 `think-h3 route:list` 打印、生成 OpenAPI、生成前端类型安全的 API 客户端。

### 5.3 控制器

```ts
// app/controller/UserController.ts
export class UserController {
  private users = inject(UserService)

  async show(ctx: HttpContext) {
    return this.users.find(Number(ctx.param('id')))   // 返回值自动序列化
  }

  async store(ctx: HttpContext<{ body: typeof CreateUserSchema }>) {
    const data = ctx.validated.body                    // 已校验且有类型
    return ctx.created(await this.users.create(data))
  }
}
```

`HttpContext` 是对 `H3Event` 的薄封装：`param/query/body/header/cookie/validated/json/created/noContent/redirect`，并暴露 `ctx.event` 以便直接使用 h3 全部工具函数。返回值沿用 h3 的转换规则，再经过统一响应格式化（可关闭）。

---

## 6. 中间件设计

```ts
// config/middleware.ts
export default defineMiddlewareConfig({
  global: [RequestId, Cors, AccessLog],                  // 全局，按顺序
  alias:  { auth: Authenticate, throttle: Throttle },    // 路由中按名引用
  groups: { api: [ForceJson, 'throttle:60,60'] },        // 中间件组
  priority: [RequestId, Authenticate],                   // 可选：强制排序
})
```

```ts
// app/middleware/Authenticate.ts
export class Authenticate implements Middleware {
  private auth = inject(AuthService)

  async handle(ctx: HttpContext, next: Next, ...args: string[]) {
    const user = await this.auth.verify(ctx.header('authorization'))
    if (!user)
      throw new UnauthorizedException()
    ctx.set('user', user)
    return next()                                        // 洋葱模型，可在 next 后处理响应
  }
}
```

- 两种写法：**类中间件**（可注入依赖）与**函数中间件** `defineMiddleware((ctx, next) => ...)`。
- 参数化：`'throttle:10,60'` 解析为 `handle(ctx, next, '10', '60')`（ThinkPHP/Laravel 风格）。
- 层级：全局 → 分组 → 路由 → 控制器（控制器可声明 `static middleware = [...]`，支持 `only/except`）。
- 底层全部转换成 h3 中间件 `(event, next)`，全局的用 `app.use()`，路由的放进路由选项 `middleware`。

---

## 7. 集中错误处理

### 7.1 异常体系

```ts
HttpException (extends h3 HTTPError)
├─ BadRequestException       400
├─ UnauthorizedException     401
├─ ForbiddenException        403
├─ NotFoundException         404
├─ ValidationException       422  (携带字段级错误)
├─ TooManyRequestsException  429
└─ BusinessException         200/自定义 code（业务错误码）
```

### 7.2 Handler

```ts
// app/exception/Handler.ts
export default class Handler extends ExceptionHandler {
  dontReport = [ValidationException, NotFoundException]

  report(error: unknown, ctx: HttpContext) {
    super.report(error, ctx)                // 默认写日志；这里可接 Sentry
  }

  render(error: unknown, ctx: HttpContext) {
    if (error instanceof BusinessException)
      return { code: error.code, message: error.message, data: null }
    return super.render(error, ctx)         // 默认统一格式
  }
}
```

### 7.3 接入点

1. 框架注册**最外层中间件**做 `try { await next() } catch (e) { handler.report(); return handler.render() }` —— 覆盖路由、中间件、控制器抛出的所有异常；
2. 同时接 h3 的 `onError`，兜底 404（未匹配路由）、URL 解析失败等 h3 内部错误；
3. 开发环境渲染带堆栈的 JSON/HTML 错误页，生产环境隐藏内部信息；
4. 统一响应格式可配置：

```ts
// config/app.ts
response: {
  envelope: true,                                  // { code, message, data }
  successCode: 0,
}
```

---

## 8. 应用生命周期

```
createApplication(manifest)
  1. 加载 .env（.env → .env.local → .env.[mode] → .env.[mode].local）
  2. 加载 config/*.ts → Config 仓库（支持点路径、类型推导）
  3. 创建根 Container，注册内核绑定（Config/Logger/Router/ExceptionHandler）
  4. 所有 Provider.register()
  5. 所有 Provider.boot()
  6. 编译中间件配置 + 路由表 → 构建 new H3({ onError, debug })
  7. 返回 { fetch, router, container, dispose }

serve: srvx serve({ fetch }) + 优雅停机（SIGTERM → 停止接收 → 等待在途请求 → Provider.shutdown()）
```

`createApplication` 是**纯函数式的构建过程**，不监听端口——这正是热替换、测试、Vite 挂载能复用同一套代码的关键。

### 8.1 编译期发现（虚拟模块）

不在运行时扫描文件系统，而是由 Vite 插件生成虚拟模块：

```ts
// virtual:think/manifest（插件生成）
export const configs   = import.meta.glob('/config/*.ts', { eager: true })
export const routes    = import.meta.glob('/route/*.ts', { eager: true })
export const providers = import.meta.glob('/app/provider/*.ts', { eager: true })
export const handler   = import.meta.glob('/app/exception/Handler.ts', { eager: true })
```

- dev 下 Vite 自动追踪这些模块的依赖图，文件增删改都能感知；
- build 时变成静态 import，可完整打包成单文件，不依赖源码目录；
- 测试时 Vitest（同为 Vite）同样能解析。

---

## 9. 脚手架 / CLI

基于 unjs 生态：`citty`（命令）、`consola`（输出）、`c12`（加载 `think.config.ts`）、`giget`（拉模板）。

| 命令 | 作用 |
|------|------|
| `pnpm create think-h3 my-app` | 交互选择模板（api / fullstack-vue）、包管理器、是否带 ORM |
| `think-h3 dev` | 启动开发服务器，热替换 |
| `think-h3 build` | 产出 `dist/server/index.mjs`（全栈时另有 `dist/client`） |
| `think-h3 start` | 运行生产产物（等同 `node dist/server/index.mjs`） |
| `think-h3 test` | 调用 vitest（自动注入框架配置） |
| `think-h3 make:controller User --resource` | 生成器：controller/service/middleware/provider/validate/exception |
| `think-h3 route:list` | 表格打印路由、方法、中间件、处理器 |
| `think-h3 typegen` | 生成 `.think/types`：config 键、路由名、中间件别名的类型 |

### 9.1 `dev` 热更新实现（核心）

```ts
// @think-h3/vite 内部 dev 运行时（示意）
const vite = await createServer({
  configFile: false,
  root,
  appType: 'custom',
  server: { middlewareMode: true },
  plugins: [thinkH3(options)],
})
const env = vite.environments.ssr                 // RunnableDevEnvironment

let current: ThinkApp | undefined
async function load() {
  const { createApplication } = await env.runner.import('virtual:think/entry')
  return createApplication({ mode: 'development' })
}

current = await load()

vite.watcher.on('all', debounce(async (_event, file) => {
  // 1. Vite 模块图已标记受影响模块失效（必要时 env.runner.clearCache()）
  // 2. 重新构建应用；失败则保留旧应用并打印错误（开发体验不中断）
  const next = await load().catch((err) => { printError(err); return undefined })
  if (!next) return
  const prev = current
  current = next                                  // 原子切换：新请求走新应用
  await prev?.dispose({ reason: 'hmr' })          // 在途请求结束后释放旧容器
  consola.success(`hot reloaded (${relative(root, file)})`)
}, 50))

// 外层监听只创建一次，永不重启
serve({ port, fetch: req => current!.fetch(req) })
```

要点：

- **进程不重启、端口不断开**：只换 `current` 引用，毫秒级生效；
- TS 直接运行，无需预编译；路径别名、`.env`、插件与 Vue 项目共享同一套 Vite 配置；
- 持久资源通过 `definePersistent` 跨重载保留（§4.4）；
- 只有 `.env`、`think.config.ts` 变更时才重建 Vite 实例（仍不需要手动重启）；
- 后续可以做“细粒度 HMR”：仅路由文件变化时只重建 Router，不重建容器。

### 9.2 `build`

使用 Vite 的 `builder.buildApp()`（Environment API）：

- `ssr`（server）环境：入口为 `virtual:think/server-entry`，生成 `dist/server/index.mjs`，内含 `createApplication + serve + 优雅停机`；
- `client` 环境（全栈模式）：Vue 正常构建到 `dist/client`，server 端用 h3 `serveStatic` 托管并做 SPA fallback；
- 依赖默认 external（保留 `node_modules`），可配置全量打包以便 Docker 精简镜像。

---

## 10. 作为 Vite 插件服务 Vue 项目

```ts
// vite.config.ts（Vue 项目）
import vue from '@vitejs/plugin-vue'
import { thinkH3 } from '@think-h3/vite'

export default defineConfig({
  plugins: [
    vue(),
    thinkH3({ root: 'server', prefix: '/api' }),
  ],
})
```

- **dev**：在 `configureServer` 中注入 connect 中间件，匹配 `/api/**` 的请求经 Node → Web Request 适配（srvx / h3 的 Node 适配工具）交给当前热替换的 `current.fetch`；其余请求交还 Vite 处理 Vue。**前后端同一个端口、同一个 `pnpm dev`，无需配 proxy，也无跨域问题。**
- **build**：插件声明 `ssr` 环境，`vite build` 一次产出 client + server。
- **类型共享（第三期）**：根据路由表 + 控制器返回类型生成 `$api` 客户端类型，前端 `useApi('/api/v1/users/:id')` 获得完整的请求/响应类型提示（参考 Nitro 的 typed `$fetch`）。

---

## 11. 测试（Vitest）

```ts
// vitest.config.ts
import { defineThinkTestConfig } from '@think-h3/testing/config'
export default defineThinkTestConfig()   // 自动加 thinkH3 插件，node 环境

// tests/user.test.ts
import { createTestApp } from '@think-h3/testing'

it('获取用户', async () => {
  const app = await createTestApp({
    override: c => c.instance(UserRepository, new FakeUserRepository()),
  })
  const res = await app.request('/api/v1/users/1', {
    headers: { authorization: 'Bearer test' },
  })
  expect(res.status).toBe(200)
  expect(await res.json()).toMatchObject({ data: { id: 1 } })
})
```

- 基于 `app.request()`，**不监听端口**，并行安全、速度快；
- 容器 override 方便替换外部依赖；也可以单测 Service：`app.make(UserService)`；
- 全栈项目用 Vitest `projects` 拆分 `server`（node）与 `web`（jsdom/happy-dom）。

---

## 12. 实施路线

| 阶段 | 内容 | 产出 / 验收 |
|------|------|-------------|
| **M0 基础设施**（~1 周） | monorepo、tsdown、vitest、eslint、changesets；升级 Node 22 | `pnpm build && pnpm test` 通过 |
| **M1 内核**（~2 周） | Container（作用域/循环检测/ALS）、Config/Env、Application 生命周期、Router（group/resource/name）、中间件管线、HttpContext、异常体系与 Handler | 用 `app.request()` 跑通 playground 的 CRUD 示例 + 单测覆盖 |
| **M2 工具链**（~2 周） | Vite 插件（虚拟模块）、dev 热替换 runner、build/start、CLI 基础命令、`definePersistent` | `think-h3 dev` 改控制器/服务/路由即时生效，进程不重启 |
| **M3 Vue 集成 + 脚手架**（~1.5 周） | dev 挂载 `/api/**`、client+server 构建、`create-think-h3` 两个模板、`@think-h3/testing` | 一个命令创建并启动全栈项目 |
| **M4 体验增强**（持续） | 校验（Standard Schema）、Logger、make:* 生成器、route:list、typegen、错误页 | 文档站（VitePress） |
| **M5 生态** | ORM provider（drizzle 优先）、缓存（unstorage）、Session/Auth、事件、队列/定时任务、OpenAPI、前端类型安全 API 客户端 | 按业务需要排期 |

### 主要风险与对策

| 风险 | 对策 |
|------|------|
| HMR 后旧定时器/连接泄漏 | Provider `shutdown` + `dispose({reason:'hmr'})`；资源统一走 `definePersistent`；开发模式下检测未清理的 interval 并警告 |
| 装饰器/元数据兼容性 | 核心不依赖装饰器，`inject()` 为主；装饰器做可选插件 |
| ALS 性能开销 | Node 22 下 ALS 开销已很低；仅在请求入口 `run` 一次 |
| h3 v2 API 变化 | 通过 `@think-h3/core` 内部适配层隔离，用户代码不直接依赖 h3 内部 |
| 产品改名 | 名称、bin、配置文件名、虚拟模块前缀集中在 `packages/core/src/constants.ts`，包 scope 一次性替换 |

---

## 13. 待确认事项

1. 统一响应格式默认是否开启 `{ code, message, data }`？业务错误码规范？
2. ORM 首选（drizzle / prisma / typeorm / 自研 Model 层仿 ThinkPHP ORM）？
3. 是否需要多应用模式（ThinkPHP 的 `app/admin`、`app/api` 多应用）？
4. 部署目标：仅 Node（Docker/PM2），还是需要 Serverless / Bun？
5. npm 发布到公共仓库还是私有 registry（gitea）？

---

## 14. 实施记录

### M0 + M1（2026-10-26）

已完成 `@think-h3/core` 运行时内核与 playground，56 个测试通过。与原方案相比的调整与默认值：

| 项 | 结论 |
|----|------|
| 统一响应格式 | 默认开启 `{ code: 0, message: 'ok', data }`；错误为 `{ code, message, data: null, errors? }`，HTTP 状态码保持真实值；`BusinessException` 默认 HTTP 200 + 业务码 |
| TypeScript | 固定 `~6.0.3`。TS 7（Go 原生版）不提供经典 JS API，tsdown 生成 d.ts 与后续 vue-tsc / Volar 都依赖该 API |
| `@types/node` | 使用 `^24`。`@types/node@22` 依赖的 `undici-types@6.21.0` 被 pnpm 的 `trustPolicy: no-downgrade` 拦截（无 provenance），未放宽该策略；运行时下限仍为 Node 22.12 |
| 配置文件 | 读取环境变量的配置须用函数形式 `defineConfig(() => ({ ... }))`，保证在 `.env` 加载后求值 |
| 资源路由校验 | 新增 `resource(...).validateMember(schemas)`，统一校验成员路由的 `:id` |
| ESLint | 包代码要求显式返回类型；playground / 测试关闭该规则（业务代码依赖返回类型推导，为后续类型安全 API 客户端做准备） |
| 其余待确认项 | ORM、多应用模式、部署目标、发布仓库：M1 不涉及，仍待定 |

下一步：M2（Vite 插件虚拟模块 `virtual:think/manifest`、dev 热替换 runner、CLI `dev / build / start`）。

### M2（2026-10-26）

新增 `@think-h3/vite` 与 `@think-h3/cli`，65 个测试通过（含真实文件修改的热更新集成测试）。实测 playground：启动约 170ms，修改服务文件后 10–15ms 生效，PID 与端口不变。

**虚拟模块**

| 模块 | 内容 |
|------|------|
| `virtual:think/manifest` | `import.meta.glob` 发现 `config/*`、`route/*`、`app/provider/*`、`app/exception/Handler` |
| `virtual:think/app` | `createApp(options)`，dev / build / vitest 共用（类型：`@think-h3/vite/client`） |
| `virtual:think/server-entry` | 生产入口：`createApp({ mode: 'production' }).serve()` |

**热替换机制要点**（实现于 `packages/vite/src/dev.ts`）

- 外层 srvx 监听只创建一次，`fetch` 转发给当前应用；变化时 `runner.clearCache()` + 重新 import `virtual:think/app` 并 boot，成功后原子替换。
- 触发点用插件的 `hotUpdate` 钩子（ssr 环境），而不是直接监听 watcher：Vite 的模块失效是异步的，`hotUpdate` 保证在失效之后执行。
- `server.hmr` 必须保持开启（`hmr: false` 会跳过 `hotUpdate`），用 `server.ws: false` 关闭 WebSocket 端口。
- `envDir: false`：否则 Vite 在 `.env` 变化时会重启整个开发服务器；`.env` 由框架在每次 boot 时重新加载。**M3 的 Vue 模式需要重新评估**（前端需要 `VITE_*` 变量）。
- 旧应用等在途请求结束后才 `dispose({ reason: 'hmr' })`；重载串行执行并防抖。
- 失败策略：重载失败保留旧版本继续服务并打印错误（带 source map 定位）；首次启动失败则所有请求返回 500 错误详情，修复后自动恢复。
- 新增 / 删除文件时主动失效 manifest 模块，使 glob 重新计算。

**其它**

- `think.config.ts`（可选）：`srcDir`、`port`、`host`、`outDir`、`vite`。
- 生产构建依赖保持 external；monorepo 内 `@think-h3/core` 为链接包，会被打进产物（真实安装时不会）。
- srvx 默认的信号处理已关闭（`gracefulShutdown: false`），由 `Application.serve()` / CLI 统一执行停机流程。
- 当前每次变化都重新执行全部应用代码（毫秒级）；细粒度 HMR（只重建路由等）暂无必要。

下一步：M3（Vue 项目集成：dev 挂载 `/api/**`、client + server 一次构建、`create-think-h3` 模板、`@think-h3/testing`）。

### M3（2026-10-26）

新增 `@think-h3/testing` 与 `create-think-h3`，`thinkH3()` 支持 Vue 全栈模式；77 个测试通过（含模板端到端：生成 → 类型检查 → 模板自带测试 → dev 热更新 → 构建 → 生产运行）。并用真实 CLI + 浏览器验证了 Vue 模板的开发与生产流程。

**Vue 全栈模式**（`vite.config.ts` 中 `plugins: [vue(), thinkH3()]`）

- 开发：插件在 Vite 内置中间件之前挂载 `/api/**`（`prefix` 可配），经 srvx `toNodeHandler` 交给热替换的应用；前后端同端口，无需代理。后端文件变化走 `hotUpdate`（ssr 环境）整体重载，前端 HMR 不受影响。
- `.env`：全栈模式保留 Vite 的 `envDir`（前端需要 `VITE_*`），`.env` 变化时 Vite 自行重启，插件通过包装 `server.close()` 释放旧应用，实测新值立即生效。纯后端模式仍为 `envDir: false`。
- 构建：插件配置 `builder.buildApp`，`vite build` 依次构建 `client → dist/client`、`ssr → dist/server`；生产入口通过 core 新增的 `static` 选项托管 `dist/client`（`/assets/` 长期缓存、HTML 请求回退 index.html、`/api` 排除在外返回 JSON 404）。
- `srcDir` / `outDir` 统一从 `think.config.ts` 读取，`vite.config.ts` 与 `think-h3` 命令共用。
- `think-h3 dev / build` 检测到 `vite.config.*` 时交给用户的 Vite 配置；`start` 自动查找 `dist/index.mjs` 或 `dist/server/index.mjs`。

**@think-h3/testing**

- `useTestApp(options)`：每个用例前创建全新应用、用例后释放；`createTestApp()` 手动管理。
- 客户端：`get / post / put / patch / delete` 自动 JSON 编解码，`withHeaders()` 派生带默认头的客户端；`override: c => c.instance(...)` 替换绑定。
- `defineThinkTestConfig()`：注册 `thinkH3({ standalone: true })` 并内联 `@think-h3/testing`（它需要导入 `virtual:think/app`）。

**create-think-h3**

- 模板放在 `packages/create/templates/{api,vue}`（与原方案的仓库根 `templates/` 不同，便于随包发布）；`_gitignore` → `.gitignore`，`{{name}}` / `{{version}}` 占位替换。
- Vue 模板的 TypeScript 拆分为 `tsconfig.app.json`（DOM + Vue）与 `tsconfig.server.json`（Node + 虚拟模块类型），`vue-tsc --build` 统一检查。

**已知限制 / 后续**

- 包尚未发布，模板依赖的 `^0.0.0` 在仓库外无法安装；发布前需确定 npm 仓库（公共 / gitea 私有）。
- 前端调用 API 仍是手写 `fetch`，路由与控制器返回类型尚未生成前端类型（计划中的类型安全 API 客户端）。
- M4：`make:*` 代码生成器、`typegen`、日志增强、错误页；M5：ORM、缓存、Session/Auth、队列、OpenAPI。

### M4（2026-10-26）

98 个测试通过；在 playground 中用真实开发服务器 + 浏览器验证了访问日志与 500 / 422 / 404 错误页。

**日志**

- `Logger` 支持 `format: 'pretty' | 'json'`、`child(context)`（保留子类）、`access()`；JSON 行含 `time / level / tag / msg / requestId / err`，error 级别写 stderr。
- 默认值按模式：development 彩色 + 访问日志；production JSON + 访问日志；test 仅 warn 以上、关闭访问日志。
- 内置请求 ID：沿用上游 `x-request-id`（仅接受 `[\w.:-]{1,128}`，防日志注入），否则生成 UUID，并回写响应头；`app.requestIdHeader: false` 可关闭回写。
- `ctx.requestId` / `ctx.logger`（带 requestId）；访问日志在 h3 `onResponse` 中记录，状态码为异常渲染后的最终值；ExceptionHandler 的上报改用 `ctx.logger`。
- 模板与 playground 删除了自写的 requestId 中间件。

**开发错误页**

- `app.debug` 开启且请求 `Accept: text/html` 时渲染 HTML：异常类名、源码片段（经 Vite source map 定位到 TS 源文件）、调用栈、校验错误表、请求信息（敏感头脱敏）、404 时列出全部路由；API 请求仍为 JSON，生产环境永不渲染。
- 开发服务器“应用启动失败”的响应同样使用该页面。
- 修复：模板 `.env` 原先写死 `APP_DEBUG=true`，导致生产构建也开启调试（会泄露堆栈）。现在 debug 完全由模式决定（仅 development 开启）。

**typegen**

- 生成 `.think/types/think.d.ts`：`GeneratedConfig`（`typeof import('config/x').default`，仅依赖文件列表）与 `RouteNames`（路由名 → 路径参数）。dev 每次成功重载后写入（内容不变不写），`think-h3 typegen` 手动执行，`think.config.ts` 中 `typegen: false` 可关闭。
- `GeneratedConfig` 与手写的 `ConfigSchema` 在类型层深合并（直接扩充 `ConfigSchema` 会与内置 `app: AppConfig` 冲突）。
- 生成后配置键变为严格模式：未知键报错，读取任意键需传默认值 `config.get('x', fallback)`；`router.url()` 校验路由名与必填参数。通过“带 / 去掉 `@ts-expect-error` 各跑一次 tsc”验证类型确实生效。

**make:* 生成器**

- `make:controller [--resource] / service / repository / middleware / provider / validate / test / config / route`，名称支持子目录（`admin/User`）并自动去除重复后缀；`config`、`route` 只按第一层自动发现，带子目录时报错。
- stub 为 CLI 包内的 `.stub` 文件；项目 `stubs/<name>.stub` 优先（`think-h3 stub:publish` 导出）；仅安装 zod 时 `make:validate` 使用 zod 版本。
- 模板端到端测试：生成全部类型 → typegen → 类型探针 → tsc → vitest（含生成的测试）。

**已知限制**

- monorepo 内框架包以链接方式被内联执行，重新构建 core 后需重启开发服务器（真实安装时框架位于 node_modules，升级依赖本就需要重启）。
- 中间件别名尚未生成类型（`.middleware('auth')` 仍为字符串）。

---

## 15. 第二阶段决策（2026-10-26）

| 议题 | 决定 |
|------|------|
| 统一业务码 | 默认输出 `{ code, message, data }`；用户可全局替换成功 / 错误的响应格式（`app/response/Formatter.ts`），并可拦截最终出站的 Response（出站拦截器） |
| ORM | 不完全自研：以 drizzle 为底层，二次开发 ThinkPHP 风格的 `Db` 查询构造器 + `Model`（软删除、时间戳、获取器 / 修改器、作用域、关联、分页、事务）；表结构用 drizzle schema 定义，类型由其推导 |
| 数据库 | MySQL、PostgreSQL、SQLite；MongoDB 通过独立适配器（官方 `mongodb` 驱动）提供同形态的 Db / Model API，聚合等特有能力单独暴露 |
| 多应用 | 目录多应用：`app/<name>/` 各自拥有 controller / route / middleware / config / 异常处理 / 响应格式，按 URL 前缀或域名分发，共享容器与 `app/common` |
| 部署 | 尽可能覆盖全部模式：Node（单进程 / 集群 / Docker）、Bun、Deno、Serverless（Vercel、Netlify、AWS Lambda）、边缘（Cloudflare Workers、Deno Deploy） |
| 发布 | 暂不考虑，功能完成后再定 |

### 后续路线

| 阶段 | 内容 |
|------|------|
| M5 | 响应格式化器（ResponseFormatter）+ 出站拦截器 + `raw()` 跳过格式化 |
| M6 | 目录多应用（前缀 / 域名 / 应用级配置、中间件、异常处理、响应格式，路由名带应用前缀） |
| M7 | `@think-h3/orm`：drizzle 之上的 Db + Model（MySQL / PostgreSQL / SQLite），迁移与 make:model |
| M8 | MongoDB 适配器 |
| M9 | 部署预设：`think-h3 build --preset node|bun|deno|cloudflare|vercel|netlify|aws-lambda|docker` |
| M10 | 补齐 M9 的已知限制：生产迁移入口、Cloudflare D1 / Turso HTTP 驱动 |
| M11 | 参考 Nitro：依赖追踪进产物（nf3）、`vite preview` / `think-h3 preview` 运行产物、React 模板与多框架验证 |
| M12 | 内置中间件（CORS、限流、安全头、压缩、请求体上限）、文件上传、Cookie / Session、认证（JWT / Session Guard） |
| M13 | 授权（Gate / Policy、ctx.can / authorize、can: 中间件）与 CSRF 同步令牌 |
| M14 | 缓存（memory / redis / upstash / kv）、原子锁、响应缓存，限流与 Session 的共享存储，Cloudflare 限流绑定 |
| M15 | 队列（sync / memory / redis(BullMQ) / Cloudflare Queues，重试、延迟、超时、失败任务）与定时任务（croner，onOneServer / withoutOverlapping） |
| M16 | 事件 / 监听器（同步与排队）、WebSocket（crossws：开发热替换、各运行时、Redis 多实例广播、Cloudflare Durable Object） |

### M5 实施记录（2026-10-26）

- **统一格式改为出站阶段处理**：路由处理器返回原始数据，异常边界在出站时交给 `ResponseFormatter.success()`；错误经 `ExceptionHandler.render()` → `format()` → `ResponseFormatter.error()`，成功与失败由同一个类定义格式。中间件 `await next()` 拿到的是原始数据，可在格式化前加工；中间件短路返回的数据同样会被格式化。
- **自定义**：`app/response/Formatter.ts` 继承 `ResponseFormatter` 覆盖 `success / error / shouldFormat`（自动发现，支持热更新）；跳过格式化用 `.meta({ envelope: false })` 或 `return raw(value)`。
- **出站拦截器**：`app/interceptor/*.ts`（`defineInterceptor`，按文件名顺序）或在提供者中 `app.intercept(fn)`；拿到最终 Response（格式化、异常渲染之后），可改头或返回新 Response。仅在注册了拦截器时才提前把返回值转成 Response，不影响默认性能；访问日志仍只记录一次。
- `make:interceptor`；模板新增 `app/response/Formatter.ts` 作为可直接修改的入口。

### M6 实施记录（2026-10-26）

- **声明**：`config/app.ts` 的 `apps`（`prefix` / `domain`，域名支持 `*.example.com`），目录 `app/<name>/{route,config,provider,exception,response}`；未声明的目录（如 `app/common`）不会启用。
- **分发**：每个应用一个独立的 H3 子实例（应用中间件 + 路由），因此不同域名的应用可以有相同路径。主应用在全局中间件之后、全局路由之前按“域名优先、前缀最长”匹配，剥离前缀后交给子实例；错误、格式化、拦截器、访问日志仍走主应用的统一管线。
- **应用级能力**：配置 = 全局 + 应用配置深合并（`ctx.config`、`config()`、请求作用域内的 `inject(Config)` 读取应用配置；单例服务注入的仍是全局配置）；应用中间件只作用于本应用，可覆盖全局别名；应用自己的 `exception/Handler.ts`、`response/Formatter.ts` 绑定到请求容器。
- **路由**：路由名自动加 `<app>.` 前缀，`router.url()` / `route:list` / typegen 覆盖所有应用，`route:list` 显示 APP / DOMAIN 列；启动时检查重名与前缀 / 域名冲突。
- **生成器**：`make:* --app <name>`。

### M7 实施记录（2026-10-26）

新增 `@think-h3/orm`，150 个测试通过；同一套 ORM 用例（17 个场景）在 SQLite（libsql）、PostgreSQL（PGlite）与 MySQL 8.4.13（Docker）上全部通过。MySQL 用例只在设置 `THINK_TEST_MYSQL_URL` 时执行：

```bash
docker run -d --name think-h3-mysql -e MYSQL_ROOT_PASSWORD=think -e MYSQL_DATABASE=think_test -p 3307:3306 mysql:8
THINK_TEST_MYSQL_URL='mysql://root:think@127.0.0.1:3307/think_test' pnpm vitest run --project orm
```

尚未覆盖：MySQL / PostgreSQL 下的 `db:generate` / `db:migrate` 命令流程（模板端到端测试只覆盖 SQLite）。

**Db 查询构造器**（`Db.table(users)`）：`where`（列/值、运算符、对象、drizzle 表达式、分组回调）、`orWhere`、`whereIn / whereNull / whereBetween / whereLike`、`when`、`order / limit / page / field`、`select / find / findOrFail / value / column`、`count / sum / avg / max / min / exists`、`paginate`、`chunk`、`insert`（返回完整行，MySQL 通过 `$returningId()` 回查）、`insertGetId`、`update / delete`（返回影响行数，无条件写入需显式 `{ all: true }`）、`increment / decrement`、`toSQL`；`Db.execute(sql)`、`Db.drizzle()` 用于复杂查询；`Db.connection(name)` 切换连接。

**事务**：`Db.transaction(fn)` 通过 AsyncLocalStorage 隐式传播，回调内的 Db / Model 查询自动使用事务，嵌套为保存点。

**Model**：`class User extends Model.define(users)`，字段类型由 drizzle 表推导（不需要重复声明）；`create / find / findOrFail / all / paginate / destroy / save（只更新脏字段）/ delete / forceDelete / restore / refresh`；软删除（`withTrashed / onlyTrashed`）、时间戳（列存在时自动维护，按列类型写 Date / 字符串 / 毫秒）、`get*Attr / set*Attr`、`hidden / append`、`static scopeXxx` → `scope('xxx')`、事件 `onBefore/AfterInsert|Update|Write|Delete|Restore`；关联 `hasOne / hasMany / belongsTo`，可直接 await，也可 `with('posts.author')` 嵌套预加载，`toJSON` 包含已加载关联。
- 类型实现要点：模型通过 `'~table'` 品牌属性推导表类型，避免互相引用的模型在结构比较时无限展开。

**连接**：`config/database.ts`（`sqlite | postgres | pglite | mysql`），驱动为可选 peer 依赖、按需动态加载；连接懒建立、跨 HMR 复用、应用关闭时释放；唯一约束冲突统一转换为 `UniqueConstraintException`（409）。

**迁移与命令**：表结构在 `database/schema/*.ts`，`think-h3 db:generate`（调用 drizzle-kit）、`db:migrate`（drizzle 运行时迁移器）、`db:seed`（在应用模块图中执行 `database/seeders/*.ts`）、`make:model`（模型 + 对应方言的表结构）、`make:seeder`；测试用 `refreshDatabase()` 配合 `.env.test` 的 `DATABASE_URL=:memory:`。

**模板**：api / vue 模板默认集成 SQLite、User 模型与 CRUD 控制器、初始迁移、数据填充与测试。

**环境说明**：pnpm 11 要求显式决定依赖的安装脚本；drizzle-kit 依赖的 esbuild 安装脚本已设置为不执行（`allowBuilds: esbuild: false`），esbuild 通过平台二进制包正常工作。pnpm 还自动把较新的 `@electric-sql/pglite` 加入了 `minimumReleaseAgeExclude`。

### M8 实施记录（2026-10-26）

新增 `@think-h3/orm/mongo`（独立入口，只有使用时才加载 `mongodb` 驱动），165 个测试通过；MongoDB 用例运行在 mongodb-memory-server 启动的单节点副本集上（首次运行下载 mongod 二进制，之后离线可用），事务真实提交 / 回滚。

- **共享基类**：从 SQL `Model` 中抽出 `ActiveRecord`（属性与脏检查、访问器 / 修改器、hidden / append、事件、关联与预加载、序列化），`Model` 与 `MongoModel` 都继承它；关联 `hasOne / hasMany / belongsTo` 两种模型通用，ObjectId 关联键按字符串比较。重构后 SQL 用例全部通过（MySQL 组本次未重跑，colima 已停止；重构未改动方言相关代码）。
- **Mongo 查询构造器**：`Mongo.collection<Doc>('users')`，方法与 `Db.table()` 一致（where / orWhere / 分组 / whereIn / whereNull / whereBetween / whereLike → 正则 / order / page / field / paginate / chunk / 聚合 / insert / update / delete / increment），无条件写入同样需要 `{ all: true }`；Mongo 特有：`aggregate(pipeline)`（自动在前面加当前条件的 `$match`）、`where({ age: { $gt: 1 } })` 直接使用查询运算符、`update({ $push: … })` 直接使用更新运算符、`Mongo.db()` 获取原生 Db。
- **MongoModel**：`class User extends MongoModel.define<UserDoc>('users')`；文档无固定结构，实例以 Proxy 把未声明属性的读写转为 getAttr / setAttr（因此内部不使用 `#私有成员`）；字符串 `_id` 自动转为 ObjectId，JSON 中输出为字符串；软删除、时间戳、作用域、事件与 SQL 模型一致。
- **事务**：`Mongo.transaction(fn)` 使用会话并通过 AsyncLocalStorage 隐式传播；MongoDB 不支持嵌套事务，嵌套调用复用外层事务。
- **其它**：`config/database.ts` 新增 `driver: 'mongodb'`（`database` 指定库名）；重复键（11000）同样转换为 409；`refreshDatabase()` 对 MongoDB 清空数据库；`db:generate / db:migrate` 跳过 MongoDB 连接；`make:model --dialect mongodb` 生成带文档接口的模型。
- **类型实现要点**：模型相关泛型只用品牌属性约束（`ModelLike` / `MongoModelLike`），关联目标不加 `extends ActiveRecord` 约束，避免互相引用的模型在结构比较时无限展开。
- **依赖**：`mongodb-memory-server-core` 间接依赖的 `semver@6.3.1` 被 trustPolicy 拦截，通过 `overrides: 'make-dir@3>semver': ^7.7.0` 改用 semver 7（make-dir 只调用 `semver.satisfies()`），未放宽安全策略；使用 `-core` 包，没有安装脚本。

### M9 实施记录（2026-10-26）

`think-h3 build --preset <name>`（或 `think.config.ts` 的 `preset`），纯后端与 Vue 全栈项目共用同一套预设：插件在构建时按预设决定产物布局、打包策略、解析条件与生产入口，构建结束执行预设的收尾步骤（生成平台配置、复制依赖）并给出部署提示。178 个测试通过。

| 预设 | 产物 | 打包策略 | 验证方式 |
|------|------|----------|----------|
| node（默认） | `dist/index.mjs`；全栈为 `dist/server` + `dist/client` | 依赖 external | 真实 Node 进程 |
| bun | 同 node | 依赖 external，`bun` 条件 | 真实 Bun 1.4 进程 |
| deno | `dist/server/index.mjs` | 全部打包（驱动除外），`deno` 条件 | 真实 Deno 2.9 进程 |
| docker | `dist/` 即构建上下文：Dockerfile + 运行时 package.json | 框架与纯 JS 依赖打包，数据库驱动在镜像内 `npm install` | 真实 Docker 构建与运行（colima） |
| aws-lambda | `dist/lambda`（含复制的驱动 node_modules，全栈含 client） | 驱动 external + 复制 | 以 API Gateway v2 / v1 事件调用 handler |
| vercel | `.vercel/output`（static + `__server.func` + config.json 路由） | 驱动 external + 复制 | 以 Node HTTP 服务器挂载函数 |
| netlify | `.netlify/v1/functions/think-h3-server.mjs` + `netlify.toml` + `_redirects` | 驱动 external（Netlify 构建时打包） | 直接调用函数 |
| cloudflare | `dist/index.mjs` 单文件 Worker + `wrangler.json`（nodejs_compat、Assets、SPA 回退、`run_worker_first`） | 全部打包、`browser` 平台，不可用驱动替换为报错空模块 | 真实 workerd（miniflare） |

**要点**
- 全栈：服务端先于前端构建（部分预设的前端目录位于服务端目录内）；Vercel / Netlify / Cloudflare 的静态资源由平台 CDN 提供，Lambda / Docker / Node 由同一进程托管。
- 打包后的产物不依赖框架包的发布（`@think-h3/*` 已打包）；ORM 按变量动态加载的驱动扫描不到，按项目依赖显式带上。
- Docker 中驱动在镜像内安装，得到 Linux 平台的原生二进制（实测容器内为 `@libsql/linux-x64-*`）。
- Cloudflare：消除了 Node 平台的 `createRequire(import.meta.url)` 辅助代码；core 的日志颜色改为自带的小工具（原 `consola/utils` 依赖 `node:tty`）；Worker 入口只能导出处理器，因此输出单文件。
- core 新增 `createLambdaHandler`（API Gateway v1 / v2、ALB、Function URL）并导出 `toNodeHandler`。
- 依赖：新增 miniflare、deno（npm 包）作为测试开发依赖；pnpm 11 中 `deno`、`workerd` 的安装脚本被设置为不执行（平台二进制随可选依赖安装）。

**已知限制 / 后续**
- ~~Cloudflare Workers 上 ORM 的 SQL 驱动不可用~~（M10 已解决：D1 / Turso 驱动）。
- Vercel / Netlify / AWS Lambda 只在本地按平台约定模拟调用验证，尚未真实部署。
- ~~生产环境的数据库迁移依赖开发工具链~~（M10 已解决：迁移随产物打包）。

### M10 实施记录（2026-10-26）：生产迁移与 Edge 数据库

补齐 M9 的已知限制。199 个测试通过，5 个跳过（D1 上的 2 个事务用例、非 D1 方言上的 D1 专属用例，以及按环境变量启用的 Worker + Turso 用例）；Turso 的 20 个 ORM 用例与 Worker 用例在设置 `THINK_TEST_TURSO_URL` 后运行。

**驱动**
- 新增 `turso`：使用 `@libsql/client/web`（纯 fetch 的 HTTP 客户端，不加载 libsql 原生模块），Edge 与 Serverless 都能用，支持交互式事务与保存点。
- 新增 `d1`：`drizzle-orm/d1`，`binding` 为 Workers 绑定名（默认 `DB`）或直接传入 D1Database。core 新增 `setPlatformBindings` / `usePlatformBinding`；Cloudflare 入口每次请求前注册 `env`。
- D1 拒绝 `BEGIN` / `SAVEPOINT`：`transaction()` 直接抛出带 `batch` 提示的 DatabaseError；影响行数读取 D1 的 `meta.changes`。
- `turso` / `d1` 的方言均为 sqlite，与 `sqlite` 共用表结构、迁移与 `db:generate`。
- 驱动改为字面量动态导入（`importDriver(name, () => import('pkg'))`），打包器可以静态解析，这是 Workers 能用 ORM 的前提。随之调整：
  - 全量打包（cloudflare）时，未安装的驱动在构建期替换为“调用即报错”的空模块；
  - `cloudflare:*` 保留为运行时导入（postgres.js 的 Workers 构建会用到 `cloudflare:sockets`）；
  - 扫描产物得到的驱动只保留项目实际安装的（Docker 的 package.json、Lambda / Vercel 复制的 node_modules 不会多出未安装的驱动）；
  - Cloudflare 产物是单个 `index.mjs`，Miniflare 测试直接用 `scriptPath`，不再需要手工列出模块。

**迁移**
- ORM 自带迁移执行器，不再调用 drizzle 各驱动的 `migrator`（它们用 `node:fs` 读目录）。逻辑与 drizzle 一致：
  - 同一张 `__drizzle_migrations` 表，哈希相同（SHA-256 改用 Web Crypto 计算），可以和 drizzle-kit migrate 混用；
  - libsql 走 `session.migrate`，D1 走 `batch`（插入用字面量，与 drizzle 一致），PostgreSQL / MySQL 委托 `dialect.migrate`。
- `migrate({ folder, files? })` 可读磁盘，也可读内嵌文件；`runMigrations({ connection?, all?, files?, srcDir? })` 按 config/database.ts 解析各连接的迁移目录，跳过 MongoDB，返回 `{ connection, folder, applied, total }`。`think-h3 db:migrate` 改为调用它。
- Vite 插件新增 `virtual:think/migrations`：用 `import.meta.glob('?raw')` 把 `database/**` 下的 SQL 与 `_journal.json` 打进产物，键为相对 srcDir 的路径。
- 各预设的生产迁移入口：

| 预设 | 入口 | 验证 |
|------|------|------|
| node / bun / deno / docker | 构建额外输出 `migrate.mjs`（`--connection`、`--all`），与 `index.mjs` 共享 chunk | Docker 产物中执行两次（1/1、0/1），再启动服务 CRUD |
| aws-lambda | 同一 bundle 导出 `migrate(event)`，handler 设为 `index.migrate` | 进程内调用 |
| cloudflare + D1 | `think.config.ts` 的 `cloudflare.wrangler` 合并进 wrangler.json；`d1_databases` 默认 `migrations_dir: 'migrations'`，构建时复制 `database/migrations`；提示 `wrangler d1 migrations apply` | Miniflare D1 中按 wrangler 方式执行 SQL，再在 Worker 内 CRUD（201 / 409 / 204） |
| vercel / netlify / cloudflare + Turso | 在 CI 中执行 `think-h3 db:migrate` | `db:migrate` 写入真实 sqld，再在 Worker 内读写 |

**验证**
- D1：ORM 全部 SQL 用例（查询构造器、唯一约束 → 409、模型、关联、内嵌迁移、框架集成）在 Miniflare 的 workerd D1 上运行，事务用例跳过并改为验证报错。
- Turso：colima 中运行 `ghcr.io/tursodatabase/libsql-server`，`THINK_TEST_TURSO_URL=http://127.0.0.1:18080` 跑 ORM 全部用例（含 HTTP 上的事务与保存点）与 Worker + Turso 端到端用例，均通过。容器与镜像已删除，colima 已停止。

**仍然存在的限制**
- 本地开发时 Node 中没有 D1 绑定：开发用 `sqlite` 文件，部署时用环境变量切到 `d1`。如需本地也连 D1，可接入 wrangler 的 `getPlatformProxy`，目前没有做。
- D1 只支持 `batch` 形式的原子写入，框架的隐式事务传播在 D1 上不可用。
- Vercel / Netlify / AWS Lambda 仍只在本地按平台约定模拟调用。

### M11 实施记录（2026-10-26）：依赖追踪、预览与多框架

参考 Nitro v3 的两项能力：产物自带依赖，以及 `vite preview` 运行构建产物。确认的决策：
- 依赖追踪用 nf3；
- node / bun 默认改为打包加追踪；
- Docker 保持在镜像内安装依赖；
- SSR 入口（entry-server）放到后续。

**依赖追踪（nf3）**
- 新增依赖 `nf3`（MIT，零依赖，Nitro v3 同款，内部打包了 @vercel/nft），替换原来按 package.json 整包复制的 `copyDependencies`。
- 打包策略：除下面这些包外全部打包，它们保持 external：
  - 数据库驱动；
  - nf3 的 `NodeNativePackages`、`NonBundleablePackages`；
  - `externals.traceDeps` 中列出的包。
- 构建后从产物入口出发追踪实际加载的文件，复制为 `<serverDir>/node_modules`。同名多版本放在 `node_modules/.nf3/<name>@<version>`，并链接到依赖方。
- 各预设的处理：

| 预设 | 打包 | 追踪 |
|------|------|------|
| node / bun | 打包（原为全部 external） | 默认开启；`externals.trace: false` 时退回全部 external、使用项目的 node_modules |
| deno | 打包（驱动除外） | 默认开启 |
| aws-lambda / vercel | 打包（驱动除外） | 始终开启 |
| docker | 打包（驱动除外） | 不追踪：驱动在镜像内 `npm install`，保证 Linux 原生二进制 |
| netlify / cloudflare | 不变 | 不追踪 |

- 实测：vue 模板的 node 产物 `dist/` 拷到项目之外，可以直接执行迁移、启动并读写 SQLite。追踪到的有 `@libsql/client`、`libsql` 及其平台二进制、`ws` 等，约 9 MB。
- 跨平台检查：aws-lambda / vercel 的目标平台为 linux。在其它系统上构建且追踪到平台二进制（如 `@libsql/darwin-x64`）或 nf3 已知的原生包时，构建期会警告，提示在 Linux 上构建。这个问题在原来的整包复制方案中同样存在，只是之前没有提示。
- `think.config.ts` 新增 `externals: { trace?, traceDeps?, inline? }`，`traceDeps` 中的 `pkg*` 表示整包复制。

**预览**
- 构建结束写入 `.think/build.json`，记录预设、产物布局、入口、是否全栈与后端前缀。
- 插件实现 `configurePreviewServer`：在 Vite 内置静态中间件之前挂载产物。`vite preview` 预览时，`environments.client.build.outDir` 取自构建记录。
- 新增 `think-h3 preview` / `previewServer()`：全栈项目使用项目的 vite.config.ts，纯后端项目使用内置配置（`appType: 'custom'`），默认端口 4173。
- 各预设的运行方式：

| 预设 | 方式 | 静态文件 |
|------|------|----------|
| node / docker | 在随机端口启动产物进程（cwd 为项目根，加载 .env），用 fetch 转发全部请求（去掉逐跳头与 content-encoding） | 产物托管 |
| bun / deno | 同上，需要对应运行时（产物按 bun / deno 导出条件构建，不能用 Node 运行）；deno 也可使用 npm 的 deno 包 | 产物托管 |
| aws-lambda | 进程内调用 `handler`；core 新增 `requestToLambdaEvent` / `lambdaResultToResponse` | 产物托管 |
| vercel | 进程内调用 Node handler | Vite 托管 `.vercel/output/static`，后端前缀交给函数 |
| netlify | 进程内调用 Functions v2 handler | Vite 托管 publish 目录 |
| cloudflare | 用项目安装的 Miniflare 运行 `dist/index.mjs`：`vars`、D1、KV 绑定读取自 wrangler.json，数据持久化在 `.think/preview`；D1 迁移按 wrangler 的方式自动应用（`d1_migrations` 表记录） | Vite 托管 `dist/client` |

**多框架**
- 插件本身不依赖任何前端框架，前端框架插件与 `thinkH3()` 并列使用即可。
- 新增 `react` 模板：React 19、`@vitejs/plugin-react`；后端与 vue 模板相同，类型检查用 `tsc --build`。
- 新增 frameworks 测试：React 与纯 Vite（无框架）项目各自跑开发、构建、`vite preview` 三个环节，React 模板另跑类型检查和自带测试。三个模板都加了 `pnpm preview` 脚本。

**验证**
- preview 测试：vue 模板在 node、bun、docker、deno、aws-lambda、vercel、netlify、cloudflare 八个预设下预览，检查接口、SPA 回退、静态资源和 422 校验错误。
- Cloudflare + D1：本地预览自动迁移，再次预览时数据仍在、迁移不重复执行。
- 纯后端项目的预览，以及没有构建时的报错，都有用例。
- vite 包的 node 用例改为验证追踪结果，以及产物拷到 tmp 目录后仍能运行；`trace: false` 有单独用例。

**仍然存在的限制**
- 预览不转发 WebSocket（框架目前也没有 WebSocket 支持）。
- 在 macOS 上构建的 Lambda / Vercel 产物仍然带着 macOS 的原生二进制，构建只给警告，不会自动下载 Linux 版本。

### M12 实施记录（2026-10-27）：内置中间件、上传、Session 与认证

确认的决策：
- JWT 使用 jose；
- Session 提供 cookie、memory 两种驱动，加 `SessionStore` 接口（Redis / KV 等放到后续的缓存模块）；
- 三个模板带上 JWT 登录示例；
- 授权（Gate / Policy）放到后续。

**请求管道**
- 新增 `ctx.onResponse(hook)`：在统一格式化、异常渲染与出站拦截器之后执行。后注册的先执行（洋葱模型），所以全局的 `compress` 最后执行。`issueTestCredentials` 也复用这些钩子取回会话 Cookie。
- 发现 h3 对没有额外响应头的 JSON 响应复用了冻结的 Headers，新增 `mutableResponse()` 统一处理，出站拦截器也因此更稳。
- 内置中间件注册为默认别名，`config/middleware.ts` 的 alias 可以同名覆盖。

**内置中间件**

| 名字 | 实现要点 |
|------|----------|
| `cors` | h3 `handleCors`，配置在 `config/cors.ts`；预检请求必须放在 global |
| `throttle:60,60` / `throttle:<name>` | 固定窗口：已登录按用户 ID，否则按 IP（`app.trustProxy` 为 true 时取 X-Forwarded-For）；返回 RateLimit-Limit / Remaining / Reset 头，超限 429 + Retry-After；`RateLimitStore` 可替换，默认内存（跨热更新保留） |
| `secureHeaders` | 参考 helmet 默认值；CSP 默认关闭；HSTS 只在 https 且非 debug 时发送 |
| `compress` | br（node:zlib，运行时没有时跳过）> gzip > deflate（CompressionStream），按 Accept-Encoding 的 q 值协商；长度未知时先读到阈值（1kb）再决定是否压缩；跳过已编码、不可压缩类型、SSE、`no-transform`、204 / 206 / 304 |
| `bodyLimit:10mb` | 调整 `ctx.bodyLimit`；默认取 `app.bodyLimit`（1mb），在 `ctx.body()` 读取时校验 content-length 与实际字节数，超出返回 413 |
| `session` / `auth` / `guest` | 见下文 |

**文件上传**
- `ctx.body()` 支持 multipart：普通字段为字符串，文件为 `UploadedFile`，同名多值为数组，空的文件输入会被忽略。
- `UploadedFile` 继承 File，valibot 的 `v.file()`、`v.maxSize()`、`v.mimeType()` 可以直接校验；提供 `extension`、`store(dir)`（随机文件名）、`storeAs(dir, name)`（只取文件名，防止路径穿越）。
- 其他入口：`ctx.file()`、`ctx.files()`。
- 坑：srvx 对请求体做大小限制时会包装 Request，undici 的 `formData()` 因此丢失 multipart 类型。改为用计数后的流重新构造 Response 再解析。

**Cookie 与 Session**
- `ctx.cookie / setCookie / deleteCookie` 的默认选项为 httpOnly、SameSite=Lax、非 debug 时 Secure，可用 `app.cookie` 覆盖。
- 签名 Cookie：`ctx.signedCookie / setSignedCookie`，HMAC-SHA256，密钥为 `APP_KEY`。
- `APP_KEY`：至少 32 个字符。`think-h3 key:generate` 写入 `.env`（已有时需加 `--force`），create 模板为每个项目生成独立的密钥。
- Session 由 `session` 中间件或 `await ctx.startSession()` 启动，`ctx.session` 提供 `get / set / has / forget / pull / flush / flash / regenerate / invalidate`。
- 只有修改过才写回；新会话没有数据时不设置 Cookie。
- 两种驱动：
  - `cookie`：数据用 AES-GCM 加密存在 Cookie 中，密钥通过 HKDF 从 APP_KEY 派生，与签名用途分开；超过约 3.8KB 时报错，提示改用服务端存储。
  - `memory` / 自定义 `SessionStore`：Cookie 中只保存签名的会话 ID；`regenerate` 时删除旧 ID。

**认证**
- `config/auth.ts`：`default`、`guards`（`jwt` / `session`）、`providers`（`UserProvider` 接口；`@think-h3/orm` 提供 `modelUserProvider(() => User, { username, password })`）。
- `ctx.auth`：`user / check / id / logout`、`guard(name)`，`jwt()` / `session()` 取得具体类型的 Guard；`auth:<guards>` 中间件通过后调用 `shouldUse()` 设置默认 Guard。
- JWT Guard（jose）：
  - 算法：HS*（密钥默认 APP_KEY）以及 RS / PS / ES / EdDSA（PEM 公私钥）；
  - 签发：`login(user, claims)` / `attempt(credentials)` 返回 `{ token, type, expiresIn, expiresAt }`；令牌中 sub 为用户 ID，并包含 jti、iss / aud；
  - 读取令牌：Authorization: Bearer，也可以配置从 Cookie 读取；`payload()` 返回声明；
  - 过期、篡改、格式错误都视为未登录；退出是无状态的（令牌在过期前仍有效，需要立即失效时在业务中维护黑名单）。
- Session Guard：`login` 时 regenerate 会话 ID，`logout` 时 invalidate；会话按需自动启动，不需要额外加 `session` 中间件。
- `Hash`：默认 scrypt（node:crypto），运行时没有 scrypt 时用 PBKDF2-SHA256（Web Crypto，600000 次迭代）；哈希串记录算法与参数，`needsRehash()` 用于升级参数。
- 类型：`AuthUser` 由 typegen 生成的 `config/auth.ts` 类型推导，模板中 `ctx.auth.user()` 的类型即为 `User`（已在脚手架项目中验证）。
- 测试：`@think-h3/testing` 的 `t.actingAs(user, guard?)` 基于 core 的 `issueTestCredentials()`，生成真实的令牌或会话 Cookie。
- 未做 `make:guard`：Guard 由配置驱动，自定义用户来源实现 `UserProvider` 接口即可，暂不支持自定义 Guard 驱动。

**模板**
- users 表新增 nullable 的 `password` 列（drizzle-kit 生成 `0001_add_user_password`），模型隐藏 password。
- 新增 `AuthController`（register / login / me）与 `validate/auth.ts`；`/api/auth/login` 加了 `throttle:10,60`。
- 全局中间件：api 模板为 cors、secureHeaders、compress；全栈模板为 secureHeaders、compress。
- 数据填充的管理员账号带上了密码；README 新增"认证与安全"一节。

**验证**
- core 新增两组测试：`middleware.test.ts`（11 个）和 `auth.test.ts`（24 个）。
  - 覆盖每个中间件、上传（valibot 校验、保存、413）、签名 Cookie；
  - 三种 Session 存储方式各跑一遍（含 flash、regenerate、伪造 Cookie）；
  - JWT（HS256 / ES256、过期、篡改、guest）、Session Guard、Hash。
- 模板：每个模板新增 3 个认证用例，其中包括 actingAs。
- workerd（Miniflare）：
  - vue 模板 + D1：注册 → 登录 → 用 Bearer 访问 `/me`（jose、scrypt 在 Workers 上可用）；
  - basic fixture：加密 Cookie Session 计数。
- Cloudflare 部署提示新增 `wrangler secret put APP_KEY`（Workers 没有 .env）。

**仍然存在的限制 / 后续**
- ~~限流与 memory Session 只在单进程内生效~~（M14：缓存存储共享）。
- `store()` 只写本地文件系统；S3 / R2 等存储计划在后续的 Storage 模块中提供。
- ~~没有 CSRF 中间件~~、~~授权~~（M13 已补）。

### M13 实施记录（2026-10-27）：授权与 CSRF

确认的决策：
- CSRF 只用 token（Laravel 方式，不做 Origin / Sec-Fetch-Site 检查）；
- `can:` 中间件支持按路由参数加载模型；
- 能力名由 typegen 生成类型；
- 模板加 UserPolicy 示例，全栈模板全局启用 csrf。

**Gate / Policy**
- 定义方式：
  - `definePolicy(Model, { before?, <ability>(user, model) })`：模型策略；
  - `defineAbilities({ name: (user, ...args) => ... })`：与模型无关的能力。
- 两者都放在 `app/policy/*.ts`，虚拟清单新增 `policies` 并自动注册到应用的单例 `Gate`；提供者里也可以 `app.make(Gate).define()` / `.policy()`。
- 能力函数的返回值：`true / false / undefined`，或 `allow()` / `deny(message)`，支持异步。
- 判断顺序：
  1. 全局 `Gate.before`；
  2. 策略的 `before`：返回非 undefined 时直接决定结果；
  3. 未登录用户默认拒绝，不调用能力函数（`allowGuest()` 包装后才调用）；
  4. 执行能力函数；
  5. 全局 `Gate.after` 只做观察。
- 查找策略：传入模型实例时沿原型链查找，子类沿用父类的策略；传入模型类时为类级能力（如 `create`），能力函数只收到 user。未知能力、策略中没有的能力会抛错，属于编程错误。
- 用法：
  - 请求中：`ctx.can` / `ctx.cannot` / `ctx.authorize`。`authorize` 未登录时抛 401，已登录但无权限时抛 403，消息取自 `deny()`。用户来自 `ctx.auth`；没有 `config/auth.ts` 时视为未登录。
  - 请求之外：`gate.forUser(user)`；`gate.inspect()` 返回 `{ allowed, message, guest }`。
- 类型：
  - typegen 读取 `app/policy` 生成 `GeneratedPolicies`；
  - `ModelAbility<M>` 按实例类型匹配策略，得到可用的能力名，`PlainAbility` 为 `defineAbilities` 中的能力名；
  - 没有生成类型时退回 string。
  - 能力函数的类型用方法签名声明，参数是双变的，因此可以直接把 user 标注为 `User`。
  - 已在脚手架项目中验证：拼错能力名、使用策略中没有的能力都会报类型错误。
- 中间件：
  - `can:<ability>`、`can:<ability>,<Model>`（按策略中的模型类名查找）；
  - `can:<ability>,<Model>,<param>`：调用模型的静态 `findOrFail(ctx.param(param))`，不存在时 404；实例存入 `ctx.get('<model>')`。
- 生成器：`make:policy`（stub 中包含 before / allowGuest / deny 的示例）。
- 命名：允许未登录的包装函数叫 `allowGuest()`，避免与 `guest` 中间件同名。

**CSRF（`csrf` 中间件）**
- token 存在会话的 `_csrf` 中（需要 APP_KEY），响应时同步一个不带 HttpOnly 的 `XSRF-TOKEN` Cookie，axios 会自动回传。
- 不安全方法须在 `X-CSRF-TOKEN` / `X-XSRF-TOKEN` 头，或 urlencoded / multipart 表单的 `_token` 字段中回传，用常量时间比较；失败返回 419（`CsrfTokenMismatchException`）。
- 以下请求不校验：
  - 安全方法；
  - 带 `Authorization: Bearer` 的请求（不依赖 Cookie 认证）；
  - `except` 中的路径（支持通配）；
  - 测试模式（与 Laravel 一致，`csrf.testing: true` 时也校验）。
- token 轮换：Session Guard 登录时更换 token；退出后会话被清空，响应时生成新 token。
- `ctx.csrfToken()` 用于服务端渲染表单。

**模板**
- users 新增 `role` 列（member / admin，drizzle-kit 生成 `0002_add_user_role`），新增 `UserPolicy`：管理员通过 before 放行，其他人只能修改 / 删除自己。
- `UserController.update/destroy` 调用 `ctx.authorize()`；模板测试改用 actingAs，并新增"本人 / 他人 403 / 未登录 401 / 管理员"的用例。
- 全栈模板：
  - 全局启用 `csrf`；
  - 新增 `GET /api/csrf-cookie`；
  - `src/api.ts` 在修改类请求前读取 XSRF-TOKEN，没有时先请求一次，然后带上 `X-XSRF-TOKEN`。

**连带修改**
- 全局 csrf 让每个请求都依赖 APP_KEY，因此做了以下调整：
  - 预览：aws-lambda、vercel、netlify 在进程内运行前从项目根目录加载 `.env`，与 `think-h3 start` 一致；
  - Cloudflare 预览：把 `.env` 中的变量作为绑定传入（与 wrangler dev 一致，wrangler.json 的 vars 优先）；
  - 预览启动的产物子进程不再继承框架自己从 `.env` 写入的变量，修复了多个项目先后预览时 APP_NAME 互相串用的问题；
  - Docker、Lambda、Vercel、Netlify 的部署提示加上了设置 APP_KEY 的方法。
- `AppConfig` 新增只读的 `mode`。

**验证**
- core 的 `gate.test.ts`（11 个）覆盖：
  - 策略的各种匹配方式（实例、子类、类级）、before、deny 消息、allowGuest、全局 before / after、未知能力；
  - ctx.can / authorize（401 / 403）、三种 can: 写法（含 404）、未配置认证时的行为；
  - CSRF：头、表单、multipart 三种回传方式，419，跨会话 token，Bearer / except / 测试模式跳过，登录后轮换。
- 产物用例：Docker、Cloudflare（D1、Turso）、8 个预设的预览都在 csrf 开启的情况下运行，均验证"不带 token 返回 419、带上后通过"。
- Cloudflare + D1 的用例同时验证了未登录不能删除用户（401）。

**后续**
- 授权目前只有全局策略，多应用的 `app/<name>/policy` 尚未支持。
- 策略中的能力不能接收除模型外的类型化参数（能接收，但类型为 any）。

### M14 实施记录（2026-10-27）：缓存与共享存储

确认的决策：
- 缓存放在 core 内置；
- Redis 客户端用 ioredis，Edge 上用 Upstash；
- 在 colima 中用 redis:7 与 serverless-redis-http（SRH）做真实验证；
- 顺带做原子锁、响应缓存中间件和 Cloudflare 限流绑定。

**设计**
- 没有用 unstorage：它没有原子自增和锁，各驱动对 TTL 的支持也不一致。改为自己实现一个小的 `CacheStore` 接口：
  - 读写类：`get / set(ttl) / add / delete`；
  - 原子类：`increment(key, by, ttl)` 返回新值与剩余秒数，`deleteIf(key, expected)` 用于持有者校验；
  - 清理：`clear(prefix)`；
  - `atomic` 标记驱动是否保证原子性。
- 值统一以字符串存储，序列化在上层完成；自增的计数与 JSON 数字兼容。
- 上层 `CacheRepository` 提供 `get(fallback) / many / has / set / setMany / add / forget / pull / remember / rememberForever / increment / decrement / flush / lock / restoreLock`，TTL 可写成 `'10m'`。
- 值以 JSON 序列化，Date 读回为字符串。
- `CacheManager` 是应用单例，可以注入；没有 `config/cache.ts` 时默认使用内存缓存，键前缀默认为 `think:`。
- 门面 `Cache` 在请求内从请求容器取管理器，请求外取最近启动的应用。

| 驱动 | 实现要点 |
|------|----------|
| memory | Map，热更新后保留，惰性清理过期项 |
| redis（ioredis 6） | 自增用 Lua 脚本，一次完成 INCRBY 与首次 EXPIRE；`deleteIf` 也是 Lua；`clear` 用 SCAN + DEL；连接跨热更新复用，应用关闭时 quit |
| upstash | 关闭 `automaticDeserialization`，与 redis 驱动共用同一组 Lua 脚本 |
| kv | 绑定名默认 `CACHE`；KV 的 TTL 最短 60 秒，更短的有效期记录在元数据的 expiresAt 中；add / increment / deleteIf 是先读后写（非原子）；`clear` 用 list 分页删除 |

- 依赖：ioredis 与 @upstash/redis 是 core 的可选 peer 依赖，按固定包名导入。构建时它们被列入驱动包：
  - ioredis 在 Workers 上替换为报错空模块（TCP 长连接不可用）；
  - Node 类产物按需追踪进产物。

**锁**
- `Lock`：`add` 获取（相当于 SET NX EX），持有者标识为随机值，`release` 只删除自己持有的锁。
- 其他方法：`block(wait)` 轮询等待，`run(fn, wait?)` 拿到锁后执行并在结束时释放，拿不到时抛 `LockTimeoutException`。
- 非原子驱动（KV）直接拒绝创建锁。

**限流与 Session 的共享存储**
- `throttle.store` 可以写缓存存储名（`'redis'`），由 `cacheRateLimitStore` 用原子自增和剩余 TTL 计算固定窗口。用非原子驱动时只警告一次（结果为近似值）。
- 限流规则支持 `binding`，使用 Cloudflare Workers Rate Limiting（`limit({ key })`）：超限返回 429，`Retry-After` 取 window。本地没有绑定时回退到 store 计数。
- Session 新增 `driver: 'cache'` 与 `store`，键为 `session:<id>`，即 `cacheSessionStore`。

**响应缓存（`cacheResponse:<ttl>[,user]`）**
- 只缓存 GET / HEAD 的 200 响应，按路径与查询参数区分，`user` 时再按用户区分。
- 跳过 `no-store` / `private` 的响应；缓存副本不含 Set-Cookie。
- 命中时直接返回，带 `X-Cache: HIT` 与 `Age`；未命中时在 onResponse 中写入缓存，响应带 `X-Cache: MISS`。
- 它是路由中间件，钩子先于全局的 compress 执行，因此缓存的是未压缩的内容，命中后仍会按客户端压缩。

**模板**
- 新增 `config/cache.ts`：`CACHE_STORE`、`CACHE_PREFIX`、`REDIS_URL`，注释中给出 upstash / kv 示例。
- 新增 `config/throttle.ts`：store 跟随 `CACHE_STORE`，注释中给出 Workers 限流绑定的示例。
- README 新增"缓存"一节。

**验证**
- `cache.test.ts`：同一套 11 个行为用例分别在 memory、KV（Miniflare）、真实 Redis 7（colima）、Upstash REST（SRH 代理到同一个 Redis）上运行：
  - 基本读写、过期、remember / add / many；
  - 自增与 TTL 只在创建时设置；50 次并发自增；
  - 只清理自己前缀；锁（持有者释放、run、block）；
  - Session 与限流走缓存；cacheResponse。
- 另有 3 个接入用例：默认内存缓存、按用户的响应缓存、Cloudflare 限流绑定及其回退。
- workerd：KV 缓存的自增与 remember 在 Worker 中运行，并直接读取 KV 校验写入的值。
- 多实例端到端：api 模板的 node 产物拷到项目之外，用同一个 Redis 启动两个实例轮流请求带 `throttle:10,60` 的登录接口，第 11 次返回 429。同时验证了 ioredis 被追踪进 `dist/node_modules`。
- Redis / Upstash 用例按 `THINK_TEST_REDIS_URL`、`THINK_TEST_UPSTASH_URL`、`THINK_TEST_UPSTASH_TOKEN` 启用。验证结束后容器、镜像与 Docker 网络已删除，colima 已停止。

**限制**
- KV 非原子、最终一致，不适合精确计数与锁（构建与运行时都有提示）。
- 没有缓存标签（tags）与防击穿：`remember` 并发未命中时会重复计算，可以配合 `lock` 使用。

### M15 实施记录（2026-10-27）：队列与定时任务

确认的决策：
- Redis 队列基于 BullMQ，cron 用 croner；
- Cloudflare Queues + Cron Triggers、Lambda 定时入口、Vercel Cron 都做；
- 用 colima 中的 redis:7 做真实验证。

**和方案不一致的地方**：Lambda 只提供 `index.schedule`，没有做 `index.queue`。消费 SQS 需要另写一个基于 AWS SDK 的 SQS 投递驱动，否则这个入口无任务可消费。Lambda 上的队列请用 redis 驱动加独立的 worker 进程。

**任务与投递**
- `app/job/*.ts`：`defineJob({ name?, tries, backoff, timeout, queue, connection, handle(payload, job), failed(payload, error, job) })`。
  - 自动发现，文件名即任务名；
  - `job` 上下文包含 `id / attempt / queue / logger / app / signal`，超时时 signal 会中止。
- 投递：`Job.dispatch(payload, { delay, queue, connection })`，或 `Queue.dispatch('Name', payload)`；payload 以 JSON 传递。
- `backoff` 的写法：秒数、`'5m'`、按重试次数取的数组（不足取最后一个），或 `'exponential'`（2^n 秒）。
- `QueueManager.process(message, attempt)` 统一执行：成功返回 ok；还有次数时返回 retry 与退避秒数；最后一次失败时调用 `failed()` 并返回 failed。各驱动只负责把结果映射到自己的重试机制。

| 驱动 | 实现 |
|------|------|
| sync | 投递时立即执行，失败直接抛给调用方（不重试） |
| memory | 进程内队列，第一次使用即在本进程消费（`concurrency` 可配）；计时器处理延迟与退避；失败任务保存在内存中；`Queue.idle()` 等待清空，测试中使用 |
| redis | BullMQ：attempts 等于 tries，自定义 backoffStrategy 按任务定义计算；`removeOnFail: false` 保留失败任务，`queue:retry` 重试时重置已执行次数；Worker 使用 `maxRetriesPerRequest: null`；应用关闭时关闭 Queue / Worker |
| cloudflare | 投递到 Queues 绑定（延迟上限 12h）；Worker 导出的 `queue()` 调用 `handleBatch`：成功 ack，可重试时 `retry({ delaySeconds })`，最终失败调用 `failed()` 后 ack |

- 失败任务：`QueueManager.failed / retry / forget / flush`。
- 测试：`Queue.fake()` 提供 `assertDispatched(job, predicate?)`、`assertNotDispatched`、`assertCount`，`drain()` 按顺序执行已记录的任务。
- bullmq 是 core 的可选 peer 依赖，纳入驱动包处理（Workers 上替换为报错空模块，Node 类产物追踪进产物）；msgpackr-extract 的安装脚本设为不执行，使用预编译二进制。

**定时任务**
- `schedule/*.ts`：`defineSchedule(s => ...)`。
- 定义方式：`s.call(name, fn)` / `s.cron(expr, name, fn)` / `s.job(Job, payload, options)`（到期时投递，任务名为 `job:<Name>`）。
- 频率：`everyMinute … everyThirtyMinutes / hourly / hourlyAt / daily / dailyAt / twiceDaily / weekly / weeklyOn / monthly / monthlyOn / at / weekdays / weekends / cron()`。
- 其它选项：`timezone()`（默认 `config/schedule.ts` 的 timezone，否则 UTC）、`when / skip`、`onSuccess / onFailure`。
- 到期判断用 croner 的 `match()`，按分钟取整；`nextRun()` 用于 `schedule:list`。
- 锁基于 `Cache.lock`，要求原子缓存存储，用 KV 时直接报错：
  - `onOneServer`：按"任务 + 分钟"加锁，不主动释放，1 小时后过期；
  - `withoutOverlapping`：执行期间持有锁，结束后释放，ttl 默认 24h。
- `Scheduler.runDue(date)` 返回每个任务的 `{ status: ok | failed | skipped, reason: filter | overlapping | other-server }`；`work(signal)` 在每分钟整点执行。

**命令与生产入口**
- CLI：`queue:work [--queue a,b] [--concurrency n] [--connection]`、`queue:failed / retry / forget / flush`、`schedule:list / run / work`。
  - 在开发服务器的模块图中运行；`queue:work` 每条消息从最新的应用取任务定义，`schedule:work` 每分钟换用最新的应用，代码修改后无需重启。
- `make:job` 生成器。
- node / bun / deno / docker 产物输出 `worker.mjs`：`queue [--queue] [--concurrency] [--connection]`、`schedule`、`schedule:run`；收到 SIGTERM 后等待执行中的任务完成。
- cloudflare：Worker 导出 `queue()` 与 `scheduled()`；有 `schedule/*.ts` 时 wrangler.json 自动加 `triggers.crons: ['* * * * *']`。
- aws-lambda：导出 `schedule(event)`，按 `event.time` 执行到期任务。
- vercel：函数拦截 `/__think/schedule`，要求 `Authorization: Bearer $CRON_SECRET`；config.json 增加路由与 `crons`，频率可用 `think.config.ts` 的 `vercel.cron` 调整，Hobby 计划只允许每天一次。

**顺带修复**
- 后端源码目录就是项目根时（api 模板），`normalizePath('')` 返回 `'.'`，导致内嵌迁移的路径被多截掉字符，`migrate.mjs` 找不到迁移（M10 遗留，M10 只用 vue 模板验证过）。已修复，并补了 api 模板的回归用例。

**模板**
- `config/queue.ts`：`QUEUE_CONNECTION` 切换连接，默认 memory。
- `app/job/SendWelcomeEmail.ts`：注册后投递，只写日志。
- `schedule/app.ts`：每天 03:00 执行、带 onOneServer 的示例。
- 认证测试用 `Queue.fake()` 断言注册后投递了任务。
- `package.json` 增加 `queue`、`schedule` 脚本；README 新增"队列与定时任务"一节。

**验证**
- `queue.test.ts`（9 个）：
  - memory：按文件名注册、重试与 failed()、失败任务的重试 / 删除 / 清空、退避与延迟的实际耗时、超时与中止信号；
  - sync：失败时抛出；
  - fake 的各项断言与 drain；
  - 真实 Redis（BullMQ）：两个应用各起一个 Worker（并发 3）消费 30 个任务，每个只执行一次；重试与退避、失败保留、重试失败任务、延迟任务、多个队列。
- `schedule.test.ts`（9 个）：表达式构造、按时区判断到期、过滤 / 投递 / 失败钩子、withoutOverlapping、onOneServer（同进程共用内存缓存，以及 3 个实例共用真实 Redis 时只执行一次）、非原子存储报错、work 中止。
- workerd：Cloudflare Queues 的真实生产者与消费者（第一次失败后经 `message.retry()` 在第二次成功）、`scheduled()` 写入 KV。
- Vercel Cron 的 401 / 200 与 config.json，Lambda `index.schedule` 的到期判断。
- 产物端到端（真实 Redis）：api 模板产物拷到项目外，执行 `migrate.mjs`，启动 web 进程；注册用户后，独立的 `worker.mjs queue` 进程输出欢迎邮件日志；`worker.mjs schedule:run` 正常退出。bullmq 已追踪进 `dist/node_modules`。
- Redis 用例按 `THINK_TEST_REDIS_URL` 启用；验证后已删除容器与镜像，colima 已停止。

**限制**
- memory 队列只在本进程内，进程退出时任务丢失。
- Vercel / Lambda 的定时触发频率受平台限制；`runDue` 只执行当前这一分钟到期的任务，触发间隔大于 1 分钟时，其余分钟的任务会被跳过。
- 没有任务批处理（batch）与任务链（chain）。

### M16 实施记录（2026-10-27）：事件与 WebSocket

确认的决策：
- 事件用 `defineEvent` 常量定义；
- Cloudflare 上用 Durable Objects；
- 多实例广播本次用 Redis 实现（在 colima 中用 redis:7 验证）。

**事件**
- 定义：
  - `app/event/*.ts`：`defineEvent<P>({ name? })`，文件名即事件名，`Event.emit(payload)` 触发；
  - `app/listener/*.ts`：`defineListener(event | events[], handler(payload, ctx), { queue? })`，监听多个事件时 payload 为联合类型。
- 执行：
  - 同步监听器按文件名顺序执行（与拦截器一致），抛错会传给触发方，返回 `false` 时不再执行后续监听器；
  - 排队监听器在启动时注册为队列任务 `listener:<名字>`，复用队列的 tries / backoff / timeout / queue / connection 与 `delay`，payload 为 `{ event, payload }` 的 JSON。
- `EventManager` 为应用单例，`on()` 用于运行时注册。
- 门面命名为 `Events`，避免与全局的 `Event` 类型重名：`Events.emit / on / fake / restore`。
- `Events.fake(events?)` 提供 `assertEmitted / assertNotEmitted / assertEmittedTimes`；传入事件时只 fake 这些事件，其余照常执行。
- 生成器：`make:event`、`make:listener`。

**WebSocket（h3 + crossws 0.4）**
- 定义：`r.ws(path, handler)` 注册为 GET 路由，钩子 `upgrade / open / message / close / error` 的最后一个参数为升级请求的 ctx，也可以用 `defineWebSocket()` 单独定义。
- 鉴权：升级请求经过全局与路由中间件，`auth` 等中间件拒绝时以该响应（如 401）拒绝升级。普通 GET 得到 426。
- 钩子挂在请求对象上（`kWebSocketHooks`），中间件重建响应也不会丢失。`resolveHooks(fetch)` 与 crossws 的默认解析一致：调用应用的 fetch，非 101 / 426 的响应拒绝升级。
- 各运行时的接入：

| 环境 | 实现 |
|------|------|
| node 产物 / 纯后端开发服务器 | srvx 插件：监听 http 服务器的 `upgrade` 事件，交给 crossws 的 Node 适配器；开发时 fetch 指向热替换后的最新应用 |
| bun / deno 产物 | srvx 插件：Bun 设置 `bun.websocket`，Deno 由中间件处理升级 |
| Vite 全栈开发 | 在 Vite 的 httpServer 上处理后端前缀下的升级请求，排除 `vite-hmr` 协议 |
| `vite preview` / `think-h3 preview`（进程型预设） | 把升级请求按原始 TCP 字节转发给产物进程 |
| cloudflare | 新增 `@think-h3/core/cloudflare` 子路径的 `createWebSocketDurableObject()`；入口导出 `ThinkWebSocket`，Worker 的 fetch 把升级请求交给 DO，钩子在 DO 内经应用解析；wrangler.json 增加 `durable_objects` 与 SQLite DO 的迁移；路由中出现 `.ws(` 时生成，也可用 `cloudflare.websocket` 强制开关；Cloudflare 预览会读取 DO 绑定 |
| vercel / netlify / aws-lambda | 平台不支持，升级请求返回 426 |

- Node 适配器按需动态导入：crossws 内置的 ws 库在模块顶层调用 `createRequire(import.meta.url)`，在 Workers 中会导致启动失败（已在 workerd 中复现）。
- `Socket.publish(topic, data)`：发给进程内已注册的所有 crossws 适配器（`globalStore`，因此开发服务器与应用代码中的两个 core 实例共用）；`Socket.connections()` 返回连接数。
- 多实例：`config/websocket.ts` 的 `broadcast: { driver: 'redis', url, channel }` 使用 crossws 自带的 Redis 同步（`crossws/sync` 的 `redis`），ioredis 延迟加载。Cloudflare 上 `Socket.publish` 经 crossws 的 RPC（`webSocketPublish`）进入 DO。

**模板**
- `app/event/UserRegistered.ts`；`AuthController.register` 改为触发该事件。
- 监听器：`QueueWelcomeEmail`（投递欢迎邮件任务）、`BroadcastRegistration`（推送 `users` 主题）。
- `route/ws.ts`（`/api/ws`：连接后订阅 users，`ping` 回复 `pong`）。
- `config/websocket.ts`（`WS_BROADCAST=redis`）。
- 认证测试新增"注册触发事件"（4 个认证用例）。

**验证**
- core：
  - `events.test.ts`（5 个）：顺序执行与排队执行、返回 false 停止、运行时注册与错误传递、fake 的各项断言、非法模块；
  - `websocket.test.ts`（4 个）：回显与 `peer.publish`、HTTP 接口中调用 `Socket.publish`、426 与 auth 拒绝 / 带令牌通过；
  - 真实 Redis 跨实例：两个应用分别接一个连接，`peer.publish` 与 `Socket.publish` 双向到达。
- vite `websocket.test.ts`（3 个）：
  - 开发服务器回显、热替换后的新连接使用新代码、应用代码中的 `Socket.publish`；
  - node 产物；
  - workerd 中的 Durable Object：两个连接，Worker 中 HTTP 接口的广播经 RPC 到达。
- create：React 模板经 Vite 全栈开发服务器连接 `/api/ws`；vue 模板的 node / bun / docker / deno 预览经转发连接成功。
- 验证结束后 Redis 容器与镜像已删除，colima 已停止。

**限制**
- 已建立的连接在热替换后仍使用旧的钩子，需重新连接才会使用新代码。
- 升级完成后请求级容器即被释放：长连接中使用的数据需在 `open` 时读取并保存。
- Cloudflare 预览（Miniflare）不转发 WebSocket，请用 `wrangler dev`；所有连接集中在同一个 DO 中，连接数很大时需要按房间拆分 DO（`resolveDurableStub`）。
- 排队监听器的 payload 经 JSON 序列化，模型实例会变成普通对象。

