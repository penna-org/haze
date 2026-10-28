# 第三方登录（OAuth）

`@hazejs/oauth` 为应用加上“使用 GitHub / 微信 / 支付宝……登录”，用法参考 Laravel Socialite。它内置了国内外常见平台的驱动和一个通用的 OpenID Connect 驱动，并处理好容易出错的部分：`state`（防 CSRF）、PKCE、OIDC 的 `nonce`、用平台的 JWKS 校验 `id_token` 签名，以及各家不标准的参数。

| 驱动 | 平台 | 说明 |
|------|------|------|
| `github` | GitHub / GitHub Enterprise | PKCE；公开资料没有邮箱时读取已验证的主邮箱 |
| `google` | Google | OpenID Connect，`id_token` + userinfo |
| `apple` | Sign in with Apple | `form_post` 回调、ES256 签名的 client secret、`id_token` |
| `microsoft` | Microsoft Entra ID | 租户 `common` / `organizations` / `consumers` / 租户 ID；Graph `/me` |
| `gitlab` | GitLab | `baseUrl` 支持自建实例 |
| `discord` | Discord | |
| `wechat` | 微信开放平台（网站应用扫码登录） | `snsapi_login`，openid / unionid |
| `wechat_mp` | 微信公众号网页授权 | `snsapi_base` / `snsapi_userinfo` |
| `qq` | QQ 互联 | 通过 `/oauth2.0/me` 取 openid / unionid |
| `dingtalk` | 钉钉 | 新版 `login.dingtalk.com` OAuth2 |
| `feishu` | 飞书 / Lark | authen v2 令牌接口，PKCE |
| `wecom` | 企业微信 | 扫码登录或企业微信内网页授权 |
| `alipay` | 支付宝 | RSA2 签名的网关请求 |
| `oidc` | 任意 OpenID Connect 服务 | discovery、JWKS、nonce（Keycloak、Auth0、Authing、Logto、Zitadel 等） |

::: tip 目录约定
本页示例使用 API 模板的目录结构（`app/...`、`config/...`）。全栈项目中这些目录位于 `server/` 下。
:::

## 安装

```bash
pnpm add @hazejs/oauth
```

不依赖任何平台 SDK：所有接口都用 `fetch` 调用，JWT 由 [jose](https://github.com/panva/jose) 处理，RSA / ECDSA 签名使用 Web Crypto，因此可以运行在 Node、Bun、Deno 和 Cloudflare Workers 上。

## 配置

创建 `config/oauth.ts`。键名就是代码中使用的提供方名称；没有写 `driver` 时，它同时也是驱动名。

```ts
// config/oauth.ts
import { env } from '@hazejs/core'
import { defineOAuthConfig } from '@hazejs/oauth'

export default defineOAuthConfig(() => ({
  providers: {
    github: {
      clientId: env('GITHUB_CLIENT_ID', ''),
      clientSecret: env('GITHUB_CLIENT_SECRET', ''),
      // 写路径时以 APP_URL（或当前请求的 origin）补全
      redirect: '/auth/github/callback',
    },
    google: {
      clientId: env('GOOGLE_CLIENT_ID', ''),
      clientSecret: env('GOOGLE_CLIENT_SECRET', ''),
      redirect: '/auth/google/callback',
    },
    // 同一驱动换个名字再配一份
    company: {
      driver: 'oidc',
      issuer: 'https://sso.example.com/realms/main',
      clientId: env('SSO_CLIENT_ID', ''),
      clientSecret: env('SSO_CLIENT_SECRET', ''),
      redirect: '/auth/company/callback',
    },
  },
}))
```

值为 `false` / `null`，或 `clientId` 为空的提供方视为**未启用**：`OAuth.enabled(name)` 返回 `false`，`OAuth.driver(name)` 抛出 404。所以 client ID 从环境变量读取、默认值留空即可：路由可以一直保留，设置了环境变量的平台才会生效。

所有提供方共有的选项：

| 选项 | 说明 |
|------|------|
| `driver` | 内置驱动名、`registerOAuthProvider()` 注册的名字，或 `defineOAuthProvider()` 的返回值。默认取键名 |
| `clientId` | 即 `client_id`，各家叫法不同（AppID、APP ID、Client ID、corpid 等） |
| `clientSecret` | `client_secret` / AppSecret / corpsecret |
| `redirect` | 回调地址：绝对地址，或以 `APP_URL` 补全的路径 |
| `scopes` | 替换驱动的默认 scope |
| `pkce` | 开启或关闭 PKCE（S256），默认按驱动是否支持 |
| `stateless` | 该提供方不校验 state（见下文） |
| `parameters` | 授权地址上固定附加的参数 |
| `endpoints` | 覆盖接口地址（代理、私有部署、测试） |

全局选项：

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `stateStore` | `'cookie'` | 跳转到回调之间 state 的保存位置：加密 Cookie，或 `'session'` |
| `cookie` | `'haze_oauth'` | Cookie 名前缀，实际为 `<前缀>_<提供方>` |
| `stateTtl` | `'10m'` | 用户完成登录的时限 |
| `fetch` | 全局 `fetch` | 调用平台接口的 HTTP 函数（代理、测试） |

## 路由与控制器

每个平台只需要两个路由：一个跳转到平台的授权页，一个处理回调。用 `:provider` 参数可以一次覆盖所有平台，未启用或不存在的名字返回 404。

```ts
// route/api.ts
r.get('/auth/:provider', [OAuthController, 'redirect']).name('oauth.redirect')
r.get('/auth/:provider/callback', [OAuthController, 'callback']).name('oauth.callback')
// Apple 用 POST 回调（form_post）
r.post('/auth/:provider/callback', [OAuthController, 'callback'])
```

```ts
// app/controller/OAuthController.ts
import type { HttpContext } from '@hazejs/core'
import { OAuth } from '@hazejs/oauth'
import { User } from '~/app/model/User'

export class OAuthController {
  redirect(ctx: HttpContext) {
    return OAuth.driver(ctx.param('provider')!).redirect(ctx)
  }

  async callback(ctx: HttpContext) {
    const provider = ctx.param('provider')!
    const profile = await OAuth.driver(provider).user(ctx)

    // 关联到本地用户，再用 Guard 登录
    const user = await User.where('email', profile.email).find()
      ?? await User.create({ name: profile.name ?? profile.nickname ?? '用户', email: profile.email! })
    return ctx.auth.jwt().login(user)
  }
}
```

实际项目中，建议把 `(provider, id)` 存到单独的表（如 `social_accounts`）中关联用户，而不是按邮箱匹配：微信、QQ、企业微信不返回邮箱，Apple 可能返回中转邮箱，第三方给的邮箱也不应无条件信任。

单页应用如果想拿到授权地址而不是 302 跳转，可以以 JSON 返回。state Cookie 设置在同一个响应上，因此要在浏览器中带凭据请求：

```ts
async url(ctx: HttpContext) {
  return { url: await OAuth.driver('github').authorizationUrl(ctx) }
}
```

## 用户对象

`user(ctx)` 依次校验 state、用授权码换取令牌、读取用户资料，返回：

| 字段 | 说明 |
|------|------|
| `provider` | 提供方名称（`config/oauth.ts` 中的键） |
| `id` | 平台的用户 ID，统一为字符串 |
| `name` / `nickname` / `email` / `avatar` | 统一后的资料字段，平台没有返回时为 `null` |
| `raw` | 平台返回的原始资料（unionid、手机号、租户等） |
| `token` | `{ accessToken, refreshToken?, expiresIn?, idToken?, tokenType?, scope?, raw }` |

## 单次请求的选项

`OAuth.driver(name)` 每次调用都返回新的实例，下面的设置只影响本次请求：

```ts
OAuth.driver('github')
  .scopes(['repo'])                 // 在默认 scope 上追加
  .setScopes(['read:user'])         // 或整体替换
  .with({ prompt: 'consent' })      // 附加授权参数
  .redirectUrl('/auth/github/link') // 换一个回调地址
  .stateless()                      // 不写 state Cookie，不使用 PKCE 与 nonce
  .redirect(ctx)
```

## state、PKCE 与 nonce

`redirect()` 时生成随机的 `state`（驱动支持时还有 PKCE 的 `code_verifier` 和 OIDC 的 `nonce`），用 AES-GCM 加密后写入短期 Cookie，密钥由 `APP_KEY` 派生。回调时该 Cookie 只读取**一次**并立即删除：`state` 用常量时间比较，`code_verifier` 随令牌请求发送，`id_token` 中的 nonce 必须一致。state 缺失、过期、被篡改或重复使用时抛出 `InvalidStateException`（400）。

- Cookie 为 `SameSite=Lax`，平台跳转回来的顶层导航会带上它。Apple 的 `form_post` 回调是跨站 POST，因此 Apple 的 Cookie 为 `SameSite=None; Secure`（Chrome 与 Firefox 在 `http://localhost` 上也接受 `Secure` Cookie；其它浏览器请在开发环境使用 HTTPS）。
- `stateStore: 'session'` 时 state 改存会话。
- `stateless()` 关闭以上全部校验。只在有其它机制保护流程时使用，例如原生 App 自己接收授权码。
- 全栈模板全局启用了 `csrf` 中间件时，需要把 POST 回调（Apple）加入 `except`：平台无法回传你的 CSRF token，OAuth 的 state 已经承担了这个作用。

## 各平台说明

### Apple

```ts
apple: {
  clientId: env('APPLE_CLIENT_ID', ''),      // Services ID，如 com.example.web
  teamId: env('APPLE_TEAM_ID', ''),
  keyId: env('APPLE_KEY_ID', ''),
  privateKey: env('APPLE_PRIVATE_KEY', ''),  // AuthKey_XXXX.p8 的内容，可以用 \n 转义换行
  redirect: '/auth/apple/callback',
},
```

client secret 是用 `.p8` 私钥签名的 ES256 JWT，按需生成并缓存（`secretTtl`，默认 1 小时）。请求 `name` / `email` 时必须使用 `response_mode=form_post`，所以要为回调注册 POST 路由。Apple 没有 userinfo 接口：用户来自校验后的 `id_token`，姓名**只在首次授权时**随表单字段 `user` 返回，请在那时保存。iOS App 内的 Sign in with Apple，把 `identityToken` 交给 `OAuth.driver('apple').userFromToken(identityToken)` 即可。

### Microsoft

`tenant` 默认为 `common`（个人账号与工作 / 学校账号）。只允许工作 / 学校账号用 `organizations`，只允许个人账号用 `consumers`，单租户应用填租户 ID。资料来自 Microsoft Graph `/me`（`User.Read`），没有 `mail` 时 `email` 取用户主体名称（UPN）。

### GitLab 与 GitHub Enterprise

自建实例设置 `baseUrl`：GitLab 为 `https://gitlab.example.com`，GitHub Enterprise Server 为 `https://github.example.com`（接口地址为 `<baseUrl>/api/v3`）。

### 微信开放平台（`wechat`）

网站应用扫码登录，scope 为 `snsapi_login`。`clientId` 为 AppID，`clientSecret` 为 AppSecret。授权地址使用 `appid`（不是 `client_id`），按微信要求的顺序排列参数，并以 `#wechat_redirect` 结尾。令牌响应没有 `token_type`，带有 `openid` / `unionid`。

`user.id` 默认为 `openid`，每个应用各不相同。同一开放平台账号下有多个应用（网站、App、公众号）时，设置 `idField: 'unionid'`，同一个人在各处得到相同的 ID。

### 微信公众号（`wechat_mp`）

用于在微信内打开的网页。`snsapi_userinfo`（默认）需要用户确认，可以拿到昵称和头像；`snsapi_base` 为静默授权，只有 openid，因此不会请求 userinfo：

```ts
OAuth.driver('wechat_mp').setScopes('snsapi_base').redirect(ctx)
```

### QQ

`clientId` 为 APP ID，`clientSecret` 为 APP Key。openid 来自 `/oauth2.0/me`（请求时带 `unionid=1`，应用获得 unionid 权限后会一并返回）。`idField: 'unionid'` 的用法与微信相同。

### 钉钉

使用新版 OAuth2（`login.dingtalk.com/oauth2/auth`、`api.dingtalk.com/v1.0/oauth2/userAccessToken`、`v1.0/contact/users/me`）。`clientId` / `clientSecret` 为应用的 Client ID（原 AppKey）与 Client Secret（原 AppSecret）。`user.id` 为 `unionId`；授权了相应权限时，`raw` 中还有 `openId`、`mobile`、`stateCode`。

### 飞书 / Lark

```ts
feishu: {
  clientId: env('FEISHU_APP_ID', ''),
  clientSecret: env('FEISHU_APP_SECRET', ''),
  redirect: '/auth/feishu/callback',
  domain: 'feishu', // 海外版 Lark 用 'lark'（open.larksuite.com）
  // idField: 'union_id' | 'user_id'（默认 'open_id'）
},
```

使用 authen v2 令牌接口，支持 PKCE。需要 refresh_token 时在 `scopes` 中加上 `offline_access`。

### 企业微信

```ts
wecom: {
  clientId: env('WECOM_CORP_ID', ''),
  clientSecret: env('WECOM_SECRET', ''),   // 应用的 Secret
  agentId: env('WECOM_AGENT_ID', ''),
  redirect: '/auth/wecom/callback',
  mode: 'qr',        // 'qr'（浏览器扫码登录，默认）或 'web'（企业微信内打开的网页）
  // profile: true,  // 调用 user/get 读取姓名（2022 年后新建的应用通常没有权限）
  // detail: true,   // 用 user_ticket 读取头像、邮箱等（web 模式，scope 为 snsapi_privateinfo）
},
```

企业微信不是标准的“授权码换用户令牌”：驱动先获取并缓存企业的 `access_token`，再用 `auth/getuserinfo` 把授权码换成成员的 `userid`。非企业成员的 `user.id` 为 `openid`。`token.accessToken` 在有 `user_ticket` 时为它，否则为空字符串；不支持 `userFromToken()` 与 `refreshToken()`。

### 支付宝

```ts
alipay: {
  clientId: env('ALIPAY_APP_ID', ''),
  privateKey: env('ALIPAY_PRIVATE_KEY', ''),          // 应用私钥（RSA2）
  alipayPublicKey: env('ALIPAY_PUBLIC_KEY', ''),      // 校验响应签名
  redirect: '/auth/alipay/callback',
  // sandbox: true,
},
```

回调参数为 `auth_code`。换取令牌（`alipay.system.oauth.token`）与读取用户（`alipay.user.info.share`）都是 RSA2（SHA256withRSA）签名的网关请求。私钥可以是 PKCS#8 或 PKCS#1 的 PEM，也可以是支付宝密钥工具生成的纯 base64 字符串。配置 `alipayPublicKey` 后会校验每个响应的签名，不通过时返回 502。`user.id` 为 `open_id`（老应用为 `user_id`）。目前只支持公钥模式，不支持证书模式。

### 通用 OpenID Connect

```ts
keycloak: {
  driver: 'oidc',
  issuer: 'https://sso.example.com/realms/main',
  clientId: env('SSO_CLIENT_ID', ''),
  clientSecret: env('SSO_CLIENT_SECRET', ''),
  redirect: '/auth/keycloak/callback',
  // userinfo: false,          // 只使用 id_token 中的声明
  // algorithms: ['RS256'],
},
```

接口地址来自 `<issuer>/.well-known/openid-configuration`（会缓存，文档中的 `issuer` 必须一致）。`id_token` 用 `jwks_uri` 中的公钥校验签名（RS / PS / ES / EdDSA；公钥集合会缓存，遇到新的 `kid` 时重新拉取），同时校验 `iss`、`aud`、有效期与 `nonce`；随后合并 userinfo 的结果，其 `sub` 必须与令牌一致。`verifyIdToken(token, { jwksUri, issuer, audience, nonce })` 也可以单独使用，例如校验移动端 SDK 交来的令牌。

## 移动端交来的令牌

原生 App 用平台 SDK 登录后把访问令牌交给服务端时，可以不走跳转流程直接取得用户：

```ts
const profile = await OAuth.driver('github').userFromToken(accessToken)
// 微信 / QQ 需要随令牌一起返回的 openid
const wx = await OAuth.driver('wechat').userFromToken(accessToken, { openid })
// Apple：identityToken（即 id_token）
const apple = await OAuth.driver('apple').userFromToken(identityToken)
```

支持刷新的平台（标准 OAuth 2.0、微信、QQ、钉钉、飞书、支付宝）可以用 `refreshToken(refreshToken)` 换取新的 `OAuthToken`。

## 自定义平台

遵循标准 OAuth 2.0 的平台（授权码、表单提交换取令牌、Bearer 读取用户）只需要一份定义：

```ts
// app/provider/OAuthProvider.ts
import { defineProvider } from '@hazejs/core'
import { defineOAuthProvider, registerOAuthProvider } from '@hazejs/oauth'

const Gitea = defineOAuthProvider<{ clientId: string, clientSecret: string, redirect: string, baseUrl: string }>({
  endpoints: config => ({
    authorize: `${config.baseUrl}/login/oauth/authorize`,
    token: `${config.baseUrl}/login/oauth/access_token`,
    user: `${config.baseUrl}/api/v1/user`,
  }),
  scopes: ['read:user'],
  mapUser: raw => ({ id: raw.id, name: raw.full_name, nickname: raw.login, email: raw.email, avatar: raw.avatar_url }),
})

export default defineProvider({
  register() {
    registerOAuthProvider('gitea', Gitea)
  },
})
```

之后在 `config/oauth.ts` 中写 `driver: 'gitea'`，也可以不注册，直接写 `driver: Gitea`。流程不标准的平台，继承 `OAuthProvider`（或 `OidcProvider`）并覆盖 `authorizeParams()`、`exchangeCode()`、`fetchUser()`、`mapUser()`；`registerOAuthProvider()` 也接受这个类。`OAuth.build(driver, config)` 可以在运行时用一份配置构造驱动，例如每个租户各自的 client。

## 错误

| 异常 | 状态码 | 触发条件 |
|------|--------|----------|
| `InvalidStateException` | 400（`code: 'invalid_state'`） | state 缺失、过期、被篡改或重复使用 |
| `OAuthException` | 400 | 用户拒绝授权（`code: 'access_denied'`）、授权码无效或已使用、平台返回错误。`code` 为平台的错误码（`invalid_grant`、`40029` 等） |
| `OAuthException` | 502 | 平台不可达、返回 5xx，或（支付宝）响应签名无效 |
| `NotFoundException` | 404 | `OAuth.driver(name)` 的提供方不存在或未启用 |

## 测试

把 `fetch` 换成进程内的模拟实现，测试中不会访问真实平台：

```ts
import { createApplication } from '@hazejs/core'

const app = await createApplication({
  mode: 'test',
  config: {
    oauth: {
      fetch: async (input, init) => {
        const url = new URL(String(input))
        if (url.pathname === '/login/oauth/access_token')
          return Response.json({ access_token: 'test-token', token_type: 'bearer' })
        if (url.pathname === '/user')
          return Response.json({ id: 1, login: 'octocat', email: 'octocat@example.com' })
        return new Response('not found', { status: 404 })
      },
      providers: { github: { clientId: 'id', clientSecret: 'secret', redirect: '/auth/github/callback' } },
    },
  },
})
```

先请求 `/auth/github`，从 `Location` 头中取出 `state` 并保留 `Set-Cookie`，再带着 Cookie 请求 `?code=...&state=...` 的回调地址。本包自己的测试就是这样针对每个平台的模拟服务器运行的。
