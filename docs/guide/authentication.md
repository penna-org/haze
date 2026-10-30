# Authentication

Authentication in hazejs is split into two parts, both configured in `config/auth.ts`:

- **Guards** decide *how* a request is authenticated: a `jwt` guard reads `Authorization: Bearer <token>`, a `session` guard reads the session cookie, and a `token` guard checks revocable [personal access tokens](./api-tokens).
- **Providers** decide *where users come from*: usually a model, but any object implementing `UserProvider` works.

The api template ships with a JWT guard, a `User` model with a hashed `password` column, and a working register / login / me flow, plus API tokens, [email verification](#email-verification), [password reset](#password-reset) and GitHub login. [Two-factor authentication and passkeys](./two-factor) are available too.

## Configuration

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
    // Same-origin browser apps can add a session guard:
    // web: { driver: 'session', provider: 'users' },
  },
  providers: {
    users: modelUserProvider(() => User, { username: 'email', password: 'password' }),
  },
}))
```

`default` is the guard used when you don't name one. Each guard points at a provider by name.

## User providers

`modelUserProvider(() => User, options)` from `@hazejs/orm` looks users up through a model. The model is passed as a function to avoid circular imports between the config file and the model.

| Option | Default | Description |
|--------|---------|-------------|
| `username` | `'email'` | Login field(s). An array is allowed; every field present in the credentials is matched |
| `password` | `'password'` | Column holding the hash from `Hash.make()`. The credential with the same name is the plain-text password |

To load users from somewhere else (a remote service, LDAP, …), implement the `UserProvider` interface with `defineUserProvider`:

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

`getId()` is what ends up in the session or in the JWT `sub` claim.

## Hashing passwords

`Hash` uses scrypt by default and falls back to PBKDF2-SHA256 (Web Crypto) where scrypt is unavailable. The hash string records its algorithm and parameters, so verification keeps working when you change settings:

```ts
import { Hash } from '@hazejs/core'

const hash = await Hash.make('correct horse')         // $scrypt$n=16384,r=8,p=1$…
await Hash.verify(hash, 'correct horse')              // true
Hash.needsRehash(hash)                                // true if the parameters are outdated
await Hash.make('correct horse', { algorithm: 'pbkdf2' })
```

## Logging in with JWT

The template's `AuthController` shows the whole flow:

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

`login(user, claims?)` and `attempt(credentials, claims?)` return an `IssuedToken`:

```json
{ "token": "eyJ…", "type": "Bearer", "expiresIn": 7200, "expiresAt": "…" }
```

Clients send it back as `Authorization: Bearer <token>`. `attempt()` returns `undefined` when the credentials are wrong.

### JWT options

| Option | Default | Description |
|--------|---------|-------------|
| `algorithm` | `'HS256'` | `HS256/384/512`, `RS256/384/512`, `PS256`, `ES256/384/512` or `EdDSA` |
| `secret` | `APP_KEY` | Secret for `HS*` algorithms |
| `privateKey` / `publicKey` | | PEM keys (PKCS#8 / SPKI) for the asymmetric algorithms |
| `expiresIn` | `'2h'` | Token lifetime, as a duration string or seconds; a function `(ctx) => …` is evaluated on every login (for lifetimes stored in runtime settings). `login(user, claims, { expiresIn })` overrides it for one token |
| `issuer` / `audience` | | Set on issued tokens and checked on incoming ones |
| `cookie` | | Also read the token from this cookie (browser use) |
| `resolveUser` | | `(payload, ctx) => user`: resolves the user from the verified claims instead of `provider.retrieveById(sub)` — see below |
| `rejectClaims` | | Tokens carrying any of these claims cannot authenticate, e.g. `['purpose']` for password-reset tickets signed with the same secret |

Tokens carry `sub` (the user id), `iat`, `exp` and a random `jti`, plus any custom claims. Read them with `await ctx.auth.jwt().payload()`. Expired, tampered or malformed tokens are treated as "not logged in".

### Resolving the user yourself

JWTs are stateless. When logout, kicking a device or disabling an account must take effect immediately, put a session id in the token and check it on every request with `resolveUser`. It receives the verified claims and the request context, so it can also read headers such as the current organisation. Return the user, or `undefined` for "not logged in"; an `HttpException` it throws becomes the response as-is, so clients can tell a revoked session or a forbidden organisation apart from a missing login:

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
      throw new UnauthorizedException('Session expired', { code: 'session_invalid' })
    return User.findOrFail(payload.sub)
  },
},
```

```ts
// issue a token for a session
const token = await ctx.auth.jwt().login(user, { sid: session.id })
```

::: warning JWT logout is stateless
`ctx.auth.jwt().logout()` only forgets the user for the current request; the token stays valid until it expires. Keep lifetimes short, or maintain a deny list (for example by `jti`) if you need immediate revocation.
:::

## Session login

For same-origin browser apps, a session guard keeps the user id in the session:

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

`login(user)` regenerates the session id (preventing session fixation) and rotates the CSRF token; `logout()` invalidates the session. The session is started automatically, so you don't need the `session` middleware for this. Cookie-based auth should be paired with the `csrf` middleware; see [Sessions, CSRF & More](./security#csrf-protection).

## Protecting routes

| Middleware | Behavior |
|------------|----------|
| `auth` | Requires a user on the default guard, otherwise `401` |
| `auth:api` | Uses a specific guard |
| `auth:web,api` | Passes if **any** listed guard authenticates; that guard becomes the default for the rest of the request |
| `auth:optional` / `auth:api,optional` | Never rejects: recognises the user when the credentials are valid, otherwise continues as a guest (public routes that still care who is calling) |
| `guest` / `guest:web` | Rejects already-authenticated users with `403` (useful for login and register routes) |
| `verified` | Requires a verified email: `401` when not logged in, `403` when unverified (see [Email verification](#email-verification)) |
| `abilities:a,b` / `ability:a,b` | The [API token](./api-tokens#abilities) must have all / any of the abilities |

```ts
// route/api.ts
r.get('/me', [AuthController, 'me']).middleware('auth')
r.group({ prefix: '/account', middleware: ['auth:web,api'] }, (r) => {
  r.get('/', [AccountController, 'show'])
})
```

A rejected request gets `401` with `code: 'unauthenticated'` when no credentials were sent and `code: 'token_invalid'` when they were expired, tampered with or rejected — clients use it to decide between logging in again and refreshing the token.

## The `ctx.auth` API

| Method | Description |
|--------|-------------|
| `user()` | Current user or `undefined` (cached for the request) |
| `check()` | Whether a user is authenticated |
| `id()` | Current user id |
| `logout()` | Log out from the default guard |
| `guard(name?)` | A guard by name; also has `user()`, `check()`, `id()`, `validate(credentials)` and `logout()` |
| `jwt(name?)` | A JWT guard with `login()`, `attempt()` and `payload()`; throws if the guard is not `jwt` |
| `session(name?)` | A session guard with `login()`, `attempt()` and `logout()` |
| `token(name?)` | A token guard with `createToken()`, `tokens()` and `currentAccessToken()` (see [API Tokens](./api-tokens)) |
| `tokenCan(ability)` | Whether the request may use an ability: checks the token for token guards, `true` for jwt / session users, `false` for guests |
| `currentAccessToken()` | The personal access token used for this request, if any |
| `defaultGuard` | Name of the guard in use for this request |

`guard(name).validate(credentials)` checks credentials and returns the user without logging in.

The user type is inferred from the providers in `config/auth.ts` once typegen has run (`haze dev` does it automatically), so in the template `await ctx.auth.user()` is typed as `User | undefined`.

## Email verification

Verification links are [signed URLs](./routing#signed-urls): they carry an expiry and an HMAC signature keyed with `APP_KEY`, so nothing has to be stored. The link points at `<path>/<id>/<hash>`, where `hash` is a SHA-256 digest of the user's email, so a link stops working if the email changes.

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

| Option | Default | Description |
|--------|---------|-------------|
| `provider` | default guard's provider | Where users come from |
| `route` | | Name of the verify route (parameters `id` and `hash`). Use the **full** name, including group prefixes |
| `path` | `'/email/verify'` | Used when `route` is not set: the link is `<path>/<id>/<hash>?expires=…&signature=…` |
| `expire` | `'60m'` | Link lifetime |
| `email` | `'email'` | Email field |
| `field` | `'emailVerifiedAt'` | Field that records the verification time |
| `url` | | `(link, user) => string`: rewrite the link in the email, e.g. to a frontend page that forwards the parameters to the API |
| `mail` | `VerifyEmailMail` | Replace the built-in mail. It receives `{ appName, name, url, expiresInMinutes }` |
| `queue` | `false` | Send through the queue |

Set `APP_URL` so the links in emails are absolute; without it they are site-relative paths.

The users table needs a nullable timestamp for `field`. In the templates it is `emailVerifiedAt` (`email_verified_at`) in `database/schema/users.ts`.

### Sending and verifying

```ts
import { hasVerifiedEmail, sendEmailVerification, verifyEmail } from '@hazejs/core'

export class VerificationController {
  /** Resend the link (logged in) */
  async send(ctx: HttpContext) {
    const user = await ctx.auth.user()
    if (hasVerifiedEmail(user))
      return { status: 'verified' }
    await sendEmailVerification(user)
    return { status: 'sent' }
  }

  /** The link from the email */
  async verify(ctx: HttpContext) {
    const { verified } = await verifyEmail(ctx)
    return { status: verified ? 'verified' : 'already-verified' }
  }
}
```

```ts
// route/api.ts (inside the api. / auth. groups)
r.post('/email/verification-notification', [VerificationController, 'send']).middleware(['auth', 'throttle:6,60']).name('verification.send')
r.get('/email/verify/:id/:hash', [VerificationController, 'verify']).middleware('throttle:6,60').name('verification.verify')
```

- `sendEmailVerification(user)` mails the link and returns `false` (without sending) when the user is already verified. Call it after registration; the templates do so in `AuthController.register`.
- `verificationUrl(user)` returns `{ url, id, hash, expires, signature }` if you deliver the link some other way.
- `verifyEmail(ctx)` checks the signature and expiry (`403`), loads the user (`404` when missing), compares the email hash (`403`), and, if someone is logged in, requires it to be the same user (`403`). It then marks the user as verified and returns `{ user, verified }`; `verified` is `false` when the email was already verified. The link works without being logged in, so it can be opened from a mail client.
- `markEmailAsVerified(user)` sets `field` to now and calls `user.save()` when the object has one (ORM models do). It emits `EmailVerified` with `{ user, id }`.
- `hasVerifiedEmail(user)` reads `field`.

The `verified` middleware guards routes that require a verified email. It returns `401` when nobody is logged in and `403` when the email is not verified:

```ts
r.post('/orders', [OrderController, 'store']).middleware(['auth', 'verified'])
```

## Password reset

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

| Option | Default | Description |
|--------|---------|-------------|
| `provider` | default guard's provider | Where users come from (looked up by email) |
| `store` | in memory | A `PasswordResetStore`, or the name of a store in `config/cache.ts` (tokens then expire in the cache) |
| `expire` | `'60m'` | Token lifetime |
| `throttle` | `'60s'` | Minimum time between two links for the same email (`0` disables) |
| `email` / `password` | `'email'` / `'password'` | User fields |
| `path` | `'/reset-password'` | Page in your frontend; the link is `<APP_URL><path>?token=…&email=…` |
| `url` | | `({ token, email, user }) => string` for full control over the link |
| `mail` | `ResetPasswordMail` | Replace the built-in mail. It receives `{ appName, name, url, expiresInMinutes }` |
| `queue` | `false` | Send through the queue |

There is one token per email; a new link replaces the previous one. Only the SHA-256 hash of the token is stored. Besides `databasePasswordResetStore()`, `cachePasswordResetStore(storeName?)` and `memoryPasswordResetStore()` are available.

```ts
import { PasswordReset, validate, ValidationException } from '@hazejs/core'

export class PasswordResetController {
  async forgot(ctx: HttpContext) {
    const { email } = await validate(ForgotPasswordSchema, await ctx.body())
    const status = await PasswordReset.sendLink(email)
    // Same answer whether or not the email exists
    return { status: status === 'throttled' ? 'throttled' : 'sent' }
  }

  async reset(ctx: HttpContext) {
    const status = await PasswordReset.reset(await validate(ResetPasswordSchema, await ctx.body()))
    if (status !== 'reset')
      throw new ValidationException([{ target: 'body', path: 'token', message: 'This link is invalid or has expired' }])
    return { status }
  }
}
```

- `PasswordReset.sendLink(email)` returns `'sent'`, `'throttled'` or `'invalid-user'`. Don't reveal `'invalid-user'` to clients, or the endpoint can be used to find out which emails are registered.
- `PasswordReset.reset({ email, token, password }, callback?)` returns `'reset'`, `'invalid-token'` (wrong, expired or already used) or `'invalid-user'`. By default it stores `Hash.make(password)` in the password field and saves the user. Pass a callback to do more, such as revoking API tokens:

```ts
await PasswordReset.reset<User>(input, async (user, password) => {
  user.password = await Hash.make(password)
  await user.save()
  await PersonalAccessTokens.revokeAll(user)
})
```

The token is deleted after a successful reset. `PasswordResetLinkSent` and `PasswordResetCompleted` are emitted with `{ user, id, email }`. For custom flows there are `PasswordReset.createToken(user)`, `tokenExists(user, token)` and `deleteToken(user)`.

Rate-limit both endpoints (`throttle:6,60` in the templates).

## Ready-made routes

To get started quickly, `authRoutes()` registers the verification, password reset and [API token](./api-tokens) endpoints with built-in validation:

```ts
// route/api.ts
import { authRoutes, defineRoutes } from '@hazejs/core'

export default defineRoutes((r) => {
  r.group({ prefix: '/api/auth', as: 'auth.' }, (r) => {
    authRoutes(r, { verification: true, passwordReset: true, tokens: true })
  })
})
```

| Option | Routes |
|--------|--------|
| `verification` | `POST /email/verification-notification` (`verification.send`, needs login), `GET /email/verify/:id/:hash` (`verification.verify`) |
| `passwordReset` | `POST /forgot-password` (`password.email`), `POST /reset-password` (`password.update`) |
| `tokens` | `GET /tokens`, `POST /tokens`, `DELETE /tokens/:id` (`tokens.*`, need login); `{ abilities }` limits what can be requested |
| `auth` | Middleware for the routes that need login, default `['auth']` |
| `throttle` | Rate limit for the other routes, default `'throttle:6,60'`; `false` disables it |
| `minPasswordLength` | Minimum new password length, default `8` |

Route names get the group's `as` prefix, so with the example above set `verification.route` to `'auth.verification.verify'`. Write your own controllers when you need different responses or validation, as the templates do.

## In the templates

The api, vue and react templates include the whole flow:

- `app/controller/TokenController.ts`: `GET/POST /api/auth/tokens`, `DELETE /api/auth/tokens/:id`;
- `app/controller/VerificationController.ts`: `POST /api/auth/email/verification-notification`, `GET /api/auth/email/verify/:id/:hash`; registering sends the verification mail;
- `app/controller/PasswordResetController.ts`: `POST /api/auth/forgot-password`, `POST /api/auth/reset-password`;
- `app/controller/OAuthController.ts`: GitHub login at `/api/auth/github`, disabled until `GITHUB_CLIENT_ID` is set (see [OAuth Social Login](./oauth));
- `database/schema/auth.ts` (tokens and reset tokens) plus `users.emailVerifiedAt`, created by the migration `0003_add_auth_tables`.

For TOTP and passkeys see [Two-Factor Authentication & Passkeys](./two-factor).

## Testing

`actingAs()` from `@hazejs/testing` returns a client that is already logged in. It issues a real token for JWT guards and a real session cookie for session guards:

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

Pass a guard name as the second argument to log in through a different guard: `t.actingAs(user, 'web')`; with a token guard it issues a real personal access token (`t.actingAs(user, 'token')`). Outside `@hazejs/testing`, `issueTestCredentials(app, user, guard?)` from `@hazejs/core` returns the same credentials as request headers (`authorization` or `cookie`). More in [Testing](./testing).
