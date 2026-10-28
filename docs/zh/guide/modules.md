# 模块

模块是可复用的后端功能单元，比如博客、CMS、支付对接。项目启用一个模块后，就获得了它的路由、中间件、默认配置、服务、数据库迁移，以及任务、事件、监听器、命令、定时任务、授权策略、通知和广播频道。

模块有两种来源，两者最终都是同一种 `defineModule()` 定义：

- **本地模块**：项目中的 `modules/<name>/` 目录（相对 `srcDir`），自动发现，目录结构与应用本身相同。
- **模块包**：安装的 npm 包，在 `config/modules.ts` 中显式启用。`pnpm create hazejs my-module --template module` 可以生成一个模块包项目。

## 模块与多应用的区别

模块合并进**同一个**应用，共用容器、认证守卫、响应格式、异常处理、日志和数据库连接，模块之间没有隔离。需要隔离时请使用[多应用](./multi-app)。

| | 模块 | 多应用 |
| --- | --- | --- |
| 用途 | 在本项目和其它项目中复用一块功能 | 把一个项目拆成配置各自独立的多个入口（对外 API、管理后台、移动端） |
| 位置 | `modules/<name>/` 或 npm 包 | `app/<name>/` |
| 配置 | 默认配置位于项目配置**之下** | 只对该应用的请求，与全局配置深合并、覆盖在**之上** |
| 中间件、异常处理、响应格式 | 共用；模块可以添加别名、分组和全局中间件 | 每个应用独立 |
| 提供者、任务、事件、命令、迁移 | 支持 | 只支持提供者 |
| 路由 | 带前缀和路由名前缀挂载，可以只挂到某个应用 | 每个应用独立，按前缀或域名分发 |

两者可以组合：用 `app: 'admin'` 把模块只挂载到某个应用（见[启用模块](#启用模块)）。

## 本地模块

本地模块是 `modules/` 下的一个目录，内部结构与应用相同：

```
modules/
  blog/
    module.ts              # 可选：用 defineModule() 覆盖约定（前缀、中间件等）
    route/                 # 路由文件（自动加载）
    config/                # 默认配置，每个文件一个配置键（自动加载）
      blog.ts              #   → config('blog.*')，项目的 config/blog.ts 可覆盖
      middleware.ts        #   → 模块的中间件别名 / 分组 / 全局中间件
    app/
      controller/          # 由路由文件导入
      provider/            # 服务提供者（自动加载）
      job/ event/ listener/ policy/ notification/ channel/   （自动加载）
      command/             # 自定义命令，可以有子目录（自动加载）
      model/ service/ middleware/ …
    schedule/              # 定时任务（自动加载）
    database/
      schema/              # drizzle 表结构
      migrations/          # drizzle-kit 生成的迁移，先于项目的迁移执行
      seeders/             # haze db:seed 在项目的数据填充之前执行
    tests/                 # Vitest 测试
```

本地模块默认全部启用。按文件名命名的规则与应用完全一样：`modules/blog/app/job/SendDigest.ts` 是任务 `SendDigest`，`modules/blog/app/command/db/Prune.ts` 是命令 `db:prune`，`modules/blog/app/event/PostPublished.ts` 是事件 `PostPublished`。

用下面的命令生成模块骨架：

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

所有 `make:*` 生成器都支持 `--module <name>`（简写 `-m`），生成到模块目录而不是应用目录：

```bash
haze make:controller Post --module blog     # modules/blog/app/controller/PostController.ts
haze make:model Post --module blog          # modules/blog/app/model/Post.ts + modules/blog/database/schema/posts.ts
haze make:job SendDigest --module blog      # modules/blog/app/job/SendDigest.ts
haze db:generate --module blog              # modules/blog/database/schema → modules/blog/database/migrations
```

### `module.ts`

没有 `module.ts` 时按约定处理：路由不加 URL 前缀，路由名带 `blog.` 前缀。需要调整时添加 `modules/<name>/module.ts`：

```ts
// modules/blog/module.ts
import { defineModule } from '@hazejs/core'

export default defineModule({
  prefix: '/api/blog',          // 模块路由的 URL 前缀
  as: 'blog.',                  // 路由名前缀（默认值）
  routeMiddleware: ['throttle:60,60'],
  config: { blog: { perPage: 20 } },
})
```

`module.ts` 中的列表（路由、提供者、任务等）追加在自动发现的定义之后，配置键与 `config/*.ts` 深合并。本地模块的名字始终是目录名。

## 启用模块

在 `config/modules.ts` 中启用模块包、配置本地模块：

```ts
// config/modules.ts
import { defineModulesConfig } from '@hazejs/core'
import blog from '@acme/hazejs-blog'

export default defineModulesConfig({
  modules: [
    // 可以直接使用，也可以带选项调用
    blog({ prefix: '/api/blog', as: 'blog.', middleware: ['auth'], perPage: 10 }),
  ],
  // 本地模块默认启用：false 关闭，对象为挂载选项
  local: {
    shop: false,
    cms: { prefix: '/cms' },
  },
})
```

| 选项 | 说明 |
| --- | --- |
| `prefix` | 模块路由的 URL 前缀 |
| `as` | 路由名前缀，默认 `<模块名>.`；`''` 表示保留模块自己的路由名 |
| `middleware` | 加在模块全部路由上的中间件，位于模块自己的 `routeMiddleware` 之后 |
| `app` | 只把路由挂载到某个[子应用](./multi-app)，如 `'admin'` → `/admin/<prefix>/…`，路由名为 `admin.<as>…` |
| `connection` | 模块迁移使用的数据库连接，默认为 default 连接 |

模块包还可以接受自己的带类型选项（上例的 `perPage`），见[带类型的选项](#带类型的选项)。

### 加载顺序与优先级

启用顺序为：`createApplication({ modules })` 传入的模块 → `config/modules.ts` 的 `modules` → 按目录名排序的本地模块。两个模块同名时报错。

| 内容 | 模块与应用如何组合 |
| --- | --- |
| 配置 | 框架默认值 → 模块默认配置（按启用顺序）→ 项目的 `config/*.ts`，深合并：`config/blog.ts` 只需写要改的键 |
| 提供者 | 模块的提供者先于项目的提供者 `register()`，项目可以重新绑定模块的服务 |
| 中间件别名与分组 | 合并进中间件注册表。两个模块定义了同名项，或模块与内置中间件同名时报错，并指出双方来源；项目的 `config/middleware.ts` 也定义了同名项时视为显式覆盖，不报错 |
| 全局中间件 | 在项目的全局中间件之后执行，按启用顺序 |
| 路由 | 在项目路由之后加载，走同一套编译流程。路由名重复时报错并指出来源：`Duplicate route name "blog.index" (the app and module "blog")` |
| 任务、事件、监听器、定时任务、授权策略、命令 | 先于项目的定义注册；与项目同名的任务以项目为准；命令重名时报错 |

## 编写模块包

生成一个可发布的模块包：

```bash
pnpm create hazejs my-module --template module
```

其中包含 `defineModule()` 入口，以及示例路由、控制器、中间件别名、默认配置、迁移和测试，用 tsdown 构建。入口大致如下：

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
  jobs: { SendDigest },                 // { 名称: 定义 }：包里没有文件名可用
  events: { PostPublished },
  commands: [defineCommand({ name: 'my-module:sync', run })],
  migrations: new URL('../database/migrations', import.meta.url),
})
```

| 字段 | 说明 |
| --- | --- |
| `name` | 模块包必填。用作默认的路由名前缀，出现在错误信息、`module:list` 和迁移记录表名中 |
| `prefix`、`as`、`routeMiddleware`、`app`、`connection` | [启用选项](#启用模块)的默认值 |
| `config` | 按配置键给出默认配置；值可以是函数（在 `.env` 加载之后求值） |
| `routes` | `defineRoutes()` 路由模块 |
| `middleware` | `{ alias, groups, global }`，与 `config/middleware.ts` 同形 |
| `providers` | 服务提供者 |
| `jobs`、`events`、`listeners`、`schedules`、`policies`、`notifications`、`channels`、`commands`、`interceptors` | 数组，或以名称为键的对象（任务名、事件名、命令名、通知类型） |
| `discovered` | 供扩展包读取的其它定义，如 Socket.IO 的 `{ sockets: [...] }`、微服务的 `{ messages: [...] }` |
| `migrations` | drizzle-kit 的迁移目录。请写成字面量 `new URL('…', import.meta.url)`，生产构建才能把它打包进产物 |
| `options` | 带类型的启用选项，见下文 |

`package.json` 需要声明这是一个模块，并发布迁移目录：

```json
{
  "files": ["database", "dist"],
  "hazejs": { "module": true },
  "peerDependencies": { "@hazejs/core": "^0.2.0" }
}
```

`"hazejs": { "module": true }` 让宿主项目的构建识别这个包：它总是被打包进产物（与应用共用同一份 `@hazejs/core`），迁移目录会内嵌到生产产物中；以链接方式安装时，开发服务器由 Vite 处理它的源码。

### 配置的类型

把配置类型写成模块扩充，随包的类型声明发布。宿主项目中 `config('myModule.perPage')` 直接得到正确的类型，不需要 typegen：

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

本地模块的配置类型由 typegen 生成：`modules/<name>/config/*.ts` 中项目自己没有定义的配置键会写入 `.haze/types/haze.d.ts`。模块的路由名和其它路由一样生成类型。

### 带类型的选项

`options` 收到启用时传入的参数（挂载选项之外的部分），返回要合并进定义的字段：

```ts
export default defineModule({
  name: 'myModule',
  config: { myModule: defaults },
  options: (options: { perPage?: number }) => options.perPage
    ? { config: { myModule: { perPage: options.perPage } } }
    : undefined,
})

// config/modules.ts：prefix、as、middleware、app、connection 与 perPage 都有类型
myModule({ prefix: '/blog', perPage: 10 })
```

返回的配置与模块的默认配置深合并，返回的列表追加在原有定义之后。

## 迁移

`haze db:migrate`、`refreshDatabase()` 和生产迁移入口（`migrate.mjs`、Lambda 的 `index.migrate`）对每个连接依次执行：

1. 已启用模块的迁移，按启用顺序；
2. 项目自身的迁移，最后执行。

```
[main] module myModule: migrated: 1 of 1 applied (node_modules/my-module/database/migrations)
[main] module blog: migrated: 1 of 1 applied (modules/blog/database/migrations)
[main] migrated: 4 of 4 applied (database/migrations)
```

每个模块的迁移记录在自己的表 `__drizzle_migrations_<模块名>` 中（`myModule` → `__drizzle_migrations_my_module`），项目自身仍使用 `__drizzle_migrations`。drizzle 通过与表中**最后一条**记录的时间戳比较来决定执行哪些迁移，多个目录共用一张表会互相跳过；每个目录一张表就互不影响，重复执行也不会重复迁移，项目的记录表也仍然与 `drizzle-kit migrate` 兼容。

- 没有迁移目录（或目录为空）的模块会被跳过。
- `connection`（定义中或启用时）让模块的迁移在另一个连接上执行；`haze db:migrate --all` 覆盖所有连接。
- `refreshDatabase({ modules: false })` 只执行项目自身的迁移。
- `haze db:generate --module blog` 读取 `modules/blog/database/schema`，写入 `modules/blog/database/migrations`。模块包用 drizzle-kit 自行生成迁移（模板中为 `pnpm db:generate`）。
- 生产构建会打包本地模块的迁移，以及所有声明了 `"hazejs": { "module": true }` 的依赖的迁移。模块代码同样被打包，`import.meta.url` 不再指向包目录，所以构建时会把 `new URL('../database/migrations', import.meta.url)` 改写为内嵌目录的键（`node_modules/<包名>/database/migrations`）。

## 测试模块

本地模块是应用的一部分，它的测试与应用的测试写法相同。`haze make:module` 会在 `modules/<name>/tests/` 中生成一个：

```ts
import { useTestApp } from '@hazejs/testing'

const t = useTestApp()

it('serves the module routes', async () => {
  const res = await t.get('/api/blog')
  expect(res.status).toBe(200)
})
```

`refreshDatabase()` 会先执行已启用模块的迁移，再执行项目的迁移。

模块包需要一个宿主应用来测试。模板把它放在 `tests/app/`，其中的 `config/modules.ts` 以源码方式启用模块，测试配置指向这个目录：

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

宿主应用没有自己的迁移，此时 `refreshDatabase()` 只执行模块的迁移。

## 开发

- 本地模块属于应用的模块图：修改任何文件都会热替换应用，新增或删除文件会更新清单。
- 以链接方式安装的模块包（pnpm 的 `workspace:` 或 `link:`）由 Vite 处理，而不是从 `node_modules` 加载，修改后同样会热替换。如果包的 `exports` 指向 `dist/`，在包中运行 `tsdown --watch`（模板中为 `pnpm dev`）。
- `node_modules` 中已发布的模块包在开发时与普通依赖一样加载，升级后需要重启开发服务器。

## 查看模块

```bash
haze module:list
```

```
NAME      SOURCE   PREFIX          ROUTE NAMES  ROUTES  MIGRATIONS
myModule  package  /api/my-module  myModule.*   2       /…/node_modules/my-module/database/migrations
blog      local    /api/blog       blog.*       1       modules/blog/database/migrations
```

有模块注册路由时，`haze route:list` 会增加 MODULE 列。两个命令都支持 `--json`。

## 限制

- 没有隔离：模块的服务、中间件别名和全局中间件作用于整个应用。需要各自独立配置的部分请使用[多应用](./multi-app)。
- 挂载到子应用（`app`）只影响路由，别名、提供者和配置仍然是全局的。
- 模块不能有自己的异常处理器或响应格式，模块中的 `lang/` 目录不会被发现。
- 本地模块的配置类型来自 `modules/<name>/config/*.ts` 文件，`module.ts` 中内联的默认配置没有类型。
- 模块包没有文件名，任务、事件和命令需要名称（对象的键或 `name` 选项）。
- 模块的迁移先于项目的迁移执行，因此不能依赖项目迁移创建的表。
- 生产构建内嵌迁移需要字面量 `new URL('…', import.meta.url)`。要支持多种数据库方言，为每个目录各写一个字面量，在 `options()` 中选择。
- Cloudflare D1：`wrangler d1 migrations apply` 只读取项目的 `database/migrations`，不会复制模块的迁移。Cron Triggers 与 WebSocket Durable Object 只从本地模块中检测，模块包需要时请在 `cloudflare.wrangler` 中设置。
- `haze db:seed` 执行本地模块的 `database/seeders`，不执行模块包的数据填充。
