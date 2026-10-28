# 授权

[认证](./authentication)回答“你是谁”，授权回答“你能做什么”。hazejs 通过 Gate 管理两类规则，都放在 `app/policy/*.ts` 中并自动注册：

- **策略（Policy）**：把一个模型的能力放在一起，`definePolicy(Post, { update, delete, ... })`。
- **能力（Ability）**：与模型无关的规则，`defineAbilities({ 'admin.access': ... })`。

## 编写策略

api 模板为用户加了 `role` 列（`member` 或 `admin`），并自带下面这个策略：

```ts
// app/policy/UserPolicy.ts
import { definePolicy, deny } from '@hazejs/core'
import { User } from '~/app/model/User'

export default definePolicy(User, {
  // 管理员拥有全部权限
  before: (actor: User | undefined) => actor?.role === 'admin' || undefined,
  update: (actor: User, user: User) => actor.id === user.id || deny('You can only edit your own profile'),
  delete: (actor: User, user: User) => actor.id === user.id || deny('You can only delete your own account'),
})
```

能力函数的第一个参数是当前用户，第二个是模型实例。可以是异步函数，返回值含义如下：

| 返回值 | 含义 |
|--------|------|
| `true` / `allow()` | 允许 |
| `false` / `undefined` / `null` | 拒绝 |
| `deny(message)` | 拒绝，`message` 会作为 `403` 响应的消息 |

新建策略：`haze make:policy Post`，生成的文件里带有 `before`、`allowGuest`、`deny` 的示例。`app/policy` 下每个文件默认导出一个策略或一组能力。

### `before`

策略的 `before(user, ability, args)` 会先于该策略中的所有能力执行：返回 `true` / `false` 直接决定结果，返回 `undefined` 则继续执行具体的能力函数。模板就是用它让管理员直接通过。

### 未登录用户

未登录用户默认直接被拒绝，能力函数根本不会被调用。用 `allowGuest()` 包装后，能力函数才会执行，此时 `user` 为 `undefined`：

```ts
// app/policy/PostPolicy.ts
import { allowGuest, definePolicy, deny } from '@hazejs/core'
import { Post } from '~/app/model/Post'
import type { User } from '~/app/model/User'

export default definePolicy(Post, {
  view: allowGuest((user: User | undefined, post: Post) => post.published || post.userId === user?.id),
  create: () => true,
  update: (user: User, post: Post) => post.userId === user.id || deny('You can only edit your own posts'),
})
```

### 类级能力

像 `create` 这样的能力，还没有实例可以检查，此时传入模型类，能力函数只会收到 user：

```ts
await ctx.authorize('create', Post)
```

## 与模型无关的能力

```ts
// app/policy/abilities.ts
import { defineAbilities } from '@hazejs/core'
import type { User } from '~/app/model/User'

export default defineAbilities({
  'admin.access': (user: User) => user.role === 'admin',
  'report.export': (_user: User, format: string) => format === 'csv',
})
```

```ts
await ctx.authorize('admin.access')
await ctx.can('report.export', 'csv')
```

## 在控制器中检查

| 方法 | 返回值 |
|------|--------|
| `await ctx.can(ability, ...args)` | 允许时为 `true` |
| `await ctx.cannot(ability, ...args)` | 拒绝时为 `true` |
| `await ctx.authorize(ability, ...args)` | 无返回值，拒绝时抛出异常 |

`authorize()` 在未登录时抛出 `401`，已登录但无权限时抛出 `403`，`403` 的消息取自 `deny()`。模板 `UserController` 中的用法：

```ts
// app/controller/UserController.ts
async update(ctx: WithId) {
  const user = await User.findOrFail(ctx.validated.params.id)
  await ctx.authorize('update', user)
  user.fill(await validate(UpdateUserSchema, await ctx.body()))
  return user.save()
}
```

用户取自 `ctx.auth`（默认 Guard）。没有 `config/auth.ts` 时，所有人都视为未登录。

## 路由中间件

`can` 中间件在进入控制器之前做同样的检查：

```ts
// route/api.ts
r.get('/admin/stats', [AdminController, 'stats']).middleware('can:admin.access')
r.post('/posts', [PostController, 'store']).middleware('can:create,Post')
r.patch('/posts/:id', [PostController, 'update']).middleware('can:update,Post,id')
```

| 写法 | 检查内容 |
|------|----------|
| `can:<ability>` | `defineAbilities` 中的能力 |
| `can:<ability>,<Model>` | `<Model>` 策略中的类级能力 |
| `can:<ability>,<Model>,<param>` | 先用 `Model.findOrFail(ctx.param(param))` 加载模型（不存在时 `404`），再检查该实例 |

`<Model>` 是已注册策略的模型类名。第三种写法会把加载出的实例存到上下文中，键名为类名首字母小写，控制器无需再查一次：

```ts
// app/controller/PostController.ts
async update(ctx: HttpContext) {
  const post = ctx.get<Post>('post')!
  post.fill(await validate(UpdatePostSchema, await ctx.body()))
  return post.save()
}
```

## 能力名的类型检查

typegen（`haze dev` 自动执行，也可以手动 `haze typegen`）会读取 `app/policy`，生成能力名的类型。之后 `ctx.can()`、`ctx.cannot()`、`ctx.authorize()` 只接受真实存在的能力：模型能力按传入的模型匹配，普通能力来自 `defineAbilities`。能力名拼错会在类型检查时报错，而不是等到运行时抛出 “Unknown ability”。

## 在请求之外使用

Gate 是应用内的单例。在任务、监听器或脚本中，需要显式绑定用户：

```ts
import { Gate, useApp } from '@hazejs/core'

const gate = useApp().make(Gate)
if (await gate.forUser(user).can('update', post)) {
  // ...
}
const { allowed, message, guest } = await gate.forUser(user).inspect('update', post)
```

`forUser()` 返回的对象有 `can()`、`cannot()`、`authorize()`、`inspect()`。在服务中也可以 `inject(Gate)`。

## 在代码中注册规则

除了 `app/policy`，也可以在服务提供者中注册能力和全局钩子：

```ts
// app/provider/AuthProvider.ts
import { defineProvider, Gate } from '@hazejs/core'
import type { User } from '~/app/model/User'

export default defineProvider({
  boot(app) {
    const gate = app.make(Gate)
    gate.define('beta', (user: User) => user.role === 'admin')
    // 先于所有检查执行；返回 undefined 继续判断
    gate.before((user: User | undefined) => user?.role === 'admin' || undefined)
    // 观察每次判断结果（审计日志），不能改变结果
    gate.after((user, ability, allowed) => {
      app.logger.info(`gate ${ability}: ${allowed}`)
    })
  },
})
```

## 判断顺序

1. 先执行全局 `gate.before()`，再执行策略的 `before`，第一个非 `undefined` 的结果即为最终结果。
2. 未登录用户直接拒绝，除非能力用 `allowGuest()` 包装过。
3. 执行能力函数。
4. 全局 `gate.after()` 观察结果。

策略沿原型链查找，模型的子类会沿用父类的策略。请求一个不存在的能力会直接抛错，因为这属于编程错误。

::: info
策略目前是全局的：[多应用](./multi-app)项目中的 `app/<name>/policy` 暂不会被加载。
:::

## 测试

用 `actingAs()` 分别验证规则的两面：

```ts
// tests/user.test.ts
it('only lets users change themselves', async () => {
  const ada = await User.create({ name: 'Ada', email: 'ada@example.com' })
  const bob = await User.create({ name: 'Bob', email: 'bob@example.com' })

  expect((await t.patch(`/api/users/${ada.id}`, { name: 'x' })).status).toBe(401)
  const forbidden = await (await t.actingAs(bob)).patch(`/api/users/${ada.id}`, { name: 'x' })
  expect(forbidden.status).toBe(403)
})
```

更多内容见[测试](./testing)。
