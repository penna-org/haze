# OpenAPI 文档

hazejs 的路由本身就是数据，所以不需要额外的注解就能描述接口。框架根据已注册的路由和 `.validate()` 的 schema 生成 **OpenAPI 3.1** 文档，提供文档页面（Scalar 或 Swagger UI），还能为前端生成类型安全的客户端。

```ts
// route/api.ts
import { defineRoutes } from '@hazejs/core'
import { PostController } from '~/app/controller/PostController'
import { CreatePostSchema, PostSchema } from '~/app/validate/post'

export default defineRoutes((r) => {
  r.post('/posts', [PostController, 'store'])
    .name('posts.store')
    .middleware('auth')
    .validate({ body: CreatePostSchema })
    .doc({ summary: '发布文章', response: PostSchema, status: 201 })
})
```

开发时打开 `http://localhost:3000/docs` 即可浏览接口，原始文档位于 `/openapi.json`。

## 配置

除生产环境外，文档默认开启。只有需要调整时才添加 `config/openapi.ts`：

```ts
// config/openapi.ts
import { defineOpenAPIConfig } from '@hazejs/core'

export default defineOpenAPIConfig({
  info: { version: '1.2.0', description: '博客接口' },
  servers: [{ url: 'https://api.example.com' }],
  ui: 'scalar',
})
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | 生产环境外为 `true` | 是否提供 JSON 文档与文档页面 |
| `path` | `'/openapi.json'` | JSON 文档的地址 |
| `docsPath` | `'/docs'` | 文档页面的地址；`false` 只提供 JSON |
| `ui` | `'scalar'` | `'scalar'` 或 `'swagger'` |
| `uiOptions` | — | 传给 Scalar / Swagger UI 的额外配置 |
| `info` | `title` 取 `app.name`，`version` 为 `'1.0.0'` | OpenAPI 的 `info` |
| `servers` | `app.url`（`APP_URL`） | OpenAPI 的 `servers` |
| `tags` | — | 标签说明，例如 `[{ name: 'posts', description: '文章' }]` |
| `envelope` | `app.response.envelope` | 成功响应的外层格式，见 [统一响应格式](#response-envelope) |
| `securitySchemes` | 由 `config/auth.ts` 生成 | 追加或覆盖安全方案 |
| `include` | — | `(route) => boolean`，筛选写入文档的路由 |

文档页面从 jsDelivr 加载固定版本的 Scalar / Swagger UI，不会增加项目依赖，但浏览器需要能访问外网。

::: tip valibot schema
实现了 Standard JSON Schema 的库（zod 4、arktype 等）可以直接转换。valibot 需要安装转换器：

```bash
pnpm add @valibot/to-json-schema
```

未安装时文档照常生成，只是 valibot schema 会显示为“任意值”。
:::

::: warning 全栈项目
在 [全栈项目](./fullstack) 中，后端只接收前缀（默认 `/api`）下的请求，因此要把文档地址也放到前缀下：`path: '/api/openapi.json'`、`docsPath: '/api/docs'`。
:::

如果要在生产环境公开文档，设置 `enabled: true`，必要时为页面加上访问控制。

## 生成规则

每个路由对应一个 operation：

- **路径**：`:id` 转为 `{id}`，分组与 [多应用](./multi-app) 的前缀都会包含在内。WebSocket 路由与 `r.any()` 注册的路由不写入文档。
- **operationId**：取路由名（`api.posts.show`），未命名时由方法和路径生成（`getApiPostsById`）。
- **标签**：取路径的第一段，跳过 `api` 以及 `v1` 这类版本段（`/api/v1/posts/:id` → `posts`）。
- **参数**：路径参数来自 `.validate({ params })`（没有时为字符串）；`query` 与 `headers` schema 的每个属性各生成一个参数，`required` 与 `description` 取自 schema。query 与请求头描述的是 transform 之前的*输入*类型。
- **请求体**：`body` schema 默认为 `application/json`，含文件字段（`v.file()`、`v.blob()`、`z.file()`）时为 `multipart/form-data`。
- **响应**：
  - 成功响应，按统一响应格式包装；
  - 有 `.validate()` 时附带 `422`，结构与 [校验错误](./requests#校验错误) 一致；
  - 使用 `auth` 中间件时附带 `401`；
  - 使用 `can:` 或 `guest` 时附带 `403`。
- **安全要求**：`auth` 中间件会为对应的 Guard 添加安全要求。JWT Guard 生成 HTTP Bearer 方案，Session Guard 生成 Cookie 方案（`haze_session`），方案名与 Guard 同名；`auth:api,web` 表示任选其一。没有 `config/auth.ts` 时使用通用的 `bearerAuth`。

使用了 `$defs` 的 schema 会被提升到 `components.schemas`，引用关系保持不变。

## 为路由补充文档

`.doc()` 为路由添加文档信息，与 `.validate()` 一样可以链式调用、多次调用。

```ts
// route/api.ts
r.get('/posts/:id', [PostController, 'show'])
  .name('posts.show')
  .validate({ params: PostIdParams })
  .doc({
    summary: '文章详情',
    description: '返回已发布的文章。',
    tags: ['博客'],
    response: PostSchema,
    responses: { 404: { description: '文章不存在' } },
  })

r.get('/internal/metrics', [MetricsController, 'index']).doc({ hidden: true })
```

| 字段 | 说明 |
| --- | --- |
| `summary`、`description` | 显示在文档页面中 |
| `tags` | 替换默认标签 |
| `deprecated` | 标记为已废弃 |
| `operationId` | 替换路由名 |
| `hidden` | 不写入文档 |
| `response` | 成功响应数据（统一响应格式中的 `data`）的 schema，可以是 Standard Schema 或 JSON Schema |
| `status` | 成功响应的状态码，默认 `200`；`204` 表示没有响应体 |
| `responses` | 额外的响应：`{ 404: { description, schema?, contentType? } }`，这里的 schema 不会被包装 |
| `contentType` | 默认推断的请求体类型不对时手动指定 |
| `security` | 替换安全要求；`[]` 表示无需认证 |
| `extensions` | 规范扩展字段，原样写入 operation，如 `{ 'x-permission': ['user:delete'] }` |

资源路由可以为其下所有路由统一设置 `tags`、`deprecated` 与 `hidden`：

```ts
// route/api.ts
r.resource('/posts', PostController).doc({ tags: ['文章'] })
```

## 统一响应格式 {#response-envelope}

成功响应在文档中的结构是 `{ code, message, data }`（见 [响应](./responses)），`data` 由 `.doc({ response })` 描述。设置了 `.meta({ envelope: false })` 的路由，以及 `app.response.envelope` 为 `false` 的应用，不做包装。

如果通过 `app/response/Formatter.ts` 换成了自己的格式，用函数描述它：

```ts
// config/openapi.ts
import { defineOpenAPIConfig } from '@hazejs/core'

export default defineOpenAPIConfig({
  envelope: data => ({
    type: 'object',
    properties: { success: { type: 'boolean' }, result: data },
    required: ['success', 'result'],
  }),
})
```

## 导出文档

`haze openapi` 与 `haze route:list` 一样启动应用，然后输出文档。可以把文档提交到仓库，或交给代码生成工具：

```bash
npx haze openapi                      # 输出到标准输出
npx haze openapi --output openapi.json
```

在代码中，应用启动后调用 `generateOpenAPI()`：

```ts
// tests/openapi.test.ts
import { generateOpenAPI } from '@hazejs/core'

const document = await generateOpenAPI(app, { info: { version: '2.0.0' } })
```

## 类型安全的客户端

`haze typegen`（`haze dev` 会自动执行）还会为每个**命名**路由生成客户端所需的内容：

- `.haze/types/haze.d.ts`：每个路由的方法、路径、输入与输出类型（`interface GeneratedRoutes`）；
- `.haze/routes.ts`：客户端运行时需要的路由清单（路由名 → 方法与路径）。

```ts
// src/api.ts
import { createClient } from '@hazejs/core/client'
import { routes } from '../.haze/routes'

export const api = createClient({
  routes,
  headers: () => ({ authorization: `Bearer ${localStorage.getItem('token')}` }),
})
```

```ts
// src/pages/post.ts
import { api } from '../api'

const post = await api('api.posts.show', { params: { id: 1 } })
const posts = await api('api.posts.index', { query: { page: 2 } })
await api('api.posts.store', { body: { title: 'Hello' } })
```

客户端按路由路径拼出 URL，`body` 以 JSON 发送（含 `File` / `Blob` 时自动改用 `multipart/form-data`），返回解包后的 `data`。`api.url(name, { params, query })` 只生成地址，不发请求。

`@hazejs/core/client` 只依赖 `fetch`，不包含任何服务端代码，可以放心打包进前端。

### 类型

- **输入**来自 `.validate()` 的 schema。从 `app/` 下 `validate`、`validator` 或 `schema` 目录导出的 schema（例如 `app/validate/post.ts`）会被直接引用，输入类型与 schema 的输入类型完全一致；内联的 schema 经 JSON Schema 转换，覆盖对象、数组、枚举、联合等常见结构。没有 schema 时，路径参数为 `string | number`。
- **输出**是控制器方法的返回值经 JSON 序列化后的类型：`raw()` 会被展开，模型和日期取 `toJSON()` 的结果，方法被去掉。闭包处理器的输出类型为 `unknown`。

前端的 `tsconfig` 需要包含 `.haze/types/**/*.d.ts`。输出类型指向后端的控制器文件，所以前端的 TypeScript 也要能解析后端代码的导入：在 `vue` / `react` 模板中，把 `tsconfig.server.json` 里的 `~/*` 路径加到 `tsconfig.app.json`。

### 选项

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `routes` | 必填 | `.haze/routes.ts` 中的路由清单 |
| `baseURL` | `''`（同源） | 所有地址的前缀，例如 `https://api.example.com` |
| `headers` | — | 每个请求都携带的请求头，也可以是返回请求头的（异步）函数 |
| `fetch` | `globalThis.fetch` | 自定义 `fetch`，用于 SSR 或测试 |
| `credentials` | `'same-origin'` | 传给 `fetch`；跨域携带 Cookie 时用 `'include'` |
| `envelope` | `true` | `app.response.envelope` 为 `false` 时设为 `false` |
| `unwrap` | — | `(body, response) => data`，配合自定义的响应格式 |

单次请求除了 `params`、`query`、`body`，还可以传 `headers`、`signal` 以及 `init`（其它 `fetch` 选项）。

### 错误处理

非 2xx 响应会抛出 `ClientError`，带有 `status`、解析后的 `body`、`code`、`message`，422 响应还带有校验错误 `errors`：

```ts
// src/pages/new-post.ts
import { ClientError } from '@hazejs/core/client'
import { api } from '../api'

try {
  await api('api.posts.store', { body: { title: '' } })
}
catch (error) {
  if (error instanceof ClientError && error.status === 422)
    console.log(error.errors) // [{ target: 'body', path: 'title', message: '...' }]
}
```
