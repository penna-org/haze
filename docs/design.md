# hazejs 框架设计与实现方案

> 状态：草案 v0.1（2026-10-26）
> 框架名 hazejs，命令 `haze`，包名 `@hazejs/*`（2026-10-28 由 think-h3 更名，见文末记录）。

---

## 1. 目标与定位

做一套**基于 h3 v2 的、约定优于配置的 Node 服务端框架**，设计思路参考 ThinkPHP（容器、服务提供者、中间件、集中路由、统一异常处理、分层目录），但用 TypeScript + Vite 生态来实现。

核心诉求：

| # | 诉求 | 方案要点 |
|---|------|----------|
| 1 | 脚手架一条命令启动项目 | `haze dev / build / start / test / make:*`，`create-hazejs` 初始化项目 |
| 2 | 热更新，不重启进程 | Vite Environment API + ModuleRunner 重新加载应用，**外层 HTTP 监听不变，只热替换 fetch handler** |
| 3 | 依赖注入 | 自研轻量 IoC 容器，`inject()` 函数式注入，支持 singleton / request / transient 三种作用域 |
| 4 | 中间件 | 全局 / 分组 / 路由 / 别名中间件，类中间件可注入依赖，底层映射到 h3 的 `(event, next)` |
| 5 | 集中错误处理 | `HttpException` 体系 + `app/exception/Handler.ts`（report / render），统一响应格式 |
| 6 | 路由统一管理 | `route/*.ts` 集中定义，支持 group / resource / 中间件 / 校验 / 命名路由，`route:list` 查看 |
| 7 | 分层 | Controller → Service → Repository/Model，DTO/Validate、Provider、Event/Listener |
| 8 | 集成 Vitest | `@hazejs/testing`：`createTestApp()` 免监听端口测试，支持替换容器绑定 |
| 9 | 作为 Vite 插件服务 Vue 项目 | `@hazejs/vite`：开发时挂到 Vite dev server 的 `/api/**`，构建时同时产出 client + server |

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
│  route/  config/  tests/  .env  haze.config.ts                │
└──────────────┬───────────────────────────────┬─────────────────┘
               │ haze dev/build/test       │ vite.config.ts 中 haze()
┌──────────────▼──────────────┐  ┌─────────────▼──────────────────┐
│ @hazejs/cli               │  │ @hazejs/vite                 │
│ citty 命令 / make:* 生成器   │──▶ Vite 插件：虚拟模块、dev 挂载、 │
│ route:list / typegen        │  │ 热替换 runner、client+server 构建│
└──────────────┬──────────────┘  └─────────────┬──────────────────┘
               │                               │
┌──────────────▼───────────────────────────────▼─────────────────┐
│ @hazejs/core                                                  │
│  Application(生命周期) · Container(DI) · Config/Env             │
│  Router(集中路由→h3) · Middleware 管线 · HttpContext            │
│  Exception(Handler/HttpException) · Validation · Event · Logger │
└──────────────┬──────────────────────────────────────────────────┘
               │
┌──────────────▼──────────────┐      ┌─────────────────────────────┐
│ h3 v2 (H3 / HTTPError /     │      │ @hazejs/testing (vitest)   │
│ utils / serve via srvx)     │      │ createTestApp / 容器 override │
└─────────────────────────────┘      └─────────────────────────────┘
```

### 3.1 框架仓库（monorepo）结构

```
hazejs/
├─ packages/
│  ├─ core/            # @hazejs/core       运行时内核
│  ├─ vite/            # @hazejs/vite       Vite 插件 + dev 运行时
│  ├─ cli/             # @hazejs/cli        bin: hazejs
│  ├─ testing/         # @hazejs/testing    vitest 集成
│  └─ create/          # create-hazejs      项目初始化
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
└─ haze.config.ts       # 框架/工具链配置（目录、端口、前缀等）
```

全栈 Vue 项目时，后端整体放在 `server/` 下（`server/app`、`server/route`、`server/config`），前端仍是标准 Vue 项目 `src/`。

### 3.3 ThinkPHP 概念映射

| ThinkPHP | hazejs | 说明 |
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
| 命令行 `php think make:controller` | `haze make:controller` | 见 §9 |

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
import { inject, Scope } from '@hazejs/core'
import { UserRepository } from '../repository/UserRepository'
import { Logger } from '@hazejs/core'

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

实现上挂在 `globalThis.__HAZE_PERSIST__`（同一进程内跨重载存活），仅在真正退出或配置变更时销毁。

---

## 5. 路由设计（集中管理）

### 5.1 路由文件

```ts
// route/api.ts
import { defineRoutes } from '@hazejs/core'
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

好处：路由表是数据，因此可以 `haze route:list` 打印、生成 OpenAPI、生成前端类型安全的 API 客户端。

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
// virtual:haze/manifest（插件生成）
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

基于 unjs 生态：`citty`（命令）、`consola`（输出）、`c12`（加载 `haze.config.ts`）、`giget`（拉模板）。

| 命令 | 作用 |
|------|------|
| `pnpm create hazejs my-app` | 交互选择模板（api / fullstack-vue）、包管理器、是否带 ORM |
| `haze dev` | 启动开发服务器，热替换 |
| `haze build` | 产出 `dist/server/index.mjs`（全栈时另有 `dist/client`） |
| `haze start` | 运行生产产物（等同 `node dist/server/index.mjs`） |
| `haze test` | 调用 vitest（自动注入框架配置） |
| `haze make:controller User --resource` | 生成器：controller/service/middleware/provider/validate/exception |
| `haze route:list` | 表格打印路由、方法、中间件、处理器 |
| `haze typegen` | 生成 `.haze/types`：config 键、路由名、中间件别名的类型 |

### 9.1 `dev` 热更新实现（核心）

```ts
// @hazejs/vite 内部 dev 运行时（示意）
const vite = await createServer({
  configFile: false,
  root,
  appType: 'custom',
  server: { middlewareMode: true },
  plugins: [haze(options)],
})
const env = vite.environments.ssr                 // RunnableDevEnvironment

let current: HazeApp | undefined
async function load() {
  const { createApplication } = await env.runner.import('virtual:haze/entry')
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
- 只有 `.env`、`haze.config.ts` 变更时才重建 Vite 实例（仍不需要手动重启）；
- 后续可以做“细粒度 HMR”：仅路由文件变化时只重建 Router，不重建容器。

### 9.2 `build`

使用 Vite 的 `builder.buildApp()`（Environment API）：

- `ssr`（server）环境：入口为 `virtual:haze/server-entry`，生成 `dist/server/index.mjs`，内含 `createApplication + serve + 优雅停机`；
- `client` 环境（全栈模式）：Vue 正常构建到 `dist/client`，server 端用 h3 `serveStatic` 托管并做 SPA fallback；
- 依赖默认 external（保留 `node_modules`），可配置全量打包以便 Docker 精简镜像。

---

## 10. 作为 Vite 插件服务 Vue 项目

```ts
// vite.config.ts（Vue 项目）
import vue from '@vitejs/plugin-vue'
import { haze } from '@hazejs/vite'

export default defineConfig({
  plugins: [
    vue(),
    haze({ root: 'server', prefix: '/api' }),
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
import { defineHazeTestConfig } from '@hazejs/testing/config'
export default defineHazeTestConfig()   // 自动加 haze 插件，node 环境

// tests/user.test.ts
import { createTestApp } from '@hazejs/testing'

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
| **M2 工具链**（~2 周） | Vite 插件（虚拟模块）、dev 热替换 runner、build/start、CLI 基础命令、`definePersistent` | `haze dev` 改控制器/服务/路由即时生效，进程不重启 |
| **M3 Vue 集成 + 脚手架**（~1.5 周） | dev 挂载 `/api/**`、client+server 构建、`create-hazejs` 两个模板、`@hazejs/testing` | 一个命令创建并启动全栈项目 |
| **M4 体验增强**（持续） | 校验（Standard Schema）、Logger、make:* 生成器、route:list、typegen、错误页 | 文档站（VitePress） |
| **M5 生态** | ORM provider（drizzle 优先）、缓存（unstorage）、Session/Auth、事件、队列/定时任务、OpenAPI、前端类型安全 API 客户端 | 按业务需要排期 |

### 主要风险与对策

| 风险 | 对策 |
|------|------|
| HMR 后旧定时器/连接泄漏 | Provider `shutdown` + `dispose({reason:'hmr'})`；资源统一走 `definePersistent`；开发模式下检测未清理的 interval 并警告 |
| 装饰器/元数据兼容性 | 核心不依赖装饰器，`inject()` 为主；装饰器做可选插件 |
| ALS 性能开销 | Node 22 下 ALS 开销已很低；仅在请求入口 `run` 一次 |
| h3 v2 API 变化 | 通过 `@hazejs/core` 内部适配层隔离，用户代码不直接依赖 h3 内部 |
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

已完成 `@hazejs/core` 运行时内核与 playground，56 个测试通过。与原方案相比的调整与默认值：

| 项 | 结论 |
|----|------|
| 统一响应格式 | 默认开启 `{ code: 0, message: 'ok', data }`；错误为 `{ code, message, data: null, errors? }`，HTTP 状态码保持真实值；`BusinessException` 默认 HTTP 200 + 业务码 |
| TypeScript | 固定 `~6.0.3`。TS 7（Go 原生版）不提供经典 JS API，tsdown 生成 d.ts 与后续 vue-tsc / Volar 都依赖该 API |
| `@types/node` | 使用 `^24`。`@types/node@22` 依赖的 `undici-types@6.21.0` 被 pnpm 的 `trustPolicy: no-downgrade` 拦截（无 provenance），未放宽该策略；运行时下限仍为 Node 22.12 |
| 配置文件 | 读取环境变量的配置须用函数形式 `defineConfig(() => ({ ... }))`，保证在 `.env` 加载后求值 |
| 资源路由校验 | 新增 `resource(...).validateMember(schemas)`，统一校验成员路由的 `:id` |
| ESLint | 包代码要求显式返回类型；playground / 测试关闭该规则（业务代码依赖返回类型推导，为后续类型安全 API 客户端做准备） |
| 其余待确认项 | ORM、多应用模式、部署目标、发布仓库：M1 不涉及，仍待定 |

下一步：M2（Vite 插件虚拟模块 `virtual:haze/manifest`、dev 热替换 runner、CLI `dev / build / start`）。

### M2（2026-10-26）

新增 `@hazejs/vite` 与 `@hazejs/cli`，65 个测试通过（含真实文件修改的热更新集成测试）。实测 playground：启动约 170ms，修改服务文件后 10–15ms 生效，PID 与端口不变。

**虚拟模块**

| 模块 | 内容 |
|------|------|
| `virtual:haze/manifest` | `import.meta.glob` 发现 `config/*`、`route/*`、`app/provider/*`、`app/exception/Handler` |
| `virtual:haze/app` | `createApp(options)`，dev / build / vitest 共用（类型：`@hazejs/vite/client`） |
| `virtual:haze/server-entry` | 生产入口：`createApp({ mode: 'production' }).serve()` |

**热替换机制要点**（实现于 `packages/vite/src/dev.ts`）

- 外层 srvx 监听只创建一次，`fetch` 转发给当前应用；变化时 `runner.clearCache()` + 重新 import `virtual:haze/app` 并 boot，成功后原子替换。
- 触发点用插件的 `hotUpdate` 钩子（ssr 环境），而不是直接监听 watcher：Vite 的模块失效是异步的，`hotUpdate` 保证在失效之后执行。
- `server.hmr` 必须保持开启（`hmr: false` 会跳过 `hotUpdate`），用 `server.ws: false` 关闭 WebSocket 端口。
- `envDir: false`：否则 Vite 在 `.env` 变化时会重启整个开发服务器；`.env` 由框架在每次 boot 时重新加载。**M3 的 Vue 模式需要重新评估**（前端需要 `VITE_*` 变量）。
- 旧应用等在途请求结束后才 `dispose({ reason: 'hmr' })`；重载串行执行并防抖。
- 失败策略：重载失败保留旧版本继续服务并打印错误（带 source map 定位）；首次启动失败则所有请求返回 500 错误详情，修复后自动恢复。
- 新增 / 删除文件时主动失效 manifest 模块，使 glob 重新计算。

**其它**

- `haze.config.ts`（可选）：`srcDir`、`port`、`host`、`outDir`、`vite`。
- 生产构建依赖保持 external；monorepo 内 `@hazejs/core` 为链接包，会被打进产物（真实安装时不会）。
- srvx 默认的信号处理已关闭（`gracefulShutdown: false`），由 `Application.serve()` / CLI 统一执行停机流程。
- 当前每次变化都重新执行全部应用代码（毫秒级）；细粒度 HMR（只重建路由等）暂无必要。

下一步：M3（Vue 项目集成：dev 挂载 `/api/**`、client + server 一次构建、`create-hazejs` 模板、`@hazejs/testing`）。

### M3（2026-10-26）

新增 `@hazejs/testing` 与 `create-hazejs`，`haze()` 支持 Vue 全栈模式；77 个测试通过（含模板端到端：生成 → 类型检查 → 模板自带测试 → dev 热更新 → 构建 → 生产运行）。并用真实 CLI + 浏览器验证了 Vue 模板的开发与生产流程。

**Vue 全栈模式**（`vite.config.ts` 中 `plugins: [vue(), haze()]`）

- 开发：插件在 Vite 内置中间件之前挂载 `/api/**`（`prefix` 可配），经 srvx `toNodeHandler` 交给热替换的应用；前后端同端口，无需代理。后端文件变化走 `hotUpdate`（ssr 环境）整体重载，前端 HMR 不受影响。
- `.env`：全栈模式保留 Vite 的 `envDir`（前端需要 `VITE_*`），`.env` 变化时 Vite 自行重启，插件通过包装 `server.close()` 释放旧应用，实测新值立即生效。纯后端模式仍为 `envDir: false`。
- 构建：插件配置 `builder.buildApp`，`vite build` 依次构建 `client → dist/client`、`ssr → dist/server`；生产入口通过 core 新增的 `static` 选项托管 `dist/client`（`/assets/` 长期缓存、HTML 请求回退 index.html、`/api` 排除在外返回 JSON 404）。
- `srcDir` / `outDir` 统一从 `haze.config.ts` 读取，`vite.config.ts` 与 `hazejs` 命令共用。
- `haze dev / build` 检测到 `vite.config.*` 时交给用户的 Vite 配置；`start` 自动查找 `dist/index.mjs` 或 `dist/server/index.mjs`。

**@hazejs/testing**

- `useTestApp(options)`：每个用例前创建全新应用、用例后释放；`createTestApp()` 手动管理。
- 客户端：`get / post / put / patch / delete` 自动 JSON 编解码，`withHeaders()` 派生带默认头的客户端；`override: c => c.instance(...)` 替换绑定。
- `defineHazeTestConfig()`：注册 `haze({ standalone: true })` 并内联 `@hazejs/testing`（它需要导入 `virtual:haze/app`）。

**create-hazejs**

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

- 生成 `.haze/types/haze.d.ts`：`GeneratedConfig`（`typeof import('config/x').default`，仅依赖文件列表）与 `RouteNames`（路由名 → 路径参数）。dev 每次成功重载后写入（内容不变不写），`haze typegen` 手动执行，`haze.config.ts` 中 `typegen: false` 可关闭。
- `GeneratedConfig` 与手写的 `ConfigSchema` 在类型层深合并（直接扩充 `ConfigSchema` 会与内置 `app: AppConfig` 冲突）。
- 生成后配置键变为严格模式：未知键报错，读取任意键需传默认值 `config.get('x', fallback)`；`router.url()` 校验路由名与必填参数。通过“带 / 去掉 `@ts-expect-error` 各跑一次 tsc”验证类型确实生效。

**make:* 生成器**

- `make:controller [--resource] / service / repository / middleware / provider / validate / test / config / route`，名称支持子目录（`admin/User`）并自动去除重复后缀；`config`、`route` 只按第一层自动发现，带子目录时报错。
- stub 为 CLI 包内的 `.stub` 文件；项目 `stubs/<name>.stub` 优先（`haze stub:publish` 导出）；仅安装 zod 时 `make:validate` 使用 zod 版本。
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
| M7 | `@hazejs/orm`：drizzle 之上的 Db + Model（MySQL / PostgreSQL / SQLite），迁移与 make:model |
| M8 | MongoDB 适配器 |
| M9 | 部署预设：`haze build --preset node|bun|deno|cloudflare|vercel|netlify|aws-lambda|docker` |
| M10 | 补齐 M9 的已知限制：生产迁移入口、Cloudflare D1 / Turso HTTP 驱动 |
| M11 | 参考 Nitro：依赖追踪进产物（nf3）、`vite preview` / `haze preview` 运行产物、React 模板与多框架验证 |
| M12 | 内置中间件（CORS、限流、安全头、压缩、请求体上限）、文件上传、Cookie / Session、认证（JWT / Session Guard） |
| M13 | 授权（Gate / Policy、ctx.can / authorize、can: 中间件）与 CSRF 同步令牌 |
| M14 | 缓存（memory / redis / upstash / kv）、原子锁、响应缓存，限流与 Session 的共享存储，Cloudflare 限流绑定 |
| M15 | 队列（sync / memory / redis(BullMQ) / Cloudflare Queues，重试、延迟、超时、失败任务）与定时任务（croner，onOneServer / withoutOverlapping） |
| M16 | 事件 / 监听器（同步与排队）、WebSocket（crossws：开发热替换、各运行时、Redis 多实例广播、Cloudflare Durable Object） |
| M17 | Socket.IO 兼容：`@hazejs/socket.io`（官方 socket.io 服务端，Node / Bun，Guard 鉴权，redis-adapter） |
| M18 | 文件存储（local / s3 / r2 / memory 磁盘，签名临时链接，UploadedFile.store 接入）与邮件（log / array / smtp / resend / postmark / mailgun / ses，排队发送） |

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

新增 `@hazejs/orm`，150 个测试通过；同一套 ORM 用例（17 个场景）在 SQLite（libsql）、PostgreSQL（PGlite）与 MySQL 8.4.13（Docker）上全部通过。MySQL 用例只在设置 `HAZE_TEST_MYSQL_URL` 时执行：

```bash
docker run -d --name hazejs-mysql -e MYSQL_ROOT_PASSWORD=haze -e MYSQL_DATABASE=haze_test -p 3307:3306 mysql:8
HAZE_TEST_MYSQL_URL='mysql://root:haze@127.0.0.1:3307/haze_test' pnpm vitest run --project orm
```

尚未覆盖：MySQL / PostgreSQL 下的 `db:generate` / `db:migrate` 命令流程（模板端到端测试只覆盖 SQLite）。

**Db 查询构造器**（`Db.table(users)`）：`where`（列/值、运算符、对象、drizzle 表达式、分组回调）、`orWhere`、`whereIn / whereNull / whereBetween / whereLike`、`when`、`order / limit / page / field`、`select / find / findOrFail / value / column`、`count / sum / avg / max / min / exists`、`paginate`、`chunk`、`insert`（返回完整行，MySQL 通过 `$returningId()` 回查）、`insertGetId`、`update / delete`（返回影响行数，无条件写入需显式 `{ all: true }`）、`increment / decrement`、`toSQL`；`Db.execute(sql)`、`Db.drizzle()` 用于复杂查询；`Db.connection(name)` 切换连接。

**事务**：`Db.transaction(fn)` 通过 AsyncLocalStorage 隐式传播，回调内的 Db / Model 查询自动使用事务，嵌套为保存点。

**Model**：`class User extends Model.define(users)`，字段类型由 drizzle 表推导（不需要重复声明）；`create / find / findOrFail / all / paginate / destroy / save（只更新脏字段）/ delete / forceDelete / restore / refresh`；软删除（`withTrashed / onlyTrashed`）、时间戳（列存在时自动维护，按列类型写 Date / 字符串 / 毫秒）、`get*Attr / set*Attr`、`hidden / append`、`static scopeXxx` → `scope('xxx')`、事件 `onBefore/AfterInsert|Update|Write|Delete|Restore`；关联 `hasOne / hasMany / belongsTo`，可直接 await，也可 `with('posts.author')` 嵌套预加载，`toJSON` 包含已加载关联。
- 类型实现要点：模型通过 `'~table'` 品牌属性推导表类型，避免互相引用的模型在结构比较时无限展开。

**连接**：`config/database.ts`（`sqlite | postgres | pglite | mysql`），驱动为可选 peer 依赖、按需动态加载；连接懒建立、跨 HMR 复用、应用关闭时释放；唯一约束冲突统一转换为 `UniqueConstraintException`（409）。

**迁移与命令**：表结构在 `database/schema/*.ts`，`haze db:generate`（调用 drizzle-kit）、`db:migrate`（drizzle 运行时迁移器）、`db:seed`（在应用模块图中执行 `database/seeders/*.ts`）、`make:model`（模型 + 对应方言的表结构）、`make:seeder`；测试用 `refreshDatabase()` 配合 `.env.test` 的 `DATABASE_URL=:memory:`。

**模板**：api / vue 模板默认集成 SQLite、User 模型与 CRUD 控制器、初始迁移、数据填充与测试。

**环境说明**：pnpm 11 要求显式决定依赖的安装脚本；drizzle-kit 依赖的 esbuild 安装脚本已设置为不执行（`allowBuilds: esbuild: false`），esbuild 通过平台二进制包正常工作。pnpm 还自动把较新的 `@electric-sql/pglite` 加入了 `minimumReleaseAgeExclude`。

### M8 实施记录（2026-10-26）

新增 `@hazejs/orm/mongo`（独立入口，只有使用时才加载 `mongodb` 驱动），165 个测试通过；MongoDB 用例运行在 mongodb-memory-server 启动的单节点副本集上（首次运行下载 mongod 二进制，之后离线可用），事务真实提交 / 回滚。

- **共享基类**：从 SQL `Model` 中抽出 `ActiveRecord`（属性与脏检查、访问器 / 修改器、hidden / append、事件、关联与预加载、序列化），`Model` 与 `MongoModel` 都继承它；关联 `hasOne / hasMany / belongsTo` 两种模型通用，ObjectId 关联键按字符串比较。重构后 SQL 用例全部通过（MySQL 组本次未重跑，colima 已停止；重构未改动方言相关代码）。
- **Mongo 查询构造器**：`Mongo.collection<Doc>('users')`，方法与 `Db.table()` 一致（where / orWhere / 分组 / whereIn / whereNull / whereBetween / whereLike → 正则 / order / page / field / paginate / chunk / 聚合 / insert / update / delete / increment），无条件写入同样需要 `{ all: true }`；Mongo 特有：`aggregate(pipeline)`（自动在前面加当前条件的 `$match`）、`where({ age: { $gt: 1 } })` 直接使用查询运算符、`update({ $push: … })` 直接使用更新运算符、`Mongo.db()` 获取原生 Db。
- **MongoModel**：`class User extends MongoModel.define<UserDoc>('users')`；文档无固定结构，实例以 Proxy 把未声明属性的读写转为 getAttr / setAttr（因此内部不使用 `#私有成员`）；字符串 `_id` 自动转为 ObjectId，JSON 中输出为字符串；软删除、时间戳、作用域、事件与 SQL 模型一致。
- **事务**：`Mongo.transaction(fn)` 使用会话并通过 AsyncLocalStorage 隐式传播；MongoDB 不支持嵌套事务，嵌套调用复用外层事务。
- **其它**：`config/database.ts` 新增 `driver: 'mongodb'`（`database` 指定库名）；重复键（11000）同样转换为 409；`refreshDatabase()` 对 MongoDB 清空数据库；`db:generate / db:migrate` 跳过 MongoDB 连接；`make:model --dialect mongodb` 生成带文档接口的模型。
- **类型实现要点**：模型相关泛型只用品牌属性约束（`ModelLike` / `MongoModelLike`），关联目标不加 `extends ActiveRecord` 约束，避免互相引用的模型在结构比较时无限展开。
- **依赖**：`mongodb-memory-server-core` 间接依赖的 `semver@6.3.1` 被 trustPolicy 拦截，通过 `overrides: 'make-dir@3>semver': ^7.7.0` 改用 semver 7（make-dir 只调用 `semver.satisfies()`），未放宽安全策略；使用 `-core` 包，没有安装脚本。

### M9 实施记录（2026-10-26）

`haze build --preset <name>`（或 `haze.config.ts` 的 `preset`），纯后端与 Vue 全栈项目共用同一套预设：插件在构建时按预设决定产物布局、打包策略、解析条件与生产入口，构建结束执行预设的收尾步骤（生成平台配置、复制依赖）并给出部署提示。178 个测试通过。

| 预设 | 产物 | 打包策略 | 验证方式 |
|------|------|----------|----------|
| node（默认） | `dist/index.mjs`；全栈为 `dist/server` + `dist/client` | 依赖 external | 真实 Node 进程 |
| bun | 同 node | 依赖 external，`bun` 条件 | 真实 Bun 1.4 进程 |
| deno | `dist/server/index.mjs` | 全部打包（驱动除外），`deno` 条件 | 真实 Deno 2.9 进程 |
| docker | `dist/` 即构建上下文：Dockerfile + 运行时 package.json | 框架与纯 JS 依赖打包，数据库驱动在镜像内 `npm install` | 真实 Docker 构建与运行（colima） |
| aws-lambda | `dist/lambda`（含复制的驱动 node_modules，全栈含 client） | 驱动 external + 复制 | 以 API Gateway v2 / v1 事件调用 handler |
| vercel | `.vercel/output`（static + `__server.func` + config.json 路由） | 驱动 external + 复制 | 以 Node HTTP 服务器挂载函数 |
| netlify | `.netlify/v1/functions/haze-server.mjs` + `netlify.toml` + `_redirects` | 驱动 external（Netlify 构建时打包） | 直接调用函数 |
| cloudflare | `dist/index.mjs` 单文件 Worker + `wrangler.json`（nodejs_compat、Assets、SPA 回退、`run_worker_first`） | 全部打包、`browser` 平台，不可用驱动替换为报错空模块 | 真实 workerd（miniflare） |

**要点**
- 全栈：服务端先于前端构建（部分预设的前端目录位于服务端目录内）；Vercel / Netlify / Cloudflare 的静态资源由平台 CDN 提供，Lambda / Docker / Node 由同一进程托管。
- 打包后的产物不依赖框架包的发布（`@hazejs/*` 已打包）；ORM 按变量动态加载的驱动扫描不到，按项目依赖显式带上。
- Docker 中驱动在镜像内安装，得到 Linux 平台的原生二进制（实测容器内为 `@libsql/linux-x64-*`）。
- Cloudflare：消除了 Node 平台的 `createRequire(import.meta.url)` 辅助代码；core 的日志颜色改为自带的小工具（原 `consola/utils` 依赖 `node:tty`）；Worker 入口只能导出处理器，因此输出单文件。
- core 新增 `createLambdaHandler`（API Gateway v1 / v2、ALB、Function URL）并导出 `toNodeHandler`。
- 依赖：新增 miniflare、deno（npm 包）作为测试开发依赖；pnpm 11 中 `deno`、`workerd` 的安装脚本被设置为不执行（平台二进制随可选依赖安装）。

**已知限制 / 后续**
- ~~Cloudflare Workers 上 ORM 的 SQL 驱动不可用~~（M10 已解决：D1 / Turso 驱动）。
- Vercel / Netlify / AWS Lambda 只在本地按平台约定模拟调用验证，尚未真实部署。
- ~~生产环境的数据库迁移依赖开发工具链~~（M10 已解决：迁移随产物打包）。

### M10 实施记录（2026-10-26）：生产迁移与 Edge 数据库

补齐 M9 的已知限制。199 个测试通过，5 个跳过（D1 上的 2 个事务用例、非 D1 方言上的 D1 专属用例，以及按环境变量启用的 Worker + Turso 用例）；Turso 的 20 个 ORM 用例与 Worker 用例在设置 `HAZE_TEST_TURSO_URL` 后运行。

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
- `migrate({ folder, files? })` 可读磁盘，也可读内嵌文件；`runMigrations({ connection?, all?, files?, srcDir? })` 按 config/database.ts 解析各连接的迁移目录，跳过 MongoDB，返回 `{ connection, folder, applied, total }`。`haze db:migrate` 改为调用它。
- Vite 插件新增 `virtual:haze/migrations`：用 `import.meta.glob('?raw')` 把 `database/**` 下的 SQL 与 `_journal.json` 打进产物，键为相对 srcDir 的路径。
- 各预设的生产迁移入口：

| 预设 | 入口 | 验证 |
|------|------|------|
| node / bun / deno / docker | 构建额外输出 `migrate.mjs`（`--connection`、`--all`），与 `index.mjs` 共享 chunk | Docker 产物中执行两次（1/1、0/1），再启动服务 CRUD |
| aws-lambda | 同一 bundle 导出 `migrate(event)`，handler 设为 `index.migrate` | 进程内调用 |
| cloudflare + D1 | `haze.config.ts` 的 `cloudflare.wrangler` 合并进 wrangler.json；`d1_databases` 默认 `migrations_dir: 'migrations'`，构建时复制 `database/migrations`；提示 `wrangler d1 migrations apply` | Miniflare D1 中按 wrangler 方式执行 SQL，再在 Worker 内 CRUD（201 / 409 / 204） |
| vercel / netlify / cloudflare + Turso | 在 CI 中执行 `haze db:migrate` | `db:migrate` 写入真实 sqld，再在 Worker 内读写 |

**验证**
- D1：ORM 全部 SQL 用例（查询构造器、唯一约束 → 409、模型、关联、内嵌迁移、框架集成）在 Miniflare 的 workerd D1 上运行，事务用例跳过并改为验证报错。
- Turso：colima 中运行 `ghcr.io/tursodatabase/libsql-server`，`HAZE_TEST_TURSO_URL=http://127.0.0.1:18080` 跑 ORM 全部用例（含 HTTP 上的事务与保存点）与 Worker + Turso 端到端用例，均通过。容器与镜像已删除，colima 已停止。

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
- `haze.config.ts` 新增 `externals: { trace?, traceDeps?, inline? }`，`traceDeps` 中的 `pkg*` 表示整包复制。

**预览**
- 构建结束写入 `.haze/build.json`，记录预设、产物布局、入口、是否全栈与后端前缀。
- 插件实现 `configurePreviewServer`：在 Vite 内置静态中间件之前挂载产物。`vite preview` 预览时，`environments.client.build.outDir` 取自构建记录。
- 新增 `haze preview` / `previewServer()`：全栈项目使用项目的 vite.config.ts，纯后端项目使用内置配置（`appType: 'custom'`），默认端口 4173。
- 各预设的运行方式：

| 预设 | 方式 | 静态文件 |
|------|------|----------|
| node / docker | 在随机端口启动产物进程（cwd 为项目根，加载 .env），用 fetch 转发全部请求（去掉逐跳头与 content-encoding） | 产物托管 |
| bun / deno | 同上，需要对应运行时（产物按 bun / deno 导出条件构建，不能用 Node 运行）；deno 也可使用 npm 的 deno 包 | 产物托管 |
| aws-lambda | 进程内调用 `handler`；core 新增 `requestToLambdaEvent` / `lambdaResultToResponse` | 产物托管 |
| vercel | 进程内调用 Node handler | Vite 托管 `.vercel/output/static`，后端前缀交给函数 |
| netlify | 进程内调用 Functions v2 handler | Vite 托管 publish 目录 |
| cloudflare | 用项目安装的 Miniflare 运行 `dist/index.mjs`：`vars`、D1、KV 绑定读取自 wrangler.json，数据持久化在 `.haze/preview`；D1 迁移按 wrangler 的方式自动应用（`d1_migrations` 表记录） | Vite 托管 `dist/client` |

**多框架**
- 插件本身不依赖任何前端框架，前端框架插件与 `haze()` 并列使用即可。
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
- `APP_KEY`：至少 32 个字符。`haze key:generate` 写入 `.env`（已有时需加 `--force`），create 模板为每个项目生成独立的密钥。
- Session 由 `session` 中间件或 `await ctx.startSession()` 启动，`ctx.session` 提供 `get / set / has / forget / pull / flush / flash / regenerate / invalidate`。
- 只有修改过才写回；新会话没有数据时不设置 Cookie。
- 两种驱动：
  - `cookie`：数据用 AES-GCM 加密存在 Cookie 中，密钥通过 HKDF 从 APP_KEY 派生，与签名用途分开；超过约 3.8KB 时报错，提示改用服务端存储。
  - `memory` / 自定义 `SessionStore`：Cookie 中只保存签名的会话 ID；`regenerate` 时删除旧 ID。

**认证**
- `config/auth.ts`：`default`、`guards`（`jwt` / `session`）、`providers`（`UserProvider` 接口；`@hazejs/orm` 提供 `modelUserProvider(() => User, { username, password })`）。
- `ctx.auth`：`user / check / id / logout`、`guard(name)`，`jwt()` / `session()` 取得具体类型的 Guard；`auth:<guards>` 中间件通过后调用 `shouldUse()` 设置默认 Guard。
- JWT Guard（jose）：
  - 算法：HS*（密钥默认 APP_KEY）以及 RS / PS / ES / EdDSA（PEM 公私钥）；
  - 签发：`login(user, claims)` / `attempt(credentials)` 返回 `{ token, type, expiresIn, expiresAt }`；令牌中 sub 为用户 ID，并包含 jti、iss / aud；
  - 读取令牌：Authorization: Bearer，也可以配置从 Cookie 读取；`payload()` 返回声明；
  - 过期、篡改、格式错误都视为未登录；退出是无状态的（令牌在过期前仍有效，需要立即失效时在业务中维护黑名单）。
- Session Guard：`login` 时 regenerate 会话 ID，`logout` 时 invalidate；会话按需自动启动，不需要额外加 `session` 中间件。
- `Hash`：默认 scrypt（node:crypto），运行时没有 scrypt 时用 PBKDF2-SHA256（Web Crypto，600000 次迭代）；哈希串记录算法与参数，`needsRehash()` 用于升级参数。
- 类型：`AuthUser` 由 typegen 生成的 `config/auth.ts` 类型推导，模板中 `ctx.auth.user()` 的类型即为 `User`（已在脚手架项目中验证）。
- 测试：`@hazejs/testing` 的 `t.actingAs(user, guard?)` 基于 core 的 `issueTestCredentials()`，生成真实的令牌或会话 Cookie。
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
  - 预览：aws-lambda、vercel、netlify 在进程内运行前从项目根目录加载 `.env`，与 `haze start` 一致；
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
- `CacheManager` 是应用单例，可以注入；没有 `config/cache.ts` 时默认使用内存缓存，键前缀默认为 `haze:`。
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
- Redis / Upstash 用例按 `HAZE_TEST_REDIS_URL`、`HAZE_TEST_UPSTASH_URL`、`HAZE_TEST_UPSTASH_TOKEN` 启用。验证结束后容器、镜像与 Docker 网络已删除，colima 已停止。

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
- vercel：函数拦截 `/__haze/schedule`，要求 `Authorization: Bearer $CRON_SECRET`；config.json 增加路由与 `crons`，频率可用 `haze.config.ts` 的 `vercel.cron` 调整，Hobby 计划只允许每天一次。

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
- Redis 用例按 `HAZE_TEST_REDIS_URL` 启用；验证后已删除容器与镜像，colima 已停止。

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
| `vite preview` / `haze preview`（进程型预设） | 把升级请求按原始 TCP 字节转发给产物进程 |
| cloudflare | 新增 `@hazejs/core/cloudflare` 子路径的 `createWebSocketDurableObject()`；入口导出 `HazeWebSocket`，Worker 的 fetch 把升级请求交给 DO，钩子在 DO 内经应用解析；wrangler.json 增加 `durable_objects` 与 SQLite DO 的迁移；路由中出现 `.ws(` 时生成，也可用 `cloudflare.websocket` 强制开关；Cloudflare 预览会读取 DO 绑定 |
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

### M17 实施记录（2026-10-27）：Socket.IO 兼容

背景：前端大多使用 socket.io-client，它使用 Engine.IO / Socket.IO 协议（长轮询握手、升级、命名空间、ack、房间），无法直接连接 M16 的原生 WebSocket（`r.ws()`）。

确认的决策：
- 集成官方 socket.io 服务端，不在 crossws 上自研协议；
- Bun 通过 `@socket.io/bun-engine` 支持；
- 多实例使用 `@socket.io/redis-adapter`（在 colima 中用 redis:7 验证）；
- 全栈模板带示例。

**core 的扩展点**
- `registerServerExtension({ name, matches(pathname), node?(httpServer), bun? })`：服务器扩展注册表（进程级）。
  - Node：框架创建的每个 http 服务器都会注册（`registerNodeServer`：产物服务端、`haze dev`、Vite 开发服务器），扩展在注册时或服务器出现时挂载；
  - 挂载前记录 `request` / `upgrade` 监听器，用于卸载与同名替换（engine.io 会替换 request 监听器）；`unregisterServerExtension()` 卸载。
- crossws 的 Node 升级处理会跳过扩展匹配的路径。
- Bun：srvx 中间件先把匹配路径的请求交给扩展；由于 Bun 只允许一组 websocket 处理器，按 `owns(ws)` 把连接分发给扩展或 crossws；`idleTimeout` 取扩展的最大值，长轮询需要较长的空闲超时。
- `app.discovered(name)`：通用的按目录发现，虚拟清单中提供 `discovered.sockets`，即 `app/socket/*.ts`。
- `app.contextFor(request)`：为请求之外的 Request 创建 HttpContext（可读 `ctx.auth`），用于握手鉴权。

**@hazejs/socket.io**
- `socketIoProvider()`：创建 socket.io Server，跨热替换保留。
  - 设置 `serveClient: false`、`destroyUpgrade: false`（不能销毁 `r.ws()` 与 Vite HMR 的升级请求）；CORS 默认沿用 `config/cors.ts` 的 origin；
  - Node 上 `io.attach(httpServer)`，Bun 上 `io.bind(new BunEngine())`；
  - 在 Cloudflare Workers 上警告后跳过（socket.io 在构建时已替换为空模块）。
- `defineNamespace({ name?, middleware, connection(socket, io, namespace) })`：文件名决定命名空间（`index` 为 `/`，`ChatRoom` 为 `/chat-room`）。每个命名空间只挂一次中间件与 connection 处理器，每次从最新的定义中取，所以热替换后新连接使用新代码。
- `authenticate({ guard?, optional? })`：用握手的请求头（以及 `auth.token`，作为 Bearer）构造 Request，按 Guard 取得用户，存入 `socket.data.user`；未登录时以 `unauthorized` 拒绝。兼容 Bun 引擎握手中的完整 URL。
- `SocketIO.emit / to / except / of`、`SocketIOServer` 注入令牌。
- `config/socketio.ts`：`path`、`cors`、`adapter: { driver: 'redis', url, key }`、`options`（透传）。
- 释放：socket.io 实例还没挂到任何服务器时 `io.close()` 会抛错（例如模板自带的测试），此时只断开连接；关闭时注销服务器扩展。
- 构建：`socket.io`、`@socket.io/bun-engine`、`@socket.io/redis-adapter` 列入驱动包（保持 external 并追踪进产物，Docker 在镜像内安装，Workers 上替换为空模块）。

**模板（vue / react）**
- `server/app/provider/SocketProvider.ts`、`server/app/socket/chat.ts`（广播在线人数、`chat:send` 带 ack）、`server/config/socketio.ts`（`SOCKET_ADAPTER=redis`）。
- `src/socket.ts`；页面显示"在线 N 人（Socket.IO）"。
- api 模板只在 README 中说明用法。

**验证**
- `socketio.test.ts`（8 个）：
  - 同进程：长轮询、WebSocket、默认客户端从长轮询升级、ack、房间与 `SocketIO.to()` 推送、握手鉴权（拒绝 / 令牌通过并取得用户）、与 HTTP 路由及 `r.ws()` 共用服务器；
  - 两个 Node 子进程经真实 Redis 互通；
  - 真实 Bun 1.4 子进程：长轮询、WebSocket、升级、鉴权、同一个 Bun.serve 中的 `r.ws()`。
- create：
  - React 模板经 Vite 全栈开发服务器以两种传输连接 `/chat`，修改命名空间后新连接使用新代码；
  - vue 模板的 node / bun / docker 预览以两种传输连接；
  - Cloudflare 构建与运行不受影响。
- 验证结束后 Redis 容器与镜像已删除，colima 已停止。

**限制**
- Deno、Cloudflare Workers、Vercel / Netlify / Lambda 不支持（Workers 请用 `r.ws()` + Durable Object）。
- 开发服务器刚启动、应用尚未启动完成时到达的第一个握手会失败，客户端默认会自动重连。
- 每个进程只有一个 socket.io 实例，只挂到一个 HTTP 服务器（engine.io 的限制）。

### M18 实施记录（2026-10-27）：文件存储与邮件

确认的决策：
- S3 驱动基于 AWS SDK v3（`@aws-sdk/client-s3`、`lib-storage` 分片上传、`s3-request-presigner` 预签名）；SES 使用 `@aws-sdk/client-sesv2`；
- 邮件驱动：SMTP（nodemailer）、Resend、Postmark、Mailgun、Amazon SES，以及 log / array；
- 邮件内容：函数返回 html / text，并提供简单的布局辅助；
- 验证：S3 用本地 RustFS（MinIO 镜像已无法拉取），SMTP 用 Mailpit。
- 以上 SDK 均为 core 的可选 peer 依赖，按需安装，运行时动态导入。

**文件存储（`config/filesystem.ts`）**
- `defineFilesystemConfig({ default, disks, signedRoute? })`。缺省配置有两个本地磁盘：
  - `local`：根目录 `storage/app`；
  - `public`：根目录 `storage/app/public`，`url: '/storage'`，`serve: true`。
- 驱动：
  - `local`：Node / Bun / Deno，路径不能越出根目录，流式读写；
  - `s3`：AWS 与 S3 兼容服务；有 `endpoint` 时默认路径风格；超过 `multipartThreshold`（默认 8MB）或内容为流时分片上传；`root` 为键前缀；
  - `r2`：Workers 绑定，经 `usePlatformBinding` 读取；
  - `memory`：测试用；
  - `custom`：传入自定义的 DiskDriver。
- `Disk` 的接口：
  - 写入：`put`（字符串 / 字节 / Blob / ReadableStream）、`putFile` / `putFileAs`（File，随机文件名保留扩展名）；
  - 读取：`get` / `text` / `json` / `stream` / `meta` / `exists` / `missing` / `size`；
  - 管理：`delete`（返回删除数量）/ `deleteDirectory` / `copy` / `move` / `files(dir, { recursive })`；
  - 链接与响应：`url` / `temporaryUrl` / `response`（流式，带 Content-Type / Length / ETag，支持 304 与 HEAD）/ `download`。
- 路径统一规范化：去掉开头的 `/`，合并重复的 `/`，`..` 直接拒绝。
- 临时链接：
  - S3 使用原生预签名；
  - 其余磁盘使用框架的签名路由 `/__haze/storage/<disk>/<path>?expires&signature`，签名为 APP_KEY 的 HMAC，覆盖磁盘、路径、过期时间与下载文件名；
  - 新增 `app.url`（APP_URL）配置，用于生成绝对链接，未设置时生成站内路径。
- `StorageManager.middleware()` 自动安装在静态资源之后、全局中间件之前：
  - 处理签名路由，签名无效或已过期时返回 403；
  - 在 `url` 下提供 `serve: true` 的本地磁盘文件，文件不存在时交给后续路由；Workers 上跳过。
- 门面：`Storage.disk(name)`，以及默认磁盘的全部方法。
- 测试：`Storage.fake(name)` 把磁盘换成内存磁盘（保留 url），提供 `assertExists` / `assertMissing` / `assertCount` / `assertDirectoryEmpty`；`Storage.restore()` 恢复。
- `UploadedFile.store(dir, disk | { disk, ...PutOptions })` 与 `storeAs` 改为写入磁盘，返回磁盘内路径。不兼容的变化：原来写本地目录并返回完整路径。

**邮件（`config/mail.ts`）**
- `defineMailConfig({ default, from, replyTo, mailers, queue, alwaysTo })`，缺省为 log 驱动。
- `defineMail(payload => ({ subject, html, text?, attachments?, cc?, ... }), { name?, mailer? })`：定义可复用的邮件。
- 链式调用：`Mail.to(addr).cc().bcc().replyTo().from().mailer(name)`，再接 `.send(mail, payload)`、`.queue(...)` 或 `.later('10m', ...)`。
- 原始消息：`Mail.send({ to, subject, ... })`、`Mail.queue(...)`。
- 地址格式：`'Ada <ada@example.com>'`、`{ address, name }`，或二者组成的数组。
- 发送前解析：
  - 地址规范化，合并默认发件人；
  - 未提供 `text` 时由 html 生成纯文本；
  - 附件可直接给 `content`，也可以用 `{ disk, path }` 在发送时从存储磁盘读取；
  - 设置 `alwaysTo` 时所有邮件改投到这些地址，原收件人写入 `X-Original-To`。
- 排队发送：
  - 渲染后的消息作为内置任务 `mail:send` 的载荷，附件转为 base64，磁盘附件只记录路径；
  - 重试取 `mail.queue.tries`（默认 3）与 `backoff`（默认 [10, 60]）；
  - 渲染发生在投递时，worker 端无需注册邮件定义。
- 驱动：
  - `smtp`：nodemailer，默认连接池；
  - `resend` / `postmark` / `mailgun`：直接 fetch，可用 `endpoint` 覆盖接口地址；
  - `ses`：SendEmail 的 Simple 内容，附件走 `Attachments`；
  - `log` / `array`：array 可通过 `transport('array').messages` 读取；
  - `custom`。
  - 应用释放时关闭全部传输。
- 布局辅助：
  - `html` 模板，插值自动转义，数组拼接；`rawHtml()` 原样插入；
  - `button(text, url)`；
  - `mailLayout({ body, brand, preheader, footer, color })`，表格布局、内联样式；
  - `htmlToText()`。
- 测试：`Mail.fake()` 提供：
  - `assertSent` / `assertNotSent` / `assertSentTimes` / `assertQueued` / `assertNotQueued` / `assertNothingSent` / `assertNothingQueued`，匹配邮件定义或谓词；
  - `MailFake.hasRecipient()`。

**构建**
- AWS SDK 的四个包与 nodemailer 列入驱动包：Node 预设保持 external 并追踪进产物，未安装时替换为空模块。
- nodemailer 在 Workers 上替换为报错空模块。
- Cloudflare 预设增加 `mainFields: ['browser', 'module', ...]`（与 wrangler 一致），使 AWS SDK 使用 fetch 版的 runtimeConfig，否则会引入 `node:child_process`，Workers 无法启动。
- 本地磁盘的根目录改为在运行时求 `process.cwd()`。原来的 `resolve(process.cwd(), 'storage/app')` 会被 nf3（nft）的静态分析当作文件引用，把构建时 cwd 下的全部依赖追踪进 `dist/node_modules`。

**模板（vue / react / api）**
- `config/filesystem.ts`（local / public / s3，注释中给出 r2）与 `config/mail.ts`（`MAIL_MAILER`，默认 log；smtp 默认连接 Mailpit 的 1025 端口；resend；其余在注释中给出）。
- `app/mail/WelcomeMail.ts`：`SendWelcomeEmail` 任务真正发送欢迎邮件。
- `POST /api/auth/avatar`（需登录，`bodyLimit:3mb`）：valibot 校验 png / jpeg / webp、不超过 2MB，保存到 public 磁盘，返回 `/storage/...` 链接。
- `.gitignore` 加入 `storage`。
- 模板测试：
  - 注册后执行队列任务，断言欢迎邮件已发送；
  - 用 `Storage.fake('public')` 测试头像上传。

**验证**
- `storage.test.ts`：同一组用例覆盖 memory / local / r2（Miniflare）/ s3（RustFS，`HAZE_TEST_S3_ENDPOINT`）。
  - 内容：读写、流式读写、复制 / 移动 / 列表 / 删除、路径穿越、文件响应（ETag、304、下载文件名）、临时链接；
  - 临时链接：S3 直接访问预签名链接；其余磁盘经签名路由访问，并验证篡改与过期；
  - S3 另测 6MB 流的分片上传；
  - HTTP：上传到 public 磁盘并经 `/storage` 访问、穿越路径 404、APP_URL 绝对签名链接、fake。
- `mail.test.ts`：
  - 布局与转义、纯文本生成、磁盘附件、排队任务载荷的 JSON 往返、sync 队列、`later` 延迟、fake、alwaysTo；
  - Resend / Postmark / Mailgun / SES 发到本地捕获服务器，校验请求格式；SES 校验 SigV4 签名头；
  - 真实 SMTP：发到 Mailpit，经 Mailpit API 校验主题、发件人、收件人、抄送、HTML、纯文本与中文文件名附件（`HAZE_TEST_SMTP_URL`、`HAZE_TEST_MAILPIT_API`）。
- 验证结束后 RustFS 与 Mailpit 的容器和镜像已删除，colima 已停止。

**限制**
- R2 绑定没有原生预签名：临时链接走应用的签名路由；需要直连时，改用 s3 驱动连接 R2 的 S3 接口。
- 本地磁盘的 `files()` 遍历目录，不适合超大目录。
- 排队邮件的内联附件以 base64 写入队列载荷，大文件请用磁盘附件。
- SMTP 不能在 Workers 上运行。


### 改名与开源化（2026-10-28）：think-h3 → hazejs

框架更名为 **hazejs**，命令行为 `haze`，作为开源项目发布到 https://github.com/penna-org/haze。

**命名对照**

| 原名 | 新名 |
|------|------|
| `@think-h3/core / cli / vite / orm / testing / socket.io` | `@hazejs/core / cli / vite / orm / testing / socket.io` |
| `create-think-h3` | `create-hazejs`（`pnpm create hazejs`） |
| 命令 `think-h3` | `haze` |
| `think.config.ts`、`defineThinkConfig` | `haze.config.ts`、`defineHazeConfig` |
| Vite 插件 `thinkH3()` | `haze()` |
| `.think/`、`virtual:think/*`、`/__think/*` | `.haze/`、`virtual:haze/*`、`/__haze/*` |
| `THINK_*` 环境变量（含测试用的 `THINK_TEST_*`） | `HAZE_*` |
| `Symbol.for('think-h3.*')` 等内部标识 | `hazejs.*` |

- 不带 scope 的 `hazejs` 与 `haze` 在 npm 上已被占用，因此使用 `@hazejs` scope，发布前需要在 npm 注册 hazejs 组织。
- 本文档中各里程碑的历史记录同步使用新名字；ThinkPHP 仍作为设计参考保留。
- Session 加密的 HKDF info 随之改为 `hazejs session`，旧的 Session Cookie 会失效（预发布阶段无兼容负担）。

**开源配套**
- 许可证：MIT（根目录与每个包各一份 LICENSE）。
- 每个包补充 description、keywords、homepage、repository（含 directory）、bugs，以及英文 README。
- 文档：根 README 英文为主，并提供 `README.zh-CN.md`；`CONTRIBUTING.md` / `CONTRIBUTING.zh-CN.md`、`CODE_OF_CONDUCT.md`（采用 Contributor Covenant 2.1）、`SECURITY.md`（GitHub 私密漏洞报告）。
- 路线图与框架对比：`docs/roadmap.md` / `docs/roadmap.zh-CN.md`，列出 M19 起的计划。
- GitHub：
  - `ci.yml`：lint 与类型检查；完整测试，以服务容器提供 Redis、serverless-redis-http、MySQL、libsql-server、RustFS、Mailpit，并安装 Bun，使需要真实服务的测试全部运行；
  - `release.yml`：Changesets 自动开 "Version Packages" PR，合并后带 provenance 发布到 npm（需要仓库密钥 `NPM_TOKEN`）；
  - Issue 模板（Bug / Feature）、PR 模板、dependabot（GitHub Actions）。
- Changesets 3：所有 `@hazejs/*` 与 `create-hazejs` 为 fixed 组，共用一个版本号；首个 changeset 为 minor，首次发布即 0.1.0。
- 组织策略要求 action 固定到完整提交 SHA：工作流中的 action 均写成 `owner/action@<sha> # vX.Y.Z`（checkout v7、setup-node v7、pnpm/action-setup v6、setup-bun v2、changesets/action v2），Dependabot 按组每月更新 SHA 与注释。
- changesets/action v2 对应 Changesets 3（v1 对应 Changesets 2），输入改名为 `version-script` / `publish-script` / `pr-title` / `commit-message`；npm 令牌由 setup-node 的 `registry-url` 与 `NODE_AUTH_TOKEN` 提供。仓库与组织都需开启 "Allow GitHub Actions to create and approve pull requests"。

### 发布前检查（2026-10-28）

做法：
1. 用 `pnpm pack` 打包 7 个包，检查内容：dist、LICENSE、README、bin、stubs、模板（`.env` 保留，`_gitignore` 改名），`workspace:` / `catalog:` 已替换为实际版本。
2. 在仓库之外的临时目录，用打包出的 `create-hazejs` 创建 vue / react / api 项目，经 pnpm overrides 把 `@hazejs/*` 指向本地 tarball 后安装。
3. 逐项验证：类型检查、模板测试（各 12 个）、`haze dev`（页面、接口、修改服务后热更新、CSRF 419）、生产构建；vue 产物拷到项目外执行迁移并启动，注册用户后排队任务发出欢迎邮件；api 项目另外构建 cloudflare / vercel / aws-lambda / docker / bun 预设。

monorepo 内的测试覆盖不到、由这次检查发现的两个问题：
- **pnpm 11 拒绝未声明的安装脚本**：drizzle-kit、tsx 引入的 esbuild 带安装脚本，pnpm 11 未声明时 `pnpm install` 报 `ERR_PNPM_IGNORED_BUILDS`，并且 `pnpm run` 前的依赖检查会再次失败，新项目的 `pnpm dev` / `pnpm test` 都无法运行。pnpm 11 不再读取 package.json 中的 pnpm 字段，因此脚手架生成 `pnpm-workspace.yaml`（`allowBuilds: { esbuild: false }`，esbuild 的二进制来自平台可选依赖）。目标目录已位于某个 pnpm workspace 内时不生成，避免嵌套 workspace。
- **未安装的数据库驱动导致构建失败**：drizzle-orm 的各驱动模块静态导入 mysql2、pglite 等；真实项目只安装用到的驱动，Vite 会把缺失的可选 peer 依赖替换为没有导出的空模块，构建报 `MISSING_EXPORT`。monorepo 中这些驱动经 devDependencies 都能解析，因此之前没有暴露。drivers-external 预设现在把驱动等外部包直接加入 Rolldown 的 `external`（`externalPattern()`），导入原样保留，未安装的驱动只在真正使用时才报错（ORM 按需动态加载驱动）。

### 文档站（2026-10-28）：GitHub Pages

- VitePress 站点位于 `docs/`，发布到 https://penna-org.github.io/haze/（`base: '/haze/'`）；英文在根路径，中文在 `/zh/`，两种语言共用同一份页面结构（`docs/.vitepress/config.ts` 中的 `guide` 列表），本地搜索带中文界面。
- 指南共 29 页 × 2 种语言：介绍（什么是 hazejs、快速开始、目录结构、配置）、基础（路由、控制器、服务容器、中间件、请求与校验、响应、异常与日志）、数据库（快速开始、模型与查询）、安全（认证、授权、Session / CSRF 等）、进阶（缓存、队列、定时任务、事件、WebSocket、Socket.IO、文件存储、邮件）、全栈与部署（Vite 全栈、多应用、测试、部署、命令行参考）；路线图移入站点（`docs/roadmap.md`、`docs/zh/roadmap.md`），`design.md` 不参与构建。
- 版本：VitePress 1.6 依赖 vite 5.4.21，被 pnpm `trustPolicy: no-downgrade` 拦截（该版本发布时 vite 已启用 trusted publisher，而它本身没有）；改用 2.0.0-alpha.20，它基于 Vite 8，与仓库共用同一个 vite，未放宽安全策略。
- `docs.yml`：PR 中只构建（VitePress 遇到失效的站内链接会构建失败）；`main` 上构建后用 configure-pages / upload-pages-artifact / deploy-pages 发布，action 均固定到提交 SHA。需要在仓库 Settings → Pages 中把 Source 设为 GitHub Actions。
- 编写文档时核对出的设计文档与实现不一致之处（以代码为准）：`ctx.json()`、中间件 `priority`、路由分组的 `domain` 并不存在（域名路由通过多应用配置实现）；URL 生成为 `router.url(name, params, query)`；框架当时不会自动读取 `APP_URL`（0.1.2 起 `app.url` 默认读取 `APP_URL`）；`Disk.url()` 在未配置 url 时抛错。

### 发布流程：npm 可信发布与 tag / Release 补齐（2026-10-28）

- 0.1.1 是在本地手动发布的（发布时间早于版本提交与 Release 运行，逐个发布的间隔符合交互式 2FA 发布），CI 运行时已无待发布的包。
- changesets/action v2 通过 `CHANGESETS_OUTPUT` 读取 Changesets CLI 写出的 NDJSON 事件来创建 tag 与 Release，事件只在 CLI 自己打 tag 时写出；CLI 的 "tag-only" 补打只针对私有包，已发布的公开包不会补 tag。因此本地发布的版本不会有 tag 与 Release。
- `.github/scripts/sync-releases.mjs` 在 Release 工作流的每次运行末尾执行（幂等）：对每个公开包的当前版本，若已在 npm 上而缺少 tag，则在把 package.json 改成该版本的提交上打 tag 并推送；缺少 GitHub Release 时用 CHANGELOG 中该版本的段落创建。checkout 改为完整历史。`--dry-run` 只打印操作。
- 可信发布：pnpm 11 原生支持，在 GitHub Actions 中用 OIDC 身份令牌按包换取短期 npm 令牌，并自动判断附带 provenance（`publishConfig.provenance` / `NPM_CONFIG_PROVENANCE` 不再需要；此前 `pnpm publish` 不读取该环境变量，0.1.1 没有 provenance）。工作流去掉了 `registry-url` 与 `NODE_AUTH_TOKEN`，只保留 `id-token: write`。前提：每个包在 npmjs.com 的 Settings → Trusted Publisher 中登记 GitHub Actions：`penna-org` / `haze` / `release.yml`。

### M19 实施记录（2026-10-28）：@hazejs/ai

确认的决策：
- 自研 fetch 适配器，不依赖任何厂商 SDK，可运行在 Node、Bun、Deno 与 Workers；
- 厂商：OpenAI 与兼容厂商、Anthropic、Gemini，以及 Azure、Bedrock、Workers AI；
- 能力：文本、流式、工具、结构化输出（必备），以及 Embedding 与向量检索、Agent 与对话记忆、图像与语音、MCP；
- 前端协议两者都支持：hazejs 自有 SSE + Vue / React 的 `useChat`，以及 Vercel AI SDK 的 UI Message Stream。

**核心**
- 统一的数据模型（`types.ts`）：`Message` 与各类 part（文本、图片、文件、推理、工具调用、工具结果），厂商专属数据放在 `providerMetadata` 中原样回传（Anthropic thinking 签名、Gemini thoughtSignature、Bedrock reasoning 签名）。
- 模型接口 `LanguageModel / EmbeddingModel / ImageModel / SpeechModel / TranscriptionModel`，适配器只做协议转换。
- `generateText`：多步工具循环（工具参数先按 schema 校验，非法参数与执行异常作为错误结果回传给模型；没有 execute 的工具结束循环交给调用方），`maxSteps`（有可执行工具时默认 10）、`stopWhen`、`onStepFinish`。
- `streamText`：后台运行，事件写入可重放缓冲，`fullStream` / `textStream` / Promise / `toResponse()`（自有 SSE）/ `toUIMessageStreamResponse()` / `toTextStreamResponse()` 互不影响；工具在流继续时就开始执行。
- `generateObject` / `streamObject`：按模型能力选择 native（JSON Schema 约束）、json（JSON 模式 + 提示）或 tool；结果按 schema 校验；流式时解析不完整的 JSON。
- schema：Standard Schema 1.1 的 Standard JSON Schema（zod 4、arktype）直接转换，valibot 经可选依赖 `@valibot/to-json-schema`，或 `jsonSchema()`。
- HTTP：429 / 408 / 409 / 5xx / 网络错误按指数退避重试，遵循 `retry-after(-ms)`；SSE 解析处理多行 data、注释、CRLF 与跨块的 `\r\n`；每步请求传入消息快照（避免模型持有引用时看到后续修改）。
- 模型注册表：`provider:model` 与别名、各类默认模型；`setModelOverride` 供 `AI.fake()` 拦截所有模型（包括直接传入的模型对象）。

**适配器**（共 17 个厂商）
- OpenAI（Chat Completions、embedding、图像、语音合成与识别）；`ChatCompat` 描述兼容厂商的差异（max_tokens 字段、reasoning_content / reasoning、推理内容回传、json_schema 或 json_object），预设 DeepSeek、通义千问、Kimi、智谱、豆包、硅基流动、OpenRouter、Groq、xAI、Mistral、Ollama，以及通用的 `createOpenAICompatible`。
- Anthropic：`anthropic-version: 2026-10-21`（该版本对采样参数一律返回 400，因此不发送并给出警告）；自适应思考 + `output_config.effort`，`output_config.format` 结构化输出（对象补 `additionalProperties: false`）；thinking / redacted_thinking 签名回传；提示缓存；PDF。
- Gemini：`parametersJsonSchema` / `responseJsonSchema`；thoughtSignature 回传（函数调用上的签名会被严格校验）；thinkingLevel / thinkingBudget 按模型代际选择；embedding、图像（Imagen `:predict` 与图像模型）、TTS（PCM 封装为 WAV）。
- Azure：v1 API 或部署地址 + api-version，复用 OpenAI 实现。
- Bedrock：Converse / ConverseStream，Web Crypto 实现 SigV4（通过 AWS 官方测试向量校验）与 AWS event stream 二进制帧解码（CRC32 校验），也支持 Bedrock API Key；Claude 4.6 起用自适应思考 + effort，旧版用 budget_tokens；Titan / Cohere embedding，Nova Canvas / Titan 图像。
- Workers AI：REST（OpenAI 兼容接口）或 `env.AI` 绑定；配置中 `binding: 'AI'` 在调用时经 `@hazejs/core` 的平台绑定读取。

**其它能力**
- Embedding：`embed` / `embedMany`（按模型上限分批、并发）、`cosineSimilarity`；`createKnowledgeBase`（切分 → 向量化 → 存储 → 检索，`asTool()` 交给模型），`VectorStore` 接口与内存实现。
- Agent：`defineAgent`（指令可按调用上下文生成、工具、记忆、`asTool()` 多 Agent 协作）；对话记忆 `memoryConversationStore` / `cacheConversationStore`（兼容 hazejs 的缓存，二进制内容转为 data URL，截断以用户消息为界）。
- 图像、语音合成与识别：`generateImage`（按单次上限分批）、`generateSpeech`、`transcribe`。
- MCP：客户端支持 Streamable HTTP 与 stdio，使用最新规范 2026-07-28（无握手、每个请求带协议元数据、`server/discover`），并能自动回退到 2025-11-25 及更早的 initialize 握手协议；服务端为无状态 Streamable HTTP（JSON 响应），默认校验 Origin，可挂在路由上。
- 前端：`@hazejs/ai/client`（与框架无关的 `createChat`）、`@hazejs/ai/vue`、`@hazejs/ai/react` 的 `useChat`；`convertUIMessages` 把 AI SDK 的 UIMessage 转为 `Message`。

**框架集成与模板**
- `config/ai.ts`（`defineAIConfig`：default、aliases、defaults、providers 的 driver 配置）+ `aiProvider()`；`registerAIDriver` 扩展 driver。`@hazejs/ai` 对 `@hazejs/core` 只是可选 peer 依赖，单独使用时直接传模型对象或调用 `configureAI()`。
- `AI` 门面与 `AI.fake()`（按顺序回复、记录请求、断言；Embedding / 图像 / 语音返回确定性假数据）。
- 模板：`config/ai.ts`、`AIProvider`、`POST /api/chat`（`ChatController`：流式 SSE、示例工具、限流、valibot 校验）、`tests/chat.test.ts`；全栈模板首页加入 `AiChat` 组件（经 `headers` 函数带上 CSRF 令牌）。

**实现方式与验证**
- 核心、OpenAI / 兼容厂商、Agent / 记忆 / 向量、框架集成与模板由主线完成；Anthropic、Gemini、云平台、MCP、前端客户端由 5 个子代理并行实现（各自独占文件，对照官方文档核对协议细节），再统一集成与审阅。
- 测试：本地模拟服务器按各厂商真实的请求 / 响应格式（JSON、SSE、AWS event stream、multipart）校验，共 134 个；未使用真实 API Key 做在线验证。

**已知限制**
- Gemini 流式输出中文本上的签名经推理事件传递（文本 part 暂无 providerMetadata），无推理的回答 `reasoningText` 可能为空字符串。
- Workers AI 的 JSON 模式不支持流式，流式时忽略 `response_format` 并给出警告。
- MCP 尚未实现多轮请求（elicitation、sampling）与资源订阅；服务端只返回 JSON，不返回 SSE。
- 我们的 SSE 协议不传递推理签名，客户端回传的历史中推理内容不带签名（Anthropic / Bedrock 适配器会丢弃无签名的推理）。

### M20 实施记录（2026-10-28）：OpenAPI 与类型安全的客户端

- `generateOpenAPI(app)` 由路由生成 OpenAPI 3.1：`:id` → `{id}`，operationId 取路由名，默认 tag 取第一个路径段（跳过 `api`、`v1` 等）；参数与请求体来自 `.validate()` 的 schema（zod 4 / arktype 的 Standard JSON Schema，valibot 经可选依赖 `@valibot/to-json-schema`），含文件字段时请求体为 `multipart/form-data`；转换失败退化为 `{}`，`$defs` 提升到 `components.schemas`。
- 响应：成功响应按 `app.response.envelope` 包装（路由或全局可关），自动补 422；带 `auth` 中间件的路由补 401 与安全要求（JWT 守卫 → bearer，session 守卫 → Cookie），带 `can:` 的补 403。
- 路由文档：`.doc({ summary, description, tags, deprecated, operationId, response, status, security, hidden })`，资源路由的 `.doc()` 作用于全部动作。
- `config/openapi.ts`（`defineOpenAPIConfig`）：默认生产环境关闭；`/openapi.json` 与 `/docs`（Scalar 或 Swagger UI，jsDelivr 固定版本）。中间件安装在全局中间件之前（CSP、鉴权、CSRF 不影响文档页），文档在首次请求时生成并缓存。
- typegen 为每个命名路由生成方法、路径、参数 / 查询 / 请求体与输出类型：通过模块图导入 controller / validate 模块，按对象身份匹配 schema 与控制器，匹配到的用 `SchemaInput<typeof import(...)>` 与 `Awaited<ReturnType<...>>`，内联 schema 由 JSON Schema 转为 TS 类型，闭包处理器为 `unknown`；运行时路由表写入 `.haze/routes.ts`。
- `@hazejs/core/client` 的 `createClient({ routes, baseURL })`：零依赖，按信封解包，输出类型经 `Serialize<>`（`toJSON`、Date → string、去掉方法）。
- `haze openapi [-o file]`。

已知限制：多应用按域名绑定的路由需要各自的 baseURL；`r.any()` 路由不出现在文档中；自定义 `ResponseFormatter` 时错误响应的结构按默认信封描述；全栈模式下后端只接收 `/api/*`，需把文档路径配置为 `/api/openapi.json`。

### M21 实施记录（2026-10-28）：自定义命令与 REPL

- `defineCommand({ name?, description, args, run(args, ctx) })`，放在 `app/command/**`；文件名转命令名（`SendReport` → `send:report`，`db/PruneOld` → `db:prune-old`，去掉末尾的 `Command`），`name` 优先；重名报错，与内置命令同名时跳过并警告。
- 参数定义与 citty 兼容（positional / string / boolean / enum、alias、default、`--no-`），core 内置解析器，生产构建无需 citty；`run` 返回数字作为退出码，抛错退出码为 1。上下文：`app`、`logger`、`prompt / confirm / ask / choice`（consola）。
- 发现：清单中 `discovered.commands` 为非 eager 的 glob，Web 服务不会执行命令模块；CLI 只在第一个参数不是内置命令（或打印命令列表）时才启动应用加载命令。
- 生产：`node dist/server/worker.mjs command <name> [...args]`。
- `haze repl`：启动后的应用、`config`、`inject`、各门面、`Db`（安装了 ORM 时）和 `app/model` 下的模型；顶层 await；串行求值（管道输入不会并发）；热重载后刷新上下文；`--eval` 先按表达式求值，失败再按 async 函数体执行。
- 生成器：`make:command`（无后缀、可带子目录、不支持 `--app`）、`make:mail`（后缀 `Mail`）。模板新增示例命令 `inspire`。

已知限制：命令不区分应用（没有 `app/<name>/command`）；Serverless / 边缘预设没有命令入口。

### M27 实施记录（2026-10-28）：@hazejs/graphql 与 @hazejs/microservices

确认的决策：协议库作为可选 peer（graphql、@grpc/grpc-js + @grpc/proto-loader、NATS、ioredis）。

**@hazejs/graphql**
- schema-first：`defineSchema({ typeDefs, resolvers })` 通过各类型的 `toConfig()` 重建 schema（不修改 graphql-js 内部字段），标量与枚举内部值可用，解析器指向不存在的类型或字段时启动即报错；code-first 只提供 `objectType` / `inputType` / `field` 等薄封装，原生 graphql-js schema 直接可用。peer 范围 graphql 16 / 17（测试使用 17）。
- GraphQL over HTTP：GET / POST，按 Accept 协商 `application/graphql-response+json`（请求错误返回 400）与 `application/json`（一律 200）；GET 执行 mutation 返回 405，415 / 406；请求体遵守 bodyLimit。
- 上下文：`http`、`auth`、`can`、`authorize`、`inject`、`loader(def)`；解析器在请求作用域内执行。`createLoader` / `defineLoader` 自研，语义同 DataLoader，每个请求一个实例。
- 错误映射到 `extensions.code`（401 UNAUTHENTICATED、403 FORBIDDEN、404 NOT_FOUND、422 BAD_USER_INPUT 附 issues、业务异常 BUSINESS_ERROR），未知错误在非 debug 下隐藏消息并上报。
- 限制：`maxDepth` 默认 15（展开片段），`maxComplexity` 默认关闭；生产环境默认关闭内省与 GraphiQL。GraphiQL 从 esm.sh 加载固定版本并带 SRI。
- 订阅：同一路径的 WebSocket 升级，`graphql-transport-ws` 协议；`connection_init` 时按升级请求头重建上下文，payload 中的 token 作为 Authorization。`createPubSub()` 仅限本进程。
- `graphqlProvider()` 注册的路由在 OpenAPI 文档中隐藏。

**@hazejs/microservices**
- `defineMessageHandler(pattern, handler, { schema })`，放在 `app/message/*.ts`；同一处理器响应 `send`（请求 / 响应）与 `emit`（事件），`ctx.kind` 区分；可选 Standard Schema 校验（失败返回 422）。
- `Microservice.client(name).send(pattern, data, { timeout })` / `emit()`；错误均为 HttpException：远端 4xx 与业务异常保留状态码（RemoteError），其它远端错误 502，超时 504，无监听者 503，无对应处理器 404。
- 传输：
  - memory：进程内总线，载荷经 JSON 序列化，与网络传输行为一致；
  - redis：请求写入列表、各实例 BRPOP 竞争消费（每个请求只处理一次），事件与回复走 pub/sub；无监听者只能等到超时；
  - nats：request / reply + 队列组（队列组 = 配置中的 `name`），无订阅者立即 503；使用官方后继包 `@nats-io/transport-node`（`nats` 包已弃用），加载失败时回退到 `nats` v2；
  - grpc：仅 Node、仅一元方法，proto 方法映射到消息模式（默认 `服务名.方法名`），错误详情放在 `x-haze-error-bin` 元数据。
- `haze microservice:listen [--transport a,b]`：在开发服务器的模块图中启动应用，每条消息使用热替换后的最新应用；未安装包、未注册 provider 或未配置传输时给出明确错误。
- protobufjs（@grpc/proto-loader 的依赖）的 postinstall 只做版本检查，在 `allowBuilds` 中设为 false。

已知限制：没有 `Microservice.fake()`（测试使用 memory 传输）；gRPC 不支持流式方法；GraphQL 订阅的 pubsub 不跨实例。

### M23 实施记录（2026-10-28）：多语言、API 资源、签名链接与加密

- 多语言：`lang/<locale>/*.ts`（默认导出嵌套对象，键为 `文件.路径`），`{name}` 插值，`Intl.PluralRules` 复数（`{ one, other }` + `{count}`），回退语言。`config/i18n.ts` 的 `detect` 依次检测查询参数、Cookie、Accept-Language（先精确匹配，再按语言部分匹配，`zh` / `zh-TW` → `zh-CN`），结果按请求缓存。优先级：`withLocale`（AsyncLocalStorage）> 请求语言 > 请求之外的 `setLocale()` > 默认语言。
- 只有存在 `config/i18n.ts` 时才翻译校验错误与框架异常消息，`t()` 始终可用；未配置时行为不变。校验消息只替换校验库的默认英文消息（valibot、zod 4；arktype 不翻译），schema 中自定义的消息原样保留（若本身是翻译键则翻译）；支持 `validation.attributes.<字段>` 与 `validation.custom.<路径>.<规则>`。框架异常按"已知默认消息 → `http.*` 键"翻译，zh-CN 文案与原有中文一致。
- 邮件：`defineMail({ locale })` 与 `Mail.to(...).locale()`，渲染时包在 `withLocale` 中。typegen 以 `lang/en`（没有时取第一个语言）生成翻译键类型（`.haze/types/i18n.d.ts`），拼错的键编译报错。
- API 资源：`defineResource((model, ctx) => ({ ... }))`，`make()` / `collection()` 返回可 await 的 `PendingResource`；条件不成立的字段整个移除（`when`、`whenLoaded`、`whenNotNull`、`merge`），字段可以是异步的。分页结果输出 `{ data, meta, links }`，放在信封的 `data` 中（类型安全的客户端只解出 `data`，不丢分页信息）。`haze make:resource`。
- 签名链接：HMAC-SHA256（APP_KEY）覆盖用途前缀 + 路径 + 排序后的查询参数，不含主机；校验使用原始请求 URL（多应用剥离前缀不影响）。`signed` 中间件（`signed:a,b` 忽略这些查询参数）、`ctx.hasValidSignature()`；旧密钥签发的链接在轮换后仍然有效。
- 加密：`Crypt.encrypt / decrypt / encryptString / decryptString`，AES-256-GCM（WebCrypto，各运行时可用），密钥经 HKDF（info `hazejs crypt`）从 APP_KEY 派生，与 Session 加密隔离；载荷 `v1.` + base64url(iv ‖ 密文 ‖ 标签)，AAD 绑定版本；`app.previousKeys` / `APP_PREVIOUS_KEYS` 用于解密；失败抛出 `DecryptException`。
- 模板：默认语言 zh-CN（不带语言头的响应与之前一致），`lang/en` 与 `lang/zh-CN`，`UserResource`（只对本人和管理员输出邮箱），欢迎邮件使用 `t()`；用户列表的响应变为 `{ data, meta, links }`。

已知限制：多应用模式下只读取全局的 `config/i18n.ts`；请求之外调用 `I18n.setLocale()` 影响整个进程（建议使用 `withLocale`）；前端暂不共享翻译。

### M22 实施记录（2026-10-28）：通知与广播

**通知**
- `defineNotification({ via, toMail, toDatabase, toBroadcast, toSlack, toWebhook, toWecom, toDingtalk, toFeishu, queue })`；`notify(user, n)` / `Notification.send(users, n)`，按需发送 `Notification.route('mail', ...).route('slack', url).notify(n)`。
- 渠道：mail（M18 邮件）、database（`@hazejs/orm` 的 `databaseNotificationStore`，表由 `haze make:notifications-table` 生成）、broadcast（默认 `private-<type>.<id>`，事件名 `notification`）、slack（incoming webhook）、webhook（JSON POST，可选 HMAC 签名与 `verifyWebhookSignature`）、企业微信 / 钉钉（可选加签）/ 飞书（可选签名）群机器人；`registerNotificationChannel` 自定义渠道。厂商返回的 errcode 与 HTTP 错误都会抛出。
- 排队：渲染在发送时完成，每个渠道一个 `notification:send` 任务，任务携带地址与内容的 JSON（worker 不需要通知定义）；重试取 `config.notification.queue`（默认 3 次，退避 [10, 60]）。
- 被通知者：ID 取 `getKey()` 或 `id`，类型取 `notifiableType` 或类名（普通对象为 `User`）。`Notification.fake()` 提供断言。

**广播**
- 频道授权放在 `app/channel/*.ts`（`route/*.ts` 会被当作路由模块加载），`defineChannels(c => { c.private('orders.{id}', ...); c.presence('chat.{room}', ...) })`。
- `broadcast({ channel, event, data })`；`defineEvent` 可声明 `broadcastOn / broadcastAs / broadcastWith / broadcastWhen`，`Events.dispatch()` 时先广播再执行监听器（`Events.fake()` 时不广播）。
- 投递路径：`broadcast()` → 总线（memory / redis，未配置时复用 `config/websocket.ts` 的 Redis）→ 进程级 hub → 各连接；不使用 crossws topic 或 `io.to(room)`，避免与已有的跨实例同步重复投递。Presence 成员存于 Redis hash（MULTI 保证原子性），同一用户多连接去重。
- 传输：内置 `/broadcasting/ws`、`/broadcasting/sse`，Socket.IO 在 `config/socketio.ts` 中开启 `broadcasting: true`。授权：ws / socket.io 默认调用 `POST /broadcasting/auth` 获取 APP_KEY 的 HMAC 签名（任意实例可校验），未带签名时按升级 / 握手请求头直接授权；SSE 在请求内逐个授权，频道变化时先建新流再关旧流。
- 前端客户端 `@hazejs/core/echo`（零依赖，socket.io 通过传入 `io` 支持）：`channel / private / join / listen / notification / whisper / here / joining / leaving`。`Broadcast.fake()`。

已知限制：进程崩溃时 Redis 中的 presence 成员不会过期；Workers 中 `broadcast()` 到不了 Durable Object 内的 WebSocket；SSE 重新订阅的重叠期间可能收到重复消息；模板暂不包含通知表。

### M24 实施记录（2026-10-28）：可观测性

- 健康检查：默认开启 `/health`（与 `/health/ready` 相同）与 `/health/live`，默认没有检查项；内置 `cacheCheck / dbCheck / redisCheck / storageCheck / queueCheck`，区分关键与非关键（degraded），超时中止；生产环境响应只给出 `check failed`（原因写日志）；用户定义了同路径的 GET 路由时让位。安装在全局中间件之前，不包信封，不写访问日志。
- OpenTelemetry（`@opentelemetry/api` 为可选 peer，`observability.otel.enabled` 显式开启）：请求 SERVER span（`http.request.method`、`url.path`、`http.route`、`http.response.status_code`），入站 traceparent 接续，`tracedFetch` 出站传播；队列投递时把追踪上下文写入任务，worker 中 PRODUCER → CONSUMER 接续；SQL、邮件、缓存（默认关闭）、AI（`gen_ai.*`）的 span 在操作结束后按真实开始时间补建；指标 `http.server.request.duration`、活跃请求数、任务耗时与失败数；日志带 `trace_id / span_id`。未安装、未开启或被打包器替换为空模块时都是空操作。
- 遥测总线：`globalThis[Symbol.for('hazejs.telemetry')]` 上的约定结构，ORM 与 AI 不依赖 core（ORM 包装 drizzle session 的 `prepareQuery` 并通过 `logQuery` 取 SQL 与绑定；AI 用 Proxy 包装模型），没有监听者时只判断一次 `Set.size`。
- 日志通道：`channel` / `channels`，stack 组合与按通道级别；`json`、`file`（按天轮转、maxFiles，仅 Node）、`http`（按条数与间隔批量发送，ndjson / loki / 自定义格式，失败写 stderr）、自定义传输；`logger.channel(name)`；应用 dispose 时写出并关闭。未配置时行为不变。
- 开发面板 `/__haze`：只在 development 模式启用；按请求 ID 关联请求、SQL、任务、邮件（渲染预览，`CSP: sandbox`）、事件、缓存、日志与 AI 调用；环形缓冲（默认每类 500 条，跨 HMR 保留），敏感请求头脱敏，SSE 实时更新，错误页链接到对应请求。写操作要求 `x-haze-dashboard: 1` 请求头并校验同源。全栈开发时 Vite 把 `/__haze` 交给后端。
- 队列面板：开发面板中的 `/__haze/queues`（待处理与失败任务、重试、删除、清空）；生产环境用 `queueDashboard(r, { path })` 在 `auth` / `can:` 中间件保护下挂载。队列驱动新增可选的 `counts()`。

已知限制：OpenTelemetry SDK（exporter 等）需要用户自行初始化；Workers 中没有 AsyncLocalStorage 之外的上下文传播保证。

### M25 实施记录（2026-10-28）：认证扩展

确认的决策：OAuth、TOTP 等自研；WebAuthn 以 `@simplewebauthn/server` 为可选 peer；OAuth 覆盖国际主流、国内主流与通用 OIDC。

- `@hazejs/oauth`（唯一依赖 jose）：`OAuth.driver('github').redirect(ctx)` / `user(ctx)`，state + PKCE（存于 Cookie / Session）、`scopes()`、`with()`、`stateless()`、`userFromToken()`。驱动：GitHub、Google（OIDC）、Apple（form_post、ES256 client secret、id_token 校验）、Microsoft（Entra ID 租户）、GitLab（可自建）、Discord、微信开放平台（扫码）、微信公众号、QQ（`/oauth2.0/me` 取 openid、unionid）、钉钉、飞书 / Lark、企业微信、支付宝（RSA2 签名）、通用 OIDC（discovery + JWKS 校验 RS256 / ES256 + nonce）；`defineOAuthProvider` 自定义。测试使用进程内的模拟厂商服务。
- 个人访问令牌：明文 `id|secret`（可加前缀）只返回一次，只存 SHA-256 并常量时间比较；格式错误的 ID 在查库前拒绝（避免 PG 整数主键报 500）；`last_used_at` 至多每分钟写一次；`token` 守卫、`ctx.auth.tokenCan()`（jwt / session 用户视为第一方，返回 true）、`abilities:` / `ability:` 中间件，能力支持 `*` 与 `prefix:*`；注销时撤销当前令牌。
- 邮箱验证：复用 M23 的签名链接，链接含邮箱的 SHA-256（修改邮箱后失效，登录用户不能验证他人的链接）；`verified` 中间件。密码重置：每个邮箱一个哈希令牌，带过期与节流，返回状态而不抛异常（控制器可以不暴露邮箱是否存在）。
- TOTP（RFC 6238 / 4226）：密钥用 M23 的 `Encrypter` 加密保存，恢复码哈希保存，记录最后使用的时间步防重放；Session 挑战流程超过 `maxAttempts` 清除；已确认的 2FA 再次 `enable()` 返回 409（除非 `force`）。
- 通行密钥：挑战默认存于 Session，或按 clientDataJSON 中的 challenge 存于缓存（无状态 API）；按需加载 `@simplewebauthn/server`，未安装时给出明确错误；测试使用软件 ES256 认证器（none attestation）。
- 存储：core 定义 `TokenStore / PasswordResetStore / TwoFactorStore / PasskeyStore` 与内存实现，`@hazejs/orm` 提供结构兼容的 `database*Store(table)`；表由 `haze make:auth-tables` 生成。`authRoutes()` 注册带校验的现成路由。
- 模板：令牌、邮箱验证、密码重置与 GitHub 登录（未配置环境变量时不可用）的控制器与路由，新增迁移 `0003_add_auth_tables`。

已知限制：飞书 v2、钉钉、企业微信 SSO 与支付宝沙箱的接口需要对照厂商最新文档复核；Apple 的 POST 回调在全栈模板中需要加入 `csrf.except`；没有 `social_accounts` 表（示例按邮箱关联账号）；模板未接入 2FA 与通行密钥。

### M26 实施记录（2026-10-28）：全文搜索与多租户

确认的决策：搜索引擎支持数据库（MySQL / PG 全文、SQLite FTS5、LIKE）、Meilisearch、Typesense、Elasticsearch / OpenSearch，均通过 fetch 实现，不依赖 SDK。

**@hazejs/search**（peer：core、orm、drizzle-orm）
- `searchable(Post, opts)` 保持 ORM 的静态类风格，通过 ORM 新增的通用钩子 `observeModel` 注册观察者（不覆盖 `onAfter*`，避免子类覆盖后静默失效）；文档默认取 `toJSON()`（隐藏字段不入索引）。`search(Post, q)` / `Post.search(q)`：`where / whereIn / orderBy / paginate / get / raw / keys / options`。
- 数据库引擎直接返回 `ModelQuery` 的模型（软删除、全局作用域与租户作用域都生效）：MySQL `MATCH ... AGAINST`（natural / boolean），PostgreSQL `to_tsvector('<lang>'::regconfig, ...) @@ websearch_to_tsquery`（语言内联以匹配 GIN 表达式索引，也可指向 `vectorColumn`），SQLite FTS5（`triggers` 外部内容表 + 触发器，或 `engine` 独立表、可索引计算字段；用户输入加引号避免语法错误，末项前缀匹配），LIKE（`escape '!'`，PG 用 `ilike`）。DDL 由 `search:sync-settings`、`createSearchIndex()` 或 `searchIndexSql()` 生成。
- 同步：模型事件触发 upsert / delete，可排队（`search:sync` 任务携带预先计算的文档与索引描述，worker 不需要模型）；数据库引擎总是同步执行；`withoutSyncing()`、`Search.fake()`。命令 `haze search:import / search:flush / search:sync-settings`。
- 引擎细节：Meilisearch 的任务由 `settle()` 等待（命令总会等待）；Typesense 自动建集合并分页越过 250 条上限；Elasticsearch 字符串过滤使用 `.keyword` 子字段。

**多租户**（core + ORM）
- `config/tenancy.ts`：按域名、子域名、请求头、路径（路由需声明 `/t/:tenant`，不改写 URL）或自定义解析器识别租户，`find(key)` 查询租户，未知租户 404；租户 ID 限定 `[\w.-]`。中间件安装在 OpenAPI 与健康检查之后、全局中间件之前（异常经 ExceptionHandler 渲染）。
- 上下文：独立的 AsyncLocalStorage，`useTenant()` / `ctx.tenant` / `Tenancy.run(tenant, fn)`；排队任务自动携带租户并在 worker 中恢复（租户已不存在时任务失败）。
- 隔离：缓存键前缀、存储目录前缀（签名链接带前缀路径，FakeDisk 断言仍可用）、Session Cookie 名与密钥；数据库二选一：每租户独立连接（`DatabaseManager.resolveName` 解析为 `<name>@<tenant>`，连接配置按租户计算并缓存），或共享库 + `static belongsToTenant`（`tenant` 全局作用域自动过滤、插入时自动填充，可 `withoutGlobalScope()`）。每租户独立数据库时搜索索引名自动加 `<tenant>_` 前缀；共享库时外部引擎自动按租户列过滤。

已知限制：搜索同步不等待事务提交（ORM 尚无 after-commit 钩子）；租户上下文之外 `belongsToTenant` 不过滤；租户连接池没有 LRU 淘汰；`Queue.fake().drain()` 不携带租户；开启多租户会改变 Session Cookie 名（已有会话失效）。

### M28 实施记录（2026-10-28）：模块化

确认的决策：
- 两种来源：npm 包（显式启用）与本地目录 `modules/<name>/`（自动发现，目录结构与应用相同），都得到同一种 `defineModule()` 定义；
- 模块合并进同一个应用，共用容器、守卫、响应格式、异常处理与数据库连接，不做隔离（隔离用多应用）；
- 脚手架：`haze make:module` 生成本地模块，`create-hazejs --template module` 生成可发布的模块包。

**定义与启用**
- `defineModule({ name, prefix, as, routeMiddleware, app, connection, config, routes, middleware: { alias, groups, global }, providers, interceptors, jobs, events, listeners, schedules, policies, notifications, channels, commands, discovered, migrations, options })`，返回值可直接启用，也可以带选项调用（`blog({ prefix, as, middleware, app, connection, ...自定义选项 })`）；`options(opts)` 返回的字段与定义合并（列表追加，同名配置深合并）。
- 启用写在 `config/modules.ts`（`defineModulesConfig({ modules, local })`），没有放进 `config/app.ts`：模块包的 import 会带进控制器等代码，单独一个文件更清楚，也可以用函数形式按环境变量启用。`local` 中 `false` 关闭本地模块、对象为挂载选项，写了不存在的本地模块名直接报错。
- 挂载选项中路由名前缀用 `as`（与 `r.group({ as })` 一致），没有用草案中的 `name`，避免与模块名混淆；默认 `<模块名>.`，`''` 保留模块自己的路由名。模块级的“额外路由中间件”在定义中叫 `routeMiddleware`，`middleware` 留给别名 / 分组 / 全局中间件（与 config/middleware.ts 同形）。
- 启用顺序：`createApplication({ modules })` → `config/modules.ts` 的 `modules` → 按目录名排序的本地模块；同名模块报错。
- 本地模块：清单新增 `modules` 记录（`module.ts`、`route/*`、`config/*`、`schedule/*`、`app/{provider,interceptor,policy,job,event,listener,notification,channel,socket,message}/*` 为 eager，`app/command/**` 按需加载），键去掉 srcDir 前缀；core 的 `groupLocalModules()` 按模块分组并保留文件路径，任务名、事件名、命令名（`db/Prune.ts` → `db:prune`）等按文件名命名的规则不变。`config/middleware.ts` 视为模块的中间件声明，其余 `config/*.ts` 为默认配置；可选的 `module.ts` 覆盖约定（列表追加、配置深合并），本地模块名固定为目录名。
- 模块包没有文件名：任务、事件、命令等用 `{ 名称: 定义 }` 或定义自身的 `name`。

**加载顺序与冲突**
- 配置：框架默认值 → 模块默认配置（按启用顺序）→ 项目 config/*.ts，均为深合并；为此 `#loadConfig()` 先求值全部配置文件，读取 `modules` 后再合并。
- 提供者：模块的先 `register()`，项目可以覆盖模块的绑定；任务 / 事件 / 监听器 / 定时任务 / 策略 / 拦截器同样模块在前（同名任务以项目为准），`app.discovered(name)` 也包含模块的定义（Socket.IO、微服务、通知、频道直接受益）。
- 中间件：模块的别名与分组合并进 `config.middleware`（子应用的注册表因此也能用）；模块之间、模块与内置中间件同名时报错并给出双方来源，项目 config/middleware.ts 中同名即为显式覆盖。模块的全局中间件在项目全局中间件之后执行。
- 路由：在项目路由之后加载，走同一套 `Router.load({ as, prefix, middleware, module })` → `compile()`；`RouteDefinition` / `RouteInfo` 新增 `module`，重名报错附带来源（`(the app and module "blog")`）。`app: 'admin'` 时模块路由加载到子应用的路由表（路由名 `admin.<as>…`），只影响路由；子应用未声明时启动报错。
- 自定义命令：新增 `app.commands()`（模块命令 + app/command，跨来源重名报错），CLI 与 `worker.mjs command` 改用它；CLI 在有本地模块命令或 `config/modules.ts` 时才启动应用加载命令。

**迁移**
- drizzle 的迁移器只看记录表中最后一条记录的 `created_at`，多个目录共用 `__drizzle_migrations` 时，时间戳较早的目录会被整体跳过（已用“模块时间戳晚于项目”的用例复现）。因此每个模块使用自己的记录表 `__drizzle_migrations_<模块名>`（驼峰转下划线），项目仍为 `__drizzle_migrations`（与 drizzle-kit migrate 兼容）。`migrate({ table })` 透传给 drizzle 的 `migrationsTable`（PG 仍在 `drizzle` schema 下），SQLite / Turso / D1 的自带执行器同样使用该表名。
- 顺序：每个连接先按启用顺序执行模块迁移，最后执行项目迁移；模块没有迁移目录时跳过；只有模块迁移时项目缺少迁移目录不再报错。`runMigrations` 的结果带 `module`，`db:migrate` 按模块输出。
- 模块迁移目录：本地模块默认为 `modules/<name>/database/migrations`（相对 srcDir）；模块包用 `new URL('../database/migrations', import.meta.url)`。`databaseProvider()` 把 `app.modules()` 的迁移目录交给 `DatabaseManager`；`refreshDatabase()` 同样先执行模块迁移（`modules: false` 关闭），默认迁移目录改为应用 srcDir 下的 `database/migrations`（宿主应用没有自己的迁移时跳过），相对目录以新增的 `app.srcDir`（清单在开发 / 测试中提供）为基准。
- 生产构建：`virtual:haze/migrations` 增加本地模块的 glob，并在构建时读取 `"hazejs": { "module": true }` 依赖包中的迁移（键为 `node_modules/<包名>/<包内路径>`）。模块包被打包后 `import.meta.url` 指向产物，插件的 transform 只把指向迁移目录（含 `meta/_journal.json`）的字面量 `new URL(..., import.meta.url)` 改写为该键，其它 `import.meta.url` 不动。没有选择“迁移文件转成 JS 模块”或要求包名重复声明的方案：前者需要模块包自带额外构建步骤，后者容易与 package.json 不一致。
- `haze db:generate --module <name>` 读写 `modules/<name>/database/{schema,migrations}`，连接取 `--connection`、模块的连接或 default。

**Vite / HMR / 依赖**
- 模块包的识别：项目 package.json 的依赖中，`package.json` 带 `"hazejs": { "module": true }` 的包。
- 开发：本地模块在应用的模块图中，新增文件触发清单重算；以 workspace / `link:` 链接的模块包（真实路径不在 node_modules 中）显式加入 `ssr.noExternal`（Vite 对链接包本就内联，这里保证行为明确），修改后热替换；已发布的模块包按普通依赖 external。
- 构建：node / bun 的 `drivers-external` 与 cloudflare 的全量打包本就会打包模块包；`externals.trace: false`（依赖全部 external）时也把模块包加入 `noExternal`，保证与应用共用同一份 core，且迁移目录可以内嵌。nf3 追踪与驱动 external 不受影响。
- 预设上下文：定时任务与 WebSocket 的检测也扫描本地模块（`schedule/`、`route/` 中的 `.ws(`）。
- typegen：模块路由来自 `router.list()` 自然包含；本地模块的 `config/*.ts`（项目没有同名配置时）写入 `GeneratedConfig`，`modules/*/app/policy` 写入能力类型，控制器 / 校验 schema 的扫描覆盖 `modules/*/app`。模块包的配置类型由包自带的 `declare module '@hazejs/core' { interface ConfigSchema }` 提供（模板中有示例，tsdown 的 d.ts 保留该扩充）。

**CLI**
- `haze make:module <name>`：`module.ts`（默认前缀 `/api/<name>`，全栈模板的后端前缀也能命中）、路由、控制器、`config/<name>.ts`、`tests/<name>.test.ts`。
- `make:* --module <name>`（`-m`）生成到 `modules/<name>/` 下，测试为 `modules/<name>/tests/`；模块不存在或与 `--app` 同用时报错；`make:model --module` 的表结构写到模块的 `database/schema`（model.stub 的导入路径改为 `{{schemaDir}}` 变量）。
- `haze module:list [--json]`：启用顺序、来源、前缀、路由名前缀、路由数、迁移目录；`route:list` 有模块路由时增加 MODULE 列；`db:seed` 先执行已启用本地模块的 `database/seeders`。

**create-hazejs 的 module 模板**
- tsdown 构建（`dist/index.mjs` + `index.d.mts`），`files: ['database', 'dist']`，`"hazejs": { "module": true }`；`defineModule` 入口带路由 + 控制器（ORM 读写 `<name>_posts` 表）+ 中间件别名 + 默认配置（含 ConfigSchema 扩充）+ 迁移 + 带类型的 `perPage` 选项。
- 测试使用 `tests/app` 作为宿主应用（`defineHazeTestConfig({ haze: { srcDir: 'tests/app' } })`），宿主在 `config/modules.ts` 中以源码启用模块，`refreshDatabase()` 只执行模块的迁移。
- 模板源码中的占位符只出现在字符串和注释里（如 `'{{moduleName}}': PostsConfig`），保证模板本身能通过 ESLint；新增模板变量 `moduleName`（驼峰）与 `moduleTable`（下划线）。

**验证**
- core `modules.test.ts`（12 个）：defineModule 与带选项启用、迁移目录归一化、配置优先级、提供者顺序与覆盖、中间件合并与冲突、前缀 / 路由名前缀 / 额外中间件、路由重名来源、子应用挂载、任务 / 事件 / 监听器 / 定时任务 / 命令 / 策略 / 通知 / 频道注册、本地模块分组（manifest 形式的输入）、关闭与未知本地模块、包与本地模块的顺序及重名。
- orm：三种方言（SQLite、D1、PGlite；MySQL / Turso 按环境变量）上验证模块迁移先于项目迁移、各自的记录表、重复执行为 0、只有模块迁移时不报错；`modules.test.ts` 用真实应用 + `databaseProvider()` 验证 runMigrations 与 refreshDatabase 包含本地模块与模块包。
- cli：`make:module` 与 `--module` 的生成位置、提示与错误。
- vite `modules.test.ts`（3 个）：fixture 含本地 `modules/blog` 与链接进 node_modules 的模块包 `@demo/news`：识别模块包、开发服务器提供两者的路由、修改本地模块与链接包后热替换、typegen 输出模块路由与本地模块配置、node 预设产物运行模块路由且迁移目录被改写为内嵌键。
- 全部测试：77 个文件，886 个通过、37 个跳过（之前为 73 个文件、864 个通过、37 个跳过）。
- create：module 模板生成 → tsc → 自带测试（3 个）→ tsdown 构建；api 模板中 `make:module` / `make:model --module` / `db:generate --module` / `make:command --module` + 链接安装的 module 模板包：`db:migrate` 两次（包 → 本地模块 → 项目，第二次全为 0）、`module:list`、`route:list`、模块命令、typegen + 类型探针 + tsc、模板测试加模块测试 20 个通过；生产构建后在全新数据库上执行 `migrate.mjs` 两次、启动产物读写模块包的表、`worker.mjs command` 列出模块命令、`worker.mjs schedule:run` 执行模块的定时任务。

已知限制：模块没有隔离（中间件别名、全局中间件、提供者作用于整个应用），`app` 挂载只影响路由；模块不能有自己的异常处理器、响应格式与 `lang/`；`module.ts` 内联的默认配置没有类型；模块迁移先于项目迁移，不能依赖项目的表；生产内嵌要求迁移目录写成字面量 `new URL()`；Cloudflare D1 的 `wrangler d1 migrations apply` 只包含项目的迁移，模块包的定时任务 / WebSocket 不参与 Cloudflare 的自动检测；`db:seed` 不执行模块包的数据填充。

### M29 实施记录（2026-10-28）：统一 Redis 连接

背景：所有 TCP 访问早已统一为 ioredis 6（BullMQ 以它为 peer，Socket.IO 适配器直接拿 ioredis 实例），但连接配置分散在六处（缓存、队列、WebSocket 广播、广播总线、Socket.IO 适配器、微服务传输），各自默认 `redis://127.0.0.1:6379`；只有缓存接受 ioredis 选项或现成的客户端；每个功能各自建立连接；“动态导入 ioredis、取 `Redis` 或 `default`、报安装提示”的代码有五份且提示各不相同；应用代码没有 Redis 入口，`redisCheck` 只能探测缓存存储。`@upstash/redis`（HTTP）是边缘运行时的缓存驱动，不在本次范围内。

确认的决策：
- `config/redis.ts`（`defineRedisConfig`）声明命名连接，`CoreConfig` 新增 `redis` 键；缺省该文件时只有隐式的 `default` 连接（`REDIS_URL`，未设置时 `redis://127.0.0.1:6379`）；
- 各功能用 `connection: '<name>'` 引用连接，原来的 `url` / `options` / `client` 写法保留且优先；都不写时用默认连接，一个 `REDIS_URL` 配置全部功能；
- core 中的连接管理器负责共享与专用连接、关闭与热更新；新增 `Redis` 门面、`useRedis()`，`redisCheck(name)` 按连接 PING。

**配置与解析**（`packages/core/src/redis/{config,load,manager}.ts`）
- 一个连接是单机（`url` 或 host / port / username / password / db / tls）、Cluster（`cluster` 节点，节点选项在 `options.redisOptions`，顶层的认证与 TLS 复制进去）、Sentinel（`sentinels` + `name`）或自定义 `client` 工厂之一，另有 `keyPrefix` 与透传的 `options`。`client` 设计为工厂而不是实例：专用连接（订阅、阻塞命令、BullMQ）需要用同样的设置再建立连接，实例只能 `duplicate()`。
- `default` 未设置时取 `default`，不存在则取第一个连接；有 config/redis.ts 时以它为准，不再补隐式连接。
- 功能配置统一扩展 `RedisConnectionRef { connection?, url?, options? }`，由 `redisTarget()` 转成解析目标；优先级 `client`（只有缓存）> `url` > `connection` > 默认连接。`options` 与 `url` 一起是内联连接的选项，与 `connection` 一起时覆盖命名连接的选项（共享池的键包含设置的指纹，此时得到单独的连接）。缓存内联 `url` 的旧写法保留原默认值 `maxRetriesPerRequest: 2`，命名连接严格使用配置的选项（ioredis 默认值）。
- 连接名的类型：`defineRedisConfig` 以 `const` 泛型保留连接名，typegen 本来就为每个 config 文件生成 `ConfigValue<typeof import(...)>`，`RedisConnectionName` 直接从 `GeneratedConfig['redis']['connections']` 取键（未生成时为 string），无需改 typegen。门面与各功能配置的 `connection` 使用它；管理器内部方法接受 string，避免生成类型后内部代码报错（已用临时的声明合并验证：错误的连接名在功能配置与 `Redis.connection()` 处报错，core 源码不报错）。
- `loadRedis(feature)` 是唯一的 ioredis 加载入口（静态的 `import('ioredis')` 保证构建追踪），只加载一次，缺失时统一提示 `<feature> requires ioredis. Install it with: pnpm add ioredis`。缓存、WebSocket、广播总线、Socket.IO、微服务原来的五份代码全部删除；微服务的 Redis 传输不再使用自己的 `importOptional`（gRPC / NATS 仍用）。

**共享规则**
- `client(target)`：共享的命令连接，按“连接名（或内联地址）+ 设置指纹”放在 `definePersistent('redis:shared')` 中，跨热更新复用；`connection(name)` 返回命令代理（`Redis.connection('cache').get('k')`），代理不是 thenable，`client()` 取底层客户端做 pipeline / multi。
- `create(target, overrides)` / `subscriber(target)`：专用连接，按同样的设置新建（自定义工厂再调用一次；已有实例时 `duplicate()`，Cluster 的 duplicate 签名不同，选项放进 `redisOptions`），由调用方关闭，同时登记在 `redis:dedicated` 中兜底。
- 两个持久资源在管理器构造时（应用启动早期）就登记：`disposePersistent()` 按登记的逆序释放，广播总线、Socket.IO 等后登记的资源先关闭，关闭时还能使用 Redis。`app.dispose()`（非 hmr）断开全部连接，`reason: 'hmr'` 保留，与原来的 `disposePersistent` 语义一致；之后再使用会重新建立。
- 各功能的连接：缓存存储——共享；WebSocket 广播——发布用共享连接，crossws 由它 `duplicate()` 出订阅连接并自己关闭；广播总线——发布与在线成员 Hash 用共享连接，订阅用专用连接（随总线的持久资源关闭）；Socket.IO 适配器——pub 为共享连接，sub 为专用连接；微服务——应用内（`MicroserviceManager` 经新增的 `createTransport(config, { redis })` 传入应用的管理器）请求与回复的发布用共享连接，回复订阅、`BRPOP`、事件订阅各用专用连接；单独使用（不传管理器）时经 `useRedisManager()` 解析连接、全部连接都归传输所有并在 `close()` 时断开，避免独立脚本因共享连接未关闭而无法退出。门面在应用之外退回只有隐式 `default` 的管理器。
- `RedisManager` 在 `boot()` 中先于 CacheManager 创建并绑定（`setRedisManager` 供请求之外使用）；CacheManager / QueueManager / BroadcastManager / 健康检查 / 微服务 / Socket.IO 从容器取得；`webSocketPlugin` / `nodeUpgradeHandler` / `syncFromConfig` 增加可选的管理器参数（`app.serve()` 传入，Vite 开发服务器沿用最近启动的应用）。

**BullMQ**
- BullMQ 6 的 connection 接受 ioredis 选项（含 `url`，它自己 `new IORedis(url, rest)`）或实例；传实例时 Queue 共用、Worker 复制，且实例带 `keyPrefix` 时直接抛错；只有选项时无法创建 Cluster。因此 `bullmq(target)`：单机 / Sentinel 返回连接设置（去掉 `keyPrefix`，`maxRetriesPerRequest: null`），BullMQ 为每个 Queue / Worker 自己建立并关闭连接，与原来一致；Cluster 与自定义工厂返回一个专用实例（同样去掉 `keyPrefix` 并设置 `maxRetriesPerRequest: null`，Cluster 时放在 `redisOptions`），由队列驱动的 `close()` 断开。没有把共享命令连接交给 BullMQ：它的 `maxRetriesPerRequest` 与 `keyPrefix` 都可能不符合要求。
- 连接的 `keyPrefix` 不映射为 BullMQ 的 `prefix`（避免已有队列的键变化），队列仍用自己的 `prefix`（默认 `haze`），文档说明 Cluster 需要哈希标签。

**keyPrefix**
- ioredis 的 `keyPrefix` 只作用于键（包括 `EVAL` 的 KEYS），不作用于 pub/sub 频道，也不作用于 `SCAN` 的 MATCH 模式，而 SCAN 返回的键带着前缀、`DEL` 时又会再加一次。缓存存储的 `clear()` 因此用 `<keyPrefix><缓存前缀>*` 匹配，删除前去掉 `keyPrefix`（单元测试的假客户端按 ioredis 的行为模拟，真实 Redis 下整套缓存用例在带 keyPrefix 的命名连接上再跑一遍）。连接前缀位于缓存前缀之前：`<keyPrefix><prefix><key>`。
- 多租户在 CacheRepository 中给键加租户前缀，与存储使用哪个连接无关，不受影响。
- 广播总线的在线成员 Hash 与微服务的请求列表是键，会带上前缀；WebSocket 的 `channel`、总线的 `prefix`、Socket.IO 的 `key` 是频道前缀，多个应用共用 Redis 时仍需各自设置。

**健康检查与门面**
- `redisCheck(name?)`：先按 Redis 连接名（含隐式 `default`）PING 共享连接；不是连接名而是缓存存储名时沿用读写检查（旧写法）；都不是时为 down 并说明原因；不传名字时 PING 默认连接（原来默认检查名为 `redis` 的缓存存储）；传入带 `ping()` 的对象不变。
- `Redis` 门面是 Proxy：`connection` / `client` / `subscriber` / `create` 之外的属性都转为默认连接上的命令；常用命令有类型，其它命令返回 `Promise<any>`。`RedisManager` 也可以注入使用。没有做 `Redis.fake()` 与内存实现：需要模拟时可以在测试中 mock ioredis（core 的单元测试即如此），或用 `RedisManager` 的 `driver` 选项注入。

**其它修正**
- 微服务 Redis 传输的 BRPOP 循环：连接被关闭后（如同进程中另一个应用关闭时释放了全部 Redis 连接）命令立即失败，原来的 `continue` 会占满事件循环（真实 Redis 下多应用的测试因此挂住）；现在连接已结束时停止消费，其它错误等待 100ms 再试。
- crossws 的 Redis 同步在共享连接已断开后不再发布（应用关闭后仍在关闭的连接会触发发布）；原实现的发布连接从未关闭，所以没有暴露。

**模板**：api / vue / react 新增 `config/redis.ts`（默认连接读取 `REDIS_URL`，注释给出 cache 连接、Cluster、Sentinel 的写法）；`cache.ts`、`queue.ts`、`websocket.ts`、`socketio.ts` 改为 `connection: 'default'`，`REDIS_URL` 只出现一次；README 说明连接在 config/redis.ts 中声明。

**测试**
- core `redis.test.ts`（mock ioredis 与 bullmq，14 个）：隐式默认连接读取 REDIS_URL、默认连接的选取、优先级（内联 url > connection > 默认，options 覆盖）、单机 / TLS / Cluster / Sentinel / 自定义工厂的构造参数、同名共享与订阅连接独立、dispose 断开全部而 hmr 保留并被新应用复用、BullMQ 选项无 keyPrefix 且 `maxRetriesPerRequest: null`（Cluster 为专用实例并随队列关闭）、缺少 ioredis 时的统一提示、门面与 `useRedis()`、缓存在带 keyPrefix 的连接上读写与 flush、单个 REDIS_URL 同时配置缓存 / WebSocket / 广播总线（一个共享连接 + 一个订阅连接）、`redisCheck` 的三种情况。
- 微服务：假客户端验证命名连接上的连接数与选项（BRPOP 连接 `maxRetriesPerRequest: null`、共享连接由管理器关闭、其余随传输关闭）。
- 真实 Redis（`HAZE_TEST_REDIS_URL`）：新增 `redis-live.test.ts`（门面与 keyPrefix、pipeline、专用订阅连接、缓存与 `redisCheck` 使用同一套连接名、不可达连接为 down）；缓存整套用例增加带 keyPrefix 的命名连接；队列在带 keyPrefix 的命名连接上执行任务且键只用队列 prefix；广播总线在命名连接上收发、在线成员 Hash 带 keyPrefix；WebSocket 与 Socket.IO 跨实例用例分别以内联 url 与命名连接各跑一次；微服务整套传输语义在 `connection: 'default'`（REDIS_URL）上再跑一遍，另加单独使用的传输。
- 全部测试（未设置 HAZE_TEST_REDIS_URL）：79 个文件（1 个整体跳过），901 个通过、51 个跳过（之前为 77 个文件、886 个通过、37 个跳过；新增的真实 Redis 用例计入跳过）。本地 `redis:7` 下设置 `HAZE_TEST_REDIS_URL` 全量运行：79 个文件，949 个通过、25 个跳过（其余跳过为 Upstash / NATS / MySQL 等未提供的服务），其中 vue 模板的 `account.test.ts` 偶发失败一次、单独重跑通过：它把签名的第一个字符替换为 `x` 来“篡改”，签名本身以 `x` 开头时（约 1/64）篡改无效，与本次改动无关。

已知限制：`disposePersistent()` 是进程级的，同一进程中一个应用关闭（非 hmr）会断开所有应用的 Redis 连接（与原来的缓存连接池、广播总线一致）；热更新改了连接设置时旧连接保留到进程关闭；缓存 `clear()` 在 Cluster 上只扫描一个节点（原有限制）；连接级的 `keyPrefix` 不作用于 pub/sub 频道与 BullMQ，需要分别设置频道前缀与队列 prefix；共享连接上执行 SUBSCRIBE / 阻塞命令不会被阻止，只在文档中说明；`default` 用 env() 读取时类型为 string，需断言为连接名。

### M30 实施记录（2026-10-28）：缓存接口增强

背景：M14 的缓存接口沿用 Laravel 的命名（`forget` / `flush` / `increment`），没有标签、没有读取与修改 TTL 的方法，也拿不到底层客户端；值以纯 JSON 存储，`Date` 读回为字符串，BigInt（M29 前后的雪花 ID）读回为字符串；M29 的 `Redis` 门面只有原始命令，哈希、有序集合等结构要自己处理前缀与编码。

确认的决策：
- 以 ThinkPHP 的写法为主（文档优先展示），与原有名称、PSR-16 名称并存：`delete` = `forget`、`clear` = `flush`、`inc` / `dec` = `increment` / `decrement`、`getMultiple` / `setMultiple` = `many` / `setMany`，新增 `deleteMany` / `deleteMultiple`；
- 新增 `push`、`ttl`、`touch`（别名 `expire`）、`handler()`、标签缓存、redis 存储上带类型的数据结构、`cache()` 助手函数；
- 默认序列化改为“JSON + 类型还原”，仍是合法的 JSON，并兼容旧的纯 JSON 值；
- 遥测、多租户前缀覆盖新操作。

**驱动接口**（`packages/core/src/cache/store.ts`）
- `CacheStore` 增加可选能力：`ttl(key)`（永久为 undefined，不存在为 null）、`touch(key, ttl)`、`push(key, element, ttl)`、`handler()`、`commands`（数据结构命令）、`tags`（标签的键索引）。缺少时上层退回通用实现（`touch` 重写一次值、`push` 读后写）或抛出“不支持”（`ttl`、`handler`），自定义驱动不需要改动。
- memory：`ttl` / `touch` 直接改 `expiresAt`；`push` 在同一个同步段内读与写，并发安全；`delete` 不再对已过期的项返回 true。
- redis / upstash：`ttl` 为 TTL 命令（-2 → null，-1 → undefined）；`touch` 为一个 Lua 脚本（秒数时 EXPIRE，永久时 EXISTS + PERSIST），两个驱动共用脚本。
- kv：KV 没有读取 TTL 的接口，但原有的 set / increment 已把 `expiresAt` 写在元数据中，`ttl()` 由它计算（没有设置 TTL 写入的值视为永久）；KV 也不能只改有效期，`touch()` 连同值重新 put 一次（受“同一键每秒一次写入”的限制，非原子）；`push` 读后写并保留原 `expiresAt`。

**push 的原子性**
- 选择 Lua 脚本而不是列表结构：值仍是一个 JSON 数组字符串，`get` / `has` / `ttl` / 标签 / `many` / 其它驱动的行为都不变；列表结构需要 `get` 先判断 TYPE、`set` 要覆盖列表、标签与 KV 无法对应，改动面大得多。
- 脚本不解析原值（cjson 会改变大整数与浮点的精度、把空数组编码为 `{}`、打乱键顺序），只检查首尾字符是 `[` 与 `]`，用 `SETRANGE` 把 `,<元素>]` 写到末尾（`[]` 时写在第 1 位）；不存在时 `SET [<元素>]`。O(1)、不搬运整个值，`SETRANGE` 本身保留有效期；传了 ttl 时再 EXPIRE。原值不是数组时脚本返回 `NOTARRAY`，转为 `TypeError`。
- 元素的编码由序列化器的 `element(value)` 提供（`serialize([value])` 去掉方括号），因此 typed 编码的 Date 等在数组中同样还原；自定义序列化器没有 `element` 时退回读后写。
- 与 ThinkPHP 的差异：ThinkPHP 6 的 push 会 `array_unique` 并只保留 1000 项，这里不去重、不截断（大列表应使用 Redis 列表）；不传 ttl 时保留原有效期，而 ThinkPHP 会按默认有效期重写。

**标签**（`TaggedCache`，与 `CacheRepository` 在同一个文件中，避免类继承的循环导入）
- 版本号命名空间：每个标签的版本键 `<prefix>tag:<name>:version`，值为 9 字节随机数的 base64url（不用自增：版本键被 `flush` 或淘汰后从 1 重新开始会让旧值复活）；不存在时用 `add` 写入，并发时以先写入者为准。值的键为 `<prefix>tagged:<sha1(按名字排序的 标签:版本 列表)>:<key>`，标签顺序无关；SHA-1 用 WebCrypto（Workers 可用），最近 1000 个结果缓存在进程内。
- `clear()` 为每个标签写入新版本：包含其中任一标签的组合都换了命名空间，`Cache.tag('user').clear()` 同时使 `['user', 'post']` 的值失效。所有驱动通用（KV 上受最终一致影响）。
- 读取必须使用写入时的同一组标签（与 Laravel 相同；ThinkPHP 的标签只记录键，值仍在原键下），文档中说明。
- 实现方式：`CacheRepository` 的键解析改为受保护的异步 `resolve(keys)`，写入后调用 `written(key, ttl)` 钩子；`TaggedCache` 只覆盖这两个方法与 `flush()`，其余方法（get / set / remember / inc / push / many / pull / ttl / touch ...）全部继承，`many` / `setMany` / `deleteMany` 只解析一次命名空间。`tag('a').tag('b')` 合并标签。
- redis 的键索引（`store.tags`）：每个标签一个有序集合 `<prefix>tag:<name>:keys`，成员为值的键，分数为过期时间（永久为 `+inf`），写入时 `ZADD` 并 `ZREMRANGEBYSCORE` 清掉已过期的成员，避免索引无限增长；`clear()` 先换版本号，再删除索引中的键与索引本身。正确性只依赖版本号：索引漏记（竞争）或残留成员（另一个标签已删除该值）都不影响结果。删除逐个执行（Cluster 上多键 DEL 要求同一个槽）。其它驱动没有索引，被清除的值留到过期。
- 前缀：版本键、值键与索引都在 `prefix`（配置前缀 + 租户前缀）之下，不同应用 / 租户的标签互不影响；`flush()` 同时清掉标签版本。保留键：`tag:*`、`tagged:*`、`lock:*`。

**Redis 数据结构**（`packages/core/src/cache/structures.ts`）
- `RedisCacheRepository<Handler = RedisClient>` 继承 `CacheRepository`，提供 `hash` / `list` / `set` / `setOf` / `sortedSet`（`zset`）句柄与 `command(key, cmd, ...args)` / `commandBatch`。驱动通过 `store.commands`（小写命令名 + 已加前缀的键，返回值与 ioredis 相同）执行：redis 直接调用共享连接上的命令方法（ioredis 的 keyPrefix 照常生效），批量为 `MULTI`。
- 句柄按调用时的前缀计算键（含租户），元素用存储的序列化器逐个编码，有序集合的分数保持数字（`inf` / `-inf` 解析为 Infinity）；哈希 `increment` 依赖数字以普通 JSON 数字存储（json 与 typed 都是），整数用 HINCRBY、小数用 HINCRBYFLOAT。
- TTL：创建句柄时的 ttl 在每次写入后与 EXPIRE 放在同一个事务中；`hash.set` 与 `sortedSet.add` 可以直接传 ttl；`expire()` / `ttl()` / `exists()` / `drop()` 在所有句柄上可用，前两个复用仓库的 `touch` / `ttl`。
- 几个歧义的取舍：`set(key)` 只有一个参数时返回集合句柄，两个以上参数仍是写缓存（原来单参数调用本来就是类型错误，不影响已有代码；带 ttl 的集合用 `setOf(key, ttl)`）；哈希的 `delete(field, ...fields)` 删除字段且类型上至少一个字段（避免空数组展开时误删整个键），删除整个键统一用 `drop()`，列表 / 集合 / 有序集合另有 `delete()`；有序集合 `add` 的第二个参数是数字时总是“成员 + 分数”（成员可以是对象），数组为 entries，只有一个对象参数时为 `{ 成员: 分数 }` 记录（记录形式不带 ttl，避免与分数混淆），成员本身是数组时类型上要求用 entries。
- memory 也提供（决定）：`memoryCommands` 在进程内模拟用到的约 40 个命令（区间与负下标、LREM 的方向、ZRANGEBYSCORE 的开区间与 LIMIT、空结构删除键、WRONGTYPE），memory 的项可以是字符串或结构。这样业务代码 `Cache.redis().hash(...)` 在测试中把 redis 存储换成 memory 即可运行；文档标明“供测试”。因此 `isRedisCache()` 与 `Cache.redis()` 判断的是“有数据结构”（redis 与 memory），其它驱动抛错——这与“只接受 redis”的字面要求略有出入，是为了可测试性有意放宽。upstash 不提供：@upstash/redis 的方法签名与 ioredis 不同（`hset(key, record)`、`zadd(key, { score, member })`），需要单独适配，用 `handler()` 即可。
- 仓库类型：管理器按 `store.commands` 是否存在决定创建 `RedisCacheRepository` 还是 `CacheRepository`（自定义驱动实现了 `commands` 时也可用，类型上可用 `isRedisCache` 收窄）。

**类型**
- `defineCacheConfig` 改为与 `defineRedisConfig` 相同的 `const` 泛型，存储名与驱动字面量进入生成的配置类型（typegen 不需要改动）。`CacheStoreName` 为生成后的存储名联合（未生成时为 string），`CacheRepositoryFor<Name, Stores = 生成的存储>` 按驱动映射：redis → `RedisCacheRepository`，memory → `MemoryCacheRepository`（handler 为 Map），upstash → `CacheRepository<UpstashClientLike>`，kv → `CacheRepository<KvNamespaceLike>`，其它与未生成时 → `CacheRepository`。
- 门面 `Cache.store` 为三个重载（无参数、已知名字、可选名字），只接受已声明的名字；`CacheManager.store` 额外接受任意字符串，框架内部按配置值取存储（session、throttle、cacheResponse、密码重置等）在生成类型后也不报错。已用临时的声明合并（与 typegen 生成的形状相同）验证：`Cache.store('redis')` 为 `RedisCacheRepository`、拼错的名字与 kv 存储上的 `hash()` 报错、core 源码不报错。仓库测试中不做全局声明合并（会让 `ConfigPath` 只接受已知键而影响整个项目），类型测试对 `CacheRepositoryFor` 显式传入 `Stores`。
- `CacheRepository<Handler>` 的泛型只用于 `handler()` 的返回类型。

**`cache()` 助手函数**：重载 `cache()` → 默认存储的仓库、`cache<T>(key)` → 读取、`cache(key, null)` → 删除（返回是否存在）、`cache(key, value, ttl?)` → 写入；按参数个数区分，`cache(key, undefined)` 是写入。core 原来没有名为 `cache` 的导出，ORM 的 `query.cache()` 是方法，不冲突。

**序列化**（`packages/core/src/cache/serializer.ts`）
- `typedSerializer`（默认）：`JSON.stringify` 的 replacer 从 holder 上取原值（`toJSON` 之前），`Date` → `{"$t":"Date","v":ISO}`（无效日期为 `v: null`）、`BigInt` → `{"$t":"BigInt","v":"..."}`、`Map` → `{"$t":"Map","v":[[k,v],...]}`、`Set` → `{"$t":"Set","v":[...]}`、数组 / 对象中的 `undefined` → `{"$t":"undefined"}`；用户数据自身带 `$t` 键的对象整体转义为 `{"$t":"Object","v":[[k,v],...]}`。其它值保持普通 JSON，实现了 `toJSON` 的对象（模型）仍按 `toJSON` 的结果序列化；循环引用照常抛 TypeError；顶层 undefined 仍存为 null。
- 读取：原文不含 `"$t"` 时直接 `JSON.parse`（大多数值没有额外开销），否则用 reviver 还原；只认键恰好为 `$t`（+ `v`）且标记名已知的对象，因此旧的纯 JSON 值照常读取（唯一的歧义是旧数据中恰好形如 `{"$t":"Date","v":...}` 的对象）。reviver 返回 undefined 会删除属性，因此先返回占位符，再由所在的数组 / 对象替换为 undefined（只在有待替换的占位符时扫描容器）。
- `jsonSerializer`：原来的行为（BigInt 经 M29 的 `jsonReplacer` 写为字符串）。配置 `serializer: 'json' | 'typed' | { serialize, deserialize }`，全局与每个存储都可设置；`CacheStoreConfig` 改为驱动配置的联合与 `CacheStoreOptions` 的交叉类型。自增、锁的值不经过序列化器，与原来一致；ORM 的查询缓存遇到已还原的 Date / BigInt 时原样保留。

**遥测与多租户**
- `#observe` 改为受保护的 `observe`，标签缓存与数据结构复用；遥测的 operation 增加 `push` / `ttl` / `touch` / `command`，并新增 `command` 字段（`hset` 等），`add`、`increment`、`flush` 现在也会上报。OpenTelemetry 的 span 名为 `cache.<command 或 operation>`。标签版本号的读取不上报（开发面板只显示用户的操作）。
- 新操作都经过 `prefix`（配置前缀 + 租户前缀），标签与数据结构按租户隔离；没有单独的 `Cache.fake()`，memory 驱动覆盖全部新接口（包括数据结构）。

**测试**（`packages/core/test/cache-{api,tags,serializer,structures,types}.test.ts`，共用 `test/support/cache-drivers.ts`）
- 通用接口、标签、序列化在 memory、KV（Miniflare）上运行，设置 `HAZE_TEST_REDIS_URL` 时加上内联 url 的 redis 与带 keyPrefix 的命名连接，设置 `HAZE_TEST_UPSTASH_URL` / `HAZE_TEST_UPSTASH_TOKEN` 时加上 upstash；数据结构在 memory 与两种 redis 上运行。
- 覆盖：别名与 `deleteMany`；`push`（新建、空数组、非数组报错、ttl 保留与重设、原子驱动上 50 个并发 push）；`ttl` / `touch` / `expire`（永久、缺失、续期不改值、缩短后过期、自增的计数）；`handler()`（Map、与 `Redis.client('cache')` 是同一个 ioredis 实例、KV 绑定）；`cache()` 的四种用法；遥测上报新操作；驱动缺少 `ttl` / `touch` / `push` / `handler` 时的退回与报错；标签的单个 / 多个 / 跨组合清除 / remember 等方法 / 前缀隔离 / 租户隔离 / redis 上清除时删除键与索引；typed 序列化的往返（Date、BigInt、Map、Set、嵌套、undefined、无效日期、`$t` 转义、toJSON）与读取旧的纯 JSON 值、全局与按存储的序列化器、自定义序列化器的 push 退回；四种数据结构的全部方法、句柄与写入时的 ttl、前缀与 WRONGTYPE、租户隔离、redis 上为原生类型（TYPE、HGETALL 中的编码）；`expectTypeOf` 的类型测试（按驱动映射、门面与句柄、`cache()` 重载、`@ts-expect-error`）。
- 本地 `redis:7`（colima）：新增的 5 个文件未设置环境变量时 49 个通过、4 个跳过，设置 `HAZE_TEST_REDIS_URL` 后 91 个通过、2 个跳过（KV 上的并发 push 与缩短 ttl 后过期）；原有的 `cache.test.ts` 与 `redis*.test.ts` 在真实 Redis 上全部通过。全量：未设置时 84 个文件（1 个整体跳过），950 个通过、55 个跳过（之前为 79 个文件、901 个通过、51 个跳过）；设置 `HAZE_TEST_REDIS_URL` 时 84 个文件，1040 个通过、27 个跳过。没有本地的 serverless-redis-http 镜像，Upstash 用例未运行（只按 @upstash/redis 的 `eval(script, keys, args)` / `ttl()` 接口实现，与已有的 increment 脚本相同的调用方式）。

已知限制：KV 的 `ttl()` 依赖写入时记录的元数据，`touch()` 会重写值；memory 的数据结构只为测试准备（单进程、只实现用到的命令）；upstash 没有数据结构；非 redis 驱动上被清除的标签值留到过期为止（memory 上永久保存的标签值不会被回收）；redis 标签索引中永久值的残留成员只在该标签清除时删除；`push` 不去重、不截断；typed 序列化改变了 Date / BigInt 的读回类型，滚动发布期间旧实例会读到 `{ $t, v }` 对象（可设置 `serializer: 'json'`）；`set(key)` 的单参数重载依赖参数个数；缓存 `clear()` 在 Cluster 上只扫描一个节点（原有限制）。

### M31 实施记录（2026-10-29）：开发常用能力

确认的决策：服务端模板采用 TSX 视图（零依赖、构建时编译、所有预设可用）；假数据使用 `@faker-js/faker`（可选 peer）；维护模式状态默认存于缓存存储；批量任务状态存于缓存存储。四个部分在独立工作树中并行开发后合并。

**模型工厂与读写分离（@hazejs/orm）**
- `defineFactory(Model, ({ faker, sequence, n, index }) => 属性)` 放在 `database/factories`（本地模块为 `modules/<name>/database/factories`），`haze make:factory`。工厂不可变：`make / create / raw / count / createMany / makeMany`、命名状态（状态名有类型约束）、`sequence`、`afterMake / afterCreate`；属性值可以是函数或另一个工厂（创建后取主键）；类型来自模型表的插入类型。
- 关联读取模型上的关联定义：`for()`（belongsTo / morphTo，同一次调用只创建一个父模型）、`has()`（hasMany / hasOne / morphMany / morphOne / belongsToMany）、`hasAttached()`（中间表数据）；写入多条或带关联时在一个事务中执行。faker 10.6 按需动态导入，语言取 `.locale()` 或 `database.factories.locale`，未安装时只有访问 `ctx.faker` 才报错。
- 读写分离：`write`、`read`（一个或多个副本，未写字段继承连接配置）、`sticky`；`pool` 可为 `{ max, idleTimeout, connectTimeout }`。没有使用 drizzle 的 `withReplicas`（加锁读也会走副本、没有 sticky），在 `resolveSession` 中手动路由：只读查询随机选副本；写入、事务、`lock()`、`useWriter()` / `Model.onWriter()` / `Db.useWriter()`、`Db.execute()` 与 `refresh()` 走写库。sticky 通过包装写库 session 的 `prepareQuery` 识别写语句，请求内以 `getRequestStore()` 为作用域、请求外用 `Db.withinScope()`，按解析后的连接名（含租户）记录。D1 与 MongoDB 配置读写分离时报错。

**HTTP 客户端（core）**
- `Http` 是不可变的请求构造器（`Http.create()` 创建不读取配置默认值的独立客户端），基于 fetch、零依赖。设置在发送时按层合并：`config/http.ts` 的 defaults、命名客户端、构造器链、单次选项。时长中的数字为毫秒；超时按每次尝试计时并覆盖缓冲读取响应体，进入流式读取后不再计时。
- `retry(n)` 为总尝试次数，默认只重试连接失败与 408 / 425 / 429 / 5xx（501 除外），429 / 503 遵循 retry-after（超过 maxRetryAfter 时直接返回）；失败响应先缓冲，`throw()` 同步抛出带响应体预览的 `HttpRequestException`；`ConnectionException` / `TimeoutException`；URL 凭据与类似密钥的查询参数在错误与遥测中脱敏。
- 中间件包在每次尝试外面，重试在中间件之外，每次尝试记录一条 `http` 遥测（开发面板新增 HTTP Client 标签）并创建一个 CLIENT span。`Http.fake()` 属于每个应用的 HttpManager，URL 模式规则后添加的优先；不修改 globalThis.fetch，第三方 SDK 用 `toFetch()` 接入。`pool()` 用惰性请求实现真实的并发上限。

**队列增强（core + @hazejs/orm）**
- 队列驱动注册表 `registerQueueDriver`（配置类型经 `QueueDriverRegistry` 声明合并），`databaseProvider` 注册 `database` 驱动：PostgreSQL / MySQL 8 用 `SELECT … FOR UPDATE SKIP LOCKED`，SQLite / libsql / Turso / D1 用原子的 `UPDATE … RETURNING`；超过 retryAfter 的预留可被重新领取，确认 / 放回以领取时的 reserved_at 为条件；表由 `haze make:queue-tables` 生成。
- 任务链、批量、唯一任务与任务中间件在 QueueManager 中实现，所有驱动通用。任务链的剩余任务随消息传递；回调可以是任务引用或函数，函数只在 sync / memory 连接上允许。批次状态存于缓存存储，原子计数，以 `add` 写入 finished 标记选出唯一执行者运行 then / finally，第一次失败时执行 catch。唯一任务以消息 ID 持有缓存锁，在开始执行或执行结束时释放。`job.release(delay)` 放回队列不消耗次数；内置 rateLimited、withoutOverlapping、throttlesExceptions、skipIf 与全局中间件。Queue.fake() 新增 assertChained / assertBatched / assertPushedUnique 等。

**维护模式与 TSX 视图（core + vite + cli）**
- `haze down / up / maintenance:status`（生产为 `worker.mjs down|up|maintenance:status`）。状态默认直接读写默认缓存存储（不加租户前缀、不产生缓存遥测），也可用文件；缓存为进程内 memory 时非测试模式自动改用文件并提示。各进程缓存状态 2 秒。中间件紧跟请求作用域与异常边界，先于静态资源、OpenAPI、健康检查、多租户与全局中间件；健康检查、开发面板、except 放行。JSON 请求返回统一错误格式，HTML 请求返回内置页面、`--render` 视图或重定向；访问 `/<secret>` 设置签名 Cookie 绕过。`pauseWorkers` 时队列 worker 在任务之间等待、定时任务跳过；触发 `MaintenanceModeEnabled / Disabled` 事件。
- core 内置零依赖的 JSX 运行时（`@hazejs/core/jsx-runtime`）：节点惰性求值，渲染时在请求作用域内执行组件，同级异步组件并发渲染，文本与属性转义，`rawHtml()` / `dangerouslySetInnerHTML`、`Doctype`。`ctx.view()` / `view()` / 处理器直接返回 JSX 节点都输出 text/html 且不经过统一格式；`useHttpContext()`、`csrfField()`、`old()` / `flashInput()`。Vite 插件只在非 client 环境、对 srcDir 下的 .tsx/.jsx 用 oxc 编译（importSource `@hazejs/core`），React 前端不受影响；api 模板 `GET /` 渲染 `app/view/Welcome.tsx`，新增 `haze make:view`。

已知限制：工厂只支持 SQL 模型，不支持 through 关联；请求之外的 sticky 需要 `Db.withinScope()`；HTTP 客户端没有连接超时、假响应不创建 span；批量成员手动重试后计数不准、批量内不支持任务链、函数回调只在进程内有效；SQLite 上多进程抢任务吞吐有限，D1 只能投递；视图没有流式渲染与注水，只能按名称渲染 `app/view` 下的视图；全栈开发时维护模式只拦截 `/api/**`；边缘平台需要通过共享存储设置维护状态。
