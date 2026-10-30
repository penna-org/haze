# 多应用

一个 hazejs 项目可以同时承载多个应用，比如对外 API、管理后台和移动端接口。每个应用有自己的路由、配置、中间件、异常处理与响应格式，同时共用模型、服务和同一份部署。应用按目录划分，每个请求根据 URL 前缀或域名分发到对应的应用。

::: tip 模块与应用
多应用把一个项目拆成配置各自独立的多个入口。如果要把一块功能（路由、配置、迁移、任务等）打包起来，在本项目或其它项目中复用，请使用[模块](./modules)。模块合并进共用的应用（没有模块级的配置、中间件或异常处理），也可以用 `app: 'admin'` 只挂载到某个应用。
:::

## 声明应用

在 `config/app.ts`（全栈项目为 `server/config/app.ts`）中列出应用，每个应用至少要有 `prefix` 或 `domain` 之一：

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  apps: {
    admin: { prefix: '/admin' }, // /admin/** → app/admin
    api: { domain: 'api.example.com' }, // api.example.com 的请求 → app/api
    mobile: { domain: '*.m.example.com', prefix: '/v1' },
  },
}))
```

| 选项 | 说明 |
|------|------|
| `prefix` | URL 前缀，如 `/admin`。匹配应用路由前会去掉前缀；`/` 表示兜底应用 |
| `domain` | 域名或域名数组。`*.example.com` 匹配任意子域名（但不匹配 `example.com` 本身） |

一个请求匹配多个应用时，绑定了域名的应用优先，其次是前缀更长的应用；没有匹配任何应用的请求交给 `route/` 中的全局路由。启动时框架会检查每个应用都声明了前缀或域名，并且不存在两个应用占用同一“域名 + 前缀”的情况。

## 目录结构

应用的代码放在 `app/<name>/` 下。只有在 `config/app.ts` 中声明过的应用目录才会被加载，像 `app/common/` 这样的目录只是普通的共享代码。

```
app/
  admin/
    controller/     # 由应用的路由文件导入
    route/          # 应用的路由文件（自动加载）
    config/         # 应用配置，与 config/ 深合并（自动加载）
    provider/       # 服务提供者，仅在应用启用时加载
    exception/
      Handler.ts    # 应用的异常处理
    response/
      Formatter.ts  # 应用的响应格式
  api/
    ...
  model/            # 所有应用共用
  service/
```

自动发现的目录只有 `route`、`config`、`provider`、`exception`（`Handler.ts`）与 `response`（`Formatter.ts`）。控制器、服务、校验规则等都是普通代码，按需导入即可。

## 路由

`app/<name>/route/*.ts` 中的路由文件与普通[路由](./routing)写法相同，路径相对于应用前缀：

```ts
// app/admin/route/web.ts
import { defineRoutes } from '@hazejs/core'
import { UserController } from '~/app/admin/controller/UserController'

export default defineRoutes((r) => {
  r.get('/users', [UserController, 'index']).name('users.index') // GET /admin/users
  r.get('/users/:id', [UserController, 'show']).name('users.show')
})
```

路由名会自动加上应用名前缀：

```ts
router.url('admin.users.show', { id: 7 }) // /admin/users/7
```

`haze route:list` 会列出所有应用的路由，并显示 APP 与 DOMAIN 列；typegen 生成的路由名类型同样包含带前缀的名字。每个应用都有独立的路由表，因此绑定不同域名的应用可以使用相同的路径。

## 配置

`app/<name>/config/*.ts` 会与同名的全局配置深合并，只对该应用生效：

```ts
// app/admin/config/app.ts
export default {
  name: 'Admin Console',
  response: { envelope: false },
}
```

在属于该应用的请求中，`config('app.name')` 与 `ctx.config.get('app.name')` 返回 `'Admin Console'`；其它地方读到的全局配置不受影响。请求作用域的服务中 `inject(Config)` 得到的是应用配置，单例服务注入的始终是全局配置。

## 中间件

`config/middleware.ts` 中的全局中间件对所有请求生效，并且在分发到应用之前执行。应用可以在 `app/<name>/config/middleware.ts` 中声明自己的全局中间件与别名，它们只作用于该应用，别名可以覆盖同名的全局别名：

```ts
// app/admin/config/middleware.ts
import { defineMiddlewareConfig } from '@hazejs/core'
import { AdminAudit } from '~/app/admin/middleware/AdminAudit'

export default defineMiddlewareConfig({
  // 对 admin 应用的所有请求生效
  global: ['audit'],
  alias: {
    audit: AdminAudit,
  },
})
```

以带 `.middleware('auth')` 的 `/admin/secure` 路由为例，执行顺序为：全局中间件 → admin 的全局中间件 → `auth`（admin 定义了同名别名时用 admin 的，否则用全局的）。详见[中间件](./middleware)。

## 异常处理与响应格式

应用可以提供 `app/<name>/exception/Handler.ts` 与 `app/<name>/response/Formatter.ts`，对该应用的请求（包括应用前缀下不存在的路径产生的 404）替换全局的实现；日志、拦截器与错误处理管线仍然共用。

```ts
// app/api/response/Formatter.ts
import type { NormalizedError } from '@hazejs/core'
import { ResponseFormatter } from '@hazejs/core'

export default class Formatter extends ResponseFormatter {
  override success(data: unknown) {
    return { ok: true, result: data }
  }

  override error(error: NormalizedError) {
    return { ok: false, error: error.message }
  }
}
```

基类的用法见[响应](./responses)与[异常与日志](./errors)。

## 服务提供者

应用声明后，`app/<name>/provider/*.ts` 会与全局的 `app/provider/*.ts` 一起加载，在模块的提供者和全局提供者之后 register 与 boot。它们的绑定和其它提供者一样是全局的，并不只作用于该应用的请求：

```ts
// app/admin/provider/AdminProvider.ts
import { defineProvider } from '@hazejs/core'

export default defineProvider({
  boot() {
    // 应用启动时执行一次
  },
})
```

## 获取当前应用

`ctx.appName` 为处理当前请求的应用名，全局路由中为 `undefined`。请求日志也会自动带上应用名。

```ts
r.get('/ping', ctx => ({ app: ctx.appName }))
```

## 代码生成

代码生成命令支持 `--app <name>`（简写 `-a`），文件生成到 `app/<name>/` 而不是 `app/` 下：

```bash
haze make:controller User --app admin   # app/admin/controller/UserController.ts
haze make:middleware AdminAudit --app admin   # app/admin/middleware/AdminAudit.ts
haze make:route web --app admin         # app/admin/route/web.ts
haze make:config app --app admin        # app/admin/config/app.ts
haze make:model Post --app admin        # app/admin/model/Post.ts（表结构仍在 database/schema）
```

全部生成命令见[命令行参考](./cli)。
