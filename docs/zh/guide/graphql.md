# GraphQL

`@hazejs/graphql` 在 hazejs 应用中提供 GraphQL 接口。它基于官方的 [graphql-js](https://github.com/graphql/graphql-js)，补充了后端需要的部分：schema-first 与 code-first 两种写法、带内容协商的 GraphQL over HTTP、GraphiQL、深度与复杂度限制、请求级的批量加载（Loader）、hazejs 异常到 GraphQL 错误的映射，以及基于 WebSocket 的订阅。

::: tip 目录约定
本页示例使用 API 模板的目录结构（`app/...`、`config/...`）。全栈项目中这些目录位于 `server/` 下。
:::

## 安装

```bash
pnpm add @hazejs/graphql graphql
```

`graphql`（v16 或 v17）是 peer 依赖，你的 schema 与服务端使用同一份 graphql-js。

用 schema 注册服务提供者：

```ts
// app/provider/GraphQLProvider.ts
import { graphqlProvider } from '@hazejs/graphql'
import schema from '~/app/graphql/schema'

// GET 与 POST /graphql；非生产环境下浏览器访问得到 GraphiQL
export default graphqlProvider(schema)
```

## 定义 schema

### Schema-first

`defineSchema({ typeDefs, resolvers })` 由 SDL 构建可执行的 schema：

```ts
// app/graphql/schema.ts
import { UnauthorizedException } from '@hazejs/core'
import { defineSchema } from '@hazejs/graphql'
import { Post } from '~/app/model/Post'

export default defineSchema({
  typeDefs: /* GraphQL */ `
    type Post { id: Int!, title: String!, author: User! }
    type User { id: Int!, name: String! }
    type Query {
      posts: [Post!]!
      post(id: Int!): Post
    }
    type Mutation { createPost(title: String!): Post! }
  `,
  resolvers: {
    Query: {
      posts: () => Post.query().get(),
      post: (_source, args: { id: number }) => Post.find(args.id),
    },
    Mutation: {
      createPost: async (_source, args: { title: string }, ctx) => {
        const user = await ctx.auth.user()
        if (!user)
          throw new UnauthorizedException()
        return Post.create({ title: args.title, userId: user.id })
      },
    },
  },
})
```

解析器的参数与 graphql-js 一致：`(source, args, ctx, info)`，其中 `ctx` 为 [GraphQL 上下文](#上下文)。解析器可以是函数或对象：

| 写法 | 用途 |
| --- | --- |
| `field: (source, args, ctx, info) => value` | 普通字段 |
| `field: { resolve, subscribe, complexity }` | 订阅字段（`subscribe`）与[复杂度](#限制与安全) |
| `__resolveType(value, ctx)` | 接口与联合类型：返回具体类型名 |
| `__isTypeOf(value, ctx)` | 实现了接口的对象类型 |
| `Scalar: new GraphQLScalarType({...})` | 自定义标量的实现 |
| `Enum: { ADMIN: 'admin' }` | 枚举的内部值 |

为 SDL 中不存在的类型或字段写了解析器时，启动即报错，拼写错误不会被忽略。

schema 较大时可以拆分，传入数组即可。各模块可以只写 `extend type Query`，根类型会自动补上：

```ts
// app/graphql/schema.ts
import { defineSchema } from '@hazejs/graphql'
import * as posts from './posts'
import * as users from './users'

// posts.ts：export const typeDefs = `extend type Query { posts: [Post!]! } ...`；export const resolvers = {...}
export default defineSchema({
  typeDefs: [users.typeDefs, posts.typeDefs],
  resolvers: [users.resolvers, posts.resolvers],
})
```

### Code-first

`defineSchema()` 也接受 graphql-js 的 `GraphQLSchemaConfig`（或现成的 `GraphQLSchema`），任何 graphql-js schema 都可以直接使用。`objectType`、`inputType`、`field`、`nonNull`、`list` 只是很薄的封装，用于给解析器的上下文加上类型：

```ts
// app/graphql/schema.ts
import { defineSchema, field, list, nonNull, objectType } from '@hazejs/graphql'
import { GraphQLInt, GraphQLString } from 'graphql'
import { User } from '~/app/model/User'

const UserType = objectType<User>({
  name: 'User',
  fields: () => ({
    id: { type: nonNull(GraphQLInt) },
    name: { type: nonNull(GraphQLString) },
  }),
})

export default defineSchema({
  query: objectType({
    name: 'Query',
    fields: {
      users: field({ type: list(UserType), resolve: () => User.all() }),
      me: field({ type: UserType, resolve: (_source, _args, ctx) => ctx.auth.user() }),
    },
  }),
})
```

## 提供服务

### 服务提供者与配置

`graphqlProvider(schema, options?)` 在配置的路径上注册 `GET` 与 `POST` 路由。`config/graphql.ts` 是可选的：

```ts
// config/graphql.ts
import { defineGraphQLConfig } from '@hazejs/graphql'

export default defineGraphQLConfig({
  path: '/graphql',
  maxDepth: 10,
  maxComplexity: 1000,
  subscriptions: true,
})
```

| 选项 | 默认值 | 说明 |
| --- | --- | --- |
| `path` | `/graphql` | 接口路径 |
| `graphiql` | 非生产环境开启 | 浏览器访问时的 GraphiQL 页面；可传 `{ title, defaultQuery, defaultHeaders }` |
| `introspection` | 非生产环境开启 | 是否允许 `__schema` / `__type` 内省查询 |
| `maxDepth` | `15` | 最大查询深度；`false` 关闭检查 |
| `maxComplexity` | 不限制 | 最大查询复杂度 |
| `subscriptions` | `false` | 同一路径上的 WebSocket 订阅；可传 `{ connectionInitWaitTimeout, onConnect }` |

服务提供者的选项除上表外，还有 `context`、`formatError`、`rootValue`、`validationRules` 与 `middleware`（路由中间件，如 `'throttle:60,1'`）。传给服务提供者的选项优先于配置文件。schema 也可以是返回 schema（或动态 `import()`）的函数，第一次请求时加载。

### 路由辅助函数

需要自己控制路由时，挂载 `graphqlHandler()`：

```ts
// route/api.ts
import { defineRoutes } from '@hazejs/core'
import { graphqlHandler } from '@hazejs/graphql'
import schema from '~/app/graphql/schema'

const graphql = graphqlHandler(schema, { maxDepth: 8 })

export default defineRoutes((r) => {
  r.get('/graphql', graphql).middleware('throttle:60,1')
  r.post('/graphql', graphql).middleware('throttle:60,1')
})
```

### GraphQL over HTTP

处理器遵循 [GraphQL over HTTP](https://graphql.github.io/graphql-over-http/) 规范：

- `POST`：`Content-Type: application/json`，请求体为 `{ query, variables?, operationName?, extensions? }`。其它类型返回 `415`。
- `GET`：查询串中的 `query`、`operationName`，以及 JSON 编码的 `variables` / `extensions`。GET 只能执行查询，mutation 返回 `405` 与 `Allow: POST`。
- 响应类型按 `Accept` 协商：

| `Accept` | 响应类型 | 状态码 |
| --- | --- | --- |
| `application/graphql-response+json` | 同左 | 解析、校验、变量错误为 `400`；开始执行后为 `200`（字段错误在 `errors` 中） |
| `application/json`、`*/*` 或未提供 | `application/json` | 格式正确的请求一律 `200`，与旧客户端的预期一致 |
| 其它 | | `406` |

格式错误的请求（JSON 无效、缺少 `query`、`variables` 不是对象）在两种类型下都返回 `400`。不支持经 HTTP 执行订阅，请使用 WebSocket。

## 上下文

每个解析器的第三个参数是 GraphQL 上下文：

| 成员 | 说明 |
| --- | --- |
| `ctx.http` | 本次请求的 hazejs [`HttpContext`](./requests) |
| `ctx.auth` | 等同 `http.auth`：`await ctx.auth.user()`、`ctx.auth.guard('web')`（见 [认证](./authentication)） |
| `ctx.can(...)` / `ctx.authorize(...)` | [授权](./authorization)检查；`authorize` 不通过时抛出 `403` |
| `ctx.inject(Token)` | 从请求的[容器](./container)解析依赖 |
| `ctx.loader(Definition)` | 本次请求的 [Loader](#批量加载) 实例 |

解析器在请求内执行，`inject()`、`useContext()` 与请求作用域的服务和在控制器中一样可用。

用 `context` 选项添加自己的字段，并通过声明合并补充类型：

```ts
// app/provider/GraphQLProvider.ts
import { graphqlProvider } from '@hazejs/graphql'
import schema from '~/app/graphql/schema'

declare module '@hazejs/graphql' {
  interface GraphQLContext {
    tenant: string
  }
}

export default graphqlProvider(schema, {
  context: ctx => ({ tenant: ctx.header('x-tenant') ?? 'default' }),
})
```

`context()` 中抛出的 `HttpException`（如 `UnauthorizedException`）会以对应的状态码结束请求，响应体为 GraphQL 错误。

::: tip 鉴权
`authenticate()` 等路由中间件会在 GraphQL 执行之前以 hazejs 的普通 JSON 错误拒绝请求。如果 schema 是公开的、只有部分字段需要登录，请不加鉴权中间件，在解析器中检查 `ctx.auth` / `ctx.authorize()`。
:::

## 批量加载

为 50 篇文章逐个解析 `author` 会执行 50 次查询（N+1 问题）。Loader 收集同一轮中请求的键，一次批量加载。`createLoader` 内置实现，语义与 DataLoader 一致，没有额外依赖：

```ts
// app/graphql/loaders.ts
import { defineLoader } from '@hazejs/graphql'
import { User } from '~/app/model/User'

// 按 keys 的顺序返回数组，或返回以 id 为键的 Map
export const UserById = defineLoader(async (ids: readonly number[]) => {
  const users = await User.query().whereIn('id', ids).get()
  return new Map(users.map(user => [user.id, user]))
})
```

```ts
// 解析器
Post: {
  author: (post, _args, ctx) => ctx.loader(UserById).load(post.userId),
},
```

`ctx.loader(definition)` 每个请求返回一个实例：结果只在本次请求内缓存，不会在不同用户之间共享。

| API | 说明 |
| --- | --- |
| `load(key)` / `loadMany(keys)` | 加载一个或多个键；`loadMany` 中失败的键得到 `Error` |
| `prime(key, value)` | 预先写入缓存 |
| `clear(key)` / `clearAll()` | 清除缓存，例如 mutation 之后 |
| 选项 | `maxBatchSize`、`cache: false`、`cacheKey: key => string`（对象键）、`schedule` |

批量函数可以返回与 keys 一一对应的数组（元素可以是 `Error`），也可以返回 `Map`。在 GraphQL 之外需要 Loader 时，直接使用 `createLoader(fn, options)`。

## 错误

在解析器中像在控制器中一样抛出 hazejs 异常，它们会转换为带 `extensions.code` 的 GraphQL 错误：

| 抛出 | `extensions` |
| --- | --- |
| `UnauthorizedException` | `{ code: 'UNAUTHENTICATED', status: 401 }` |
| `ForbiddenException`、`ctx.authorize()` 不通过 | `{ code: 'FORBIDDEN', status: 403 }` |
| `NotFoundException` | `{ code: 'NOT_FOUND', status: 404 }` |
| `ValidationException`、`validate()` 失败 | `{ code: 'BAD_USER_INPUT', status: 422, issues: [{ path, message }] }` |
| `TooManyRequestsException` | `{ code: 'TOO_MANY_REQUESTS', status: 429 }` |
| `BusinessException(10001, '…')` | `{ code: 'BUSINESS_ERROR', status: 200, errorCode: 10001 }` |
| 其它 `HttpException` | `code` 由状态码决定（选项中的字符串 `code` 优先），并附带 `data` |
| `GraphQLError` | 原样保留，包括它的 `extensions` |
| 其它异常 | `{ code: 'INTERNAL_SERVER_ERROR' }`；未开启 `app.debug` 时消息替换为 `Internal Server Error` |

解析与校验错误的 code 为 `GRAPHQL_PARSE_FAILED` / `GRAPHQL_VALIDATION_FAILED`；下文的限制会产生 `DEPTH_LIMIT_EXCEEDED` 与 `COMPLEXITY_LIMIT_EXCEEDED`。未知错误与 5xx 异常会交给 [`ExceptionHandler`](./errors) 的 `report()`。

```ts
import { validate } from '@hazejs/core'
import { graphqlError } from '@hazejs/graphql'
import * as v from 'valibot'

const CreatePost = v.object({ title: v.pipe(v.string(), v.minLength(3)) })

export const resolvers = {
  Mutation: {
    createPost: async (_source, args) => {
      const input = await validate(CreatePost, args) // 422 → BAD_USER_INPUT，附带 issues
      if (await Post.where('title', input.title).exists())
        throw graphqlError('Title already taken', 'TITLE_TAKEN')
      return Post.create(input)
    },
  },
}
```

`formatError(formatted, error)` 可以在发送前调整每个错误。

## 限制与安全

- **深度**：`maxDepth`（默认 15）统计嵌套的选择层数，会展开片段。`{ posts { author { posts { id } } } }` 的深度为 4。
- **复杂度**：`maxComplexity` 累加每个被选字段的开销，默认为 1 加上子字段的开销。开销大或分页的字段可以单独声明：

  ```ts
  // schema-first
  Query: {
    posts: {
      resolve: (_source, args) => Post.query().limit(args.first).get(),
      complexity: ({ args, childComplexity }) => Number(args.first ?? 10) * childComplexity,
    },
  },
  // code-first：field({ type, resolve, complexity: 5 })
  ```

- 应用以生产模式运行时，**内省**与 **GraphiQL** 默认关闭。公开 API 需要保留 schema 发现时，设置 `introspection: true`。
- 内省字段不计入深度与复杂度。
- 通过 `validationRules` 追加自己的 graphql-js 校验规则。

GraphiQL 从 esm.sh 加载，版本固定并带子资源完整性（SRI）校验（版本见导出的 `GRAPHIQL_VERSIONS`），浏览器需要能访问该 CDN。

## 订阅

设置 `subscriptions: true` 后，GraphQL 路径上的 WebSocket 升级请求使用 [`graphql-transport-ws`](https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md) 协议，即 `graphql-ws` 客户端、Apollo Client 与 urql 使用的协议。升级请求与 HTTP 接口经过同一个路由与中间件，底层是 hazejs 的 [WebSocket 支持](./websocket)。

```ts
// app/graphql/pubsub.ts
import { createPubSub } from '@hazejs/graphql'

export const pubsub = createPubSub<{ postCreated: Post }>()
```

```ts
// 解析器
Mutation: {
  createPost: async (_source, args) => {
    const post = await Post.create(args)
    pubsub.publish('postCreated', post)
    return post
  },
},
Subscription: {
  postCreated: {
    subscribe: () => pubsub.subscribe('postCreated'),
    resolve: (post: Post) => post,
  },
},
```

`subscribe` 可以返回任意 `AsyncIterable`，异步生成器同样可以。`pubsub.subscribe(topic, { filter })` 按订阅者过滤事件。

客户端：

```ts
import { createClient } from 'graphql-ws'

const client = createClient({
  url: 'wss://example.com/graphql',
  connectionParams: { authorization: `Bearer ${token}` },
})
```

鉴权：可以读取浏览器 Cookie 与升级请求的请求头，`connection_init` payload 中的 `authorization`（或 `token`）字段会作为 `Authorization` 请求头，因此订阅解析器中 `ctx.auth` 照常可用。`onConnect` 可以拒绝连接：

```ts
// config/graphql.ts
import { defineGraphQLConfig } from '@hazejs/graphql'

export default defineGraphQLConfig({
  subscriptions: {
    // 返回 false 时以 4403 关闭连接
    onConnect: async ctx => (await ctx.auth.user()) !== undefined,
  },
})
```

经 WebSocket 发送的查询与 mutation 同样会执行。订阅中请用 `ctx.inject()` 而不是全局的 `inject()`：订阅不在 HTTP 请求之内。

## 测试

```ts
// tests/graphql.test.ts
import { issueTestCredentials } from '@hazejs/core'
import { expect, it } from 'vitest'
import { createApp } from './app'

it('returns the current user', async () => {
  const app = await createApp()
  const credentials = await issueTestCredentials(app, { id: 1 })
  const res = await app.request('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...credentials },
    body: JSON.stringify({ query: '{ me { id } }' }),
  })
  expect(await res.json()).toEqual({ data: { me: { id: 1 } } })
})
```

## 限制

- `createPubSub()` 只在本进程内有效。多实例部署时，请在实例之间广播事件（例如经 Redis 或[微服务](./microservices)事件），再在各实例上调用 `publish`。
- 不支持 `@defer` / `@stream`、持久化查询、文件上传与批量（数组）请求。
- 订阅需要支持 hazejs WebSocket 的运行时（Node、Bun、Deno）；Cloudflare 与 Serverless 平台见 [WebSocket](./websocket)。
