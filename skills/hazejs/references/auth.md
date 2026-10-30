# Authentication, Authorization & Social Login

Full guides: [Authentication](../../../docs/guide/authentication.md) · [Authorization](../../../docs/guide/authorization.md) · [API Tokens](../../../docs/guide/api-tokens.md) · [Two-Factor & Passkeys](../../../docs/guide/two-factor.md) · [OAuth](../../../docs/guide/oauth.md) · [Sessions & CSRF](../../../docs/guide/security.md)

Paths below use the API template layout (`config/`, `app/`, `route/`, `~/` alias). In full-stack templates they live under `server/`.

## Mental model

- **Guards** (`config/auth.ts` → `guards`) decide *how* a request is authenticated: `jwt` (Bearer JWT), `session` (session cookie), `token` (revocable personal access tokens).
- **Providers** (`providers`) decide *where users come from*: `modelUserProvider()` from `@hazejs/orm`, or any `UserProvider` built with `defineUserProvider()`.
- **Gate** (`app/policy/*.ts`) decides *what* a user may do: `definePolicy(Model, {...})` and `defineAbilities({...})`, auto-registered.
- `ctx.auth` is a per-request `Auth` instance; with no guard name it uses the default guard (or the one the `auth` middleware selected).

## Choose a guard

| Client | Guard | Notes |
|--------|-------|-------|
| SPA served from the same site (Vue/React full-stack templates) | `session` | Cookie auth: enable the `csrf` middleware; the guard starts the session itself |
| Mobile app, SPA on another origin, first-party API clients | `jwt` | Stateless, `Authorization: Bearer`; keep `expiresIn` short (logout does not revoke) |
| Scripts, CLIs, third-party integrations | `token` | Personal access tokens: listable, revocable, scoped by abilities; use `databaseTokenStore()` |

Guards can be combined on a route: `auth:api,token` accepts either.

## config/auth.ts

```ts
// config/auth.ts
import { defineAuthConfig, env } from '@hazejs/core'
import { databasePasswordResetStore, databaseTokenStore, modelUserProvider } from '@hazejs/orm'
import { User } from '~/app/model/User'
import { passwordResetTokens, personalAccessTokens } from '~/database/schema/auth'

export default defineAuthConfig(() => ({
  default: 'api',
  guards: {
    api: { driver: 'jwt', provider: 'users', expiresIn: env('JWT_TTL', '2h') },
    token: { driver: 'token', provider: 'users', store: databaseTokenStore(personalAccessTokens) },
    // web: { driver: 'session', provider: 'users' },
  },
  providers: {
    // model passed as a function to avoid circular imports
    users: modelUserProvider(() => User, { username: 'email', password: 'password' }),
  },
  verification: { route: 'api.auth.verification.verify', expire: '60m' },
  passwords: { store: databasePasswordResetStore(passwordResetTokens), path: '/reset-password', expire: '60m', throttle: '60s' },
  // twoFactor: { ... }, passkeys: { ... }
}))
```

`modelUserProvider` options: `username` (default `'email'`, string or array; every field present in the credentials is matched) and `password` (default `'password'`, column holding the `Hash.make()` hash; the credential of the same name is the plain text).

### Guard options

| Driver | Option | Default | Description |
|--------|--------|---------|-------------|
| all | `provider` | | Name of an entry in `providers` |
| `jwt` | `algorithm` | `'HS256'` | `HS256/384/512`, `RS256/384/512`, `PS256`, `ES256/384/512`, `EdDSA` |
| `jwt` | `secret` | `APP_KEY` | Secret for `HS*` |
| `jwt` | `privateKey` / `publicKey` | | PEM (PKCS#8 / SPKI) for asymmetric algorithms |
| `jwt` | `expiresIn` | `'2h'` | Duration string or seconds |
| `jwt` | `issuer` / `audience` | | Set on issued tokens and checked on incoming ones |
| `jwt` | `cookie` | | Also read the token from this cookie |
| `token` | `store` | in-memory | `databaseTokenStore()` or any `TokenStore` |
| `token` | `type` | provider name | Value of `tokenable_type` (several user kinds in one table) |
| `token` | `expiresIn` | never | Default lifetime of new tokens, e.g. `'30d'` |
| `token` | `prefix` | | Secret prefix such as `'haze_'` for secret scanners |

### Custom user provider

```ts
// config/auth.ts
import { defineUserProvider, Hash } from '@hazejs/core'
import type { Account } from '~/app/service/accounts'
import { findAccount, findAccountByEmail } from '~/app/service/accounts'

const accounts = defineUserProvider<Account>({
  retrieveById: id => findAccount(id),
  retrieveByCredentials: ({ email }) => findAccountByEmail(String(email)), // fields except the password
  validateCredentials: (account, { password }) => Hash.verify(account.passwordHash, String(password)),
  getId: account => account.id, // stored in the session / JWT `sub`
})
```

Passwords: `await Hash.make(pw)`, `await Hash.verify(hash, pw)`, `Hash.needsRehash(hash)` (scrypt, PBKDF2 fallback).

## Logging in

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
    return ctx.created({ user, ...await ctx.auth.jwt().login(user) })
  }

  async login(ctx: HttpContext) {
    const issued = await ctx.auth.jwt().attempt(await validate(LoginSchema, await ctx.body()))
    if (!issued) // undefined on wrong credentials
      throw new UnauthorizedException('Invalid email or password')
    return issued // { token, type: 'Bearer', expiresIn, expiresAt }
  }

  me(ctx: HttpContext) {
    return ctx.auth.user()
  }
}
```

`jwt().login(user, claims?)` / `attempt(credentials, claims?)` return an `IssuedToken`. Tokens carry `sub`, `iat`, `exp`, `jti` plus custom claims; read them with `await ctx.auth.jwt().payload()`.

Session login (same-origin browser apps):

```ts
// app/controller/SessionController.ts
async store(ctx: HttpContext) {
  if (!await ctx.auth.session('web').attempt(await validate(LoginSchema, await ctx.body())))
    throw new UnauthorizedException('Invalid email or password')
  return ctx.auth.user()
}
async destroy(ctx: HttpContext) {
  await ctx.auth.session('web').logout() // invalidates the session
  return ctx.noContent()
}
```

`session().login(user)` regenerates the session id and rotates the CSRF token.

### `ctx.auth` API

| Member | Description |
|--------|-------------|
| `user()` / `check()` / `id()` | Current user (cached per request) / boolean / id, on the active guard |
| `logout()` | Log out of the active guard (jwt: forget for this request; session: invalidate; token: **revoke** the token) |
| `guard(name?)` | Any guard: `user()`, `check()`, `id()`, `validate(credentials)` (check without logging in), `logout()` |
| `jwt(name?)` | JWT guard: `login()`, `attempt()`, `payload()`; throws `TypeError` if not a jwt guard |
| `session(name?)` | Session guard: `login()`, `attempt()`, `logout()` |
| `token(name?)` | Token guard: `createToken()`, `tokens()`, `currentAccessToken()` |
| `tokenCan(ability)` | Token guard → checks abilities; jwt/session user → `true`; guest → `false` |
| `currentAccessToken()` | Token record used for this request, if any |
| `defaultGuard` | Guard name in use for this request |

The user type is inferred from `providers` after typegen (`haze dev` / `haze typegen`).

## Route middleware

| Middleware | Behavior |
|------------|----------|
| `auth` / `auth:api` | Requires a user on the default / named guard → else `401` |
| `auth:web,api` | Passes if **any** guard authenticates; that guard becomes the request's default |
| `guest` / `guest:web` | Already authenticated → `403` |
| `verified` | Not logged in → `401`; email unverified → `403` |
| `can:<ability>[,<Model>[,<param>]]` | Gate check (see below): guest → `401`, denied → `403` |
| `abilities:a,b` | Token must have **all** abilities (`401` guest, `403` missing) |
| `ability:a,b` | Token must have **any** of them |

```ts
// route/api.ts
r.group({ prefix: '/auth', as: 'auth.' }, (r) => {
  r.post('/register', [AuthController, 'register']).middleware('guest').name('register')
  r.post('/login', [AuthController, 'login']).middleware('throttle:10,60').name('login')
  r.get('/me', [AuthController, 'me']).middleware('auth:api,token').name('me')
})
r.post('/posts', [PostController, 'store']).middleware(['auth:token', 'abilities:posts:write'])
r.post('/orders', [OrderController, 'store']).middleware(['auth', 'verified'])
```

## Authorization (Gate)

Every file in `app/policy` default-exports one `definePolicy(...)` or `defineAbilities(...)`; they are registered automatically. Scaffold with `haze make:policy Post`.

```ts
// app/policy/PostPolicy.ts
import { allowGuest, definePolicy, deny } from '@hazejs/core'
import { Post } from '~/app/model/Post'
import type { User } from '~/app/model/User'

export default definePolicy(Post, {
  // runs before every ability of this policy; undefined = fall through
  before: (user: User | undefined) => user?.role === 'admin' || undefined,
  view: allowGuest((user: User | undefined, post: Post) => post.published || post.userId === user?.id),
  create: () => true, // class-level: receives only the user
  update: (user: User, post: Post) => post.userId === user.id || deny('You can only edit your own posts'),
})
```

```ts
// app/policy/abilities.ts
import { defineAbilities } from '@hazejs/core'
import type { User } from '~/app/model/User'

export default defineAbilities({
  'admin.access': (user: User) => user.role === 'admin',
  'report.export': (_user: User, format: string) => format === 'csv',
})
```

Ability results: `true` / `allow()` → allowed; `false` / `undefined` / `null` → denied; `deny(message)` → denied with the `403` message. Abilities may be async.

```ts
// app/controller/PostController.ts
await ctx.authorize('update', post)    // throws 401 (guest) / 403 (denied)
await ctx.authorize('create', Post)    // class-level ability: pass the class
if (await ctx.can('report.export', 'csv')) { /* … */ }
await ctx.cannot('view', post)
```

`can` middleware forms:

```ts
// route/api.ts
r.get('/admin/stats', [AdminController, 'stats']).middleware('can:admin.access')
r.post('/posts', [PostController, 'store']).middleware('can:create,Post')
r.patch('/posts/:id', [PostController, 'update']).middleware('can:update,Post,id')
// third form: Post.findOrFail(ctx.param('id')) (404 if missing), stored as ctx.get<Post>('post')
```

Decision order: global `gate.before()` hooks → policy `before(user, ability, args)` (first non-`undefined` wins) → guests denied unless `allowGuest()` → ability fn (or `gate.fallback()` for undefined abilities) → `gate.after()` hooks observe (cannot change) the result.

A denied signed-in user gets an `AuthorizationException` — a `ForbiddenException` (403, same code and default message) with `abilities` (the denied ability, or every candidate for `authorizeAny` / `can:a|b`) and `reason` (the `deny()` message, `undefined` otherwise). Guests still get `401`. Use it in the exception handler to keep an existing error contract or name the missing permission:

```ts
// app/exception/Handler.ts
import type { HttpContext } from '@hazejs/core'
import { AuthorizationException, ExceptionHandler } from '@hazejs/core'

export default class Handler extends ExceptionHandler {
  override render(error: unknown, ctx: HttpContext) {
    if (error instanceof AuthorizationException && !error.reason) {
      ctx.status(403)
      return { code: 'forbidden', message: ctx.t('errors.missing_permission', { codes: error.abilities.join(', ') }) }
    }
    return super.render(error, ctx)
  }
}
```

Global rules / outside requests:

```ts
// app/provider/AuthProvider.ts
import { defineProvider, Gate } from '@hazejs/core'
import type { User } from '~/app/model/User'

export default defineProvider({
  boot(app) {
    const gate = app.make(Gate)
    gate.define('beta', (user: User) => user.role === 'admin')
    gate.before((user: User | undefined) => user?.role === 'admin' || undefined)
    gate.after((user, ability, allowed) => app.logger.info(`gate ${ability}: ${allowed}`))
  },
})

// in a job / listener / script
const gate = useApp().make(Gate) // or inject(Gate) in services
await gate.forUser(user).can('update', post)
const { allowed, message, guest } = await gate.forUser(user).inspect('update', post)
```

Typegen generates ability names from `app/policy`, so `ctx.can/cannot/authorize` only accept existing abilities (model abilities matched to the model passed).

## Personal access tokens

Plain token format `<id>|<secret>` (e.g. `12|haze_9qL…`), shown once; only the SHA-256 of the secret is stored. Tables: `haze make:auth-tables [--dialect postgres]` writes `database/schema/auth.ts` (`personal_access_tokens`, `password_reset_tokens`, `two_factor_secrets`, `webauthn_credentials`), then `haze db:generate && haze db:migrate`. Keep the JS property names (`tokenableType`, `abilities`, `lastUsedAt`, …).

```ts
// app/controller/TokenController.ts
async store(ctx: HttpContext) {
  const user = (await ctx.auth.user())!
  const { plainTextToken, accessToken } = await ctx.auth.token().createToken(user, 'deploy script', {
    abilities: ['posts:read', 'posts:write'], // default ['*']
    expiresIn: '90d', // or expiresAt: Date | null (wins over expiresIn)
  })
  return ctx.created({ token: plainTextToken, id: accessToken.id }) // never return accessToken.token (hash)
}
```

Outside requests (first token guard unless `guard` is passed):

```ts
import { createAccessToken, PersonalAccessTokens } from '@hazejs/core'

await PersonalAccessTokens.create(user, 'cli', { abilities: ['posts:read'] })
await createAccessToken(user, 'cli') // NOT createToken(): that is the DI token helper
await PersonalAccessTokens.list(user)
await PersonalAccessTokens.revoke(id, user) // false if not the user's
await PersonalAccessTokens.revokeAll(user)
await PersonalAccessTokens.find(plainTextToken)
```

Abilities: `*` grants all; trailing `:*` matches a prefix (`posts:*`). `last_used_at` is updated at most once a minute. Custom stores implement `TokenStore` (`create`, `find`, `list`, `update`, `delete`, `deleteAll`).

## Email verification & password reset

```ts
// app/controller/VerificationController.ts
import { hasVerifiedEmail, sendEmailVerification, verifyEmail } from '@hazejs/core'

async send(ctx: HttpContext) {
  const user = await ctx.auth.user()
  if (hasVerifiedEmail(user))
    return { status: 'verified' }
  await sendEmailVerification(user) // false (no mail) if already verified
  return { status: 'sent' }
}
async verify(ctx: HttpContext) { // works without login (opened from a mail client)
  const { verified } = await verifyEmail(ctx) // 403 bad signature/hash, 404 unknown user
  return { status: verified ? 'verified' : 'already-verified' }
}
```

Links are signed URLs (`APP_KEY`), path `<id>/<hash>`; `hash` = SHA-256 of the email. Also: `verificationUrl(user)`, `markEmailAsVerified(user)` (emits `EmailVerified`).

| `verification` option | Default | |
|---|---|---|
| `route` | | Full route name (incl. group `as` prefixes) with params `id`, `hash` |
| `path` | `'/email/verify'` | Used when `route` is unset |
| `expire` | `'60m'` | |
| `email` / `field` | `'email'` / `'emailVerifiedAt'` | `field` must be a nullable timestamp |
| `url` | | `(link, user) => string` (e.g. point at a frontend page) |
| `mail` / `queue` | `VerifyEmailMail` / `false` | |

```ts
// app/controller/PasswordResetController.ts
import { PasswordReset, validate, ValidationException } from '@hazejs/core'

async forgot(ctx: HttpContext) {
  const { email } = await validate(ForgotPasswordSchema, await ctx.body())
  const status = await PasswordReset.sendLink(email) // 'sent' | 'throttled' | 'invalid-user'
  return { status: status === 'throttled' ? 'throttled' : 'sent' } // never leak 'invalid-user'
}
async reset(ctx: HttpContext) {
  const status = await PasswordReset.reset(await validate(ResetPasswordSchema, await ctx.body()))
  if (status !== 'reset') // 'invalid-token' | 'invalid-user'
    throw new ValidationException([{ target: 'body', path: 'token', message: 'This link is invalid or has expired' }])
  return { status }
}
```

`PasswordReset.reset(input, async (user, password) => { … })` replaces the default "hash + save" (e.g. also `PersonalAccessTokens.revokeAll(user)`). One token per email; only its hash is stored. `passwords` options: `provider`, `store` (`databasePasswordResetStore(table)`, `cachePasswordResetStore(name?)`, `memoryPasswordResetStore()`, or a cache store name), `expire` (`'60m'`), `throttle` (`'60s'`, `0` disables), `email`/`password`, `path` (`'/reset-password'` → `<APP_URL><path>?token=…&email=…`), `url`, `mail` (`ResetPasswordMail`), `queue`. Low level: `PasswordReset.broker()` returns a `PasswordBroker`; `createToken`, `tokenExists`, `deleteToken`.

### `authRoutes()` (quick start)

```ts
// route/api.ts
import { authRoutes, defineRoutes } from '@hazejs/core'

export default defineRoutes((r) => {
  r.group({ prefix: '/api/auth', as: 'auth.' }, (r) => {
    authRoutes(r, { verification: true, passwordReset: true, tokens: { abilities: ['posts:read', 'posts:write'] } })
  })
})
```

| Option | Registers |
|--------|-----------|
| `verification` | `POST /email/verification-notification` (`verification.send`, login), `GET /email/verify/:id/:hash` (`verification.verify`) |
| `passwordReset` | `POST /forgot-password` (`password.email`), `POST /reset-password` (`password.update`) |
| `tokens` | `GET/POST /tokens`, `DELETE /tokens/:id` (`tokens.*`, login); `{ abilities }` restricts requestable abilities (others → `422`) |
| `auth` / `throttle` / `minPasswordLength` | Default `['auth']` / `'throttle:6,60'` (`false` disables) / `8` |

## Two-factor (TOTP) & passkeys

```ts
// config/auth.ts (excerpt)
import { databasePasskeyStore, databaseTwoFactorStore } from '@hazejs/orm'
import { twoFactorSecrets, webauthnCredentials } from '~/database/schema/auth'

twoFactor: { store: databaseTwoFactorStore(twoFactorSecrets), issuer: 'Acme' },
passkeys: { store: databasePasskeyStore(webauthnCredentials), rpName: 'Acme' }, // needs @simplewebauthn/server
```

TOTP options: `provider`, `store`, `issuer` (`app.name`), `account` (`'email'`), `digits`/`period`/`algorithm` (`6`/`30`/`'SHA1'`), `window` (`1`), `recoveryCodes` (`8`), `challengeTtl` (`'5m'`), `maxAttempts` (`5`).

```ts
// enable → confirm (2FA inactive until confirmed)
const { secret, uri, recoveryCodes } = await TwoFactor.enable(user) // 409 if already enabled; { force: true } to replace
await TwoFactor.confirm(user, code) // boolean
// also: enabled, verify, useRecoveryCode, regenerateRecoveryCodes, remainingRecoveryCodes, uri, disable

// session login with a challenge
const result = await TwoFactor.attempt(ctx, credentials) // status: 'failed' | 'authenticated' | 'two-factor'
const user = await TwoFactor.challenge(ctx, { code, recoveryCode }) // logs in, or undefined
await TwoFactor.hasPendingChallenge(ctx) // show the code form?

// JWT / token APIs: no challenge flow, verify the code yourself
const user = await ctx.auth.jwt().validate(credentials)
if (user && await TwoFactor.enabled(user) && !(code && await TwoFactor.verify(user, code)))
  throw new UnauthorizedException('A valid two-factor code is required')
```

Render `uri` as a QR code on the client (the server makes no images). Primitives: `totp`, `verifyTotp`, `hotp`, `generateTotpSecret`, `otpauthUri`, `generateRecoveryCodes`, `base32Encode/Decode`, `totpStep`.

Passkeys (`Passkeys` facade): `registrationOptions(ctx, user)` → `verifyRegistration(ctx, user, response, { name })` (logged in); `authenticationOptions(ctx[, { user }])` → `login(ctx, response, { guard? })` (session) or `verifyAuthentication(ctx, response)` → `{ user, credential }` then issue a JWT yourself. Manage with `credentials(user)`, `rename(user, id, name)`, `delete(user, id)`. Options include `rpID`/`origin` (default from `APP_URL`), `challenge: 'session' | 'cache'` (use `'cache'` for session-less APIs), `userVerification`, `residentKey`. Browser side: `@simplewebauthn/browser`.

## OAuth social login (`@hazejs/oauth`)

Drivers: `github`, `google`, `apple`, `microsoft`, `gitlab`, `discord`, `wechat` (Open Platform QR), `wechat_mp` (Official Account), `qq`, `dingtalk`, `feishu`, `wecom`, `alipay`, `oidc` (Keycloak, Auth0, Authing, …).

```ts
// config/oauth.ts
import { env } from '@hazejs/core'
import { defineOAuthConfig } from '@hazejs/oauth'

export default defineOAuthConfig(() => ({
  providers: {
    github: { clientId: env('GITHUB_CLIENT_ID', ''), clientSecret: env('GITHUB_CLIENT_SECRET', ''), redirect: '/api/auth/github/callback' },
    company: { driver: 'oidc', issuer: 'https://sso.example.com/realms/main', clientId: env('SSO_CLIENT_ID', ''), clientSecret: env('SSO_CLIENT_SECRET', ''), redirect: '/api/auth/company/callback' },
  },
}))
```

Per-provider: `driver` (defaults to the key), `clientId`, `clientSecret`, `redirect` (path completed with `APP_URL`), `scopes`, `pkce`, `stateless`, `parameters`, `endpoints`, plus vendor fields (`teamId`/`keyId`/`privateKey` for Apple, `tenant`, `baseUrl`, `idField: 'unionid'`, `agentId`/`mode` for WeCom, `alipayPublicKey`, `domain: 'lark'`). Global: `stateStore` (`'cookie'` | `'session'`), `cookie` (`'haze_oauth'`), `stateTtl` (`'10m'`), `fetch`.

```ts
// route/api.ts
r.get('/auth/:provider', [OAuthController, 'redirect']).name('oauth.redirect')
r.get('/auth/:provider/callback', [OAuthController, 'callback']).name('oauth.callback')
r.post('/auth/:provider/callback', [OAuthController, 'callback']) // Apple form_post
```

```ts
// app/controller/OAuthController.ts
import type { HttpContext } from '@hazejs/core'
import { OAuth } from '@hazejs/oauth'
import { User } from '~/app/model/User'

export class OAuthController {
  redirect(ctx: HttpContext) {
    return OAuth.driver(ctx.param('provider')!).redirect(ctx) // 404 if unknown/disabled
  }

  async callback(ctx: HttpContext) {
    const profile = await OAuth.driver(ctx.param('provider')!).user(ctx)
    // profile: { provider, id (string), name, nickname, email, avatar (null if absent), raw, token }
    // Prefer linking (provider, profile.id) in a social_accounts table over matching by email.
    const user = await User.where('email', profile.email).find()
      ?? await User.create({ name: profile.name ?? profile.nickname ?? 'User', email: profile.email! })
    return ctx.auth.jwt().login(user)
  }
}
```

Builder (fresh per `OAuth.driver()` call): `.scopes([...])` (add), `.setScopes(...)` (replace), `.with({...})`, `.redirectUrl(url)`, `.stateless()`, `.redirect(ctx)`, `await .authorizationUrl(ctx)` (SPA: return the URL as JSON). Mobile SDK tokens: `userFromToken(accessToken[, { openid }])`; `refreshToken(rt)`. Also `OAuth.enabled(name)`, `OAuth.providers()`, `OAuth.build(driver, config)`, `defineOAuthProvider()` + `registerOAuthProvider(name, def)` for custom providers, `verifyIdToken()`. Errors: `InvalidStateException` (400), `OAuthException` (400 / 502).

## Sessions & CSRF (as they relate to auth)

- Cookie-based auth (session guard, or a JWT read from `cookie`) must be paired with the `csrf` middleware. Token travels in the readable `XSRF-TOKEN` cookie and comes back as `X-XSRF-TOKEN` / `X-CSRF-TOKEN` header or `_token` form field; mismatch → `419`.
- CSRF is skipped for safe methods, requests with `Authorization: Bearer …`, `except` paths (`defineCsrfConfig({ except: [...] })`), and tests unless `testing: true`.
- The session guard starts the session itself; the `session` middleware is not required for it. Session config: `defineSessionConfig({ driver: 'cookie', lifetime: '2h' })`.

## Testing

```ts
const client = await t.actingAs(user)          // real JWT / session cookie for the default guard
await t.actingAs(user, 'web')                  // another guard
await t.actingAs(user, 'token')                // real PAT with all abilities
const headers = await issueTestCredentials(t.app, user, 'token', { abilities: ['posts:read'] })
```

## Gotchas

- **`APP_KEY` is load-bearing.** It is the default `HS*` JWT secret and keys sessions, signed verification links, 2FA secret encryption and the OAuth state cookie. Rotating it logs everyone out and invalidates links. Must be ≥ 32 chars.
- **JWT logout does not revoke.** `ctx.auth.jwt().logout()` only forgets the user for the current request. On a token guard, `logout()` *does* revoke the token used.
- **401 vs 403.** `auth`, `verified` (not logged in), `abilities`/`ability` (no user) and `authorize`/`can:` for guests → `401`. `guest` (already logged in), `verified` (unverified), missing token ability, and denied Gate checks → `403` (denied Gate checks throw `AuthorizationException`; match it, not the message, in handlers). `guest` returns 403; it does not redirect.
- **`ctx.auth.jwt()` / `.session()` without a name use the request's default guard** and throw `TypeError` if that guard has a different driver. Pass the name (`ctx.auth.session('web')`) when the default is a different driver. `ctx.auth.token()` instead falls back to the first token guard.
- **`auth:a,b` switches the default guard** for the rest of the request (`shouldUse`). `ctx.auth.user()`, `tokenCan()` and Gate checks then use that guard, so put `abilities:`/`ability:` **after** `auth`.
- **`tokenCan()` is `true` for jwt/session users.** `abilities:` middleware does not restrict first-party JWT clients; it only scopes PATs.
- **Gate user comes from `ctx.auth.user()` on the default guard.** Without `config/auth.ts`, everyone is a guest. Guests are denied before the ability runs unless it is wrapped in `allowGuest()`; a `before` hook that returns `true` still wins.
- **Policies must live in `app/policy/*.ts` and default-export `definePolicy`/`defineAbilities`**; anything else throws at boot. `app/<name>/policy` in multi-app projects is not loaded. Unknown abilities throw (500), they are not "denied" — unless `gate.fallback()` is registered, which then decides every undefined ability (`undefined` from it = denied).
- **`can:<ability>,<Model>` needs a registered policy for that model** (class name), and the 3-arg form needs a static `findOrFail()`; the loaded instance is at `ctx.get('<lowerCamelModel>')`.
- **Class-level abilities**: pass the model class (`ctx.authorize('create', Post)`); the ability then receives only the user.
- **Default stores are in-memory** (tokens, password resets, 2FA, passkeys): lost on restart and not shared across processes. Use the `database*Store()` helpers from `@hazejs/orm` in real apps.
- **Plain-text secrets are shown once**: PATs (`plainTextToken`) and recovery codes (`TwoFactor.enable()` result). Never return `accessToken.token` (it is a hash).
- **Use `createAccessToken()`, not `createToken()`** from `@hazejs/core` for PATs; `createToken()` is the DI token factory.
- **`verification.route` must be the full route name** including every group `as` prefix (e.g. `'api.auth.verification.verify'`). Set `APP_URL` or links in emails are relative.
- **Don't reveal `'invalid-user'`** from `PasswordReset.sendLink()`; it enables email enumeration. Throttle reset/verification endpoints.
- **2FA challenge flow requires a session guard.** For JWT/token APIs call `guard.validate()` + `TwoFactor.verify()` before issuing a token, and don't use `attempt()` (it would issue a token before the code check).
- **OAuth providers with an empty `clientId` are disabled** (routes 404). Several providers (WeChat, QQ, WeCom, Apple relay) return no or untrusted email: link by `(provider, profile.id)`. Apple's POST callback must be added to the `csrf` `except` list when `csrf` is global.

## Stateful JWT sessions and data-driven permissions

```ts
// config/auth.ts — check a session on every request, keep error codes, block reset tickets
api: {
  driver: 'jwt',
  provider: 'users',
  expiresIn: ctx => Settings.get('auth.accessTokenTtl'),   // function: evaluated per login
  rejectClaims: ['purpose'],
  resolveUser: async (payload, ctx) => {                      // replaces provider.retrieveById(sub)
    const session = await Session.find(payload.sid as string)
    if (!session || session.revokedAt)
      throw new UnauthorizedException('Session expired', { code: 'session_invalid' }) // passes through as-is
    return loadUser(payload.sub, ctx.header('x-org-id'))
  },
},
```

- `ctx.auth.jwt().login(user, { sid }, { expiresIn: '15m' })` — custom claims plus a per-token lifetime.
- `auth` rejects with `401` and `code: 'unauthenticated'` (no credentials) or `'token_invalid'` (expired / tampered / `rejectClaims`); `auth:optional` (`auth:api,optional`) never rejects. `guard.failure` is `'missing' | 'invalid'`.
- Permission codes kept with roles: `app.make(Gate).fallback((user, ability) => user?.permissions.includes(ability))` in a provider's `boot()` decides every undefined ability (after `before` hooks); `can:a|b` / `ctx.authorizeAny([...])` pass on any; require **all** of several codes with one `can:<code>` per code (`['auth', ...codes.map(c => \`can:${c}\`)]`). Typegen only knows abilities from `app/policy`, so `ctx.can()` with a runtime code may need a cast or a small wrapper.
- Socket.IO: `authenticate({ headers: auth => ({ 'x-org-id': auth.org }) })`; rejected handshakes carry `error.data = { status, code }`.

