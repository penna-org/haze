# Authentication, Authorization & Social Login

Full guides: [Authentication](../../../docs/guide/authentication.md) · [Authorization](../../../docs/guide/authorization.md) · [API Tokens](../../../docs/guide/api-tokens.md) · [Two-Factor & Passkeys](../../../docs/guide/two-factor.md) · [OAuth](../../../docs/guide/oauth.md) · [Security: sessions, CSRF, CORS, headers](../../../docs/guide/security.md)

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

`Gate` instance API: `define(name, fn)`, `policy(definePolicy(...))` / `register(item)` (manual registration), `before(hook)`, `after(hook)`, `fallback(hook)`, `has(name)`, `allows(user, ability, ...args)` / `denies(...)`, `authorize(user, ...)` (401 guest / 403 `AuthorizationException`), `authorizeAny(user, abilities, ...args)` (empty list throws), `inspect(user, ...)` → `{ allowed, message?, guest }`, `forUser(user)` → `UserGate` (`can`, `cannot`, `authorize`, `inspect`). `allow()` takes no message; `deny(message?)`. Policies resolve through the prototype chain (a model subclass uses its parent's policy); asking a policy for an ability it lacks throws. A `gate.fallback()` also runs for guests (receives `undefined`), unlike plain abilities.

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

Every facade method takes an optional trailing `guard` (`create(user, name, { guard })`, `list(user, guard)`, `revoke(id, user?, guard)`, `revokeAll(user, guard)`, `find(plain, guard)`); `PersonalAccessTokens.repository(guard?)` / `ctx.auth.token().tokens()` return the `TokenRepository`. `revoke(id)` without a user revokes any token.

Abilities: `*` grants all; trailing `:*` matches a prefix (`posts:*`). Pure helpers: `abilityMatches(granted, ability)`, `tokenCan(token, ability)`. A token is rejected (= guest) when the secret mismatches, it is revoked/expired, or its `tokenableType` differs from the guard's user type (`type`, default = provider name — two token guards on the same provider accept each other's tokens). `last_used_at` is updated at most once a minute. Custom stores implement `TokenStore` (`create` assigns the id, `find`, `list`, `update`, `delete` → boolean, `deleteAll` → count); ids must be numbers or `[A-Za-z0-9_-]{1,64}` strings (they form the part before `|`). Tests: `ctx.auth.token().withAccessToken(user, tokenRecord)` fakes a token with specific abilities.

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

Both are configured in `config/auth.ts` and store data through small store interfaces. Tables come from `haze make:auth-tables` (`two_factor_secrets`, `webauthn_credentials`). `authRoutes()` does **not** register any 2FA or passkey routes: write the controllers yourself.

```ts
// config/auth.ts (excerpt)
import { databasePasskeyStore, databaseTwoFactorStore } from '@hazejs/orm'
import { twoFactorSecrets, webauthnCredentials } from '~/database/schema/auth'

twoFactor: { store: databaseTwoFactorStore(twoFactorSecrets), issuer: 'Acme' },
passkeys: { store: databasePasskeyStore(webauthnCredentials), rpName: 'Acme' }, // needs @simplewebauthn/server
```

The `database*Store(table, { connection? })` helpers accept the table or `() => table`. In-memory defaults: `memoryTwoFactorStore(name?)`, `memoryPasskeyStore(name?)` (tests only).

### TOTP config (`twoFactor`)

| Option | Default | Description |
|--------|---------|-------------|
| `provider` | default guard's provider | User source; its name is the stored `userType` |
| `store` | in memory | `databaseTwoFactorStore()` or any `TwoFactorStore` |
| `issuer` | `app.name` | Service name in the authenticator app |
| `account` | `'email'` | User field for the account label (falls back to the user id) |
| `digits` / `period` / `algorithm` | `6` / `30` / `'SHA1'` | `algorithm`: `'SHA1' \| 'SHA256' \| 'SHA512'`; most apps only support the defaults |
| `window` | `1` | Accepted drift in steps (±30 s) |
| `recoveryCodes` | `8` | Count; format `xxxxx-xxxxx` (lowercase base32) |
| `challengeTtl` | `'5m'` | How long a pending session login waits for the code |
| `maxAttempts` | `5` | Wrong codes per **user**, counted server-side in the cache for `challengeTtl`; once reached no challenge completes until the TTL passes — re-entering the password or replaying an old session cookie does not reset it |
| `cacheStore` | default cache store | Where wrong-code attempts are counted |

Stored per user (`TwoFactorRecord`): `secret` encrypted with `APP_KEY` (AES-GCM, same as `Crypt`), `recoveryCodes` as SHA-256 hashes, `confirmedAt` (`null` = not active), `lastUsedStep` (replay protection: each step is accepted once, older steps are refused).

### Enable → confirm → manage

```ts
// app/controller/TwoFactorController.ts
import type { HttpContext } from '@hazejs/core'
import { BadRequestException, TwoFactor } from '@hazejs/core'

export class TwoFactorController {
  async enable(ctx: HttpContext) { // step 1: QR + recovery codes (shown only now)
    const { secret, uri, recoveryCodes } = await TwoFactor.enable((await ctx.auth.user())!)
    return { secret, uri, recoveryCodes } // render `uri` as QR in the browser (qrcode / uqr)
  }

  async confirm(ctx: HttpContext) { // step 2: first code activates 2FA
    const { code } = await ctx.body<{ code: string }>()
    if (!await TwoFactor.confirm((await ctx.auth.user())!, code))
      throw new BadRequestException('Invalid code')
    return { enabled: true }
  }

  async disable(ctx: HttpContext) { // re-check password / a code first: disable() itself checks nothing
    await TwoFactor.disable((await ctx.auth.user())!)
    return ctx.noContent()
  }
}
```

| `TwoFactor.*` | Returns | Notes |
|---|---|---|
| `enable(user, { force? })` | `{ secret, uri, recoveryCodes }` | New secret, unconfirmed. Already confirmed → `409 ConflictException` unless `force` (then back to unconfirmed) |
| `confirm(user, code)` | `boolean` | Activates; emits `TwoFactorEnabled`. `false` if `enable()` was never called |
| `enabled(user)` | `boolean` | Confirmed? |
| `verify(user, code)` | `boolean` | Only for confirmed users; consumes the step; failure emits `TwoFactorFailed` |
| `useRecoveryCode(user, code)` | `boolean` | Case-insensitive, single use; failure emits `TwoFactorFailed` |
| `regenerateRecoveryCodes(user)` | `string[]` | Old codes stop working; throws plain `Error` (500) if no record |
| `remainingRecoveryCodes(user)` | `number` | |
| `uri(user)` | `string \| undefined` | `otpauth://` URI again (re-show QR during setup) |
| `disable(user)` | `void` | Deletes secret + codes; emits `TwoFactorDisabled` |
| `attempt(ctx, credentials, { guard? })` | `{ status: 'failed' } \| { status: 'authenticated' \| 'two-factor', user }` | Session guard only |
| `challenge(ctx, { code?, recoveryCode? })` | `user \| undefined` | Logs in (session id regenerated) |
| `hasPendingChallenge(ctx)` | `boolean` | Show the code form? |
| `authenticator()` | `TwoFactorAuthenticator` | Same methods as a class instance |

Events (`defineListener(TwoFactorFailed, ({ user, id }) => …)`): `TwoFactorEnabled`, `TwoFactorDisabled`, `TwoFactorFailed`, all `{ user, id }`.

### Session login with a challenge

```ts
// app/controller/SessionController.ts
import type { HttpContext } from '@hazejs/core'
import { TwoFactor, UnauthorizedException, validate } from '@hazejs/core'
import { LoginSchema } from '~/app/validate/auth'

export class SessionController {
  async store(ctx: HttpContext) {
    const result = await TwoFactor.attempt(ctx, await validate(LoginSchema, await ctx.body()), { guard: 'web' })
    if (result.status === 'failed')
      throw new UnauthorizedException('Invalid email or password')
    return { status: result.status } // 'authenticated' (no 2FA → logged in) | 'two-factor' (ask for code)
  }

  async challenge(ctx: HttpContext) {
    const { code, recoveryCode } = await ctx.body<{ code?: string, recoveryCode?: string }>()
    const user = await TwoFactor.challenge(ctx, { code, recoveryCode })
    if (!user)
      throw new UnauthorizedException('Invalid code')
    return user
  }
}

// route/web.ts
r.post('/login', [SessionController, 'store']).middleware('throttle:10,60')
r.post('/two-factor-challenge', [SessionController, 'challenge']).middleware('throttle:10,60')
r.get('/two-factor-challenge', async ctx => ({ pending: await TwoFactor.hasPendingChallenge(ctx) }))
```

`attempt()` validates credentials without logging in, then stores `{ guard, id, expiresAt, attempts }` under the session key `_two_factor_login`. `challenge()` logs in through the guard recorded by `attempt()` (it takes no `guard` option); `recoveryCode` wins over `code` when both are sent.

### JWT / token APIs (no challenge flow)

```ts
async login(ctx: HttpContext) {
  const { code, ...credentials } = await ctx.body<{ email: string, password: string, code?: string }>()
  const user = await ctx.auth.jwt().validate(credentials) // validate, NOT attempt (attempt would issue a token)
  if (!user)
    throw new UnauthorizedException('Invalid email or password')
  if (await TwoFactor.enabled(user) && !(code && await TwoFactor.verify(user, code)))
    throw new UnauthorizedException('A valid two-factor code is required', { code: 'two_factor_required' })
  return ctx.auth.jwt().login(user)
}
```

### TOTP primitives (Web Crypto, any runtime)

```ts
import { base32Decode, base32Encode, generateRecoveryCodes, generateTotpSecret, hotp, otpauthUri, totp, totpStep, verifyTotp } from '@hazejs/core'

const secret = generateTotpSecret()            // base32, 20 bytes (arg: byte count)
otpauthUri({ secret, issuer: 'Acme', account: 'ada@example.com' }) // + digits/period/algorithm
await totp(secret)                             // current code; opts { digits, period, algorithm, time }
await verifyTotp(secret, code, { window: 1, afterStep: lastStep }) // matched step | undefined
await hotp(secret, counter)                    // RFC 4226
totpStep()                                     // current step number; opts { period, time }
generateRecoveryCodes(8)                       // ['k3j9d-x2m4p', …]
```

### Passkeys (WebAuthn)

`pnpm add @simplewebauthn/server` (v13/v14; optional peer, loaded on first use — missing → `Error` telling you to install it). Browser: `@simplewebauthn/browser` (hazejs ships no client).

| `passkeys` option | Default | Description |
|--------|---------|-------------|
| `provider` | default guard's provider | User source; credentials of another `userType` are rejected |
| `store` | in memory | `databasePasskeyStore()` or any `PasskeyStore` |
| `rpName` | `app.name` | Shown by the browser |
| `rpID` | hostname of `APP_URL`, else of the request | Domain only (no scheme/port) |
| `origin` | origin of `APP_URL`, else of the request | `string \| string[]` of accepted origins |
| `challenge` | `'session'` | `'cache'` for session-less APIs (keyed by challenge value, no cookie) |
| `cacheStore` | default cache store | Holds `challenge: 'cache'` challenges; in `'session'` mode also marks used challenges, so replaying an assertion/attestation with an old session cookie is rejected |
| `timeout` | `60000` | ms; challenges expire after the same time |
| `userVerification` | `'preferred'` | `'required'` forces biometrics/PIN (and is enforced on verify) |
| `residentKey` | `'preferred'` | Discoverable credentials (username-less login) |
| `userName` / `displayName` | `'email'` / `'name'` | User fields shown by the authenticator |

```ts
// app/controller/PasskeyController.ts
import type { HttpContext, PasskeyResponseJSON } from '@hazejs/core'
import { Passkeys } from '@hazejs/core'

export class PasskeyController {
  async registrationOptions(ctx: HttpContext) { // excludes the user's existing passkeys
    return Passkeys.registrationOptions(ctx, (await ctx.auth.user())!) // 2nd arg opt: { authenticatorAttachment: 'platform' | 'cross-platform' }
  }
  async register(ctx: HttpContext) {
    const { response, name } = await ctx.body<{ response: PasskeyResponseJSON, name?: string }>()
    const credential = await Passkeys.verifyRegistration(ctx, (await ctx.auth.user())!, response, { name })
    return ctx.created({ id: credential.id, name: credential.name })
  }
  loginOptions(ctx: HttpContext) {
    return Passkeys.authenticationOptions(ctx) // or (ctx, { user }) to allow only that user's passkeys
  }
  async login(ctx: HttpContext) {
    return Passkeys.login(ctx, await ctx.body<PasskeyResponseJSON>(), { guard: 'web' }) // session login
  }
  async token(ctx: HttpContext) { // JWT APIs: verify, then issue yourself
    const { user } = await Passkeys.verifyAuthentication(ctx, await ctx.body<PasskeyResponseJSON>())
    return ctx.auth.jwt().login(user)
  }
}

// route/web.ts
r.post('/passkeys/options', [PasskeyController, 'registrationOptions']).middleware('auth')
r.post('/passkeys', [PasskeyController, 'register']).middleware('auth')
r.post('/passkeys/login/options', [PasskeyController, 'loginOptions'])
r.post('/passkeys/login', [PasskeyController, 'login']).middleware('throttle:10,60')
```

- `verifyRegistration()` → `400` when the challenge expired / was used / belongs to another user, origin or RP ID mismatch, or the credential is already registered.
- `verifyAuthentication()` / `login()` → `401` on any failure; success updates `counter`, `backedUp`, `lastUsedAt`.
- Manage (no `ctx` needed): `Passkeys.credentials(user)` → `PasskeyCredential[]`; `rename(user, id, name)` / `delete(user, id)` → `false` if not the user's. `Passkeys.manager(ctx?)` returns a `PasskeyManager` (also exposes `.store`).
- `PasskeyCredential`: `id` (base64url), `userType`, `userId`, `name`, `publicKey`, `counter`, `transports`, `deviceType` (`'singleDevice' | 'multiDevice'`), `backedUp`, `aaguid`, `createdAt`, `lastUsedAt`.
- Session challenge mode keeps one pending challenge per kind (`_webauthn_registration` / `_webauthn_authentication`); requesting new options replaces the previous one. Send requests with cookies (`credentials: 'include'`) and the `X-XSRF-TOKEN` header when `csrf` is on.

- Browser: `startRegistration({ optionsJSON })` → POST `{ response, name }`; `startAuthentication({ optionsJSON })` → POST the result as the body.

Custom stores (`userType` = provider name, `userId` = `String(provider.getId(user))`): `TwoFactorStore` = `get(userType, userId)` → `TwoFactorRecord | undefined`, `set(userType, userId, record)` (upsert), `delete(userType, userId)`. `PasskeyStore` = `create(credential)`, `find(id)`, `list(userType, userId)`, `update(id, { name?, counter?, backedUp?, lastUsedAt? })`, `delete(id)` → whether it existed.

## OAuth social login (`@hazejs/oauth`)

`pnpm add @hazejs/oauth` (fetch + jose + Web Crypto only; runs on Node, Bun, Deno, Workers).

| Driver | Default scopes | PKCE | Vendor options / notes |
|--------|----------------|------|------------------------|
| `github` | `read:user`, `user:email` | yes | `baseUrl` (Enterprise → API `<baseUrl>/api/v3`); falls back to the verified primary email |
| `google` | `openid profile email` | yes | OIDC: `id_token` + userinfo, nonce |
| `apple` | `name`, `email` | no | `teamId`, `keyId`, `privateKey` (.p8, `\n` escapes ok), `secretTtl` (s, default 3600); `form_post` callback |
| `microsoft` | `openid profile email User.Read` | yes | `tenant` (`'common'` default, `organizations`, `consumers`, tenant id); profile from Graph `/me` |
| `gitlab` | `read_user` | yes | `baseUrl` (default `https://gitlab.com`) |
| `discord` | `identify`, `email` | no | |
| `wechat` | `snsapi_login` | no | Website QR. `idField: 'openid' \| 'unionid'`, `lang` (`zh_CN`) |
| `wechat_mp` | `snsapi_userinfo` | no | Inside WeChat; `setScopes('snsapi_base')` = silent, openid only |
| `qq` | `get_user_info` | no | `idField: 'openid' \| 'unionid'` |
| `dingtalk` | `openid` | no | New `login.dingtalk.com` flow; `id` = `unionId` |
| `feishu` | (none) | yes | `domain: 'feishu' \| 'lark'`, `idField: 'open_id' \| 'union_id' \| 'user_id'`; add `offline_access` for refresh tokens |
| `wecom` | `snsapi_base` | no | `agentId` (required), `mode: 'qr' \| 'web'`, `profile`, `detail` (web + `snsapi_privateinfo`); no `userFromToken` / `refreshToken` |
| `alipay` | `auth_user` | no | `privateKey` (RSA2, PKCS#8/PKCS#1/bare base64), `alipayPublicKey` (verify responses), `sandbox`; callback param `auth_code`; no `clientSecret` |
| `oidc` | `openid profile email` | yes | `issuer` (required; discovery + JWKS), `userinfo` (default true), `algorithms` |

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

| Per-provider option | Description |
|---|---|
| `driver` | Built-in name, a `registerOAuthProvider()` name, or a `defineOAuthProvider()` result. Default: the key |
| `clientId` | AppID / App Key / corpid … Empty → provider **disabled** (also when the value is `false`/`null`) |
| `clientSecret` | AppSecret / corpsecret (Apple: optional ready-made JWT, otherwise generated from `teamId`/`keyId`/`privateKey`; not used by Alipay) |
| `redirect` | Absolute URL, or path completed with `APP_URL` (else request origin) |
| `scopes` | **Replaces** the driver defaults |
| `pkce` | Force S256 PKCE on/off (default: driver support, table above) |
| `stateless` | Skip state (and PKCE/nonce) for this provider |
| `parameters` | Fixed extra authorize-URL params |
| `endpoints` | Override endpoint URLs (`authorize`, `token`, `user`, … — proxies, private deployments, tests) |

| Global option | Default | Description |
|---|---|---|
| `stateStore` | `'cookie'` | `'cookie'` (AES-GCM sealed with `APP_KEY`, no session needed) or `'session'` (key `_oauth.<provider>`) |
| `cookie` | `'haze_oauth'` | Prefix; actual cookie `<prefix>_<provider>` (parallel flows don't collide) |
| `stateTtl` | `'10m'` | Seconds or `'Ns/m/h/d'` |
| `fetch` | global `fetch` | HTTP client for every provider call (proxies, tests) |

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

`OAuthUser`: `provider` (config key), `id` (string; missing → `OAuthException` `missing_user_id`), `name`/`nickname`/`email`/`avatar` (`null` when absent), `raw` (vendor profile: unionid, phone, tenant, Apple `raw.user` on first sign-in …), `token: OAuthToken` = `{ accessToken, refreshToken?, expiresIn?, idToken?, tokenType?, scope?, raw }`.

| Builder (fresh instance per `OAuth.driver()` call) | |
|---|---|
| `.scopes(s \| s[])` / `.setScopes(s \| s[])` / `.getScopes()` | Add to (deduped) / replace / read scopes |
| `.with({ prompt: 'consent' })` | Extra authorize params (override `parameters`) |
| `.redirectUrl(url)` | Other callback URL; stored in the state, so the callback reuses it |
| `.stateless(value = true)` | No state, PKCE or nonce |
| `await .redirect(ctx)` | 302 to the provider (sets the state cookie) |
| `await .authorizationUrl(ctx)` | URL only (SPA: return `{ url }` as JSON; the browser must keep the `Set-Cookie`) |
| `await .user(ctx)` | Callback: provider `error` → `OAuthException` (code = vendor error); check state; exchange code; fetch profile |
| `await .userFromToken(token \| { accessToken, … }, extra?)` | Mobile SDK tokens; WeChat/QQ need `{ openid }`; Apple takes the `identityToken` |
| `await .refreshToken(rt)` | New `OAuthToken` (standard OAuth2, WeChat, QQ, DingTalk, Feishu, Alipay) |

Facade: `OAuth.enabled(name)`, `OAuth.providers()` (enabled names, e.g. login buttons), `OAuth.build(driver, config, globalOptions?)` (runtime config, e.g. per tenant; skips `config/oauth.ts`). Package exports: `oauthDrivers()`, `verifyIdToken(token, { jwksUri, issuer, audience, nonce?, algorithms?, clockTolerance? (60), fetch? })`, `codeChallenge()`, `signClientSecret()`, `clearJwksCache()`, `clearDiscoveryCache()`.

**State, PKCE, nonce.** `redirect()` stores `{ state, verifier?, nonce?, redirectUri, exp }`; the callback reads it **once** (cookie deleted / session key pulled), compares `state` in constant time, sends the verifier and checks the OIDC nonce inside the verified `id_token` (`iss`, `aud`, `exp`, JWKS signature). State cookie: `HttpOnly; SameSite=Lax`; Apple's is `SameSite=None; Secure` (cross-site `form_post`). Missing/expired/tampered/reused → `InvalidStateException`.

Account linking (recommended over email matching):

```ts
// app/controller/OAuthController.ts (callback)
const profile = await OAuth.driver(ctx.param('provider')!).user(ctx)
const link = await SocialAccount.where('provider', profile.provider).where('providerId', profile.id).find()
let user = link ? await User.find(link.userId) : undefined
if (!user) {
  const current = await ctx.auth.user() // "connect account": works with session / cookie-JWT guards (a redirect carries no Bearer header)
  user = current ?? await User.create({ name: profile.name ?? profile.nickname ?? 'User', email: profile.email })
  await SocialAccount.create({ userId: user.id, provider: profile.provider, providerId: profile.id })
}
return ctx.auth.jwt().login(user)
```

(`SocialAccount` / `social_accounts` is your own model and table, not shipped by hazejs. Only trust `profile.email` from providers that verify it.)

Custom provider (standard auth-code flow):

```ts
// app/provider/OAuthProvider.ts
import { defineProvider } from '@hazejs/core'
import { defineOAuthProvider, registerOAuthProvider } from '@hazejs/oauth'

const Gitea = defineOAuthProvider<{ clientId: string, clientSecret: string, redirect: string, baseUrl: string }>({
  endpoints: config => ({ // authorize + token required; user = Bearer GET unless fetchUser is given
    authorize: `${config.baseUrl}/login/oauth/authorize`,
    token: `${config.baseUrl}/login/oauth/access_token`,
    user: `${config.baseUrl}/api/v1/user`,
  }),
  scopes: ['read:user'], // also: scopeSeparator (' '), pkce (default true), fetchUser(token, { config, http })
  mapUser: raw => ({ id: raw.id, name: raw.full_name, nickname: raw.login, email: raw.email, avatar: raw.avatar_url }),
})

export default defineProvider({
  register() {
    registerOAuthProvider('gitea', Gitea) // then driver: 'gitea'; or pass driver: Gitea directly
  },
})
```

Non-standard flows: `class X extends OAuthProvider` (or `OidcProvider`) overriding `defaultEndpoints()`, `authorizeParams()`, `exchangeCode()`, `fetchUser()`, `mapUser()` (protected fields `defaultScopes`, `scopeSeparator`, `supportsPkce`, `usesNonce`, `codeParam`); `registerOAuthProvider(name, Class)` also accepts the class and can override a built-in name.

| Error | Status | When |
|---|---|---|
| `InvalidStateException` | 400, `code: 'invalid_state'` | State missing / expired / tampered / reused (often: cookie not sent back) |
| `OAuthException` | 400 | User denied (`access_denied`), bad/used code (`invalid_grant`, WeChat `40029`), `missing_code`, vendor error; `.provider` = name |
| `OAuthException` | 502 | Provider unreachable (`provider_unreachable`), 5xx, bad Alipay signature |
| `NotFoundException` | 404 | `OAuth.driver(name)` unknown or disabled |

Testing: `createApplication({ mode: 'test', config: { oauth: { fetch: fakeFetch, providers: { github: { clientId: 'id', clientSecret: 'secret', redirect: '/auth/github/callback' } } } } })` where `fakeFetch` answers by `new URL(String(input)).pathname` (e.g. `/login/oauth/access_token` → `Response.json({ access_token: 'test-token', token_type: 'bearer' })`, `/user` → profile JSON). Then `GET /auth/github`, read `state` from `Location`, keep `Set-Cookie`, and call `/auth/github/callback?code=x&state=…` with that cookie. Or skip the redirect flow: `OAuth.driver('github').stateless()`, or test `userFromToken()`.

## Security hardening

Built-in middleware are enabled by name in `config/middleware.ts` (`defineMiddlewareConfig({ global: ['cors', 'secureHeaders', 'compress', 'csrf'], alias: {} })`; `csrf` only for cookie-authenticated apps) and read options from `config/<name>.ts` (`cors`, `csrf`, `session`, `throttle`, `secureHeaders`).

### `APP_KEY`, cookies, encryption

- `APP_KEY` (≥ 32 chars; checked lazily — the first signing/encryption throws, not boot) signs cookies (HMAC-SHA256), encrypts `cookie` sessions (AES-GCM, HKDF-derived key), signs session ids for other drivers, signed route URLs and storage temp URLs, is the default `HS*` JWT secret, encrypts 2FA secrets and seals OAuth state. `haze key:generate [--force|--show]`; or `key` in `config/app.ts`; Workers: `wrangler secret put APP_KEY`.
- Rotation: keep old keys in `APP_PREVIOUS_KEYS` (comma-separated) or `previousKeys` in `config/app.ts`; they are only used to decrypt (`Crypt`) and verify signed URLs. Sessions, JWTs and signed cookies issued with the old key still die.
- Cookie defaults: `httpOnly`, `SameSite=Lax`, path `/`, `Secure` when `app.debug` is off; override with `cookie: { sameSite: 'strict', domain: '.example.com' }` in `config/app.ts`. `ctx.setSignedCookie(name, value)` / `await ctx.signedCookie(name)` (tamper-proof, readable by the client).
- `Crypt.encrypt(value)` / `decrypt<T>(payload)` (JSON) and `encryptString` / `decryptString`: AES-256-GCM, random IV, URL-safe `v1.<base64url>` payload; tampered/foreign → `DecryptException`. Custom key: `new Encrypter(key, previousKeys)`. Helpers: `generateKey()`, `appKey(config?)`, `previousAppKeys(config?)`.

### Password hashing (`Hash`)

```ts
const hash = await Hash.make(password)             // $scrypt$n=16384,r=8,p=1$<salt>$<key>
await Hash.verify(hash, password)                  // constant-time; unknown format → false
if (Hash.needsRehash(user.password))               // params differ from current defaults
  await user.fill({ password: await Hash.make(password) }).save() // do this right after a successful login
```

`HashOptions` (per call; there is no global hash config): `algorithm: 'scrypt' | 'pbkdf2'` (default `'scrypt'`; falls back to PBKDF2-SHA256 when `node:crypto` is unavailable), `cost` (scrypt N, `16384`), `iterations` (PBKDF2, `600000`). Pass the same options to `make` and `needsRehash`. `modelUserProvider` verifies but never rehashes automatically.

### Sessions

`defineSessionConfig({ driver: 'cookie', lifetime: '2h' })`. The session guard, `csrf`, `TwoFactor.attempt` and passkey `session` challenges start the session themselves; elsewhere add the `session` middleware or `await ctx.startSession()` (else `ctx.session` throws).

| Option | Default | |
|---|---|---|
| `driver` | `'cookie'` | `'cookie'` (encrypted in the cookie, ~4 KB, oversize throws), `'memory'` (single process), `'cache'` (shared, e.g. Redis), or a `SessionStore` `{ get(id), set(id, data, ttlSeconds), destroy(id) }` |
| `store` | default cache store | With `driver: 'cache'` |
| `cookie` | `'haze_session'` | Cookie name |
| `lifetime` | `'2h'` | Duration or seconds |
| `cookieOptions` | | Overrides cookie defaults |

`ctx.session`: `get(key, fallback?)`, `has`, `all`, `set`, `forget`, `pull`, `flash`, `flush` (keep id), `regenerate()` (new id, keep data — after login/privilege change), `invalidate()` (clear + new id — logout). Written back only when changed; a new empty session sets no cookie. Each session guard stores its user under `auth.<guardName>`.

### CSRF (`csrf`)

Required whenever auth rides on cookies (session guard, JWT `cookie`, passkey/2FA session flows).

- Token lives in the session (`_csrf`), mirrored to a readable (non-`HttpOnly`) `XSRF-TOKEN` cookie; unsafe methods must echo it in `X-XSRF-TOKEN` / `X-CSRF-TOKEN` or a `_token` field (urlencoded/multipart). Mismatch → `419 CsrfTokenMismatchException`.
- Skipped for `GET/HEAD/OPTIONS/TRACE`, any `Authorization: Bearer …` request, `except` paths (`*` wildcard), and `mode: 'test'` unless `testing: true`.
- Session-guard `login()`/`logout()` rotate the token. Server-rendered forms: `await ctx.csrfToken()` in a hidden `_token`. Low level: `csrfToken(ctx)`, `regenerateCsrfToken(session)`.

```ts
// config/csrf.ts
import { defineCsrfConfig } from '@hazejs/core'

export default defineCsrfConfig({
  except: ['/api/webhooks/*', '/api/auth/apple/callback'], // provider/webhook POSTs can't send the token
  // cookie: 'XSRF-TOKEN',  // false = don't send the cookie
  // testing: true,         // also verify in tests
})
```

### CORS (`cors`, must be global — preflights match no route)

| Option (h3 `CorsOptions`) | Default | |
|---|---|---|
| `origin` | `'*'` | `'*'`, `(string \| RegExp)[]` (strings exact; **anchor** regexes `/^https:\/\/app\.example\.com$/`), or `(origin) => boolean` |
| `methods` / `allowHeaders` / `exposeHeaders` | `'*'` | `'*'` or `string[]` |
| `credentials` | `false` | Cookies cross-origin; needs explicit origins, not `'*'` |
| `maxAge` | `false` | Preflight cache seconds as a **string** (`'600'`) |
| `preflight` | | `{ statusCode }` |

Cross-origin SPA with cookie auth: `defineCorsConfig(() => ({ origin: env('CORS_ORIGIN', 'http://localhost:5173').split(',').map(o => o.trim()), credentials: true }))` in `config/cors.ts`.

### Security headers (`secureHeaders`)

| Option | Default | Sent when |
|---|---|---|
| `contentSecurityPolicy` | off | set |
| `strictTransportSecurity` | `'max-age=15552000; includeSubDomains'` | HTTPS and `app.debug` off |
| `frameOptions` | `'SAMEORIGIN'` | always (`'DENY' \| 'SAMEORIGIN' \| false`) |
| `referrerPolicy` | `'no-referrer'` | always |
| `crossOriginOpenerPolicy` | `'same-origin'` | HTTPS only (with `Origin-Agent-Cluster: ?1`) |
| `crossOriginResourcePolicy` | `'same-origin'` | always |
| `permissionsPolicy` | off | set |
| `headers` | | Extra headers, merged last (can override the fixed ones below; `''` drops one) |

Always set: `X-Content-Type-Options: nosniff`, `X-DNS-Prefetch-Control: off`, `X-Download-Options: noopen`, `X-Permitted-Cross-Domain-Policies: none`, `X-XSS-Protection: 0`. String overrides a value, `false` drops the header. Example: `defineSecureHeadersConfig({ contentSecurityPolicy: "default-src 'self'", frameOptions: 'DENY' })` in `config/secureHeaders.ts`. Global `secureHeaders`/`cors` also apply to the served frontend build (`static`): a strict CSP can break the SPA.

### Rate limiting (`throttle`)

`throttle` = 60 / 60 s; `throttle:<max>,<seconds>` inline; `throttle:<name>` → `limiters` in `config/throttle.ts` (unknown name throws). Key: `user:<id>` on the default guard when `config/auth.ts` exists, else `ip:<ctx.ip>`; the counter is also scoped by the spec string. Headers `RateLimit-Limit/Remaining/Reset`; over → `429` + `Retry-After`.

```ts
// config/throttle.ts
import { defineThrottleConfig, env } from '@hazejs/core'

export default defineThrottleConfig(() => ({
  store: env('CACHE_STORE', 'memory'), // cache store name (shared: redis), or a RateLimitStore; omitted = process memory
  limiters: {
    api: { max: 60, window: '1m' },
    login: { max: 5, window: '1m', key: ctx => `ip:${ctx.ip}` }, // per IP even for logged-in users
    edge: { max: 60, window: '1m', binding: 'API_RATE_LIMITER' }, // Cloudflare Rate Limiting binding; falls back to store locally
  },
}))
```

Non-atomic cache stores log a warning (approximate counts). `RateLimitStore`: `{ hit(key, windowSeconds) → { count, resetAt }, reset(key) }`; helpers `memoryRateLimitStore()`, `cacheRateLimitStore(cache)`.

### Proxies, body limit, signed URLs

- `trustProxy` (`boolean | number`, `config/app.ts`, default `false`): `true` = one trusted hop → `ctx.ip` is the **rightmost** `X-Forwarded-For` entry (rate-limit keys), `n` = the nth from the right; `X-Forwarded-Proto`/`-Host` (HSTS/COOP) honoured whenever truthy. Only behind a proxy clients cannot bypass, or they spoof both. Cloudflare Workers (`cf-connecting-ip`) and AWS Lambda (`sourceIp`) set the client address in the entry, so `ctx.ip` works there without it; Vercel/Netlify need `true`.
- Body limit `1mb` (`bodyLimit` in `config/app.ts`); per route `bodyLimit:10mb`; oversize → `413`.
- Signed links (`const router = inject(Router)`): `await router.signedUrl(name, params, { expiresIn?, expiresAt?, query?, absolute? })`, `router.temporarySignedUrl(name, '30m', params)`; verify with the `signed` middleware (`signed:utm_source` ignores params; invalid/expired → `403 InvalidSignatureException`) or `await ctx.hasValidSignature({ ignore })`.

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
- **`TwoFactor.attempt/challenge` and `Passkeys.login` use `ctx.auth.session(guard)`**: when the default guard is `jwt`, pass `{ guard: 'web' }` to `attempt()` / `login()` or they throw `TypeError`. `challenge()` reuses the guard recorded by `attempt()`.
- **`TwoFactor.disable()` and `enable(user, { force: true })` check nothing.** Require the password or a current code (`TwoFactor.verify`) in your controller first, or a hijacked session can turn 2FA off.
- **`TwoFactor.verify()` consumes the time step.** Calling it twice with the same code (e.g. once in a check endpoint, once at login) fails the second time; it also returns `false` for unconfirmed users (use `confirm()` during setup).
- **Rotating `APP_KEY` without `APP_PREVIOUS_KEYS` bricks 2FA**: secrets are `Crypt`-encrypted and can no longer be decrypted (`DecryptException`). Previous keys only help `Crypt` and signed URLs; sessions, JWTs and signed cookies still end.
- **Passkey `rpID`/`origin` must match what the browser shows.** Defaults come from `APP_URL`, else the request URL — behind a proxy or a Vite dev server on another port, set `APP_URL` (or `rpID` + `origin`). Non-`localhost` hosts need HTTPS.
- **OAuth `scopes` in config replace the driver defaults**; `.scopes()` on the builder adds. Dropping e.g. `user:email` (GitHub) or `email` (OIDC) silently gives `email: null`.
- **OAuth SPA flow**: fetch `authorizationUrl()` with `credentials: 'include'` so the state cookie is stored, and keep the callback on the API's origin (the cookie is host-bound). Otherwise every callback fails with `invalid_state`.
- **CSRF is not checked in tests** (`mode: 'test'`) unless `defineCsrfConfig({ testing: true })`; a missing `X-XSRF-TOKEN` in the frontend only shows up in dev/prod as `419`.
- **`cors` with `credentials: true` needs explicit origins**, and must be global. Unanchored regex origins match look-alike domains.
- **HSTS / COOP are absent over plain HTTP and HSTS also in debug** — expected in dev. Behind TLS-terminating proxies set `trustProxy: true` or they are never sent.
- **Default throttle and `memory` session stores are per process.** With several instances use a shared cache store (`throttle.store: 'redis'`, `session: { driver: 'cache', store: 'redis' }`).

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

