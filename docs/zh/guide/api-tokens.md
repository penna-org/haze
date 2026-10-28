# API 令牌

个人访问令牌（personal access token）是用户为脚本、命令行工具和第三方集成创建的长期令牌，思路与 Laravel Sanctum 相同。与 JWT 不同，令牌保存在服务端，可以随时列出和吊销，每个令牌还带有一组**能力**（abilities）。

- 明文令牌形如 `12|haze_9qL…`（`<id>|<secret>`），只在创建时返回**一次**。
- 服务端只保存密钥部分的 SHA-256 摘要，数据库泄露也不会泄露可用的令牌。
- 请求时以 `Authorization: Bearer <token>` 发送。

## 配置

在 `config/auth.ts` 中添加 `driver: 'token'` 的 Guard：

```ts
// config/auth.ts
import { defineAuthConfig } from '@hazejs/core'
import { databaseTokenStore, modelUserProvider } from '@hazejs/orm'
import { User } from '~/app/model/User'
import { personalAccessTokens } from '~/database/schema/auth'

export default defineAuthConfig(() => ({
  default: 'api',
  guards: {
    api: { driver: 'jwt', provider: 'users' },
    token: {
      driver: 'token',
      provider: 'users',
      store: databaseTokenStore(personalAccessTokens),
    },
  },
  providers: {
    users: modelUserProvider(() => User, { username: 'email' }),
  },
}))
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `provider` | | 用户来源的名字，与其它 Guard 相同 |
| `store` | 内存存储 | 令牌的存储：`@hazejs/orm` 的 `databaseTokenStore()`，或任意 `TokenStore` |
| `type` | provider 名 | 写入 `tokenable_type` 的值，多种用户共用一张表时用于区分 |
| `expiresIn` | 永不过期 | 新令牌的默认有效期，如 `'30d'` |
| `prefix` | | 密钥前缀，如 `'haze_'`，便于 GitHub、GitLab 等平台的密钥扫描识别泄露的令牌 |

::: warning 默认存储在内存中
不设置 `store` 时，令牌保存在进程内存中（`memoryTokenStore()`），重启后丢失。测试中可以这样用，正式项目请使用数据库存储。
:::

## 数据表

`haze make:auth-tables` 生成 `database/schema/auth.ts`，其中有四张表：`personal_access_tokens`、`password_reset_tokens`、`two_factor_secrets`、`webauthn_credentials`。删去不需要的表，然后生成并执行迁移：

```bash
haze make:auth-tables                     # 按已安装的驱动推断方言
haze make:auth-tables --dialect postgres  # sqlite | postgres | mysql
haze db:generate && haze db:migrate
```

`--force` 覆盖已存在的文件。SQL 列名可以修改，但 JS 属性名（`tokenableType`、`abilities`、`lastUsedAt` 等）要保留，`database*Store()` 按这些名字读写。

## 签发令牌

请求中通过 token Guard 签发：

```ts
// app/controller/TokenController.ts
import type { HttpContext } from '@hazejs/core'

export class TokenController {
  async store(ctx: HttpContext) {
    const user = (await ctx.auth.user())!
    const { plainTextToken, accessToken } = await ctx.auth.token().createToken(user, 'deploy script', {
      abilities: ['posts:read', 'posts:write'],
      expiresIn: '90d',
    })
    // accessToken.token 是摘要，不要返回给客户端
    return ctx.created({ token: plainTextToken, id: accessToken.id })
  }
}
```

`ctx.auth.token(name?)` 按名字取 token Guard；不传名字时，默认 Guard 是 token Guard 就用它，否则取配置中的第一个 token Guard。当前用户可以通过任意 Guard 登录（模板中是 JWT 登录的用户创建令牌）。

`createToken(user, name, options?)` 的选项：

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `abilities` | `['*']` | 令牌能做的事 |
| `expiresIn` | Guard 的 `expiresIn` | 有效期，如 `'30d'` |
| `expiresAt` | | 精确的过期时间（`Date`），`null` 表示永不过期；优先于 `expiresIn` |

请求之外（数据填充、命令、队列任务）使用 `PersonalAccessTokens` 门面，默认使用第一个 token Guard，也可以传入 `guard`：

```ts
import { createAccessToken, PersonalAccessTokens } from '@hazejs/core'

const { plainTextToken } = await PersonalAccessTokens.create(user, 'cli', { abilities: ['posts:read'] })
await createAccessToken(user, 'cli')            // PersonalAccessTokens.create 的快捷函数

await PersonalAccessTokens.list(user)           // PersonalAccessToken[]（只有摘要，没有明文）
await PersonalAccessTokens.revoke(id, user)     // 令牌不属于该用户时返回 false
await PersonalAccessTokens.revokeAll(user)      // 返回吊销的数量
await PersonalAccessTokens.find(plainTextToken) // 令牌有效且未过期时返回记录
```

快捷函数叫 `createAccessToken()` 而不是 `createToken()`，因为 `@hazejs/core` 已经导出了用于[依赖注入](./container)的 `createToken()`。

Guard 上也有同样的操作：`ctx.auth.token().tokens()` 返回 `TokenRepository`，提供 `create`、`list`、`revoke`、`revokeAll`、`find`。

## 认证请求

用 token Guard 保护路由，或者同时接受 JWT 与令牌：

```ts
// route/api.ts
r.get('/me', [AuthController, 'me']).middleware('auth:api,token')
r.post('/posts', [PostController, 'store']).middleware(['auth:token', 'abilities:posts:write'])
```

以下情况视为未登录：密钥不符、令牌已吊销、已过期，或 `tokenable_type` 属于别的 Guard。认证成功时更新 `last_used_at`，同一个令牌每分钟最多写一次，避免每个请求都写库。

`ctx.auth.currentAccessToken()` 返回本次请求使用的令牌记录（不是令牌认证时为 `undefined`）。

通过 token Guard 退出会**吊销**本次请求使用的令牌：

```ts
await ctx.auth.logout() // 当前使用的是 token Guard 时
```

## 能力

能力就是字符串。`*` 表示全部能力，以 `:*` 结尾表示前缀匹配：`posts:*` 匹配 `posts:read` 和 `posts:write`。

```ts
if (await ctx.auth.tokenCan('posts:write')) {
  // …
}
```

`ctx.auth.tokenCan(ability)` 按当前使用的 Guard 判断：

- 通过 token Guard 认证：检查令牌的能力；
- 通过 `jwt` 或 `session` Guard 认证（自己的第一方客户端）：始终为 `true`；
- 未登录：`false`。

两个中间件用于检查能力，请放在 `auth` **之后**，确保使用的是正确的 Guard：

| 中间件 | 行为 |
|--------|------|
| `abilities:posts:read,posts:write` | 令牌必须具备列出的**全部**能力 |
| `ability:posts:read,admin` | 令牌具备其中**任一**能力即可 |

未登录时返回 `401`，缺少能力时返回 `403`。

## 现成的路由

`authRoutes()` 注册三个令牌接口，均需要 `auth`：

```ts
import { authRoutes } from '@hazejs/core'

r.group({ prefix: '/api/auth', as: 'auth.' }, (r) => {
  authRoutes(r, { tokens: { abilities: ['posts:read', 'posts:write'] } })
})
```

| 方法 | 路径 | 路由名 | 请求体 / 结果 |
|------|------|--------|---------------|
| `GET` | `/tokens` | `tokens.index` | 当前用户的令牌（不含摘要） |
| `POST` | `/tokens` | `tokens.store` | `{ name, abilities? }` → `201 { token, accessToken }` |
| `DELETE` | `/tokens/:id` | `tokens.destroy` | `204`；令牌不属于该用户时 `404` |

`tokens: { abilities }` 限制客户端可以申请的能力（超出时返回 `422`）；请求体中没有 `abilities` 时，令牌获得这个列表中的全部能力。`tokens: true` 不做限制。其它选项见[认证](./authentication#现成的路由)。

api、vue、react 模板在 `app/controller/TokenController.ts` 中手写了同样的接口（`GET/POST /api/auth/tokens`、`DELETE /api/auth/tokens/:id`），`GET /api/auth/me` 同时接受 JWT 与令牌（`auth:api,token`）。

## 自定义存储

存储实现 `TokenStore` 接口：

```ts
import type { TokenStore } from '@hazejs/core'

export const redisTokens: TokenStore = {
  create: async record => ({ ...record, id: await nextId() }), // 由存储分配 id
  find: async id => { /* … */ },
  list: async (tokenableType, tokenableId) => { /* … */ },
  update: async (id, values) => { /* name、abilities、lastUsedAt、expiresAt */ },
  delete: async id => { /* 返回是否存在 */ },
  deleteAll: async (tokenableType, tokenableId) => { /* 返回删除数量 */ },
}
```

id 可以是数字，或由字母、数字、`_`、`-` 组成的字符串（最长 64 个字符），即明文令牌中 `|` 之前的部分。

## 测试

对 token Guard 使用 `actingAs()` 会签发一个具备全部能力的真实令牌：

```ts
const client = await t.actingAs(user, 'token')
await client.get('/api/auth/me')
```

测试能力检查时，自己创建令牌，或者给 `issueTestCredentials()` 传入 `abilities`：

```ts
import { issueTestCredentials } from '@hazejs/core'

const headers = await issueTestCredentials(t.app, user, 'token', { abilities: ['posts:read'] })
expect((await t.withHeaders(headers).post('/api/posts', { title: 'Hi' })).status).toBe(403)
```
