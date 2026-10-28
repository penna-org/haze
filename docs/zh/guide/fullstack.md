# Vite 全栈

`haze()` Vite 插件可以把任意 Vite 项目——Vue、React、Svelte、Solid 或者不用框架——变成全栈应用：同一个仓库，开发时同一个端口，生产环境一次构建。`vue` 和 `react` 模板就是这样搭建的；本文介绍它的工作原理，以及如何把它加到已有项目中。

## 接入

在前端框架插件旁边加上 `haze()`：

```ts
// vite.config.ts
import { haze } from '@hazejs/vite'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [
    vue(),
    haze(),
  ],
})
```

把后端代码放到单独的目录，并用 `srcDir` 指向它：

```ts
// haze.config.ts
import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({
  srcDir: 'server',
  // 生产环境端口；开发时使用 Vite 的端口
  port: 3000,
})
```

之后后端在 `server/` 下沿用常规目录结构（`server/app`、`server/config`、`server/route` 等），见[目录结构](./directory-structure)。依赖方面需要安装 `@hazejs/core`，以及开发依赖 `@hazejs/vite` 和 `@hazejs/cli`。

## 插件选项 {#plugin-options}

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `prefix` | `'/api'` | 交给后端处理的路径前缀，可以是数组 |
| `srcDir` | 读取 `haze.config.ts`，否则为 `.` | 后端源码目录，相对 Vite root 或绝对路径 |
| `alias` | `'~'` | 指向 `srcDir` 的导入别名，设为 `false` 关闭 |
| `port`、`host` | 读取 `haze.config.ts` | 生产入口的默认监听地址（运行时 `PORT` / `HOST` 优先） |
| `preset` | `HAZE_PRESET`，其次 `haze.config.ts`，否则 `node` | 部署预设 |
| `outDir` | 读取 `haze.config.ts`，否则 `dist` | 构建输出目录 |
| `typegen` | 读取 `haze.config.ts`，否则 `true` | 开发服务器运行时自动生成类型 |
| `cloudflare`、`vercel`、`externals` | 读取 `haze.config.ts` | 与 [`haze.config.ts` 的同名选项](./configuration#haze-config-ts)相同 |

::: tip
建议把选项统一写在 `haze.config.ts` 中，命令行和插件读取的就是同一份配置。如果直接给 `haze()` 传了 `srcDir`，插件将完全不读取 `haze.config.ts`。
:::

## 开发

```sh
pnpm dev   # 执行 haze dev，用项目的 vite.config.ts 启动 Vite
```

也可以直接运行 `vite`。两种方式都只有一个服务器，使用 Vite 的端口（默认 `5173`）：

- 路径匹配前缀的请求（`/api`、`/api/…`、`/api?…`）交给后端处理。插件的中间件注册在 Vite 内置中间件之前，接口请求不会落入静态资源处理或 SPA 回退。
- 其余请求照常由 Vite 处理。

不需要配置代理，也没有跨域问题：页面与接口同源。

::: warning 路由需要包含前缀
前缀不会被去掉，路由定义中必须带上它，就像模板中 `r.group({ prefix: '/api' }, …)` 那样。定义在前缀之外的路由（例如 `/health`）在开发时永远收不到请求。
:::

需要多个前缀时传数组：`haze({ prefix: ['/api', '/webhooks'] })`。

### 前后端都能热更新

- **前端**修改照常走 Vite 的 HMR。
- **后端**修改（`srcDir` 下的任意文件，以及 `.env` 文件）会重新构建应用并原地替换。Vite 服务器持续运行，前端页面也不会刷新。

在浏览器中直接访问出错的接口（例如 `/api/users/oops`）时，会看到带源码定位的开发错误页；前端的 `fetch` 请求得到的仍然是 JSON。

### 环境变量

前后端读取同一个 `.env`。以 `VITE_` 开头的变量会通过 `import.meta.env` 暴露给前端，其余变量只有后端能通过 `env()` 读取：

```sh
# .env
APP_NAME=my-app
DATABASE_URL=file:./data/app.db
VITE_APP_TITLE=my-app
```

## 在前端调用接口

接口与页面同源，开发和生产环境都可以直接 `fetch('/api/…')`。模板在 `src/api.ts` 中做了一层封装，负责拆开统一响应结构并处理 CSRF。下面是稍作简化的版本：

```ts
// src/api.ts
function readCookie(name: string): string | undefined {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))
  return match
    ? decodeURIComponent(match[1])
    : undefined
}

/** 修改类请求把 XSRF-TOKEN Cookie 作为请求头回传（没有时先向后端取一次） */
async function csrfHeader(method: string): Promise<Record<string, string>> {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method))
    return {}
  if (!readCookie('XSRF-TOKEN'))
    await fetch('/api/csrf-cookie')
  const token = readCookie('XSRF-TOKEN')
  return token
    ? { 'x-xsrf-token': token }
    : {}
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...await csrfHeader((init.method ?? 'GET').toUpperCase()),
      ...init.headers,
    },
  })
  const body = await res.json()
  if (body.code !== 0)
    throw new Error(body.errors?.[0]?.message ?? body.message)
  return body.data as T
}
```

全栈模板中，这套流程在后端对应的配置是：

```ts
// server/config/middleware.ts
import { defineMiddlewareConfig } from '@hazejs/core'

export default defineMiddlewareConfig({
  global: ['secureHeaders', 'compress', 'csrf'],
  alias: {},
})
```

```ts
// server/route/api.ts —— 位于 /api 分组内
r.get('/csrf-cookie', ctx => ctx.noContent())
```

1. 全局的 `csrf` 中间件把令牌保存在 Session 中，并通过 `XSRF-TOKEN` Cookie 下发给浏览器（前端脚本需要读取，所以不是 `HttpOnly`）。
2. `GET /api/csrf-cookie` 是一个空路由，只用来让前端在第一次写操作之前拿到 Cookie。
3. `POST`、`PUT`、`PATCH`、`DELETE` 请求必须在 `X-XSRF-TOKEN`（或 `X-CSRF-TOKEN`、表单字段 `_token`）中回传令牌，否则返回 `419`。
4. 带 `Authorization: Bearer …` 的请求不做校验，`test` 模式下也不校验。

在组件中使用：

```ts
const data = await api<{ message: string }>('/api/hello', {
  method: 'POST',
  body: JSON.stringify({ name: 'Ada' }),
})
```

`csrf` 的配置项见 [Session、CSRF 等](./security)。

## WebSocket 与 Socket.IO

实时连接同样共用这个端口。

- 前缀下的 **WebSocket** 路由——`r.ws('/api/ws', { … })`——会收到来自 Vite 服务器的升级请求。Vite 自己的 HMR 连接使用 `vite-hmr` 协议，两者互不影响。页面中这样连接：`` new WebSocket(`ws://${location.host}/api/ws`) ``。详见 [WebSocket](./websocket)。
- **Socket.IO**（`@hazejs/socket.io`）直接挂在 Vite 的 HTTP 服务器上，路径为 `/socket.io/`，客户端同源连接即可，不需要前缀：

```ts
// src/socket.ts
import type { Socket } from 'socket.io-client'
import { io } from 'socket.io-client'

export const chat: Socket = io('/chat', { autoConnect: false })
```

详见 [Socket.IO](./socket-io)。

## 构建

```sh
pnpm build   # haze build，也可以直接 vite build
```

一次构建同时产出前后端，先构建服务端，再构建前端：

```
dist/
├─ client/          前端资源（index.html、assets/…）
└─ server/
   ├─ index.mjs     生产入口
   ├─ migrate.mjs   生产迁移脚本（使用 @hazejs/orm 时）
   ├─ worker.mjs    队列 worker 与定时任务
   └─ node_modules/ 追踪复制进来的驱动与原生包
```

以上是默认 `node` 预设的产物结构，其他预设见[部署](./deployment)。可以通过 `haze build --preset vercel`、`haze.config.ts` 的 `preset`，或者运行 `vite build` 时设置 `HAZE_PRESET` 环境变量来选择预设。构建还会把预设与产物布局记录到 `.haze/build.json`，供预览使用。

## 生产运行

```sh
pnpm start   # haze start，或 node dist/server/index.mjs
```

一个进程同时提供接口和前端页面：

- 前缀下的请求交给应用处理；
- 其余 `GET` / `HEAD` 请求从 `dist/client` 提供静态文件，`/assets/` 下的文件带长期缓存的 immutable `Cache-Control`；
- 没有匹配到文件、且接受 HTML 的请求回退到 `index.html`（no-cache），前端路由的 history 模式因此可以正常工作。接口路径不会回退。

在 `vercel`、`netlify`、`cloudflare` 上，前端由平台的 CDN 提供，只有前缀下的请求才会到达函数。

## 预览

```sh
pnpm preview   # haze preview，等同 vite preview
```

预览运行的是按预设构建出来的**真实产物**（默认端口 `4173`），而不是源码：`node` / `bun` / `deno` / `docker` 启动产物子进程，Serverless 预设调用函数处理器，Cloudflare 使用 Miniflare。进程型预设下 WebSocket 连接也会被转发。

## TypeScript

模板在 `tsconfig.json` 中引用了两个子项目：

- `tsconfig.app.json`：前端（`src/**`），带 `@/*` 别名和 `vite/client` 类型。
- `tsconfig.server.json`：后端（`server/**`、`tests/**`、`*.config.ts` 与 `.haze/types/**/*.d.ts`），把 `~/*` 映射到 `./server/*`，类型包含 `node`、`vite/client` 和 `@hazejs/vite/client`。

`@hazejs/vite/client` 为插件的虚拟模块（`virtual:haze/app`、`virtual:haze/migrations`）提供类型声明，供导入它们的代码使用。运行 `pnpm typecheck`（`vue-tsc --build` 或 `tsc --build`）可以同时检查两个子项目。

## 测试

后端测试位于项目根目录的 `tests/`，用 `haze test` 运行。测试配置以独立模式加载插件，只启动后端，不启动前端：

```ts
// vitest.config.ts
import { defineHazeTestConfig } from '@hazejs/testing/config'
import { defineConfig } from 'vitest/config'

export default defineConfig(defineHazeTestConfig({
  test: {
    include: ['tests/**/*.test.ts'],
  },
}))
```

详见[测试](./testing)。
