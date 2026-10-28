# 目录结构

hazejs 沿用 ThinkPHP / Laravel 风格的目录约定：每类代码都有固定的位置，其中大部分目录会在编译期自动发现，几乎不需要手动注册。

## 纯后端项目（`api` 模板）

后端源码目录就是项目根目录：

```
my-app/
├─ app/
│  ├─ channel/          广播频道授权（自动发现）
│  ├─ command/          自定义命令（自动发现）
│  ├─ controller/       控制器
│  ├─ event/            事件（自动发现）
│  ├─ exception/
│  │  └─ Handler.ts     全局异常处理器（自动发现）
│  ├─ job/              队列任务（自动发现）
│  ├─ listener/         事件监听器（自动发现）
│  ├─ mail/             邮件定义
│  ├─ model/            ORM 模型
│  ├─ notification/     通知（自动发现）
│  ├─ policy/           授权策略（自动发现）
│  ├─ provider/         服务提供者（自动发现）
│  ├─ response/
│  │  └─ Formatter.ts   统一响应格式（自动发现）
│  ├─ service/          业务服务
│  └─ validate/         请求校验
├─ config/              配置，一个文件对应一个配置键（自动发现）
├─ database/
│  ├─ migrations/       drizzle-kit 生成的 SQL 迁移
│  ├─ schema/           drizzle 表结构
│  └─ seeders/          haze db:seed 执行的数据填充
├─ route/               路由文件（自动发现）
├─ schedule/            定时任务（自动发现）
├─ tests/               Vitest 测试
├─ .env                 环境变量（APP_KEY、DATABASE_URL 等）
├─ .env.test            测试环境覆盖
├─ haze.config.ts       工具链配置（srcDir、端口、部署预设等）
├─ package.json
├─ tsconfig.json
└─ vitest.config.ts
```

## 全栈项目（`vue` / `react` 模板）

全栈项目中后端整体移到 `server/` 下，项目根目录则是一个标准的 Vite 项目：

```
my-app/
├─ server/              后端源码目录（srcDir）
│  ├─ app/              与上面相同的目录，另有 socket/
│  ├─ config/
│  ├─ database/
│  ├─ route/
│  └─ schedule/
├─ src/                 前端（Vue 或 React）
│  ├─ api.ts            封装 fetch 与 CSRF 流程
│  ├─ socket.ts         Socket.IO 客户端
│  └─ main.ts / App.vue
├─ tests/               后端测试
├─ index.html
├─ haze.config.ts       srcDir: 'server'
├─ vite.config.ts       包含 haze() 插件
├─ tsconfig.json        引用 tsconfig.app.json 与 tsconfig.server.json
└─ vitest.config.ts
```

后端目录的位置由 `haze.config.ts` 中的 `srcDir` 决定：

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  srcDir: 'server',
})
```

下文提到的 `app/…`、`config/…` 等路径都相对于 `srcDir`。以下内容始终位于**项目根目录**：`.env*` 文件、`tests/`、`stubs/`、`.haze/`、`dist/`，以及默认的 `data/` 和 `storage/`。

::: tip `~` 别名
`~/` 始终指向 `srcDir`，因此 `import { User } from '~/app/model/User'` 在两种结构下写法完全相同。可以通过 [`haze()` 插件](./fullstack#plugin-options)的 `alias` 选项调整。
:::

## 自动发现的目录

Vite 插件用 `import.meta.glob` 为以下文件生成清单。每个目录**只扫描第一层**，子目录中的文件不会被加载。

| 路径（相对 `srcDir`） | 内容 |
| --- | --- |
| `config/*.ts` | 配置文件，文件名即配置键：`config/app.ts` → `config('app.name')` |
| `route/*.ts` | 导出 `defineRoutes(...)` 的路由文件 |
| `app/provider/*.ts` | 服务提供者 |
| `app/exception/Handler.ts` | 全局异常处理器 |
| `app/response/Formatter.ts` | 统一响应格式 |
| `app/interceptor/*.ts` | 出站拦截器，按文件名顺序执行 |
| `app/policy/*.ts` | 授权策略与能力 |
| `app/job/*.ts` | 队列任务，文件名即任务名 |
| `app/command/**/*.ts` | 自定义命令，路径即命令名（`db/Cleanup.ts` → `db:cleanup`）；只由 `haze` 与 `worker.mjs command` 加载 |
| `app/event/*.ts` | 事件，文件名即事件名 |
| `app/listener/*.ts` | 监听器，按文件名顺序执行 |
| `schedule/*.ts` | 定时任务 |
| `app/socket/*.ts` | Socket.IO 命名空间，由 `@hazejs/socket.io` 读取 |
| `app/notification/*.ts` | 通知，文件名即通知类型 |
| `app/channel/*.ts` | 广播频道授权（`defineChannels()`） |
| `app/<name>/{route,config,provider,exception,response}/*.ts` | [多应用](./multi-app)下各应用自己的模块 |

开发时新增或删除这些文件会自动重新生成清单，无需重启。

## 各目录说明

### `app/controller`

控制器负责接收参数、调用服务、返回数据。控制器不会被自动发现，而是在路由中直接引用，例如 `r.get('/hello', [GreetingController, 'index'])`。可以按子目录组织（`app/controller/admin/UserController.ts`）。详见[控制器](./controllers)。

### `app/service`

与 HTTP 无关的业务逻辑。服务是普通的类，通过 `inject(GreetingService)` 由容器解析；需要特定作用域时在服务提供者中显式绑定。详见[服务容器](./container)。

### `app/repository`

可选的数据访问层，用 `haze make:repository` 生成，模板中默认没有。

### `app/model`

基于 `database/schema` 中 drizzle 表结构的 ORM 模型，例如 `class User extends Model.define(users)`。详见[模型](./models)。

### `app/validate`

Standard Schema 校验规则（默认 valibot，也可以用 zod、arktype 等），供 `.validate({ body, query, params })` 与 `validate()` 使用。详见[请求与校验](./requests)。

### `app/middleware`

类中间件或函数中间件。中间件不会被自动发现：需要在 `config/middleware.ts` 中注册别名，然后在路由中通过 `.middleware('name')` 引用。详见[中间件](./middleware)。

### `app/interceptor`

出站拦截器，拿到最终的 `Response` 后可以修改响应头或整体替换。自动发现，按文件名顺序执行。

### `app/policy`

授权策略（`definePolicy(Model, { … })`）以及与模型无关的能力（`defineAbilities({ … })`）。自动注册到 Gate，能力名会写入生成的类型。详见[授权](./authorization)。

### `app/job`

用 `defineJob()` 定义的队列任务，文件名即任务名。详见[队列](./queues)。

### `app/command`

用 `defineCommand()` 定义的自定义命令，通过 `haze <name>` 或 `node dist/worker.mjs command <name>` 运行。可以使用子目录，子目录会成为命令名的一部分。详见[自定义命令](./console)。

### `app/event` 与 `app/listener`

事件（`defineEvent()`）与监听器（`defineListener(Event, handler)`），都会自动注册；监听器可以同步执行，也可以放到队列中异步执行。详见[事件](./events)。

### `app/mail`

邮件定义（`defineMail()`），在发送的地方直接导入：`Mail.to(user.email).send(WelcomeMail, payload)`。不会被自动发现。详见[邮件](./mail)。

### `app/notification`

用 `defineNotification()` 定义的通知，通过 `notify(user, InvoicePaid(payload))` 经邮件、数据库、广播、Slack、Webhook 和群机器人发送。自动发现只用于命名：文件名就是写入数据库、推送到前端的 `type`。详见[通知](./notifications)。

### `app/channel`

私有频道与在线频道的授权（`defineChannels((c) => { c.private('orders.{id}', …) })`）。目录下每个文件都会被加载；只要有一个文件，`/broadcasting` 下的内置接口就会启用。详见[广播](./broadcasting)。

### `app/socket`

Socket.IO 命名空间（`defineNamespace()`），注册 `@hazejs/socket.io` 的提供者后加载。文件名即命名空间（`chat.ts` → `/chat`，`index.ts` → `/`）。详见 [Socket.IO](./socket-io)。

### `app/provider`

服务提供者：`register()` 中注册绑定，`boot()` 中执行启动逻辑。目录下每个文件都会被加载，例如 `DatabaseProvider.ts`（`export default databaseProvider()`）负责注册数据库。

### `app/exception`

`Handler.ts` 继承 `ExceptionHandler`，可以自定义错误的记录上报（`report()`）与响应渲染（`render()`）。详见[异常与日志](./errors)。

### `app/response`

`Formatter.ts` 继承 `ResponseFormatter`，用来调整成功与失败时的响应结构（默认 `{ code, message, data }`）。详见[响应](./responses)。

### `config/`

一个文件对应一个配置键，通常配合 `defineXxxConfig()` 辅助函数使用。详见[配置](./configuration)。

### `route/`

集中定义的路由。可以按需拆分成多个文件（`api.ts`、`ws.ts`……），每个文件都会被加载。详见[路由](./routing)。

### `database/`

- `schema/`：drizzle 表结构。drizzle-kit 会直接读取这些文件，因此只应依赖 `drizzle-orm`（不要在这里使用 `~` 别名）。
- `migrations/`：`haze db:generate` 生成的 SQL 文件与 `meta/_journal.json`。非默认连接使用 `migrations/<连接名>/`。迁移文件会打包进生产产物。
- `seeders/`：默认导出一个函数的文件，`haze db:seed` 按文件名顺序执行。

详见[数据库](./database)。

### `schedule/`

用 `defineSchedule((s) => { … })` 定义的定时任务。详见[定时任务](./scheduling)。

### `tests/`

使用 `@hazejs/testing` 的 Vitest 测试。即使在全栈项目中也位于项目根目录。详见[测试](./testing)。

## 生成目录与运行时目录

| 路径 | 用途 | 是否提交到 git |
| --- | --- | --- |
| `.haze/` | 生成的类型（`.haze/types/haze.d.ts`）、最近一次构建的记录（`build.json`）和本地预览数据 | 否 |
| `dist/` | 构建产物（`haze.config.ts` 的 `outDir`） | 否 |
| `data/` | 模板默认的 SQLite 数据库（`DATABASE_URL=file:./data/app.db`） | 否 |
| `storage/` | 本地文件存储磁盘（`storage/app`、`storage/app/public`） | 否 |
| `stubs/` | `haze stub:publish` 复制出来、供团队定制的代码生成模板 | 是 |

记得在 `tsconfig.json` 的 `include` 中加入 `.haze/types/**/*.d.ts`（模板已配置好），编辑器才能识别配置键、路由名和授权能力的类型。
