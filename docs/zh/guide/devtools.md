# 开发者工具

`@hazejs/devtools` 为开发服务器加上一个 DevTools 面板集合。它基于 [devframe](https://devfra.me)，目前是**实验性**功能：面板与选项可能在次版本之间调整。

包含以下面板：

- **概览**：应用名称、模式、调试开关、目录、Node.js 版本与路由数；最近一次（重新）加载的结果；已启用的模块及其前缀、所属应用、数据库连接与路由数；`config/app.ts` 中声明的子应用。
- **路由**：所有路由的方法、路径、名称、处理器、中间件、模块与应用。输入关键字即可过滤，每个词都需要在某一列中出现。
- **开发面板**：内嵌 `/__haze` 的[开发面板](./observability#dev-dashboard)；开发面板关闭时不显示。
- **终端**：浏览器中的终端，并可一键运行 `haze route:list`、`haze module:list`、`haze schedule:list` 与 `haze queue:work`。

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

全栈项目中，`haze()` Vite 插件会把它挂到 Vite 开发服务器上，并在前端页面中注入一个悬浮入口，点击其中的 hazejs 按钮即可在页面上打开面板。

面板运行在开发服务器进程中，而不是应用里。修改文件后应用热替换，面板原地更新数据：浏览器保持连接，状态也不会丢失。重新加载失败时，概览面板会显示错误并弹出通知；应用恢复后两者自动消失。

生产构建不会包含 DevTools：只有开发服务器会加载它，`haze build` 的产物中没有任何引用。

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
  },
})
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `base` | `'/__devtools/'` | 面板的挂载路径。 |
| `auth` | `true` | 新浏览器需要输入一次性验证码。只有在本机只有你一个人使用、且开发服务器只监听 localhost 时才建议关闭。 |
| `terminals` | `true` | 显示终端面板。 |
| `embedded` | `true` | 全栈项目：在 Vite 提供的 HTML 页面中注入悬浮入口。 |

设置 `devtools: false` 可以在不卸载包的情况下关闭 DevTools。

## 编程方式使用 {#programmatic-use}

`createDevtools()` 可以为任何能提供"当前应用"与"重载事件"的对象创建面板，例如 `@hazejs/vite` 的 `AppHost`。它返回 Web 标准的 `handler`、Connect 风格的 `nodeMiddleware`，以及处理 WebSocket 的 `attach` / `handleUpgrade`：

```ts
import { createDevtools } from '@hazejs/devtools'

const devtools = createDevtools({ source: host, root })
// devtools.handler(request)、devtools.nodeMiddleware、devtools.attach(server)
```

`inspectApp(app)` 返回面板所渲染的可序列化快照：应用信息、模块、子应用、路由与开发面板路径。
