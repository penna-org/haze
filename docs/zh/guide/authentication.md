# 认证

hazejs 的认证分为两部分，都在 `config/auth.ts` 中配置：

- **Guard** 决定“怎么认”：`jwt` Guard 读取 `Authorization: Bearer <token>`，`session` Guard 读取会话 Cookie。
- **Provider（用户来源）** 决定“用户从哪来”：通常是一个模型，也可以是任何实现了 `UserProvider` 接口的对象。

api 模板自带 JWT Guard、带 `password` 哈希列的 `User` 模型，以及可直接运行的注册 / 登录 / 获取当前用户流程。

## 配置

```ts
// config/auth.ts
import { defineAuthConfig, env } from '@hazejs/core'
import { modelUserProvider } from '@hazejs/orm'
import { User } from '~/app/model/User'

export default defineAuthConfig(() => ({
  default: 'api',
  guards: {
    api: {
      driver: 'jwt',
      provider: 'users',
      expiresIn: env('JWT_TTL', '2h'),
    },
    // 浏览器同源场景可以加一个 session Guard：
    // web: { driver: 'session', provider: 'users' },
  },
  providers: {
    users: modelUserProvider(() => User, { username: 'email', password: 'password' }),
  },
}))
```

`default` 是未指定 Guard 时使用的 Guard，每个 Guard 通过名字引用一个 provider。

## 用户来源

`@hazejs/orm` 的 `modelUserProvider(() => User, options)` 通过模型查找用户。模型以函数形式传入，避免配置文件和模型之间的循环导入。

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `username` | `'email'` | 登录名字段，可以是数组：凭据中出现的字段都会参与匹配 |
| `password` | `'password'` | 保存 `Hash.make()` 哈希的列；凭据中的同名字段是明文密码 |

用户来自别处（远程服务、LDAP 等）时，用 `defineUserProvider` 实现 `UserProvider` 接口：

```ts
// config/auth.ts
import { defineUserProvider, Hash } from '@hazejs/core'
import { findAccount, findAccountByEmail } from '~/app/service/accounts'
import type { Account } from '~/app/service/accounts'

const accounts = defineUserProvider<Account>({
  retrieveById: id => findAccount(id),
  retrieveByCredentials: ({ email }) => findAccountByEmail(String(email)),
  validateCredentials: (account, { password }) => Hash.verify(account.passwordHash, String(password)),
  getId: account => account.id,
})
```

`getId()` 的返回值会写入会话，或作为 JWT 的 `sub` 声明。

## 密码哈希

`Hash` 默认使用 scrypt；运行时没有 scrypt 时改用 PBKDF2-SHA256（Web Crypto）。哈希串中记录了算法和参数，调整设置后旧哈希仍然可以校验：

```ts
import { Hash } from '@hazejs/core'

const hash = await Hash.make('correct horse')         // $scrypt$n=16384,r=8,p=1$…
await Hash.verify(hash, 'correct horse')              // true
Hash.needsRehash(hash)                                // 参数已过时时返回 true
await Hash.make('correct horse', { algorithm: 'pbkdf2' })
```

## JWT 登录

模板中的 `AuthController` 展示了完整流程：

```ts
// app/controller/AuthController.ts
import type { HttpContext } from '@hazejs/core'
import { Hash, UnauthorizedException, validate } from '@hazejs/core'
import { User } from '~/app/model/User'
import { LoginSchema, RegisterSchema } from '~/app/validate/auth'

export class AuthController {
  async register(ctx: HttpContext) {
    const { password, ...input } = await validate(RegisterSchema, await ctx.body())
    const user = await User.create({ ...input, password: await Hash.make(password) })
    return ctx.created({
      user,
      ...await ctx.auth.jwt().login(user),
    })
  }

  async login(ctx: HttpContext) {
    const issued = await ctx.auth.jwt().attempt(await validate(LoginSchema, await ctx.body()))
    if (!issued)
      throw new UnauthorizedException('Invalid email or password')
    return issued
  }

  me(ctx: HttpContext) {
    return ctx.auth.user()
  }
}
```

```ts
// route/api.ts
r.group({ prefix: '/auth', as: 'auth.' }, (r) => {
  r.post('/register', [AuthController, 'register']).name('register')
  r.post('/login', [AuthController, 'login']).middleware('throttle:10,60').name('login')
  r.get('/me', [AuthController, 'me']).middleware('auth').name('me')
})
```

`login(user, claims?)` 与 `attempt(credentials, claims?)` 返回 `IssuedToken`：

```json
{ "token": "eyJ…", "type": "Bearer", "expiresIn": 7200, "expiresAt": "…" }
```

客户端保存令牌，之后的请求带上 `Authorization: Bearer <token>`。凭据错误时 `attempt()` 返回 `undefined`。

### JWT 选项

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `algorithm` | `'HS256'` | `HS256/384/512`、`RS256/384/512`、`PS256`、`ES256/384/512` 或 `EdDSA` |
| `secret` | `APP_KEY` | `HS*` 算法的密钥 |
| `privateKey` / `publicKey` | | 非对称算法的 PEM 密钥（PKCS#8 / SPKI） |
| `expiresIn` | `'2h'` | 有效期，时长字符串或秒数 |
| `issuer` / `audience` | | 签发时写入，校验时检查 |
| `cookie` | | 同时从该 Cookie 读取令牌（浏览器场景） |

令牌中包含 `sub`（用户 ID）、`iat`、`exp`、随机的 `jti` 以及自定义声明，可以用 `await ctx.auth.jwt().payload()` 读取。过期、被篡改或格式错误的令牌一律视为未登录。

::: warning JWT 的退出是无状态的
`ctx.auth.jwt().logout()` 只清除本次请求中的用户，令牌在过期前依然有效。请把有效期设短一些；需要立即失效时，在业务中自行维护黑名单（例如按 `jti`）。
:::

## Session 登录

浏览器同源场景可以使用 session Guard，把用户 ID 存在会话中：

```ts
// config/auth.ts
guards: {
  api: { driver: 'jwt', provider: 'users' },
  web: { driver: 'session', provider: 'users' },
},
```

```ts
// app/controller/SessionController.ts
export class SessionController {
  async store(ctx: HttpContext) {
    const credentials = await validate(LoginSchema, await ctx.body())
    if (!await ctx.auth.session('web').attempt(credentials))
      throw new UnauthorizedException('Invalid email or password')
    return ctx.auth.user()
  }

  async destroy(ctx: HttpContext) {
    await ctx.auth.session('web').logout()
    return ctx.noContent()
  }
}
```

`login(user)` 会重新生成会话 ID（防止会话固定攻击）并更换 CSRF token；`logout()` 会使会话失效。会话按需自动启动，不需要额外添加 `session` 中间件。基于 Cookie 的认证请同时启用 `csrf` 中间件，见 [Session、CSRF 等](./security#csrf-防护)。

## 保护路由

| 中间件 | 行为 |
|--------|------|
| `auth` | 默认 Guard 上必须有已登录用户，否则返回 `401` |
| `auth:api` | 使用指定的 Guard |
| `auth:web,api` | 列出的 Guard **任一**通过即放行，并作为本次请求后续使用的默认 Guard |
| `guest` / `guest:web` | 已登录用户返回 `403`（适合登录、注册接口） |

```ts
// route/api.ts
r.get('/me', [AuthController, 'me']).middleware('auth')
r.group({ prefix: '/account', middleware: ['auth:web,api'] }, (r) => {
  r.get('/', [AccountController, 'show'])
})
```

## `ctx.auth` API

| 方法 | 说明 |
|------|------|
| `user()` | 当前用户或 `undefined`（同一请求内缓存） |
| `check()` | 是否已登录 |
| `id()` | 当前用户 ID |
| `logout()` | 从默认 Guard 退出 |
| `guard(name?)` | 按名字取 Guard，同样有 `user()`、`check()`、`id()`、`validate(credentials)`、`logout()` |
| `jwt(name?)` | 取 JWT Guard，可用 `login()`、`attempt()`、`payload()`；该 Guard 不是 `jwt` 时抛错 |
| `session(name?)` | 取 Session Guard，可用 `login()`、`attempt()`、`logout()` |
| `defaultGuard` | 本次请求正在使用的 Guard 名 |

`guard(name).validate(credentials)` 只校验凭据并返回用户，不会登录。

typegen 运行后（`haze dev` 会自动执行），用户类型由 `config/auth.ts` 的 providers 推导，因此模板中 `await ctx.auth.user()` 的类型就是 `User | undefined`。

## 测试

`@hazejs/testing` 的 `actingAs()` 返回一个已登录的客户端：JWT Guard 会签发真实的令牌，Session Guard 会生成真实的会话 Cookie。

```ts
// tests/auth.test.ts
import { refreshDatabase } from '@hazejs/orm'
import { useTestApp } from '@hazejs/testing'
import { beforeEach, expect, it } from 'vitest'
import { User } from '~/app/model/User'

const t = useTestApp()
beforeEach(() => refreshDatabase({ migrations: 'database/migrations' }))

it('returns the current user', async () => {
  const user = await User.create({ name: 'Bob', email: 'bob@example.com' })
  const me = await (await t.actingAs(user)).get('/api/auth/me')
  expect(me.body.data).toMatchObject({ id: user.id })
})
```

第二个参数可以指定 Guard：`t.actingAs(user, 'web')`。不使用 `@hazejs/testing` 时，`@hazejs/core` 的 `issueTestCredentials(app, user, guard?)` 以请求头的形式（`authorization` 或 `cookie`）返回同样的凭据。更多内容见[测试](./testing)。
