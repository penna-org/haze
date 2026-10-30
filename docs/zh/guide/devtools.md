# 开发者工具

`@hazejs/devtools` 为开发服务器加上 DevTools：一组面板展示应用的组成方式与运行时行为；一个 MCP 端点让编码代理看到同样的信息；还能生成应用结构的静态报告。它基于 [devframe](https://devfra.me)，目前是**实验性**功能：面板与选项可能在次版本之间调整。

![模块联动图：项目与 shop 模块通过 OrderPlaced、UserRegistered 事件和 SendReceipt 任务相连，并标出运行时次数](/devtools/graph.png)

| 面板 | 内容 |
|------|------|
| **概览** | 应用名称、模式、目录、Node.js 版本、路由数、最近一次（重新）加载的结果、已启用的模块与子应用。 |
| **模块联动** | 模块之间如何通过事件、监听器、任务、定时任务、共用的中间件与子应用挂载联系起来，以及运行时实际发生的事件与任务。 |
| **路由** | 所有路由的方法、路径、名称、处理器、中间件、模块与应用，输入关键字即可过滤。 |
| **请求** | 最近的请求，以及每个请求做了什么的瀑布图：查询、缓存、事件、任务（包括它引发的排队任务）、邮件、日志、异常、AI 与出站 HTTP 调用；重复执行的查询会标记为疑似 N+1。 |
| **AI** | 各模型的调用次数、token 与延迟；每次调用的消息、输出与工具调用；可以用应用配置的模型直接运行提示词的 Playground。 |
| **任务与队列** | 定时任务的下次与上次执行，以及**立即执行**按钮；各队列的任务数；每个任务的投递、成功与失败次数。 |
| **容器与事件** | 全局中间件、中间件别名与分组、提供者、容器绑定、事件及其监听器、队列任务，并标出各自来自哪个模块。 |
| **接口文档** | 应用的 [OpenAPI](./openapi) 页面（`/docs`），开启时显示。 |
| **开发面板** | `/__haze` 的[开发面板](./observability#dev-dashboard)，开启时显示。 |
| **终端** | 浏览器中的终端，并可一键运行 `haze route:list`、`module:list`、`schedule:list` 与 `queue:work`。 |

## 安装 {#installation}

```bash
pnpm add -D @hazejs/devtools
```

安装即可。`haze dev` 会自动发现该包并打印地址：

```
  ➜  Local:    http://localhost:3000/
  ➜  Routes:   12
  ➜  DevTools: http://localhost:3000/__devtools/
```

全栈项目中，`haze()` Vite 插件会把 DevTools 挂到 Vite 开发服务器上，并在前端页面中注入一个悬浮入口。如果 Vite 配置开启了 [Vite DevTools](#vite-devtools)，hazejs 的面板会显示在其中。

DevTools 运行在开发服务器进程中，而不是应用里。修改文件后应用热替换，面板原地更新数据：浏览器保持连接，状态也不会丢失。重新加载失败时，概览面板会显示错误并弹出通知；应用恢复后两者自动消失。

生产构建不会包含 DevTools：只有开发服务器会加载它，`haze build` 的产物中没有任何引用。

## 模块联动图 {#the-module-graph}

hazejs 的模块之间不声明依赖，而是通过事件、任务和共用的中间件协作。模块联动面板从两方面把这些联系拼起来。

**声明的联系**来自各项定义：

- 模块（或项目）**定义**了某个事件或任务；
- 事件被某个模块的监听器**监听**（排队监听器会标出）；
- 定时任务**调度**某个任务；
- 路由通过另一个模块注册的别名**使用了它的中间件**；
- 模块**挂载到**某个子应用。

**运行时的联系**来自开发面板的记录：某个模块的请求**触发**了哪些事件、**投递**了哪些任务，以及次数。任务执行期间触发的事件归到该任务上。运行时的联系以带动画的曲线显示。

点击节点可以查看它的入向与出向联系；拖动节点可以重新排列，滚轮缩放。

## 请求 {#requests}

请求面板按时间倒序列出开发服务器处理过的请求，包括状态、耗时、路由与模块。选中一个请求即可看到它的时间线：每个操作都按相对请求开始的时刻排列。请求投递的排队任务在执行时做的事情也会列出来，并标记为 **job**。

![请求面板：POST /api/shop/orders 请求及其时间线，包括 OrderPlaced 事件、排队的 NotifyAdmin 监听器与 SendReceipt 任务](/devtools/requests.png)

同一个请求中，同一条 SQL 执行两次及以上时，面板会在**重复查询**中列出，并在每一次执行上标记 **N+1**。

该面板读取[开发面板](./observability#dev-dashboard)的记录，因此开发面板需要开启（开发环境默认开启）。

## AI {#ai}

AI 面板列出通过 [`@hazejs/ai`](./ai) 发起的模型调用：按模型汇总的数量与平均值，以及每次调用发送的消息、输出和模型发起的工具调用。消息与输出只在开发面板开启时记录，每段超过 4000 个字符会截断；OpenTelemetry 等其它遥测消费者永远不会收到这些内容。

![AI 面板：按模型统计的调用与 token、一次调用的系统提示词、用户消息与输出，以及 Playground](/devtools/ai.png)

Playground 可以用任意已配置的模型或别名运行提示词，并可指定系统提示词。它发起的调用同样会出现在列表中。

## 任务与队列 {#tasks}

任务面板列出定时任务的 cron 表达式、时区、下次与上次执行。**立即执行**会马上运行该任务，同样遵守 `withoutOverlapping` 与 `onOneServer`，并记录这次执行。队列数量由各连接的驱动提供；失败任务的重试与删除在[队列面板](./queues)中进行。

![任务面板：定时任务的下次执行时间与 Run now 按钮、队列数量，以及各任务的统计](/devtools/tasks.png)

## 编码代理（MCP） {#coding-agents-mcp}

DevTools 在 `/__devtools/__mcp` 提供 [MCP](https://modelcontextprotocol.io) 端点，编码代理可以像面板一样查看运行中的应用：

| 工具 | 用途 |
|------|------|
| `hazejs_snapshot` | 模块及其提供的内容、子应用、路由、中间件、提供者、容器绑定、事件、任务、定时任务。 |
| `hazejs_routes` | 按方法、路径、名称、处理器、中间件、模块或应用搜索路由。 |
| `hazejs_graph` | 模块联动图，含运行时次数。 |
| `hazejs_requests` | 最近的请求，含各类操作数量与重复查询标记。 |
| `hazejs_request` | 某个请求按顺序做的所有事情。 |
| `hazejs_ai` | 最近的 AI 调用及其消息与输出。 |
| `hazejs_openapi` | 应用的 OpenAPI 文档。 |
| `hazejs_run-schedule` | 立即执行某个定时任务。 |

该端点只接受本机连接，客户端需要带上本机的 `Origin` 请求头（防止 DNS rebinding）。在 Claude Code 中添加：

```bash
claude mcp add --transport http hazejs http://localhost:3000/__devtools/__mcp --header "Origin: http://localhost:3000"
```

设置 `mcp: false` 可关闭该端点。

## 静态报告 {#static-report}

`haze devtools:report` 把应用结构（概览、模块联动、路由、容器与事件）写成静态站点，可以在 CI 中归档或在评审中分享。报告不含运行时数据。

```bash
haze devtools:report                    # → .haze/devtools-report
haze devtools:report -o dist/report --base /report/
npx serve .haze/devtools-report
```

请用任意静态文件服务器提供该目录；直接从磁盘打开 `index.html` 无法使用。

## Vite DevTools {#vite-devtools}

全栈项目的 `vite.config.ts` 开启了 [Vite DevTools](https://devtools.vite.dev)（`devtools: true`，并安装了 `@vitejs/devtools`）时，`haze()` 插件会把 hazejs 的面板注册进 Vite DevTools，而不再单独提供：与 Vite 及前端框架的面板共用一个界面、一次授权和一个 MCP 端点。两者都挂在 `/__devtools/`，所以 hazejs 不会再启动第二个。

## 授权 {#authorization}

面板可以读取项目内容并在终端中执行命令，因此只接受经过授权的浏览器。浏览器第一次连接时，终端会打印一次性验证码和链接：

```
╭ hazejs DevTools ─────────────────────────────────────────╮
│ auth code   283377                                       │
│ or open     http://localhost:3000/__devtools/#devframe_otp=283377 │
╰──────────────────────────────────────────────────────────╯
```

在 DevTools 页面输入验证码，或直接打开该链接。之后这个浏览器在该项目中一直保持授权，重启开发服务器也不需要重新验证。全栈项目中，在 `/__devtools/` 授权一次后，同源页面上的悬浮入口也随之获得授权。

## 配置 {#configuration}

在 `haze.config.ts` 中设置 `devtools`。全栈项目也可以传给 `haze()`，插件选项优先。

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  devtools: {
    base: '/__devtools/', // 挂载路径
    auth: true, // 首次连接时要求输入一次性验证码
    terminals: true, // 终端面板
    embedded: true, // 全栈项目：在前端页面中注入悬浮入口
    mcp: true, // 面向编码代理的 MCP 端点
  },
})
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `base` | `'/__devtools/'` | DevTools 的挂载路径。 |
| `auth` | `true` | 新浏览器需要输入一次性验证码。只有在本机只有你一个人使用、且开发服务器只监听 localhost 时才建议关闭。 |
| `terminals` | `true` | 显示终端面板。 |
| `embedded` | `true` | 全栈项目：在 Vite 提供的 HTML 页面中注入悬浮入口。 |
| `mcp` | `true` | 提供 MCP 端点。 |

设置 `devtools: false` 可以在不卸载包的情况下关闭 DevTools。

## 编程方式使用 {#programmatic-use}

面板读取的是 `app.introspect()`：应用结构的可序列化快照，你自己的工具也可以使用：

```ts
const info = app.introspect()
info.modules // [{ name, prefix, routes, providers, jobs, schedules, events, listeners, middleware, … }]
info.events // [{ name, module, listeners: [{ name, module, queued }] }]
info.bindings // [{ key, scope, kind, resolved }]
info.schedules // [{ name, module, expression, nextRun, … }]
```

`@hazejs/devtools` 导出了各个组成部分：

```ts
import { buildGraph, buildReport, createDevtools, setupViteDevtools } from '@hazejs/devtools'

// 为任何能提供应用、重载事件与应用模块加载器的对象（如 AppHost）创建 DevTools
const devtools = createDevtools({ source: host, root })
// devtools.handler(request)、devtools.nodeMiddleware、devtools.attach(server)

await buildReport({ source: host, outDir: 'report' })
const graph = buildGraph(app.introspect())
```
