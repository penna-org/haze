# 两步验证与通行密钥

hazejs 提供两种加强登录安全的方式：

- **TOTP**（RFC 6238）：认证器 App（Google Authenticator、1Password、Authy 等）生成的六位验证码，附带恢复码。框架内置，没有额外依赖。
- **通行密钥**（WebAuthn）：用 Touch ID、Windows Hello、手机或安全密钥登录。基于可选依赖 [`@simplewebauthn/server`](https://simplewebauthn.dev)。

两者都通过小巧的存储接口保存数据。正式项目使用 `@hazejs/orm` 的数据库存储，表结构由 `haze make:auth-tables` 生成（见 [API 令牌](./api-tokens#数据表)）；默认的内存存储用于测试。

## TOTP

### 配置

```ts
// config/auth.ts
import { defineAuthConfig } from '@hazejs/core'
import { databaseTwoFactorStore, modelUserProvider } from '@hazejs/orm'
import { User } from '~/app/model/User'
import { twoFactorSecrets } from '~/database/schema/auth'

export default defineAuthConfig(() => ({
  default: 'web',
  guards: {
    web: { driver: 'session', provider: 'users' },
  },
  providers: {
    users: modelUserProvider(() => User, { username: 'email' }),
  },
  twoFactor: {
    store: databaseTwoFactorStore(twoFactorSecrets),
    issuer: 'Acme',
  },
}))
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `provider` | 默认 Guard 的 provider | 用户来源 |
| `store` | 内存 | `databaseTwoFactorStore()` 或任意 `TwoFactorStore` |
| `issuer` | `app.name` | 认证器 App 中显示的服务名 |
| `account` | `'email'` | 作为账号名显示的用户字段 |
| `digits` / `period` / `algorithm` | `6` / `30` / `'SHA1'` | 验证码参数，大多数 App 只支持默认值 |
| `window` | `1` | 允许的时钟偏差（时间步数，即 ±30 秒） |
| `recoveryCodes` | `8` | 恢复码数量 |
| `challengeTtl` | `'5m'` | 登录后等待输入验证码的时长 |
| `maxAttempts` | `5` | 一次登录挑战允许输错的次数，超过后需重新输入密码 |

保存的内容：

- 密钥用 `APP_KEY` 加密（与 `Crypt` 相同的 AES-GCM [加密](./security#加密)）；
- 恢复码只保存 SHA-256 摘要，无法读回；
- 上次通过的验证码所在的时间步：**同一个验证码只能用一次**，比它更早的验证码也会被拒绝。

### 启用两步验证

启用分两步：先生成密钥，再用 App 中的验证码确认。确认之前两步验证不会生效。

```ts
// app/controller/TwoFactorController.ts
import type { HttpContext } from '@hazejs/core'
import { BadRequestException, TwoFactor } from '@hazejs/core'

export class TwoFactorController {
  /** 第一步：展示二维码与恢复码 */
  async enable(ctx: HttpContext) {
    const { secret, uri, recoveryCodes } = await TwoFactor.enable((await ctx.auth.user())!)
    return { secret, uri, recoveryCodes }
  }

  /** 第二步：用户输入第一个验证码 */
  async confirm(ctx: HttpContext) {
    const { code } = await ctx.body<{ code: string }>()
    if (!await TwoFactor.confirm((await ctx.auth.user())!, code))
      throw new BadRequestException('验证码错误')
    return { enabled: true }
  }

  async disable(ctx: HttpContext) {
    await TwoFactor.disable((await ctx.auth.user())!)
    return ctx.noContent()
  }
}
```

`enable()` 返回 base32 格式的 `secret`（供手动输入）、`otpauth://totp/…` 地址 `uri`，以及明文的 `recoveryCodes`。恢复码只在这时可见。两步验证确认后再调用 `enable()` 会抛出 `409`，避免持有会话的人悄悄关掉它；确需更换密钥时传 `{ force: true }`（最好先用 `verify()` 校验一次当前验证码），之后回到未确认状态。

::: tip 二维码在浏览器中渲染
服务端不生成图片。在前端把 `uri` 渲染成二维码即可，例如 [`qrcode`](https://www.npmjs.com/package/qrcode)（`QRCode.toDataURL(uri)`）或 [`uqr`](https://www.npmjs.com/package/uqr)（`renderSVG(uri)`）。
:::

### `TwoFactor` 门面

| 方法 | 说明 |
|------|------|
| `enable(user, { force? })` | 生成新的密钥与恢复码（确认后才生效）；已启用时抛出 `409`，除非传 `force` |
| `confirm(user, code)` | 验证码正确时启用两步验证，触发 `TwoFactorEnabled` |
| `enabled(user)` | 是否已启用（已确认） |
| `verify(user, code)` | 校验已启用用户的验证码，每个时间步只接受一次 |
| `useRecoveryCode(user, code)` | 使用一个恢复码（不区分大小写，用后作废） |
| `regenerateRecoveryCodes(user)` | 生成新的明文恢复码，旧的全部失效 |
| `remainingRecoveryCodes(user)` | 剩余的恢复码数量 |
| `uri(user)` | 再次取得 `otpauth://` 地址（如设置过程中重新显示二维码） |
| `disable(user)` | 删除密钥与恢复码，触发 `TwoFactorDisabled` |

`verify()` 与 `useRecoveryCode()` 失败时触发 `TwoFactorFailed`，可以监听它做告警或锁定，见[事件](./events)。

### Session 登录与挑战

使用 Session Guard 时，用 `TwoFactor.attempt()` 代替 `ctx.auth.session().attempt()`。它校验密码；用户已启用两步验证时不直接登录，而是在会话中记录一个待验证的登录：

```ts
// app/controller/SessionController.ts
import type { HttpContext } from '@hazejs/core'
import { TwoFactor, UnauthorizedException, validate } from '@hazejs/core'
import { LoginSchema } from '~/app/validate/auth'

export class SessionController {
  async store(ctx: HttpContext) {
    const result = await TwoFactor.attempt(ctx, await validate(LoginSchema, await ctx.body()))
    if (result.status === 'failed')
      throw new UnauthorizedException('邮箱或密码错误')
    // 'authenticated'：已登录；'two-factor'：请用户输入验证码
    return { status: result.status }
  }

  async challenge(ctx: HttpContext) {
    const { code, recoveryCode } = await ctx.body<{ code?: string, recoveryCode?: string }>()
    const user = await TwoFactor.challenge(ctx, { code, recoveryCode })
    if (!user)
      throw new UnauthorizedException('验证码错误')
    return user
  }
}
```

```ts
// route/web.ts
r.post('/login', [SessionController, 'store']).middleware('throttle:10,60')
r.post('/two-factor-challenge', [SessionController, 'challenge']).middleware('throttle:10,60')
```

`TwoFactor.challenge(ctx, input)` 接受 `{ code }` 或 `{ recoveryCode }`。成功时通过 Session Guard 登录（会重新生成会话 ID）并返回用户，否则返回 `undefined`。挑战在 `challengeTtl` 后过期；输错 `maxAttempts` 次后挑战被清除，需要重新输入密码。`TwoFactor.hasPendingChallenge(ctx)` 可以告诉前端是否要显示验证码表单。`attempt()` 与 `challenge()` 都接受 `{ guard }`，用于指定默认 Guard 之外的 Session Guard。

### JWT 与令牌接口

挑战流程依赖会话。无状态的 API 请在签发令牌前自己校验验证码，例如让登录请求同时带上验证码：

```ts
async login(ctx: HttpContext) {
  const { code, ...credentials } = await ctx.body<{ email: string, password: string, code?: string }>()
  const user = await ctx.auth.jwt().validate(credentials)
  if (!user)
    throw new UnauthorizedException('邮箱或密码错误')
  if (await TwoFactor.enabled(user) && !(code && await TwoFactor.verify(user, code)))
    throw new UnauthorizedException('请输入正确的两步验证码')
  return ctx.auth.jwt().login(user)
}
```

### 底层函数

TOTP 的基础函数也一并导出，用于自定义流程。它们基于 Web Crypto，所有运行时都能使用：

```ts
import { generateRecoveryCodes, generateTotpSecret, hotp, otpauthUri, totp, verifyTotp } from '@hazejs/core'

const secret = generateTotpSecret()                       // base32，160 位
const uri = otpauthUri({ secret, issuer: 'Acme', account: 'ada@example.com' })
const code = await totp(secret)                           // 当前验证码
const step = await verifyTotp(secret, code, { window: 1, afterStep: lastStep }) // 匹配的时间步或 undefined
await hotp(secret, 0)                                     // RFC 4226 基于计数器的验证码
generateRecoveryCodes(8)                                  // ['k3j9d-x2m4p', …]
```

`base32Encode()` / `base32Decode()` 用于转换密钥，`totpStep()` 返回当前时间步。实现通过了 RFC 6238 与 RFC 4226 的测试向量。

## 通行密钥（WebAuthn）

安装服务端库（v13 或 v14）：

```bash
pnpm add @simplewebauthn/server
```

它是 `@hazejs/core` 的可选 peer 依赖，首次使用时才加载；不使用通行密钥时，生产构建不需要安装它。

### 配置

```ts
// config/auth.ts
import { databasePasskeyStore } from '@hazejs/orm'
import { webauthnCredentials } from '~/database/schema/auth'

export default defineAuthConfig(() => ({
  // …
  passkeys: {
    store: databasePasskeyStore(webauthnCredentials),
    rpName: 'Acme',
  },
}))
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `provider` | 默认 Guard 的 provider | 用户来源 |
| `store` | 内存 | `databasePasskeyStore()` 或任意 `PasskeyStore` |
| `rpName` | `app.name` | 浏览器提示中显示的名称 |
| `rpID` | `APP_URL` 的主机名，否则为请求的主机名 | 通行密钥绑定的域名（不含协议和端口） |
| `origin` | `APP_URL` 的 origin，否则为请求的 origin | 允许的来源，如 `['https://example.com', 'https://app.example.com']` |
| `challenge` | `'session'` | 挑战的保存位置：`'session'`，或 `'cache'`（没有会话的 API） |
| `cacheStore` | 默认缓存存储 | `challenge: 'cache'` 时使用的缓存存储名 |
| `timeout` | `60000` | 浏览器等待的毫秒数，挑战也在此时间后失效 |
| `userVerification` | `'preferred'` | `'required'` 时必须验证指纹 / PIN |
| `residentKey` | `'preferred'` | 可发现凭据（无需输入用户名即可登录） |
| `userName` / `displayName` | `'email'` / `'name'` | 认证器中显示的用户字段 |

挑战只能使用一次。`cache` 模式下以挑战值本身为键，不需要 Cookie。

::: tip 本地开发与代理
`rpID` 必须与用户所在页面的主机名一致。`localhost` 可以使用普通 HTTP，其它主机需要 HTTPS。经过代理或使用独立的前端开发服务器时，把 `APP_URL`（或 `rpID` 与 `origin`）设为浏览器地址栏中的地址。
:::

### 注册通行密钥

注册需要已登录的用户：服务端生成选项，浏览器与认证器交互，服务端校验并保存凭据。

```ts
// app/controller/PasskeyController.ts
import type { HttpContext, PasskeyResponseJSON } from '@hazejs/core'
import { Passkeys } from '@hazejs/core'

export class PasskeyController {
  async registrationOptions(ctx: HttpContext) {
    return Passkeys.registrationOptions(ctx, (await ctx.auth.user())!)
  }

  async register(ctx: HttpContext) {
    const { response, name } = await ctx.body<{ response: PasskeyResponseJSON, name?: string }>()
    const credential = await Passkeys.verifyRegistration(ctx, (await ctx.auth.user())!, response, { name })
    return ctx.created({ id: credential.id, name: credential.name })
  }

  async loginOptions(ctx: HttpContext) {
    return Passkeys.authenticationOptions(ctx)
  }

  async login(ctx: HttpContext) {
    return Passkeys.login(ctx, await ctx.body<PasskeyResponseJSON>())
  }
}
```

```ts
// route/web.ts
r.post('/passkeys/options', [PasskeyController, 'registrationOptions']).middleware('auth')
r.post('/passkeys', [PasskeyController, 'register']).middleware('auth')
r.post('/passkeys/login/options', [PasskeyController, 'loginOptions'])
r.post('/passkeys/login', [PasskeyController, 'login']).middleware('throttle:10,60')
```

`registrationOptions()` 会排除用户已有的通行密钥，同一个认证器不会重复注册；传入 `{ authenticatorAttachment: 'platform' }` 优先使用设备内置的认证器。以下情况 `verifyRegistration()` 抛出 `400`：挑战已过期或已使用、来源或 RP ID 不符、凭据已注册。

### 登录

`authenticationOptions(ctx)` 不传用户时允许任意可发现的通行密钥；`authenticationOptions(ctx, { user })` 只允许该用户的通行密钥（适合“先输入邮箱”的流程）。

- `Passkeys.login(ctx, response, { guard? })`：校验响应，通过 Session Guard 登录并返回用户。
- `Passkeys.verifyAuthentication(ctx, response)`：只校验，返回 `{ user, credential }`。JWT 或令牌接口用它，再自己签发令牌：

```ts
const { user } = await Passkeys.verifyAuthentication(ctx, await ctx.body())
return ctx.auth.jwt().login(user)
```

失败时抛出 `401`。每次登录成功都会更新凭据的签名计数器、`backedUp` 标记与 `lastUsedAt`。

### 管理通行密钥

```ts
await Passkeys.credentials(user)            // PasskeyCredential[]
await Passkeys.rename(user, id, 'MacBook')  // 不属于该用户时返回 false
await Passkeys.delete(user, id)             // 不属于该用户时返回 false
```

`PasskeyCredential` 包含 `id`、`name`、`transports`、`deviceType`（`'multiDevice'` 表示可同步的通行密钥，如 iCloud 钥匙串、Google 密码管理器）、`backedUp`、`aaguid`、`createdAt`、`lastUsedAt`。服务端只保存公钥，没有任何密钥。

### 浏览器端

使用 [`@simplewebauthn/browser`](https://simplewebauthn.dev/docs/packages/browser)，hazejs 不提供客户端：

```ts
import { startAuthentication, startRegistration } from '@simplewebauthn/browser'

// 注册（已登录）
const optionsJSON = await api.post('/passkeys/options')
const response = await startRegistration({ optionsJSON })
await api.post('/passkeys', { response, name: '我的笔记本' })

// 登录
const loginOptions = await api.post('/passkeys/login/options')
await api.post('/passkeys/login', await startAuthentication({ optionsJSON: loginOptions }))
```

挑战保存在会话中时，获取选项与提交校验的请求都要带上 Cookie（同源，或 `credentials: 'include'`）。全栈模板启用了 `csrf`，与其它 POST 请求一样带上 `X-XSRF-TOKEN` 头。

## 自定义存储

```ts
import type { PasskeyStore, TwoFactorStore } from '@hazejs/core'

const twoFactor: TwoFactorStore = {
  get: async (userType, userId) => { /* TwoFactorRecord | undefined */ },
  set: async (userType, userId, record) => { /* 插入或替换 */ },
  delete: async (userType, userId) => { /* … */ },
}

const passkeys: PasskeyStore = {
  create: async (credential) => { /* … */ },
  find: async (id) => { /* … */ },
  list: async (userType, userId) => { /* … */ },
  update: async (id, values) => { /* name、counter、backedUp、lastUsedAt */ },
  delete: async (id) => { /* 返回是否存在 */ },
}
```

`userType` 为 provider 名，`userId` 为字符串形式的用户 ID，与 [API 令牌](./api-tokens)相同。
