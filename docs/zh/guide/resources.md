# API 资源

API 资源是模型与 JSON 响应之间的一层转换：决定输出哪些字段、字段如何命名和格式化、哪些数据对当前访问者隐藏，并且保留分页信息。这些规则集中写在一处，不必散落在每个控制器里。

```ts
// app/resource/UserResource.ts
import type { User } from '~/app/model/User'
import { defineResource, when, whenLoaded } from '@hazejs/core'
import { PostResource } from '~/app/resource/PostResource'

export const UserResource = defineResource((user: User, ctx) => ({
  id: user.id,
  name: user.name,
  email: when(ctx.can('update', user), user.email),
  posts: whenLoaded('posts', PostResource),
  createdAt: user.createdAt,
}))
```

```ts
// app/controller/UserController.ts
export class UserController {
  async index(ctx: HttpContext) {
    return UserResource.collection(await User.with('posts').paginate(Number(ctx.query('page') ?? 1), 20))
  }

  async show(ctx: HttpContext) {
    return UserResource.make(await User.findOrFail(ctx.param('id')))
  }
}
```

用 `haze make:resource User` 生成（创建 `app/resource/UserResource.ts`）。

## 定义资源

`defineResource(transform, options?)` 接收一个函数，参数是要转换的对象和当前的 `HttpContext`，返回普通对象。字段的值可以是：

- 普通值、嵌套对象或数组；
- Promise：会被 await，同级字段并行求值；
- 其它资源（`PostResource.make(post)`、`PostResource.collection(posts)`）；
- 条件值（`when`、`whenLoaded`、`whenNotNull`、`merge`），条件不成立时该字段不出现在输出中。

转换函数本身也可以是 `async`。输出中的模型实例与日期照常通过 `toJSON()` 序列化。

## 返回资源

| 调用 | 输出 |
|------|------|
| `UserResource.make(user)` | 转换后的对象（`null` / `undefined` 输出 `null`） |
| `UserResource.collection(users)` | 数组 |
| `UserResource.collection(await User.paginate(page, 20))` | `{ data, meta, links }` |
| `UserResource.collection(await Db.table(logs).paginateX(20))` | `{ data, meta, links }`，meta 为游标信息 |

在控制器中直接返回即可，和其它数据一样经过[统一响应格式](./responses)：

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "data": [{ "id": 2, "name": "Bob" }],
    "meta": { "total": 41, "page": 2, "perPage": 20, "lastPage": 3, "from": 21, "to": 40 },
    "links": {
      "first": "/api/users?page=1",
      "last": "/api/users?page=3",
      "prev": "/api/users?page=1",
      "next": "/api/users?page=3"
    }
  }
}
```

关闭统一格式时（`.meta({ envelope: false })` 或 `app.response.envelope: false`），分页集合直接输出 `{ data, meta, links }`，单个资源直接输出对象本身。

分页链接沿用当前路径和查询参数，只替换 `page`（游标分页为 `lastId`），参数名可通过 `pageName` / `cursorName` 选项修改。

`make()` 与 `collection()` 返回一个惰性、可 await 的值。需要普通数据时（例如在测试中，或嵌入别的结构）直接 `await`：

```ts
const data = await UserResource.make(user)   // { id, name, ... }
```

### 追加顶层字段

`additional()` 在结果旁边追加字段：单个对象与数组会包装为 `{ data }`；分页结果则与 `data`、`meta`、`links` 并列：

```ts
return UserResource.collection(page).additional({ filters: { role } })
// { data: [...], meta: {...}, links: {...}, filters: { role: 'admin' } }
```

## 条件字段

| 辅助函数 | 输出 |
|----------|------|
| `when(condition, value, fallback?)` | 条件为真时输出 `value`，否则输出 `fallback`，没有 fallback 时移除该字段。条件可以是 Promise，如 `ctx.can(...)` |
| `whenNotNull(value)` | 值不为 `null` / `undefined` 时输出 |
| `whenLoaded('posts', PostResource?)` | 关联已经预加载（`with()` / `load()`）时输出，可用资源或函数转换 |
| `...merge(condition?, { ... })` | 一次展开多个字段，条件成立时才输出 |

值可以写成函数，只在条件成立时才求值：

```ts
defineResource((user: User, ctx) => ({
  id: user.id,
  stats: when(ctx.query('include') === 'stats', () => loadStats(user.id)),
  ...merge(user.role === 'admin', () => ({ permissions: user.permissions })),
}))
```

`whenLoaded('posts')` 作用于正在转换的对象，所以在 async 转换函数中要在第一个 `await` 之前调用；`await` 之后请显式传入对象：`whenLoaded(user, 'posts', PostResource)`。只输出已加载的关联，可以避免不经意间产生 N+1 查询。

## 在请求之外使用

只要转换函数不访问 `ctx`，资源同样可以在队列任务、命令和邮件中使用（请求之外访问 `ctx` 会抛错）。此时分页链接只有查询串部分（`?page=2`）。

## 类型与 OpenAPI

输出类型由转换函数推导：Promise 被解开，嵌套资源被展开，条件字段变为可选。可以用 `ResourceData<typeof UserResource>` 引用这个类型，类型安全的客户端（`@hazejs/core/client`）拿到的也是同一个类型。

生成 [OpenAPI](./openapi) 文档时，给资源一个 schema，再在 `.doc()` 中引用：

```ts
export const UserResource = defineResource(transform, {
  schema: v.object({ id: v.number(), name: v.string() }),
})

r.get('/users/:id', [UserController, 'show']).doc({ response: UserResource.schema })
```
