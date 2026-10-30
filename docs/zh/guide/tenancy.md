# 多租户

hazejs 可以用一个应用服务多个租户（客户、组织、工作区）。每个请求先识别出所属租户，框架再把各租户的数据隔离开：

- **缓存**：键加上租户前缀；
- **文件存储**：路径加上租户目录；
- **Session**：每个租户使用独立的 Cookie 名与密钥；
- **队列任务**：携带租户，worker 中恢复；
- **数据库**：每个租户一个数据库，或共用一个数据库、由 ORM 自动填充并过滤 `tenant_id` 列。

多租户内置在 `@hazejs/core` 中，数据库部分由 [`@hazejs/orm`](./models) 提供。

::: tip 目录约定
本页示例使用 API 模板的目录结构（`app/...`、`config/...`）。全栈项目中这些目录位于 `server/` 下。
:::

## 配置

```ts
// config/tenancy.ts
import { defineTenancyConfig } from '@hazejs/core'
import { Tenant } from '../app/model/Tenant'

export default defineTenancyConfig({
  // 按顺序尝试，第一个识别出标识的生效
  resolvers: ['subdomain', 'header'],
  domain: 'example.com', // acme.example.com → "acme"
  // 按标识查找租户；返回 null / undefined 时响应 404
  find: key => Tenant.where('slug', key).find(),
  // 查找结果在进程内缓存 1 分钟
  remember: '1m',
  // 不需要租户的路由
  except: ['/health', '/webhooks/*'],
})
```

| 选项 | 说明 |
| --- | --- |
| `resolvers` | 识别租户标识的方式：`'domain'`、`'subdomain'`、`'header'`、`'path'`，或函数 `(ctx) => string \| undefined`。默认 `['header']` |
| `find` | `(key) => Tenant \| null`，什么都没返回时响应 **404** |
| `id` | 租户 ID，用于 `tenant_id` 与各种前缀，默认 `tenant.id` |
| `remember` | 在进程内缓存 `find()` 的结果（`'1m'` 或秒数），默认不缓存 |
| `header` | `header` 识别使用的请求头，默认 `X-Tenant` |
| `domain` | `subdomain` 识别的主域名 |
| `path` | `path` 识别的前缀，默认 `/t` |
| `centralDomains` | 不识别租户的域名（如管理后台）。使用子域名识别时，`domain` 本身也是中央域名 |
| `except` | 不识别租户的路径，结尾的 `*` 匹配前缀 |
| `required` | 没有识别出标识时：`true`（默认）响应 404；`false` 以“无租户”继续 |
| `global` | `false` 时只在使用了 `tenancy` 中间件的路由上识别租户，默认 `true` |
| `cache` | `false`，或 `{ stores, prefix }`。默认隔离所有存储，前缀为 `tenant:<id>:` |
| `storage` | `false`，或 `{ disks, prefix }`。默认隔离所有磁盘，目录为 `tenants/<id>/` |
| `session` | `false` 时各租户共用 Session，默认 `true` |
| `queue` | `false` 时任务不携带租户，默认 `true` |
| `database` | 每个租户独立数据库时的 `{ connections, config }`（见下文） |

租户 ID 会出现在缓存键、路径与连接名中，只能包含字母、数字、`_`、`-` 与 `.`。

### 识别方式

| 方式 | 请求 | 标识 |
| --- | --- | --- |
| `domain` | `https://acme.com/posts` | `acme.com`（完整域名） |
| `subdomain` | `https://acme.example.com/posts` | `acme`。只取一级：`a.acme.example.com` 不匹配 |
| `header` | `X-Tenant: acme` | `acme` |
| `path` | `/t/acme/posts` | `acme` |
| 函数 | 任意 | 函数的返回值 |

`path` 识别不会改写 URL：路由中需要包含这一段，它同时也是路由参数。

```ts
// route/tenant.ts
export default defineRoutes((r) => {
  r.group({ prefix: '/t/:tenant' }, (r) => {
    r.get('/posts', [PostController, 'index'])
  })
})
```

`find()` 找不到的标识响应 **404 Not Found**。没有标识的请求同样响应 404，除非设置了 `required: false`、路径在 `except` 中，或域名在 `centralDomains` 中。

### 中间件的位置

存在 `config/tenancy.ts` 时，框架在全局中间件之前识别租户，之后的中间件、路由与控制器都运行在租户上下文中。静态资源、存储的签名链接与 OpenAPI 文档在这之前处理，不需要租户。租户不存在时的 404 与其它错误一样交给异常处理器渲染。

只有部分路由需要租户时，设置 `global: false`，并在这些路由上使用 `tenancy` 中间件：

```ts
import { tenancy } from '@hazejs/core'

r.group({ middleware: [tenancy] }, (r) => {
  // ...
})
```

## 当前租户

```ts
import { currentTenant, Tenancy, useTenant } from '@hazejs/core'

r.get('/me', (ctx) => {
  ctx.tenant // 当前租户，没有时为 undefined
  useTenant() // 当前租户；不在租户上下文中时抛错
  currentTenant() // 当前租户，没有时为 undefined
  Tenancy.key() // "acme"
  Tenancy.check() // 是否处于租户上下文
})
```

通过声明合并为 `Tenant` 类型补充字段：

```ts
// types.d.ts
declare module '@hazejs/core' {
  interface Tenant {
    slug: string
    name: string
    database: string
  }
}
```

### 任务、命令与脚本

请求之外用 `Tenancy.run()` 切换租户。可以传租户对象或标识；标识不存在时抛出 `TenantNotFoundException`（404）。

```ts
await Tenancy.run('acme', async () => {
  await Post.create({ title: 'Hello' }) // acme 的数据库 / tenant_id
  await Cache.set('stats', stats) // tenant:acme:stats
})

for (const tenant of await Tenant.all())
  await Tenancy.run(tenant, () => runMigrations())

Tenancy.central(() => { /* 没有租户，即使外层处于租户上下文 */ })
```

队列任务（包括排队的邮件、监听器与搜索同步）在投递时记录租户 ID。worker 用 `find()` 查出租户，再在 `Tenancy.run()` 中执行任务；租户已不存在时任务直接失败，不再重试。在租户上下文之外投递的任务以“无租户”执行。

## 数据隔离

### 缓存

启用多租户后，`Cache` 的键在配置的前缀之后再加上 `tenant:<id>:`。在租户中执行 `Cache.flush()` 只清理该租户的键。Session（`driver: 'cache'`）、限流与查询缓存所用的存储同样如此。只隔离部分存储，或修改前缀：

```ts
cache: { stores: ['redis'], prefix: id => `t:${id}:` }
```

### 文件存储

`Storage` 的路径加上 `tenants/<id>/`：`Storage.put('avatar.png', file)` 实际写入 `tenants/acme/avatar.png`。公开链接与临时链接都包含这个目录，在租户上下文之外也能访问。`Storage.fake()` 照常可用，在 `Tenancy.run()` 中它的断言作用于该租户的文件。选项：`storage: { disks: ['s3'], prefix: id => `customers/${id}` }`。

### Session

每个租户使用独立的 Session Cookie（`haze_session_acme`），签名 / 加密密钥也按租户派生。即使多个租户共用一个域名（请求头或路径识别），从一个租户复制来的 Session Cookie 在其它租户中也会被拒绝。

## 数据库

### 每个租户一个数据库

为 ORM 提供一个函数，由模板连接计算出租户的连接：

```ts
// config/database.ts
export default defineDatabaseConfig({
  default: 'central',
  connections: {
    central: { driver: 'postgres', url: env('DATABASE_URL') }, // 租户表、计费……
    tenant: { driver: 'postgres', url: env('TENANT_DATABASE_URL') }, // 模板
  },
})

// config/tenancy.ts
export default defineTenancyConfig({
  find: key => Tenant.where('slug', key).find(),
  database: {
    connections: ['tenant'], // 默认为默认连接
    config: (tenant, base) => ({ ...base, url: tenant.databaseUrl }),
  },
})
```

```ts
export class Post extends Model.define(posts) {
  static override connection = 'tenant'
}
```

在租户上下文中，名为 `tenant` 的连接解析为 `tenant@acme`，使用 `config()` 返回的配置。每个租户的连接只建立一次，放在连接池中直到应用关闭。`Db.connection('tenant')`、模型、事务（`transaction`、`startTrans`）与 `runMigrations()` 都随之切换。不在列表中的连接（这里的 `central`）不会切换。在租户上下文之外，`tenant` 使用模板配置。

SQLite 可以每个租户一个文件：`config: (tenant, base) => ({ ...base, url: \`file:./data/tenants/${tenant.id}.db\` })`。

### 共用一个数据库：租户列

把属于租户的模型标记出来：

```ts
export class Project extends Model.define(projects) {
  static override belongsToTenant = true // 使用 tenantId 列，也可以写列名
}
```

在租户上下文中：

- 模型的所有查询（包括关联、`find()`、统计、批量更新 / 删除）都会加上 `tenantId = 当前租户 ID`（这个过滤不算 `{ all: true }` 检查里的条件：`Project.query().delete()` 仍然会报错）；
- 新建模型时，`tenantId` 为空则自动填充。

```ts
await Tenancy.run('acme', async () => {
  await Project.create({ name: 'Rocket' }) // tenantId = 'acme'
  await Project.all() // 只有 acme 的项目
  await Project.withoutGlobalScope(['tenant']).count() // 全部租户
})
```

这个条件就是名为 `tenant` 的全局作用域：`withoutGlobalScope(['tenant'])` 或 `withoutGlobalScope()` 可以关闭它。在租户上下文之外（中央代码、管理命令）不做过滤。

::: warning
作用域只对模型查询生效。`Db.table()` 与 `Db.execute()` 能看到所有租户的数据，需要自己加条件；通过查询构造器 `insert()` 写入时也不会填充租户列。
:::

## 测试

```ts
import { Tenancy } from '@hazejs/core'

it('lists the tenant\'s projects', async () => {
  const res = await app.request('/projects', { headers: { 'x-tenant': 'acme' } })
  expect(res.status).toBe(200)
})

it('creates a project for a tenant', async () => {
  await Tenancy.run({ id: 'acme' }, () => Project.create({ name: 'Rocket' }))
})
```

## 限制

- 租户连接在应用关闭前一直保持。单个进程要服务成千上万个租户时，用 `useDatabaseManager().close('tenant@acme')` 关闭空闲的连接。
- 定时任务以“无租户”执行，需要时在任务中遍历租户并调用 `Tenancy.run()`。
- 租户列作用域只适用于 SQL 模型，不适用于 MongoDB 模型。
