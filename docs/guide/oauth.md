# OAuth Social Login

`@hazejs/oauth` adds "Sign in with …" to your app, in the spirit of Laravel Socialite. It ships drivers for international and Chinese providers plus a generic OpenID Connect driver, and takes care of the parts that are easy to get wrong: `state` (CSRF protection), PKCE, OIDC `nonce`, `id_token` signature verification against the provider's JWKS, and each vendor's non-standard parameters.

| Driver | Provider | Notes |
|--------|----------|-------|
| `github` | GitHub / GitHub Enterprise | PKCE; falls back to the verified primary email |
| `google` | Google | OpenID Connect, `id_token` + userinfo |
| `apple` | Sign in with Apple | `form_post` callback, ES256 client secret, `id_token` |
| `microsoft` | Microsoft Entra ID | tenant `common` / `organizations` / `consumers` / tenant ID; Graph `/me` |
| `gitlab` | GitLab | `baseUrl` for self-hosted instances |
| `discord` | Discord | |
| `wechat` | WeChat Open Platform (website QR login) | `snsapi_login`, openid / unionid |
| `wechat_mp` | WeChat Official Account web auth (微信公众号) | `snsapi_base` / `snsapi_userinfo` |
| `qq` | QQ Connect | openid / unionid via `/oauth2.0/me` |
| `dingtalk` | DingTalk | new `login.dingtalk.com` OAuth2 |
| `feishu` | Feishu / Lark | authen v2 token endpoint, PKCE |
| `wecom` | WeCom (企业微信) | QR login or in-app web auth |
| `alipay` | Alipay | RSA2-signed gateway requests |
| `oidc` | Any OpenID Connect provider | discovery, JWKS, nonce (Keycloak, Auth0, Authing, Logto, Zitadel, …) |

::: tip Paths
Examples on this page use the API template layout (`app/...`, `config/...`). In a full-stack project these live under `server/`.
:::

## Installation

```bash
pnpm add @hazejs/oauth
```

The package has no SDK dependencies: every provider is called with `fetch`, JWTs are handled by [jose](https://github.com/panva/jose) and RSA / ECDSA signing uses Web Crypto, so it runs on Node, Bun, Deno and Cloudflare Workers.

## Configuration

Create `config/oauth.ts`. The key is the provider name you use in code; it is also the driver name unless you set `driver`.

```ts
// config/oauth.ts
import { env } from '@hazejs/core'
import { defineOAuthConfig } from '@hazejs/oauth'

export default defineOAuthConfig(() => ({
  providers: {
    github: {
      clientId: env('GITHUB_CLIENT_ID', ''),
      clientSecret: env('GITHUB_CLIENT_SECRET', ''),
      // A path is completed with APP_URL (or the request origin)
      redirect: '/auth/github/callback',
    },
    google: {
      clientId: env('GOOGLE_CLIENT_ID', ''),
      clientSecret: env('GOOGLE_CLIENT_SECRET', ''),
      redirect: '/auth/google/callback',
    },
    // A second instance of a driver under another name
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

A provider whose value is `false` / `null` or whose `clientId` is empty is **disabled**: `OAuth.enabled(name)` returns `false` and `OAuth.driver(name)` throws a 404. So reading the client ID from the environment with an empty default lets you ship the routes and turn each provider on just by setting its variables.

Options shared by every provider:

| Option | Description |
|--------|-------------|
| `driver` | Built-in driver name, a name registered with `registerOAuthProvider()`, or a `defineOAuthProvider()` result. Defaults to the key |
| `clientId` | `client_id`. Each vendor names it differently (AppID, App Key, Client ID, corpid, …) |
| `clientSecret` | `client_secret` / AppSecret / corpsecret |
| `redirect` | Callback URL: absolute, or a path completed with `APP_URL` |
| `scopes` | Replaces the driver's default scopes |
| `pkce` | Turn PKCE (S256) on or off. Defaults to what the driver supports |
| `stateless` | Skip state verification for this provider (see below) |
| `parameters` | Extra fixed parameters for the authorization URL |
| `endpoints` | Override endpoint URLs (proxies, private deployments, tests) |

Global options:

| Option | Default | Description |
|--------|---------|-------------|
| `stateStore` | `'cookie'` | Where the state lives between redirect and callback: an encrypted cookie, or `'session'` |
| `cookie` | `'haze_oauth'` | Cookie name prefix; the actual cookie is `<prefix>_<provider>` |
| `stateTtl` | `'10m'` | How long the user has to finish signing in |
| `fetch` | global `fetch` | HTTP client used for every provider call (proxies, tests) |

## Routes and controller

Two routes per provider are enough: one sends the user to the provider, the other handles the callback. A `:provider` parameter covers every provider at once, and disabled or unknown names return 404.

```ts
// route/api.ts
r.get('/auth/:provider', [OAuthController, 'redirect']).name('oauth.redirect')
r.get('/auth/:provider/callback', [OAuthController, 'callback']).name('oauth.callback')
// Apple posts the callback (form_post)
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

    // Link the account to a local user, then log in with your guard
    const user = await User.where('email', profile.email).find()
      ?? await User.create({ name: profile.name ?? profile.nickname ?? 'User', email: profile.email! })
    return ctx.auth.jwt().login(user)
  }
}
```

In practice you usually store `(provider, id)` in a separate table (`social_accounts`) instead of matching by email: several providers (WeChat, QQ, Apple's private relay, WeCom) never return an email, or return one you shouldn't trust blindly.

For a single-page app that wants the URL instead of a 302, return it as JSON. The state cookie is set on the same response, so call it from the browser with credentials:

```ts
async url(ctx: HttpContext) {
  return { url: await OAuth.driver('github').authorizationUrl(ctx) }
}
```

## The user object

`user(ctx)` validates the state, exchanges the code and fetches the profile. It returns:

| Field | Description |
|-------|-------------|
| `provider` | Provider name (the key in `config/oauth.ts`) |
| `id` | The provider's user ID, always a string |
| `name` / `nickname` / `email` / `avatar` | Normalized profile fields, `null` when the provider doesn't return them |
| `raw` | The provider's original profile (unionid, phone, tenant, …) |
| `token` | `{ accessToken, refreshToken?, expiresIn?, idToken?, tokenType?, scope?, raw }` |

## Per-request options

`OAuth.driver(name)` returns a fresh builder on every call, so these only affect the current request:

```ts
OAuth.driver('github')
  .scopes(['repo'])                 // add scopes to the defaults
  .setScopes(['read:user'])         // or replace them
  .with({ prompt: 'consent' })      // extra authorization parameters
  .redirectUrl('/auth/github/link') // another callback URL
  .stateless()                      // no state cookie, no PKCE, no nonce
  .redirect(ctx)
```

## State, PKCE and nonce

On `redirect()` a random `state` (and a PKCE `code_verifier`, and an OIDC `nonce` where the driver supports them) is stored in a short-lived cookie encrypted with AES-GCM, using a key derived from `APP_KEY`. On the callback the cookie is read **once** and deleted, the `state` is compared in constant time, the verifier is sent with the token request, and the nonce must match the one inside the `id_token`. A missing, expired, tampered or reused state throws `InvalidStateException` (400).

- The cookie is `SameSite=Lax`, which is sent on the provider's top-level redirect back to you. Apple's `form_post` callback is a cross-site POST, so the Apple cookie is `SameSite=None; Secure` (Chrome and Firefox accept `Secure` cookies on `http://localhost`; use HTTPS in development if your browser does not).
- With `stateStore: 'session'` the state goes into the session instead.
- `stateless()` turns all of this off. Use it only when something else protects the flow, for example a native app that receives the code itself.
- If the full-stack templates' global `csrf` middleware is on, add POST callbacks (Apple) to its `except` list: the provider can't send your CSRF token, and the OAuth state does that job.

## Provider notes

### Apple

```ts
apple: {
  clientId: env('APPLE_CLIENT_ID', ''),      // Services ID, e.g. com.example.web
  teamId: env('APPLE_TEAM_ID', ''),
  keyId: env('APPLE_KEY_ID', ''),
  privateKey: env('APPLE_PRIVATE_KEY', ''),  // contents of AuthKey_XXXX.p8; "\n" escapes are fine
  redirect: '/auth/apple/callback',
},
```

The client secret is an ES256 JWT signed with your `.p8` key; it is generated on demand and cached (`secretTtl`, 1 hour by default). Requesting `name` / `email` forces `response_mode=form_post`, so register a POST route for the callback. Apple has no userinfo endpoint: the user comes from the verified `id_token`, and the name is sent **only on the first authorization** (the form field `user`), so save it then. For Sign in with Apple inside an iOS app, pass the `identityToken` to `OAuth.driver('apple').userFromToken(identityToken)`.

### Microsoft

`tenant` defaults to `common` (personal and work / school accounts). Use `organizations`, `consumers`, or your tenant ID for a single-tenant app. The profile comes from Microsoft Graph `/me` (`User.Read` scope); `email` falls back to the user principal name.

### GitLab and GitHub Enterprise

Set `baseUrl` for self-hosted instances: `https://gitlab.example.com` for GitLab, `https://github.example.com` for GitHub Enterprise Server (the API then is `<baseUrl>/api/v3`).

### WeChat Open Platform (`wechat`)

Website QR login with `snsapi_login`. `clientId` is the AppID and `clientSecret` the AppSecret. The authorization URL uses `appid` (not `client_id`), keeps WeChat's required parameter order and ends with `#wechat_redirect`. The token response has no `token_type` and includes `openid` / `unionid`.

`user.id` is the `openid` by default, which differs per app. If you have several apps under one Open Platform account (website + mobile + Official Account), set `idField: 'unionid'` so the same person gets the same ID everywhere.

### WeChat Official Account (`wechat_mp`)

For pages opened inside WeChat. `snsapi_userinfo` (default) asks the user to confirm and returns the nickname and avatar; `snsapi_base` is silent and returns only the openid, so no userinfo call is made:

```ts
OAuth.driver('wechat_mp').setScopes('snsapi_base').redirect(ctx)
```

### QQ

`clientId` is the APP ID and `clientSecret` the APP Key. The openid comes from `/oauth2.0/me` (requested with `unionid=1`, which also returns the unionid once your app has that permission). `idField: 'unionid'` works as for WeChat.

### DingTalk

Uses the new OAuth2 flow (`login.dingtalk.com/oauth2/auth`, `api.dingtalk.com/v1.0/oauth2/userAccessToken`, `v1.0/contact/users/me`). `clientId` / `clientSecret` are the app's Client ID (formerly AppKey) and Client Secret. `user.id` is the `unionId`; `raw` also has `openId`, `mobile` and `stateCode` when granted.

### Feishu / Lark

```ts
feishu: {
  clientId: env('FEISHU_APP_ID', ''),
  clientSecret: env('FEISHU_APP_SECRET', ''),
  redirect: '/auth/feishu/callback',
  domain: 'feishu', // or 'lark' for open.larksuite.com
  // idField: 'union_id' | 'user_id' (default 'open_id')
},
```

Uses the authen v2 token endpoint with PKCE. Add `offline_access` to `scopes` if you need a refresh token.

### WeCom

```ts
wecom: {
  clientId: env('WECOM_CORP_ID', ''),
  clientSecret: env('WECOM_SECRET', ''),   // the app's Secret
  agentId: env('WECOM_AGENT_ID', ''),
  redirect: '/auth/wecom/callback',
  mode: 'qr',        // 'qr' (browser QR login, default) or 'web' (inside the WeCom client)
  // profile: true,  // call user/get for the name (restricted for apps created after 2022)
  // detail: true,   // read avatar / email with the user_ticket (web mode, snsapi_privateinfo)
},
```

WeCom isn't a standard code-for-user-token exchange: the driver fetches (and caches) the corp `access_token`, then exchanges the code for the member's `userid` with `auth/getuserinfo`. Non-members get their `openid` as `user.id`. `token.accessToken` is the `user_ticket` when there is one, otherwise empty; `userFromToken()` and `refreshToken()` are not supported.

### Alipay

```ts
alipay: {
  clientId: env('ALIPAY_APP_ID', ''),
  privateKey: env('ALIPAY_PRIVATE_KEY', ''),          // app private key (RSA2)
  alipayPublicKey: env('ALIPAY_PUBLIC_KEY', ''),      // verifies response signatures
  redirect: '/auth/alipay/callback',
  // sandbox: true,
},
```

The callback parameter is `auth_code`. Token exchange (`alipay.system.oauth.token`) and the profile (`alipay.user.info.share`) are gateway calls signed with RSA2 (SHA256withRSA). The private key can be PKCS#8 or PKCS#1 PEM, or the bare base64 string from Alipay's key tool. With `alipayPublicKey` set, every response signature is verified, and a bad one fails with 502. `user.id` is the `open_id` (older apps get `user_id`). Only public-key mode is supported, not certificate mode.

### Generic OpenID Connect

```ts
keycloak: {
  driver: 'oidc',
  issuer: 'https://sso.example.com/realms/main',
  clientId: env('SSO_CLIENT_ID', ''),
  clientSecret: env('SSO_CLIENT_SECRET', ''),
  redirect: '/auth/keycloak/callback',
  // userinfo: false,          // use only the id_token claims
  // algorithms: ['RS256'],
},
```

Endpoints come from `<issuer>/.well-known/openid-configuration` (cached; the document's `issuer` must match). The `id_token` signature is checked against `jwks_uri` (RS / PS / ES / EdDSA; the key set is cached and refetched when a new `kid` appears), together with `iss`, `aud`, expiry and the `nonce`. The userinfo response is then merged in, and its `sub` must match. `verifyIdToken(token, { jwksUri, issuer, audience, nonce })` is exported for your own use, for example to verify tokens from a mobile SDK.

## Tokens from mobile apps

When a native app signs in with the provider's SDK and sends you the access token, fetch the user without the redirect flow:

```ts
const profile = await OAuth.driver('github').userFromToken(accessToken)
// WeChat / QQ need the openid that came with the token
const wx = await OAuth.driver('wechat').userFromToken(accessToken, { openid })
// Apple: the identityToken (id_token)
const apple = await OAuth.driver('apple').userFromToken(identityToken)
```

`refreshToken(refreshToken)` returns a new `OAuthToken` for providers that support refresh (standard OAuth 2.0, WeChat, QQ, DingTalk, Feishu, Alipay).

## Custom providers

A provider that follows standard OAuth 2.0 (authorization code, form-encoded token request, Bearer profile request) only needs a definition:

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

Then use `driver: 'gitea'` in `config/oauth.ts`, or pass `driver: Gitea` directly without registering. For non-standard flows, extend `OAuthProvider` (or `OidcProvider`) and override `authorizeParams()`, `exchangeCode()`, `fetchUser()` and `mapUser()`; `registerOAuthProvider()` also accepts the class. `OAuth.build(driver, config)` creates a driver from a config object at runtime, for example per tenant.

## Errors

| Exception | Status | When |
|-----------|--------|------|
| `InvalidStateException` | 400 (`code: 'invalid_state'`) | State missing, expired, tampered or reused |
| `OAuthException` | 400 | The user denied access (`code: 'access_denied'`), the code is invalid or already used, the provider returned an error. `code` carries the vendor's error code (`invalid_grant`, `40029`, …) |
| `OAuthException` | 502 | The provider is unreachable, returned 5xx, or (Alipay) its response signature is invalid |
| `NotFoundException` | 404 | `OAuth.driver(name)` for an unknown or disabled provider |

## Testing

Point `fetch` at an in-process fake so tests never reach the real providers:

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

Request `/auth/github`, read the `state` from the `Location` header, keep the `Set-Cookie`, then call the callback with `?code=...&state=...` and the cookie. The package's own tests do exactly this against fake servers for every provider.
