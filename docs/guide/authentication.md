# Authentication

Authentication in hazejs is split into two parts, both configured in `config/auth.ts`:

- **Guards** decide *how* a request is authenticated: a `jwt` guard reads `Authorization: Bearer <token>`, a `session` guard reads the session cookie.
- **Providers** decide *where users come from*: usually a model, but any object implementing `UserProvider` works.

The api template ships with a JWT guard, a `User` model with a hashed `password` column, and a working register / login / me flow.

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
| `expiresIn` | `'2h'` | Token lifetime, as a duration string or seconds |
| `issuer` / `audience` | | Set on issued tokens and checked on incoming ones |
| `cookie` | | Also read the token from this cookie (browser use) |

Tokens carry `sub` (the user id), `iat`, `exp` and a random `jti`, plus any custom claims. Read them with `await ctx.auth.jwt().payload()`. Expired, tampered or malformed tokens are treated as "not logged in".

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
| `guest` / `guest:web` | Rejects already-authenticated users with `403` (useful for login and register routes) |

```ts
// route/api.ts
r.get('/me', [AuthController, 'me']).middleware('auth')
r.group({ prefix: '/account', middleware: ['auth:web,api'] }, (r) => {
  r.get('/', [AccountController, 'show'])
})
```

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
| `defaultGuard` | Name of the guard in use for this request |

`guard(name).validate(credentials)` checks credentials and returns the user without logging in.

The user type is inferred from the providers in `config/auth.ts` once typegen has run (`haze dev` does it automatically), so in the template `await ctx.auth.user()` is typed as `User | undefined`.

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

Pass a guard name as the second argument to log in through a different guard: `t.actingAs(user, 'web')`. Outside `@hazejs/testing`, `issueTestCredentials(app, user, guard?)` from `@hazejs/core` returns the same credentials as request headers (`authorization` or `cookie`). More in [Testing](./testing).
