# 认证

hazejs 的认证分为两部分，都在 `config/auth.ts` 中配置：

- **Guard** 决定“怎么认”：`jwt` Guard 读取 `Authorization: Bearer <token>`，`session` Guard 读取会话 Cookie，`token` Guard 校验可吊销的[个人访问令牌](./api-tokens)。
- **Provider（用户来源）** 决定“用户从哪来”：通常是一个模型，也可以是任何实现了 `UserProvider` 接口的对象。

api 模板自带 JWT Guard、带 `password` 哈希列的 `User` 模型，以及可直接运行的注册 / 登录 / 获取当前用户流程，另外还有 API 令牌、[邮箱验证](#邮箱验证)、[找回密码](#找回密码)和 GitHub 登录。也支持[两步验证与通行密钥](./two-factor)。

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
| `expiresIn` | `'2h'` | 有效期，时长字符串或秒数；函数 `(ctx) => …` 在每次签发时求值（有效期保存在运行时设置中时），`login(user, claims, { expiresIn })` 可覆盖单个令牌 |
| `issuer` / `audience` | | 签发时写入，校验时检查 |
| `cookie` | | 同时从该 Cookie 读取令牌（浏览器场景） |
| `resolveUser` | | `(payload, ctx) => user`：由校验过的声明取得用户，代替 `provider.retrieveById(sub)`，见下文 |
| `rejectClaims` | | 带有这些声明的令牌不能用于认证，如用同一密钥签发的找回密码凭证 `['purpose']` |

令牌中包含 `sub`（用户 ID）、`iat`、`exp`、随机的 `jti` 以及自定义声明，可以用 `await ctx.auth.jwt().payload()` 读取。过期、被篡改或格式错误的令牌一律视为未登录。

### 自己解析用户

JWT 是无状态的。需要退出、踢下线、禁用账号立即生效时，在令牌中放入会话 ID，用 `resolveUser` 在每个请求中检查。它收到校验过的声明与请求上下文，也可以读取请求头（如当前组织）。返回用户，返回 `undefined` 表示未登录；它抛出的 `HttpException` 原样作为响应，客户端可以区分会话已失效、组织无权访问与未登录：

```ts
// config/auth.ts
api: {
  driver: 'jwt',
  provider: 'users',
  expiresIn: () => Settings.get('auth.accessTokenTtl'),
  rejectClaims: ['purpose'],
  resolveUser: async (payload, ctx) => {
    const session = await Session.find(payload.sid as string)
    if (!session || session.revokedAt)
      throw new UnauthorizedException('登录已失效', { code: 'session_invalid' })
    return User.findOrFail(payload.sub)
  },
},
```

```ts
// 为会话签发令牌
const token = await ctx.auth.jwt().login(user, { sid: session.id })
```

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
| `auth:optional` / `auth:api,optional` | 不拒绝：凭据有效时识别用户，否则按访客继续（公开接口也想知道调用者是谁） |
| `guest` / `guest:web` | 已登录用户返回 `403`（适合登录、注册接口） |
| `verified` | 要求邮箱已验证：未登录 `401`，未验证 `403`（见[邮箱验证](#邮箱验证)） |
| `abilities:a,b` / `ability:a,b` | [API 令牌](./api-tokens#能力)须具备全部 / 任一能力 |

```ts
// route/api.ts
r.get('/me', [AuthController, 'me']).middleware('auth')
r.group({ prefix: '/account', middleware: ['auth:web,api'] }, (r) => {
  r.get('/', [AccountController, 'show'])
})
```

被拒绝的请求返回 `401`：没有凭据时 `code: 'unauthenticated'`，凭据过期、被篡改或被拒绝时 `code: 'token_invalid'`，客户端据此决定重新登录还是刷新令牌。

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
| `token(name?)` | 取 token Guard，可用 `createToken()`、`tokens()`、`currentAccessToken()`（见 [API 令牌](./api-tokens)） |
| `tokenCan(ability)` | 本次请求能否使用该能力：token Guard 检查令牌，jwt / session 用户为 `true`，未登录为 `false` |
| `currentAccessToken()` | 本次请求使用的个人访问令牌（如果有） |
| `defaultGuard` | 本次请求正在使用的 Guard 名 |

`guard(name).validate(credentials)` 只校验凭据并返回用户，不会登录。

typegen 运行后（`haze dev` 会自动执行），用户类型由 `config/auth.ts` 的 providers 推导，因此模板中 `await ctx.auth.user()` 的类型就是 `User | undefined`。

## 邮箱验证

验证链接是[签名链接](./routing#签名链接)：带有过期时间和以 `APP_KEY` 为密钥的 HMAC 签名，服务端不需要保存任何数据。链接形如 `<path>/<id>/<hash>`，其中 `hash` 是用户邮箱的 SHA-256 摘要，邮箱修改后旧链接随即失效。

```ts
// config/auth.ts
export default defineAuthConfig(() => ({
  // …
  verification: {
    route: 'api.auth.verification.verify',
    expire: '60m',
  },
}))
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `provider` | 默认 Guard 的 provider | 用户来源 |
| `route` | | 验证接口的路由名（参数为 `id`、`hash`），请写**完整**的名字，包括分组前缀 |
| `path` | `'/email/verify'` | 未设置 `route` 时使用，链接为 `<path>/<id>/<hash>?expires=…&signature=…` |
| `expire` | `'60m'` | 链接有效期 |
| `email` | `'email'` | 邮箱字段 |
| `field` | `'emailVerifiedAt'` | 记录验证时间的字段 |
| `url` | | `(link, user) => string`：改写邮件中的链接，例如改为前端页面，由页面把参数转交给 API |
| `mail` | `VerifyEmailMail` | 替换内置邮件，收到的数据为 `{ appName, name, url, expiresInMinutes }` |
| `queue` | `false` | 通过队列发送 |

设置 `APP_URL` 后邮件中为绝对链接，否则为站内路径。

users 表需要一个可为空的时间字段（即 `field`）。模板中是 `database/schema/users.ts` 的 `emailVerifiedAt`（`email_verified_at`）。

### 发送与验证

```ts
import { hasVerifiedEmail, sendEmailVerification, verifyEmail } from '@hazejs/core'

export class VerificationController {
  /** 重新发送验证邮件（需登录） */
  async send(ctx: HttpContext) {
    const user = await ctx.auth.user()
    if (hasVerifiedEmail(user))
      return { status: 'verified' }
    await sendEmailVerification(user)
    return { status: 'sent' }
  }

  /** 邮件中的链接 */
  async verify(ctx: HttpContext) {
    const { verified } = await verifyEmail(ctx)
    return { status: verified ? 'verified' : 'already-verified' }
  }
}
```

```ts
// route/api.ts（位于 api. / auth. 分组内）
r.post('/email/verification-notification', [VerificationController, 'send']).middleware(['auth', 'throttle:6,60']).name('verification.send')
r.get('/email/verify/:id/:hash', [VerificationController, 'verify']).middleware('throttle:6,60').name('verification.verify')
```

- `sendEmailVerification(user)` 发送验证邮件；用户已验证时不发送，返回 `false`。注册成功后调用即可，模板在 `AuthController.register` 中这样做。
- `verificationUrl(user)` 返回 `{ url, id, hash, expires, signature }`，用于以其它方式投递链接。
- `verifyEmail(ctx)` 依次检查：签名与有效期（`403`）、用户是否存在（`404`）、邮箱摘要是否一致（`403`）；已登录时还要求链接中的用户就是当前用户（`403`）。通过后标记为已验证，返回 `{ user, verified }`，邮箱此前已验证时 `verified` 为 `false`。链接不要求登录，因此可以直接从邮件客户端打开。
- `markEmailAsVerified(user)` 把 `field` 设为当前时间，对象有 `save()` 时调用它（ORM 模型都有），并触发 `EmailVerified`（`{ user, id }`）。
- `hasVerifiedEmail(user)` 读取 `field`。

`verified` 中间件用于要求邮箱已验证的路由：未登录返回 `401`，未验证返回 `403`。

```ts
r.post('/orders', [OrderController, 'store']).middleware(['auth', 'verified'])
```

## 找回密码

```ts
// config/auth.ts
import { databasePasswordResetStore } from '@hazejs/orm'
import { passwordResetTokens } from '~/database/schema/auth'

export default defineAuthConfig(() => ({
  // …
  passwords: {
    store: databasePasswordResetStore(passwordResetTokens),
    path: '/reset-password',
    expire: '60m',
    throttle: '60s',
  },
}))
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `provider` | 默认 Guard 的 provider | 用户来源（按邮箱查找） |
| `store` | 内存 | `PasswordResetStore`，或 `config/cache.ts` 中的缓存存储名（令牌随缓存过期） |
| `expire` | `'60m'` | 令牌有效期 |
| `throttle` | `'60s'` | 同一邮箱两次发送的最短间隔，`0` 关闭 |
| `email` / `password` | `'email'` / `'password'` | 用户字段 |
| `path` | `'/reset-password'` | 前端的重置页面，链接为 `<APP_URL><path>?token=…&email=…` |
| `url` | | `({ token, email, user }) => string`，完全自定义链接 |
| `mail` | `ResetPasswordMail` | 替换内置邮件，收到的数据为 `{ appName, name, url, expiresInMinutes }` |
| `queue` | `false` | 通过队列发送 |

每个邮箱只有一个令牌，新链接会替换旧链接；令牌只保存 SHA-256 摘要。除 `databasePasswordResetStore()` 外，还可以使用 `cachePasswordResetStore(storeName?)` 与 `memoryPasswordResetStore()`。

```ts
import { PasswordReset, validate, ValidationException } from '@hazejs/core'

export class PasswordResetController {
  async forgot(ctx: HttpContext) {
    const { email } = await validate(ForgotPasswordSchema, await ctx.body())
    const status = await PasswordReset.sendLink(email)
    // 无论邮箱是否注册都返回同样的结果
    return { status: status === 'throttled' ? 'throttled' : 'sent' }
  }

  async reset(ctx: HttpContext) {
    const status = await PasswordReset.reset(await validate(ResetPasswordSchema, await ctx.body()))
    if (status !== 'reset')
      throw new ValidationException([{ target: 'body', path: 'token', message: '重置链接无效或已过期' }])
    return { status }
  }
}
```

- `PasswordReset.sendLink(email)` 返回 `'sent'`、`'throttled'` 或 `'invalid-user'`。不要把 `'invalid-user'` 告诉客户端，否则这个接口可以被用来探测哪些邮箱注册过。
- `PasswordReset.reset({ email, token, password }, callback?)` 返回 `'reset'`、`'invalid-token'`（错误、过期或已使用）或 `'invalid-user'`。默认把 `Hash.make(password)` 写入密码字段并保存用户；需要做更多事情（如吊销 API 令牌）时传入回调：

```ts
await PasswordReset.reset<User>(input, async (user, password) => {
  user.password = await Hash.make(password)
  await user.save()
  await PersonalAccessTokens.revokeAll(user)
})
```

重置成功后令牌被删除。`PasswordResetLinkSent` 与 `PasswordResetCompleted` 事件的数据为 `{ user, id, email }`。自定义流程可以使用 `PasswordReset.createToken(user)`、`tokenExists(user, token)`、`deleteToken(user)`。

这两个接口都要限流（模板中为 `throttle:6,60`）。

## 现成的路由

想快速开始时，`authRoutes()` 注册邮箱验证、找回密码与 [API 令牌](./api-tokens)的接口，并带有内置的校验：

```ts
// route/api.ts
import { authRoutes, defineRoutes } from '@hazejs/core'

export default defineRoutes((r) => {
  r.group({ prefix: '/api/auth', as: 'auth.' }, (r) => {
    authRoutes(r, { verification: true, passwordReset: true, tokens: true })
  })
})
```

| 选项 | 路由 |
|------|------|
| `verification` | `POST /email/verification-notification`（`verification.send`，需登录）、`GET /email/verify/:id/:hash`（`verification.verify`） |
| `passwordReset` | `POST /forgot-password`（`password.email`）、`POST /reset-password`（`password.update`） |
| `tokens` | `GET /tokens`、`POST /tokens`、`DELETE /tokens/:id`（`tokens.*`，需登录）；`{ abilities }` 限制可申请的能力 |
| `auth` | 需要登录的路由使用的中间件，默认 `['auth']` |
| `throttle` | 其余路由的限流，默认 `'throttle:6,60'`，`false` 关闭 |
| `minPasswordLength` | 新密码的最短长度，默认 `8` |

路由名会加上分组的 `as` 前缀，上例中 `verification.route` 应设为 `'auth.verification.verify'`。需要不同的响应或校验时，像模板一样自己写控制器。

## 模板中的实现

api、vue、react 模板包含完整的流程：

- `app/controller/TokenController.ts`：`GET/POST /api/auth/tokens`、`DELETE /api/auth/tokens/:id`；
- `app/controller/VerificationController.ts`：`POST /api/auth/email/verification-notification`、`GET /api/auth/email/verify/:id/:hash`，注册时自动发送验证邮件；
- `app/controller/PasswordResetController.ts`：`POST /api/auth/forgot-password`、`POST /api/auth/reset-password`；
- `app/controller/OAuthController.ts`：`/api/auth/github` 的 GitHub 登录，设置 `GITHUB_CLIENT_ID` 之前处于关闭状态（见[第三方登录](./oauth)）；
- `database/schema/auth.ts`（令牌与重置令牌两张表）以及 `users.emailVerifiedAt`，由迁移 `0003_add_auth_tables` 创建。

TOTP 与通行密钥见[两步验证与通行密钥](./two-factor)。

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

第二个参数可以指定 Guard：`t.actingAs(user, 'web')`；对 token Guard 会签发真实的个人访问令牌（`t.actingAs(user, 'token')`）。不使用 `@hazejs/testing` 时，`@hazejs/core` 的 `issueTestCredentials(app, user, guard?)` 以请求头的形式（`authorization` 或 `cookie`）返回同样的凭据。更多内容见[测试](./testing)。
