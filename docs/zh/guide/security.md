# Session、CSRF 等

本页介绍[认证](./authentication)之外的安全组件：应用密钥、Cookie、Session、CSRF 防护、CORS、安全响应头、限流与请求体限制。它们大多是内置中间件，在 `config/middleware.ts` 中按名字启用即可（见[中间件](./middleware)）：

```ts
// config/middleware.ts
import { defineMiddlewareConfig } from '@hazejs/core'

export default defineMiddlewareConfig({
  global: ['cors', 'secureHeaders', 'compress'],
  alias: {},
})
```

每个中间件从同名配置文件读取选项（`config/cors.ts`、`config/session.ts`、`config/csrf.ts`、`config/throttle.ts`、`config/secureHeaders.ts`）。

## 应用密钥

`.env` 中的 `APP_KEY` 用于：

- 签名 Cookie（HMAC-SHA256）；
- Session：`cookie` 驱动用 AES-GCM 加密会话数据（密钥由 `APP_KEY` 经 HKDF 派生），其他驱动对会话 ID 签名；
- `HS*` 算法 JWT Guard 的默认密钥；
- `local`、`r2` 存储磁盘的签名临时链接。

新建项目时会自动生成独立的密钥。生成或更换密钥：

```bash
haze key:generate          # 写入 .env 的 APP_KEY
haze key:generate --force  # 覆盖已有的密钥
haze key:generate --show   # 只输出，不写入文件
```

密钥至少 32 个字符。更换后，用旧密钥签发的 Cookie、Session 和令牌全部失效。也可以不用环境变量，在 `config/app.ts` 中设置 `key`。Cloudflare Workers 没有 `.env`，用 `wrangler secret put APP_KEY` 设置。

## Cookie

```ts
ctx.cookie('theme')                            // 读取
ctx.setCookie('theme', 'dark', { maxAge: 60 * 60 * 24 * 365 })
ctx.deleteCookie('theme')

await ctx.setSignedCookie('cart', cartId)      // 客户端可读，但无法篡改
await ctx.signedCookie('cart')                 // 签名不符时为 undefined
```

Cookie 默认为 `httpOnly`、`SameSite=Lax`、路径 `/`，`app.debug` 关闭时还会加上 `Secure`。可以在 `config/app.ts` 中覆盖默认值：

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  cookie: { sameSite: 'strict', domain: '.example.com' },
}))
```

不希望客户端读到的数据，请放进 Session：默认的 `cookie` 驱动会加密保存。

## Session

在需要的路由（或全局）加上 `session` 中间件，然后使用 `ctx.session`：

```ts
// route/api.ts
r.post('/cart', async (ctx) => {
  const items = ctx.session.get<string[]>('cart', [])!
  ctx.session.set('cart', [...items, 'book'])
  ctx.session.flash('status', 'Added to cart')
  return ctx.noContent()
}).middleware('session')
```

| 方法 | 说明 |
|------|------|
| `get(key, fallback?)` / `has(key)` / `all()` | 读取 |
| `set(key, value)` / `forget(key)` | 写入 / 删除 |
| `pull(key, fallback?)` | 读取并删除 |
| `flash(key, value)` | 闪存：只在下一次请求中可读 |
| `flush()` | 清空数据，保留会话 ID |
| `regenerate()` | 重新生成会话 ID，数据保留（登录、提权后调用） |
| `invalidate()` | 清空数据并重新生成 ID（退出登录） |

不经过中间件时，可以用 `await ctx.startSession()` 按需启动。会话只有修改过才会写回；新会话没有数据时不会设置 Cookie。[Session Guard](./authentication#session-登录) 会自己启动会话。

### 配置

```ts
// config/session.ts
import { defineSessionConfig } from '@hazejs/core'

export default defineSessionConfig({
  driver: 'cookie',
  lifetime: '2h',
})
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `driver` | `'cookie'` | 见下表，也可以传入自定义的 `SessionStore` 对象 |
| `store` | 缓存的默认存储 | `driver: 'cache'` 时使用 `config/cache.ts` 中的哪个存储 |
| `cookie` | `'haze_session'` | Cookie 名 |
| `lifetime` | `'2h'` | 有效期，时长字符串或秒数 |
| `cookieOptions` | | 覆盖默认的 Cookie 选项 |

| 驱动 | 数据存在哪里 |
|------|--------------|
| `cookie` | 加密后存在 Cookie 中。无状态、可用于 Edge，上限约 4KB |
| `memory` | 进程内存，Cookie 只保存签名的会话 ID。仅适合单实例 |
| `cache` | [缓存](./cache)存储，如 Redis、Upstash、KV：`{ driver: 'cache', store: 'redis' }`，多实例共享 |

自定义存储需要实现 `get(id)`、`set(id, data, ttlSeconds)` 和 `destroy(id)`：

```ts
// config/session.ts
import type { SessionStore } from '@hazejs/core'
import { defineSessionConfig } from '@hazejs/core'

const store: SessionStore = {
  get: async id => loadSession(id),
  set: async (id, data, ttl) => saveSession(id, data, ttl),
  destroy: async id => deleteSession(id),
}

export default defineSessionConfig({ driver: store })
```

## CSRF 防护

只要认证依赖 Cookie（Session Guard，或从 Cookie 读取的 JWT），就应当启用 `csrf` 中间件。它采用与 Laravel 相同的同步令牌方式：

1. token 存在会话中，并通过一个可被脚本读取的 `XSRF-TOKEN` Cookie（不带 `HttpOnly`）下发给浏览器。
2. 不安全的请求（`POST`、`PUT`、`PATCH`、`DELETE`）必须在 `X-XSRF-TOKEN` 或 `X-CSRF-TOKEN` 请求头中，或在 urlencoded / multipart 表单的 `_token` 字段中回传 token。
3. 缺少 token 或不匹配时返回 `419`（`CsrfTokenMismatchException`）。

axios 等客户端会自动把 `XSRF-TOKEN` Cookie 的值放进请求头。服务端渲染的表单，把 `await ctx.csrfToken()` 放进隐藏字段 `_token` 即可。

以下情况不校验：

- 安全方法（`GET`、`HEAD`、`OPTIONS`、`TRACE`）；
- 带 `Authorization: Bearer …` 的请求，它们不依赖 Cookie；
- `except` 中列出的路径；
- 测试环境，除非设置了 `testing: true`。

```ts
// config/csrf.ts
import { defineCsrfConfig } from '@hazejs/core'

export default defineCsrfConfig({
  except: ['/api/webhooks/*'],
  // cookie: 'XSRF-TOKEN',  // 设为 false 不下发 Cookie
  // testing: true,         // 测试中也校验
})
```

Session Guard 登录或退出时，token 会随之更换。

::: tip 全栈模板
Vue 与 React 模板全局启用了 `csrf`，并提供一个只负责下发 Cookie 的 `GET /api/csrf-cookie` 路由；`src/api.ts` 在第一次发起修改类请求前先请求它一次，之后自动带上 `X-XSRF-TOKEN`。详见 [Vite 全栈](./fullstack)。
:::

## CORS

`cors` 中间件必须放在**全局**中间件中，因为预检的 `OPTIONS` 请求匹配不到任何路由。配置写在 `config/cors.ts`：

```ts
// config/cors.ts
import { defineCorsConfig, env } from '@hazejs/core'

export default defineCorsConfig(() => {
  const origin = env('CORS_ORIGIN', '*')
  return {
    origin: origin === '*' ? '*' : origin.split(',').map(item => item.trim()),
  }
})
```

| 选项 | 默认值 | 说明 |
|------|--------|------|
| `origin` | `'*'` | `'*'`、字符串 / 正则数组，或 `(origin) => boolean` |
| `methods` | `'*'` | 预检请求允许的方法 |
| `allowHeaders` | `'*'` | 允许的请求头 |
| `exposeHeaders` | `'*'` | 浏览器可读取的响应头 |
| `credentials` | `false` | 允许携带 Cookie；此时 origin 需要明确列出，不能用 `'*'` |
| `maxAge` | `false` | 预检结果的缓存时间 |

正则形式的 origin 请加上首尾锚点（`/^https:\/\/app\.example\.com$/`），否则会匹配到形似的其他域名。

## 安全响应头

`secureHeaders` 参考 helmet 的默认值设置一组响应头：`X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy: no-referrer`、`Cross-Origin-Opener-Policy` 与 `Cross-Origin-Resource-Policy: same-origin` 等。`Strict-Transport-Security` 只在 `app.debug` 关闭且请求为 HTTPS 时发送。

```ts
// config/secureHeaders.ts
import { defineSecureHeadersConfig } from '@hazejs/core'

export default defineSecureHeadersConfig({
  contentSecurityPolicy: "default-src 'self'",   // 默认关闭
  frameOptions: 'DENY',
  headers: { 'x-robots-tag': 'noindex' },   // 额外的响应头
})
```

每个选项（`contentSecurityPolicy`、`strictTransportSecurity`、`frameOptions`、`referrerPolicy`、`crossOriginOpenerPolicy`、`crossOriginResourcePolicy`、`permissionsPolicy`）传字符串覆盖默认值，传 `false` 不发送该响应头。

## 限流

```ts
// route/api.ts
r.post('/login', [AuthController, 'login']).middleware('throttle:10,60') // 60 秒内最多 10 次
r.group({ prefix: '/api', middleware: ['throttle:api'] }, (r) => { /* ... */ })
```

`throttle:<次数>,<秒数>` 直接写限额；`throttle:<名字>` 使用命名规则。已登录用户按用户 ID 计数，未登录用户按客户端 IP 计数。响应中带有 `RateLimit-Limit`、`RateLimit-Remaining`、`RateLimit-Reset` 头；超出限额返回 `429` 和 `Retry-After`。

```ts
// config/throttle.ts
import { defineThrottleConfig, env } from '@hazejs/core'

export default defineThrottleConfig(() => ({
  // config/cache.ts 中的存储；多实例部署请使用共享存储（如 redis）
  store: env('CACHE_STORE', 'memory'),
  limiters: {
    api: { max: 60, window: '1m' },
    uploads: { max: 10, window: '1h', key: ctx => `ip:${ctx.ip}` },
  },
}))
```

不设置 `store` 时，计数保存在进程内存中（仅适合单实例）。`store` 也可以是自定义的 `RateLimitStore`。

在 Cloudflare Workers 上，推荐使用原子、全局生效的 Rate Limiting 绑定：在规则上设置 `binding`，限额与周期在 `wrangler.json` 的 `ratelimits` 中配置；本地开发没有绑定时会回退到 store 计数：

```ts
api: { max: 60, window: '1m', binding: 'API_RATE_LIMITER' },
```

## 请求体限制

请求体默认上限为 `1mb`（`config/app.ts` 的 `bodyLimit`）。单个路由可以用 `bodyLimit` 中间件调整，超出时返回 `413`：

```ts
r.post('/auth/avatar', [AuthController, 'avatar']).middleware(['auth', 'bodyLimit:3mb'])
```

## 反向代理

应用部署在可信的反向代理或负载均衡之后时，在 `config/app.ts` 中设置 `trustProxy: true`。此后 `ctx.ip` 取自 `X-Forwarded-For`（影响限流），协议取自 `X-Forwarded-Proto`（决定是否发送 HSTS）。客户端能直接访问应用时请保持关闭，否则这些请求头可以被伪造。
