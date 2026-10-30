# Authorization

[Authentication](./authentication) tells you *who* the user is; authorization decides *what* they may do. hazejs uses a Gate with two kinds of rules, both living in `app/policy/*.ts` and registered automatically:

- **Policies** group the abilities for one model: `definePolicy(Post, { update, delete, ... })`.
- **Abilities** that are not tied to a model: `defineAbilities({ 'admin.access': ... })`.

## Writing a policy

The api template gives users a `role` column (`member` or `admin`) and ships this policy:

```ts
// app/policy/UserPolicy.ts
import { definePolicy, deny } from '@hazejs/core'
import { User } from '~/app/model/User'

export default definePolicy(User, {
  // Admins can do everything
  before: (actor: User | undefined) => actor?.role === 'admin' || undefined,
  update: (actor: User, user: User) => actor.id === user.id || deny('You can only edit your own profile'),
  delete: (actor: User, user: User) => actor.id === user.id || deny('You can only delete your own account'),
})
```

Each ability receives the current user first and the model instance second. It may be async and returns:

| Result | Meaning |
|--------|---------|
| `true` / `allow()` | Allowed |
| `false` / `undefined` / `null` | Denied |
| `deny(message)` | Denied, with a message used in the `403` response |

Generate a new policy with `haze make:policy Post`. The stub contains examples of `before`, `allowGuest` and `deny`. Each file in `app/policy` default-exports one policy or ability set.

### `before`

A policy's `before(user, ability, args)` runs ahead of every ability in that policy. Return `true` or `false` to decide immediately, or `undefined` to fall through to the ability itself. The template uses it to let admins through.

### Guests

Abilities are not called for guests: an unauthenticated user is denied straight away. Wrap an ability with `allowGuest()` to let it run with `user` set to `undefined`:

```ts
// app/policy/PostPolicy.ts
import { allowGuest, definePolicy, deny } from '@hazejs/core'
import { Post } from '~/app/model/Post'
import type { User } from '~/app/model/User'

export default definePolicy(Post, {
  view: allowGuest((user: User | undefined, post: Post) => post.published || post.userId === user?.id),
  create: () => true,
  update: (user: User, post: Post) => post.userId === user.id || deny('You can only edit your own posts'),
})
```

### Class-level abilities

Abilities like `create` have no instance to check yet. Pass the model class instead; the ability then receives only the user:

```ts
await ctx.authorize('create', Post)
```

## Abilities without a model

```ts
// app/policy/abilities.ts
import { defineAbilities } from '@hazejs/core'
import type { User } from '~/app/model/User'

export default defineAbilities({
  'admin.access': (user: User) => user.role === 'admin',
  'report.export': (_user: User, format: string) => format === 'csv',
})
```

```ts
await ctx.authorize('admin.access')
await ctx.can('report.export', 'csv')
```

## Checking in controllers

| Method | Returns |
|--------|---------|
| `await ctx.can(ability, ...args)` | `true` if allowed |
| `await ctx.cannot(ability, ...args)` | `true` if denied |
| `await ctx.authorize(ability, ...args)` | Nothing; throws when denied |

`authorize()` throws `401` when the user is not logged in and `403` when they are logged in but not allowed. The `403` message comes from `deny()`. From the template's `UserController`:

```ts
// app/controller/UserController.ts
async update(ctx: WithId) {
  const user = await User.findOrFail(ctx.validated.params.id)
  await ctx.authorize('update', user)
  user.fill(await validate(UpdateUserSchema, await ctx.body()))
  return user.save()
}
```

The user comes from `ctx.auth` (the default guard). Without a `config/auth.ts`, everyone is treated as a guest.

## Route middleware

The `can` middleware runs the same checks before the controller:

```ts
// route/api.ts
r.get('/admin/stats', [AdminController, 'stats']).middleware('can:admin.access')
r.post('/posts', [PostController, 'store']).middleware('can:create,Post')
r.patch('/posts/:id', [PostController, 'update']).middleware('can:update,Post,id')
```

| Form | Checks |
|------|--------|
| `can:<ability>` | An ability from `defineAbilities` (or decided by `gate.fallback()`) |
| `can:a\|b` | Passes when the user has **any** of the abilities |
| `can:<ability>,<Model>` | A class-level ability on the policy for `<Model>` |
| `can:<ability>,<Model>,<param>` | Loads the model with `Model.findOrFail(ctx.param(param))` (missing → `404`), then checks the instance |

`<Model>` is the class name of a model that has a policy. With the third form, the loaded instance is stored on the context under the class name with a lowercase first letter, so the controller doesn't load it twice:

```ts
// app/controller/PostController.ts
async update(ctx: HttpContext) {
  const post = ctx.get<Post>('post')!
  post.fill(await validate(UpdatePostSchema, await ctx.body()))
  return post.save()
}
```

## Type-safe ability names

Typegen (run automatically by `haze dev`, or with `haze typegen`) reads `app/policy` and generates the ability names. `ctx.can()`, `ctx.cannot()` and `ctx.authorize()` then only accept abilities that exist: model abilities are matched to the model you pass, and plain abilities to `defineAbilities`. A typo becomes a type error instead of a runtime "Unknown ability" error.

## Outside of requests

The Gate is an application singleton. In jobs, listeners or scripts, bind it to a user explicitly:

```ts
import { Gate, useApp } from '@hazejs/core'

const gate = useApp().make(Gate)
if (await gate.forUser(user).can('update', post)) {
  // ...
}
const { allowed, message, guest } = await gate.forUser(user).inspect('update', post)
```

`forUser()` returns an object with `can()`, `cannot()`, `authorize()` and `inspect()`. Inside services you can also `inject(Gate)`.

## Registering rules in code

Besides `app/policy`, a provider can register abilities and global hooks:

```ts
// app/provider/AuthProvider.ts
import { defineProvider, Gate } from '@hazejs/core'
import type { User } from '~/app/model/User'

export default defineProvider({
  boot(app) {
    const gate = app.make(Gate)
    gate.define('beta', (user: User) => user.role === 'admin')
    // Runs before every check; return undefined to continue
    gate.before((user: User | undefined) => user?.role === 'admin' || undefined)
    // Observes every decision (audit logs), cannot change it
    gate.after((user, ability, allowed) => {
      app.logger.info(`gate ${ability}: ${allowed}`)
    })
  },
})
```

### Data-driven abilities

When abilities are permission codes stored with roles in the database — and new ones appear at runtime — register a fallback instead of defining each one. It decides every ability that has no definition; `before` hooks still run first, and returning `undefined` denies:

```ts
gate.fallback((user: AuthUser | undefined, ability) => user?.permissions.includes(ability))
```

`await ctx.authorizeAny(['report:export', 'report:manage'])` (and `gate.authorizeAny(user, abilities)`) passes when any of the abilities is granted; the `can:a|b` middleware does the same.

## How a decision is made

1. Global `gate.before()` hooks, then the policy's `before`. The first non-`undefined` result wins.
2. Guests are denied unless the ability is wrapped with `allowGuest()`.
3. The ability function runs.
4. Global `gate.after()` hooks observe the result.

Policies are looked up through the prototype chain, so a subclass of a model uses its parent's policy. Asking for an ability that doesn't exist throws, since it's a programming error.

::: info
Policies are global: `app/<name>/policy` in [multi-app](./multi-app) projects is not loaded yet.
:::

## Testing

Use `actingAs()` to check both sides of a rule:

```ts
// tests/user.test.ts
it('only lets users change themselves', async () => {
  const ada = await User.create({ name: 'Ada', email: 'ada@example.com' })
  const bob = await User.create({ name: 'Bob', email: 'bob@example.com' })

  expect((await t.patch(`/api/users/${ada.id}`, { name: 'x' })).status).toBe(401)
  const forbidden = await (await t.actingAs(bob)).patch(`/api/users/${ada.id}`, { name: 'x' })
  expect(forbidden.status).toBe(403)
})
```

See [Testing](./testing) for more.
