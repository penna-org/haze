# 命令行参考

`haze` 命令来自 `@hazejs/cli`，所有模板都已把它作为开发依赖安装。可以通过 package.json 脚本运行（`pnpm dev`），也可以直接调用：

```sh
npx haze <command> [options]
npx haze --help              # 列出所有命令（含自定义命令）
npx haze make:model --help   # 查看某个命令的选项
```

所有命令都支持 `--root <dir>`，用于指定项目根目录（默认当前目录 `.`）。

需要用到应用本身的命令——`route:list`、`module:list`、`typegen`、`openapi`、`repl`、`db:*`、`queue:*`、`schedule:*`、`search:*`、`microservice:listen` 以及自定义命令——会在与开发服务器相同的 Vite 模块图中启动应用，但不监听端口。它们直接运行 TypeScript 源码，无需事先构建。

## 开发与生产

### `haze dev`

启动开发服务器。修改代码后下一个请求即生效，进程不重启。

| 选项 | 说明 |
| --- | --- |
| `--port`、`-p` | 端口，依次取 `PORT` 环境变量、`haze.config.ts` 的 `port`、`3000` |
| `--host` | 监听地址 |

如果项目中存在 `vite.config.*`，`haze dev` 会改用该配置启动 Vite（由 `haze()` 插件挂载后端），端口也使用 Vite 的端口。详见 [Vite 全栈](./fullstack)。

### `haze build`

构建生产产物，`NODE_ENV` 默认为 `production`。

| 选项 | 说明 |
| --- | --- |
| `--preset`、`-p` | 部署预设：`node`、`bun`、`deno`、`docker`、`cloudflare`、`vercel`、`netlify`、`aws-lambda`；默认取 `haze.config.ts` 的 `preset`，否则为 `node` |
| `--outDir` | 输出目录（默认 `dist`），仅纯后端项目 |
| `--minify` | 压缩产物（默认 `false`），仅纯后端项目 |

全栈项目由项目自己的 Vite 配置构建，产出 `dist/client` 与 `dist/server`；压缩与输出目录请在 `vite.config.ts` 或 `haze.config.ts` 中设置。构建完成后，命令行会打印入口文件、仍需从 `node_modules` 加载的依赖，以及运行 / 部署方式。详见[部署](./deployment)。

### `haze start`

运行生产产物：从 `haze.config.ts` 的 `outDir` 中查找 `dist/index.mjs`（纯后端）或 `dist/server/index.mjs`（全栈）。会设置 `NODE_ENV=production`，并从项目根目录加载 `.env`。需要先执行 `haze build`。

| 选项 | 说明 |
| --- | --- |
| `--port`、`-p` | 为进程设置 `PORT` |
| `--host` | 为进程设置 `HOST` |

### `haze preview`

按部署预设的实际运行方式在本地运行构建产物：`node` / `bun` / `deno` / `docker` 启动产物子进程，`aws-lambda` / `vercel` / `netlify` 在进程内调用函数，`cloudflare` 用 Miniflare 运行。全栈项目使用自己的 `vite.config.ts`，等同于 `vite preview`。需要先执行 `haze build`。

| 选项 | 说明 |
| --- | --- |
| `--port`、`-p` | 端口（默认 `4173`） |
| `--host` | 监听地址 |
| `--open` | 启动后打开浏览器 |

### `haze test`

以 `NODE_ENV=test` 运行 Vitest。不带参数时执行一次 `vitest run`；带参数时参数会替换掉 `run`，原样传给 Vitest：

```sh
npx haze test                    # vitest run
npx haze test --watch            # 监听模式
npx haze test run tests/user     # 只运行一次，并按文件过滤
```

## 查看信息

### `haze route:list`

列出所有路由的请求方法、路径、名称、处理器与中间件。启用[多应用](./multi-app)时额外显示所属应用与域名；有[模块](./modules)注册的路由时增加 MODULE 列。

| 选项 | 说明 |
| --- | --- |
| `--json` | 以 JSON 输出 |

### `haze module:list`

按启用顺序（也是迁移的执行顺序）列出已启用的[模块](./modules)：来源（`package` 或 `local`）、URL 前缀、路由名前缀、路由数、迁移目录，以及挂载到的子应用。

| 选项 | 说明 |
| --- | --- |
| `--json` | 以 JSON 输出 |

### `haze typegen`

生成 `.haze/` 下的类型与文件：

- `.haze/types/haze.d.ts`：配置键、命名路由（含输入与输出类型）和授权能力；
- `.haze/types/i18n.d.ts`：`lang/` 中的翻译键（见[多语言](./localization#翻译键的类型)）；
- `.haze/routes.ts`：[类型安全的客户端](./openapi#类型安全的客户端)在运行时使用的路由表。

`haze dev` 会自动执行（除非 `haze.config.ts` 中设置了 `typegen: false`）；CI 中请在类型检查之前运行一次。

### `haze openapi`

把应用的 [OpenAPI](./openapi) 3.1 文档输出到标准输出。不要求开启文档页面，适合在 CI 中导出。

| 选项 | 说明 |
| --- | --- |
| `--output`、`-o` | 写入文件，例如 `-o openapi.json` |

### `haze repl`

打开交互式命令行，可以直接使用已启动的应用、`config`、`inject`、各个门面（`Cache`、`Queue`、`Events`、`Storage`、`Mail`，安装了 `@hazejs/orm` 时还有 `Db`）以及 `app/model` 下的所有模型。支持顶层 `await`，历史记录保存在 `.haze/repl_history`。详见[自定义命令](./console#repl)。

| 选项 | 说明 |
| --- | --- |
| `--eval`、`-e` | 执行一段代码，打印结果后退出（非交互）；代码抛出异常时退出码为 1 |

## 项目设置

### `haze key:generate`

生成一个 256 位的 `APP_KEY`（base64url），写入 `.env`。

| 选项 | 说明 |
| --- | --- |
| `--show` | 只输出密钥，不写入任何文件 |
| `--force` | 覆盖已有的 `APP_KEY`；已签发的 Cookie、Session 和令牌都会失效 |

不加 `--force` 时，已存在的密钥会保留，命令以退出码 1 结束。

### `haze stub:publish`

把内置的代码生成模板复制到 `stubs/` 目录，方便团队按自己的规范定制 `make:*` 生成的代码。存在 `stubs/<name>.stub` 时，生成器会优先使用它。

| 选项 | 说明 |
| --- | --- |
| `--force` | 覆盖 `stubs/` 中已存在的文件 |

::: v-pre
stub 名称：`controller`、`controller.resource`、`service`、`repository`、`middleware`、`interceptor`、`provider`、`event`、`listener`、`job`、`policy`、`validate`、`validate.zod`、`test`、`config`、`route`、`seeder`、`command`、`mail`、`notification`、`channel`、`resource`、`model`、`model.mongodb`、`schema.sqlite`、`schema.postgres`、`schema.mysql`、`notifications.sqlite`、`notifications.postgres`、`notifications.mysql`、`auth-tables.sqlite`、`auth-tables.postgres`、`auth-tables.mysql`。模板中使用 `{{ className }}`、`{{ camelName }}`、`{{ kebabName }}`、`{{ routePath }}`、`{{ commandName }}` 等占位变量。
:::

## 代码生成

```sh
npx haze make:<type> <name> [options]
```

路径均相对 `srcDir`（测试除外）。下表示例列出给定名称生成的文件。

| 命令 | 示例 | 生成文件 |
| --- | --- | --- |
| `make:controller` | `User` | `app/controller/UserController.ts` |
| `make:service` | `User` | `app/service/UserService.ts` |
| `make:repository` | `User` | `app/repository/UserRepository.ts` |
| `make:model` | `Post` | `app/model/Post.ts` 与 `database/schema/posts.ts` |
| `make:middleware` | `Authenticate` | `app/middleware/Authenticate.ts` |
| `make:interceptor` | `AddHeader` | `app/interceptor/add-header.ts` |
| `make:provider` | `Payment` | `app/provider/PaymentProvider.ts` |
| `make:event` | `OrderPaid` | `app/event/OrderPaid.ts` |
| `make:listener` | `SendReceipt` | `app/listener/SendReceipt.ts` |
| `make:job` | `SendInvoice` | `app/job/SendInvoice.ts` |
| `make:policy` | `Post` | `app/policy/PostPolicy.ts` |
| `make:validate` | `User` | `app/validate/user.ts` |
| `make:test` | `user` | `tests/user.test.ts`（项目根目录） |
| `make:config` | `payment` | `config/payment.ts` |
| `make:route` | `admin` | `route/admin.ts` |
| `make:seeder` | `Users` | `database/seeders/users.ts` |
| `make:command` | `SendReport` | `app/command/SendReport.ts`（用 `haze send:report` 运行） |
| `make:mail` | `Welcome` | `app/mail/WelcomeMail.ts` |
| `make:notification` | `InvoicePaid` | `app/notification/InvoicePaidNotification.ts` |
| `make:channel` | `Order` | `app/channel/order.ts`（授权 `private-order.{id}`） |
| `make:resource` | `User` | `app/resource/UserResource.ts` |
| `make:view` | `Home` | `app/view/Home.tsx`（[TSX 视图](./views)） |
| `make:notifications-table` | — | `database/schema/notifications.ts`，见[下文](#make-notifications-table) |
| `make:auth-tables` | — | `database/schema/auth.ts`，见[下文](#make-auth-tables) |
| `make:module` | `blog` | `modules/blog/`：`module.ts`、路由、控制器、`config/blog.ts` 与测试，见[模块](./modules) |

生成后，大多数命令会打印一行提示：文件需要在哪里注册，或者怎么使用。

### 命名规则

- 名称会自动转换成合适的大小写，多余的后缀会被去掉：`user`、`User`、`UserController` 生成的都是 `UserController`。
- 名称可以带子目录，例如 `make:controller admin/User` → `app/controller/admin/UserController.ts`。
- 自动发现的目录只加载第一层文件，因此 `make:interceptor`、`make:event`、`make:listener`、`make:job`、`make:policy`、`make:notification`、`make:channel`、`make:config`、`make:route`、`make:seeder` 不允许带子目录。
- 通知的类型就是文件名，所以 `make:notification InvoicePaid` 生成的类型是 `InvoicePaidNotification`；想要更短的类型名，可以重命名文件。

### 通用选项

所有需要名称的 `make:*` 命令都支持：

| 选项 | 说明 |
| --- | --- |
| `<name>` | 必填，名称，可以带子目录 |
| `--force` | 文件已存在时覆盖 |
| `--app`、`-a` | [多应用](./multi-app)：生成到 `app/<app>/…` 下（例如 `app/admin/controller`）；`make:test` 忽略此选项，`make:command` 不支持。各应用目录下只会自动发现 `route`、`config`、`provider`、`exception` 和 `response`，因此任务、事件、监听器、策略、通知和频道请放在共用的 `app/` 目录中 |
| `--module`、`-m` | [本地模块](./modules)：生成到 `modules/<module>/…` 下，目录结构与应用相同（`make:test` 写入 `modules/<module>/tests/`）。模块需已存在（`haze make:module <name>`），不能与 `--app` 同时使用 |

### `make:controller`

| 选项 | 说明 |
| --- | --- |
| `--resource`、`-r` | 生成 RESTful 资源控制器，包含 `index`、`show`、`store`、`update`、`destroy`，可直接用于 `r.resource()` |

### `make:validate`

默认生成 valibot 校验规则；如果项目只依赖了 zod 而没有 valibot，则生成 zod 版本。

### `make:model`

在 `app/model` 中生成模型，并在 `database/schema` 中生成对应的 drizzle 表结构；表结构文件已存在时不会改动。

| 选项 | 说明 |
| --- | --- |
| `--table` | 表名，默认为名称的复数下划线形式（`OrderItem` → `order_items`） |
| `--dialect` | `sqlite`、`postgres`、`mysql` 或 `mongodb`。默认按已安装的驱动推断：`mysql2` → mysql，`postgres` 或 `@electric-sql/pglite` → postgres，只装了 `mongodb` → mongodb，其余为 sqlite |
| `--soft-delete` | 为模型启用软删除 |
| `--app`、`-a` | 模型生成到 `app/<app>/model` |
| `--module`、`-m` | 模型与表结构生成到 `modules/<module>/app/model` 与 `modules/<module>/database/schema` |
| `--force` | 模型文件已存在时覆盖 |

使用 `--dialect mongodb` 时生成 `MongoModel`，不生成表结构文件。SQL 方言生成后，接着运行 `haze db:generate` 和 `haze db:migrate`。

### `make:notifications-table` {#make-notifications-table}

生成 `database/schema/notifications.ts`，即[通知](./notifications)的 `database` 渠道使用的表。之后运行 `haze db:generate` 与 `haze db:migrate`，并在 `config/notification.ts` 中把 `channels.database.store` 设为 `databaseNotificationStore(notifications)`。

### `make:auth-tables` {#make-auth-tables}

生成 `database/schema/auth.ts`，包含 [API 令牌](./api-tokens)、找回密码、[两步验证与通行密钥](./two-factor)所需的表。删掉用不到的表，再运行 `haze db:generate` 与 `haze db:migrate`。模板中已经带有精简后的版本（只保留令牌与找回密码两张表）。

这两个命令不需要名称，支持以下选项：

| 选项 | 说明 |
| --- | --- |
| `--dialect` | `sqlite`、`postgres` 或 `mysql`，默认与 `make:model` 一样按已安装的驱动推断；不支持 MongoDB |
| `--force` | 表结构文件已存在时覆盖 |

## 数据库

以下命令读取 `config/database.ts` 中的连接。详见[数据库](./database)。

### `haze db:generate`

根据表结构文件的变化，用 drizzle-kit（需已安装）生成迁移。方言由连接的驱动决定；表结构读取自 `database/schema/*.ts`，迁移写入 `database/migrations`（非默认连接为 `database/migrations/<连接名>`）。两个路径都可以在连接配置中用 `schema`、`migrations` 覆盖。

| 选项 | 说明 |
| --- | --- |
| `--connection`、`-c` | 连接名，默认为 `config/database.ts` 中的 `default`（带 `--module` 时为模块的连接） |
| `--module`、`-m` | 本地模块：读取 `modules/<module>/database/schema`，写入 `modules/<module>/database/migrations` |
| `--name` | 迁移名称，例如 `create_posts` |
| `--custom` | 生成空白迁移，手写 SQL |

MongoDB 连接没有 SQL 表结构，也没有迁移。

### `haze db:migrate`

执行尚未运行的迁移。实现与生产环境的 `migrate.mjs` 入口相同，只是从源码目录读取迁移文件。每个连接先按启用顺序执行[模块的迁移](./modules#迁移)（各自记录在自己的表中），最后执行项目自身的迁移。

| 选项 | 说明 |
| --- | --- |
| `--connection`、`-c` | 连接名，默认为 `default` |
| `--all` | 对所有连接执行 |

### `haze db:seed`

按文件名顺序执行 `database/seeders` 下的文件，在此之前先执行已启用本地模块的 `modules/<name>/database/seeders`。每个文件必须默认导出一个函数，参数为应用实例。

| 选项 | 说明 |
| --- | --- |
| `--file` | 只执行指定文件（不含扩展名） |

## 队列

以下命令使用 `config/queue.ts` 中的连接。详见[队列](./queues)。

### `haze queue:work`

持续消费队列任务，按 Ctrl+C 停止。修改任务代码后无需重启 worker 即可生效。

| 选项 | 说明 |
| --- | --- |
| `--connection` | 队列连接，默认为 `config/queue.ts` 中的 `default` |
| `--queue`、`-q` | 队列名，多个用逗号分隔，按优先级排列（默认 `default`） |
| `--concurrency`、`-c` | 并发处理的任务数（默认 `1`） |

### `haze queue:failed`

列出失败的任务：ID、任务名、队列、失败时间、执行次数和错误信息。支持 `--connection`。

### `haze queue:retry [id]`

把失败的任务重新投递到原队列；不传 `id` 时重试全部失败任务。支持 `--connection`。

### `haze queue:forget <id>`

删除一个失败的任务。支持 `--connection`。

### `haze queue:flush`

清空所有失败的任务。支持 `--connection`。

## 定时任务

以下命令执行 `schedule/*.ts` 中定义的任务。详见[定时任务](./scheduling)。

### `haze schedule:list`

列出所有任务的 cron 表达式、时区、下次执行时间以及标记（`onOneServer`、`withoutOverlapping`）。

### `haze schedule:run`

执行当前分钟到期的任务后退出，适合由系统 cron 每分钟调用一次。有任务失败时以退出码 1 结束。

### `haze schedule:work`

常驻运行，每分钟整点检查并执行到期任务。修改 `schedule/*.ts` 后从下一分钟开始生效。

## 全文搜索

以下命令作用于 [`@hazejs/search`](./search) 的可搜索模型（需要先安装该包）。命令会加载 `app/model` 与 `app/<app>/model` 下的文件，因此 `searchable()` 要写在模型自己的文件里。模型参数可以是类名，也可以是索引名。

### `haze search:import <model>`

分批把模型的全部记录写入搜索索引，跳过已软删除的记录和 `shouldBeSearchable` 拒绝的记录。

| 选项 | 说明 |
| --- | --- |
| `--chunk` | 每批读取的数量，默认为 `config/search.ts` 的 `chunk`（500） |

### `haze search:flush <model>`

清空模型索引中的全部文档。

### `haze search:sync-settings [model]`

创建索引并同步索引设置（可搜索、可过滤、可排序的字段）；database 引擎则创建全文索引。不指定模型时同步所有可搜索的模型。

## 微服务

### `haze microservice:listen`

监听[微服务](./microservices)消息，不监听 HTTP 端口。需要安装 `@hazejs/microservices`。处理器代码修改后立即生效，新增消息模式需要重启。

| 选项 | 说明 |
| --- | --- |
| `--transport`、`-t` | 要监听的传输，多个用逗号分隔，例如 `nats,grpc`。默认取 `config/microservices.ts` 的 `listen` 或 `default` |

## 维护模式

详见 [维护模式](./maintenance)。运行中的服务、worker 与定时任务在两秒内生效，无需重启。

### `haze down`

进入维护模式：请求返回 503（JSON 或 HTML 页面），健康检查、`--except` 中的路径与持有绕过 Cookie 的浏览器除外。

| 选项 | 说明 |
| --- | --- |
| `--secret` | 绕过密钥：访问 `/<secret>` 后设置 Cookie，该浏览器可以正常访问 |
| `--with-secret` | 生成随机密钥并打印出来 |
| `--retry` | `Retry-After` 秒数（默认 60） |
| `--refresh` | `Refresh` 响应头的秒数 |
| `--status` | 状态码（默认 503） |
| `--redirect` | 浏览器请求重定向到该路径 |
| `--render` | 代替内置页面渲染的视图（`app/view` 下） |
| `--except` | 放行的路径，逗号分隔，支持 `*` 通配 |
| `--message` | 页面与 JSON 响应中的提示（或翻译键） |

### `haze up`

退出维护模式。

### `haze maintenance:status`

显示当前状态以及保存的位置。

## 自定义命令

`app/command` 下（含子目录）默认导出 `defineCommand()` 的文件都会成为命令：`app/command/SendReport.ts` 用 `haze send:report` 运行，`app/command/db/Cleanup.ts` 用 `haze db:cleanup` 运行。它们会出现在 `haze --help` 的列表中，和内置命令一样支持 `--help` 与 `--root`，并以 `run()` 返回的退出码结束。详见[自定义命令](./console)。

```sh
npx haze make:command SendReport
npx haze send:report ops@example.com --dry-run
```

## 生产环境

构建产物不依赖命令行工具和源码。常驻进程型的预设（`node`、`bun`、`deno`、`docker`）会额外输出独立的入口：

```sh
node dist/migrate.mjs [--connection <name>] [--all]            # 对应 haze db:migrate
node dist/worker.mjs queue [--queue a,b] [--concurrency 5]      # 对应 haze queue:work
node dist/worker.mjs schedule                                    # 对应 haze schedule:work
node dist/worker.mjs schedule:run                                # 对应 haze schedule:run
node dist/worker.mjs command <name> [args]                       # 对应 haze <name>（app/command）
node dist/worker.mjs down [--secret s] [--retry 60] ...          # 对应 haze down
node dist/worker.mjs up                                          # 对应 haze up
node dist/worker.mjs maintenance:status                          # 对应 haze maintenance:status
```

以上路径适用于使用 `node` 或 `bun` 预设的纯后端项目；全栈项目以及 `deno` / `docker` 预设下，这些文件位于 `dist/server/`。只有项目使用了 `@hazejs/orm` 时才会生成 `migrate.mjs`。Serverless 与 Edge 平台的做法见[部署](./deployment)。

`search:*`、`microservice:listen`、`openapi`、`typegen` 和 `repl` 没有生产环境入口。全文搜索可以在自己的命令中调用 `importSearchable()` / `syncSearchSettings()`，再用 `worker.mjs command` 运行；微服务见[部署](./deployment#microservice-listeners)。
