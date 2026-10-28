# API Tokens

Personal access tokens are long-lived tokens that users create for scripts, CLIs and third-party integrations, in the spirit of Laravel Sanctum. Unlike a JWT they live on the server, so they can be listed and revoked at any time, and each token carries a list of **abilities**.

- The plain-text token looks like `12|haze_9qL…` (`<id>|<secret>`) and is shown **once**, when it is created.
- Only the SHA-256 hash of the secret is stored. A leaked database does not leak usable tokens.
- Requests send it as `Authorization: Bearer <token>`.

## Configuration

Add a guard with `driver: 'token'` to `config/auth.ts`:

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

| Option | Default | Description |
|--------|---------|-------------|
| `provider` | | User provider name, as for the other guards |
| `store` | in-memory store | Where tokens are kept: `databaseTokenStore()` from `@hazejs/orm`, or any `TokenStore` |
| `type` | provider name | Value written to `tokenable_type`. Lets several kinds of users share one table |
| `expiresIn` | never | Default lifetime of new tokens, e.g. `'30d'` |
| `prefix` | | Prefix for the secret, e.g. `'haze_'`, so secret scanners (GitHub, GitLab) can recognize leaked tokens |

::: warning The default store is in memory
Without `store`, tokens live in the process (`memoryTokenStore()`) and are lost on restart. That is fine for tests; use the database store in real apps.
:::

## Database table

`haze make:auth-tables` writes `database/schema/auth.ts` with four tables: `personal_access_tokens`, `password_reset_tokens`, `two_factor_secrets` and `webauthn_credentials`. Delete the ones you don't need, then generate and run the migration:

```bash
haze make:auth-tables                     # dialect inferred from the installed driver
haze make:auth-tables --dialect postgres  # sqlite | postgres | mysql
haze db:generate && haze db:migrate
```

`--force` overwrites an existing file. You may rename the SQL columns, but keep the JS property names (`tokenableType`, `abilities`, `lastUsedAt`, …): the `database*Store()` helpers read them.

## Issuing tokens

Inside a request, use the token guard:

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
    // accessToken.token is the hash: don't return it
    return ctx.created({ token: plainTextToken, id: accessToken.id })
  }
}
```

`ctx.auth.token(name?)` returns the named token guard, or the default guard when it is a token guard, or the first token guard in the config. The user can be logged in with any guard (the template creates tokens for users logged in with JWT).

Options for `createToken(user, name, options?)`:

| Option | Default | Description |
|--------|---------|-------------|
| `abilities` | `['*']` | What the token may do |
| `expiresIn` | guard's `expiresIn` | Lifetime, e.g. `'30d'` |
| `expiresAt` | | Exact expiry (`Date`), or `null` for no expiry. Takes precedence over `expiresIn` |

Outside a request (seeders, commands, queue jobs), use the `PersonalAccessTokens` facade. It uses the first token guard unless you pass `guard`:

```ts
import { createAccessToken, PersonalAccessTokens } from '@hazejs/core'

const { plainTextToken } = await PersonalAccessTokens.create(user, 'cli', { abilities: ['posts:read'] })
await createAccessToken(user, 'cli')            // shortcut for PersonalAccessTokens.create

await PersonalAccessTokens.list(user)           // PersonalAccessToken[] (hashes, never plain text)
await PersonalAccessTokens.revoke(id, user)     // false if the token belongs to someone else
await PersonalAccessTokens.revokeAll(user)      // number of revoked tokens
await PersonalAccessTokens.find(plainTextToken) // the record if the token is valid and not expired
```

The shortcut is called `createAccessToken()` rather than `createToken()` because `createToken()` is already exported by `@hazejs/core` for [dependency injection tokens](./container).

The guard exposes the same operations: `ctx.auth.token().tokens()` returns a `TokenRepository` with `create`, `list`, `revoke`, `revokeAll` and `find`.

## Authenticating requests

Protect routes with the token guard, or accept either a JWT or a token:

```ts
// route/api.ts
r.get('/me', [AuthController, 'me']).middleware('auth:api,token')
r.post('/posts', [PostController, 'store']).middleware(['auth:token', 'abilities:posts:write'])
```

A token is rejected (treated as "not logged in") when the secret does not match, the token was revoked, it has expired, or its `tokenable_type` belongs to another guard. On success the guard updates `last_used_at`, at most once a minute per token to avoid a write on every request.

`ctx.auth.currentAccessToken()` returns the token record used for this request (or `undefined` when the request was not authenticated with a token).

Logging out through a token guard **revokes** the token used for the request:

```ts
await ctx.auth.logout() // when the token guard is the active guard
```

## Abilities

Abilities are plain strings. `*` grants everything, and a trailing `:*` matches a prefix: `posts:*` matches `posts:read` and `posts:write`.

```ts
if (await ctx.auth.tokenCan('posts:write')) {
  // …
}
```

`ctx.auth.tokenCan(ability)` answers for the guard in use:

- authenticated with a token guard: checks the token's abilities;
- authenticated with a `jwt` or `session` guard (your own first-party clients): always `true`;
- not authenticated: `false`.

Two middleware check abilities. Put them **after** `auth`, so the right guard is active:

| Middleware | Behavior |
|------------|----------|
| `abilities:posts:read,posts:write` | The token must have **all** listed abilities |
| `ability:posts:read,admin` | The token must have **at least one** of them |

Both return `401` when nobody is logged in and `403` when an ability is missing.

## Ready-made routes

`authRoutes()` registers the three token endpoints, protected by `auth`:

```ts
import { authRoutes } from '@hazejs/core'

r.group({ prefix: '/api/auth', as: 'auth.' }, (r) => {
  authRoutes(r, { tokens: { abilities: ['posts:read', 'posts:write'] } })
})
```

| Method | Path | Name | Body / result |
|--------|------|------|---------------|
| `GET` | `/tokens` | `tokens.index` | The user's tokens, without hashes |
| `POST` | `/tokens` | `tokens.store` | `{ name, abilities? }` → `201 { token, accessToken }` |
| `DELETE` | `/tokens/:id` | `tokens.destroy` | `204`, or `404` if the token is not the user's |

`tokens: { abilities }` limits which abilities clients may request (others get a `422`); when the body has no `abilities`, the token gets that whole list. `tokens: true` allows any ability. See [Authentication](./authentication#ready-made-routes) for the other options.

The api, vue and react templates implement the same endpoints by hand in `app/controller/TokenController.ts` (`GET/POST /api/auth/tokens`, `DELETE /api/auth/tokens/:id`), and `GET /api/auth/me` accepts both a JWT and a token (`auth:api,token`).

## Custom stores

A store implements `TokenStore`:

```ts
import type { TokenStore } from '@hazejs/core'

export const redisTokens: TokenStore = {
  create: async record => ({ ...record, id: await nextId() }), // assign the id
  find: async id => { /* … */ },
  list: async (tokenableType, tokenableId) => { /* … */ },
  update: async (id, values) => { /* name, abilities, lastUsedAt, expiresAt */ },
  delete: async id => { /* return whether it existed */ },
  deleteAll: async (tokenableType, tokenableId) => { /* return the count */ },
}
```

Ids may be numbers or strings made of letters, digits, `_` and `-` (up to 64 characters); they become the part before `|`.

## Testing

`actingAs()` with the token guard issues a real token with all abilities:

```ts
const client = await t.actingAs(user, 'token')
await client.get('/api/auth/me')
```

To test ability checks, create a token yourself, or use `issueTestCredentials()` with `abilities`:

```ts
import { issueTestCredentials } from '@hazejs/core'

const headers = await issueTestCredentials(t.app, user, 'token', { abilities: ['posts:read'] })
expect((await t.withHeaders(headers).post('/api/posts', { title: 'Hi' })).status).toBe(403)
```
