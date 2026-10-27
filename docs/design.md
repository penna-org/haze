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
