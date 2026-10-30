# 请求与校验

每个处理器都会收到一个 `HttpContext`。本页介绍如何从中读取输入、处理文件上传，以及如何用任意 [Standard Schema](https://standardschema.dev) 库校验数据。

## 读取输入

```ts
// app/controller/SearchController.ts
import type { HttpContext } from '@hazejs/core'

export class SearchController {
  async index(ctx: HttpContext) {
    const id = ctx.param('id') // 路由参数：string | undefined
    const params = ctx.params() // 全部路由参数
    const page = ctx.query('page') // ?page= 的第一个值
    const query = ctx.query() // { [key]: string | string[] }
    const token = ctx.header('authorization') // 请求头
    const theme = ctx.cookie('theme') // Cookie
    const body = await ctx.body<{ q?: string }>() // 解析后的请求体

    return { id, params, page, query, token, theme, q: body.q, ip: ctx.ip }
  }
}
```

| 方法 | 返回值 |
|------|--------|
| `ctx.param(name)` / `ctx.params()` | 路由参数（已 URL 解码的字符串） |
| `ctx.query(name)` / `ctx.query()` | 查询参数；按名读取时，重复的参数取第一个值 |
| `await ctx.body<T>()` | 解析后的请求体 |
| `ctx.header(name)` | 请求头的值或 `undefined` |
| `ctx.cookie(name)` / `await ctx.signedCookie(name)` | Cookie 的值；签名 Cookie 被篡改时返回 `undefined` |
| `ctx.ip` | 客户端 IP；仅当 `app.trustProxy` 为 `true` 时读取 `X-Forwarded-For` |
| `ctx.origin` / `ctx.secure` | 客户端访问的地址（`https://admin.example.com`）与是否为 https；仅当 `app.trustProxy` 为 `true` 时读取 `X-Forwarded-Proto` / `X-Forwarded-Host` |
| `ctx.method`、`ctx.path`、`ctx.url` | 请求方法、路径、完整的 `URL` |
| `ctx.req` | 原生的 Web `Request` |

### 请求体

`ctx.body()` 按 `content-type` 解析请求体：

- JSON → 解析后的值；
- `application/x-www-form-urlencoded` → 字符串值组成的对象；
- `multipart/form-data` → 对象，普通字段为字符串，文件字段为 `UploadedFile`，同名字段为数组。

请求体只读取一次，之后的调用（包括路由校验内部的读取）都返回同一个结果。`ctx.body<T>()` 只是声明类型，并不检查数据结构，需要保证结构正确时请做校验（见下文）。

### 请求体大小限制

超过 `app.bodyLimit`（默认 `1mb`）的请求体会被拒绝，返回 **413**。可以在 `config/app.ts` 中修改全局默认值，或用 `bodyLimit` 中间件单独放宽某个路由：

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  bodyLimit: '2mb',
}))
```

```ts
// route/api.ts
r.post('/import', [ImportController, 'store']).middleware('bodyLimit:20mb')
```

## 文件上传

对于 multipart 请求，`ctx.file(name)` 返回字段的第一个文件，`ctx.files(name)` 返回全部文件（对应 `<input type="file" multiple>`）。没有选择文件的空字段会被忽略。

`UploadedFile` 继承自标准的 `File`，`name`、`size`、`type`、`arrayBuffer()`、`stream()` 都可以直接使用，此外还提供：

| 成员 | 说明 |
|------|------|
| `field` | 表单字段名 |
| `extension` | 客户端文件名的扩展名，小写、不含点（没有时为 `''`） |
| `store(dir, disk?)` | 以随机文件名（保留扩展名）保存到存储磁盘，返回磁盘内的路径 |
| `storeAs(dir, name, disk?)` | 以指定文件名保存；只取文件名部分，防止路径穿越 |

```ts
// app/controller/AvatarController.ts
import type { HttpContext } from '@hazejs/core'
import { BadRequestException, Storage } from '@hazejs/core'

export class AvatarController {
  async store(ctx: HttpContext) {
    const avatar = await ctx.file('avatar')
    if (!avatar)
      throw new BadRequestException('请选择文件')

    const path = await avatar.store('avatars', 'public') // 或 { disk: 's3' }
    return ctx.created({ path, url: Storage.disk('public').url(path) })
  }

  async gallery(ctx: HttpContext) {
    const photos = await ctx.files('photos')
    return Promise.all(photos.map(photo => photo.storeAs('gallery', `${crypto.randomUUID()}.${photo.extension}`)))
  }
}
```

`store()` / `storeAs()` 的最后一个参数可以是磁盘名，也可以是选项对象（`{ disk, ... }`）。磁盘在 `config/filesystem.ts` 中配置，详见 [文件存储](./storage)。

## 校验

hazejs 支持任何实现了 Standard Schema 的校验库。模板默认使用 [valibot](https://valibot.dev)，zod、arktype 的用法完全相同。Schema 统一放在 `app/validate/` 下：

```ts
// app/validate/user.ts
import * as v from 'valibot'

export const CreateUserSchema = v.object({
  name: v.pipe(v.string('名称必填'), v.trim(), v.minLength(1, '名称不能为空')),
  email: v.pipe(v.string('邮箱必填'), v.email('邮箱格式不正确')),
})

export const UpdateUserSchema = v.partial(CreateUserSchema)

export const UserIdParams = v.object({
  id: v.pipe(v.string(), v.transform(Number), v.integer('用户 ID 必须是整数')),
})
```

用命令生成校验文件：

```bash
npx haze make:validate User   # app/validate/user.ts，包含 CreateUserSchema / UpdateUserSchema
```

如果项目只安装了 zod 而没有 valibot，生成的文件会使用 zod。

### 在处理器中校验

`validate(schema, value)` 可以校验任意值：成功时返回 Schema 的输出（带类型，已应用 transform），失败时抛出 `ValidationException`（422）：

```ts
// app/controller/UserController.ts
import type { HttpContext } from '@hazejs/core'
import { validate } from '@hazejs/core'
import { User } from '~/app/model/User'
import { CreateUserSchema } from '~/app/validate/user'

export class UserController {
  async store(ctx: HttpContext) {
    const input = await validate(CreateUserSchema, await ctx.body())
    return ctx.created(await User.create(input))
  }
}
```

### 在路由上校验

用 `.validate()` 在路由上声明 Schema：请求会在处理器执行前完成校验，结果写入 `ctx.validated`。支持的目标有 `params`、`query`、`headers`、`body`。所有目标都会校验，全部错误汇总后一次性返回 422。

```ts
// route/api.ts
import * as v from 'valibot'
import { GreetSchema } from '~/app/validate/greeting'

r.post('/hello', [GreetingController, 'store']).validate({ body: GreetSchema })

r.get('/posts', [PostController, 'index']).validate({
  query: v.object({
    q: v.optional(v.string()),
    page: v.optional(v.pipe(v.string(), v.transform(Number))),
  }),
})

r.resource('/users', UserController).validateMember({ params: UserIdParams })
```

在控制器中用同样的 Schema 标注上下文类型，`ctx.validated` 即可获得准确的类型：

```ts
// app/controller/GreetingController.ts
import type { HttpContext } from '@hazejs/core'
import type { GreetSchema } from '~/app/validate/greeting'

export class GreetingController {
  store(ctx: HttpContext<{ body: typeof GreetSchema }>) {
    return { message: `Hello, ${ctx.validated.body.name}!` }
  }
}
```

### 校验上传文件

`UploadedFile` 就是 `File`，所以 valibot 的文件校验可以直接用在 multipart 请求体上：

```ts
// app/validate/auth.ts
import * as v from 'valibot'

export const AvatarSchema = v.object({
  avatar: v.pipe(
    v.file('请选择图片'),
    v.mimeType(['image/png', 'image/jpeg', 'image/webp'], '只支持 png / jpeg / webp'),
    v.maxSize(2 * 1024 * 1024, '图片不能超过 2MB'),
  ),
})
```

### 使用其它校验库

```ts
// app/validate/post.ts
import { z } from 'zod'

export const CreatePostSchema = z.object({
  title: z.string().min(1),
  tags: z.array(z.string()).default([]),
})
```

`validate()` 和 `.validate()` 都可以直接使用，无需任何适配。

## 校验错误

校验失败时返回状态码 **422**，响应体为标准的 [错误格式](./responses)。`errors` 列出全部问题：`target`（直接调用 `validate()` 时省略）、以点号连接的字段路径 `path`，以及 `message`：

```json
{
  "code": 422,
  "message": "Validation Failed",
  "data": null,
  "errors": [
    { "target": "body", "path": "name", "message": "名称不能为空" },
    { "target": "body", "path": "email", "message": "邮箱格式不正确" }
  ]
}
```

需要调整结构时，在 `app/response/Formatter.ts` 中覆盖 `error()`（见 [响应](./responses)）。也可以自己抛出 `new ValidationException([{ path: 'email', message: '邮箱已被注册' }])`，例如在唯一性检查之后。
