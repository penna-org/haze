# Factories

A model factory describes how to build a valid model with fake data. Tests use it to create exactly the records they need, and seeders use it to fill a development database.

```ts
const user = await UserFactory.create()
const admins = await UserFactory.state('admin').count(3).create()
const post = await PostFactory.for(user).has(CommentFactory.count(5), 'comments').create()
```

## Installation

Fake values come from [`@faker-js/faker`](https://fakerjs.dev), an optional dependency of `@hazejs/orm`. The templates already include it; in other projects add it as a dev dependency:

```bash
pnpm add -D @faker-js/faker
```

It is loaded on first use, so it never reaches your production bundle. Without it, factories still work: only reading `faker` throws an error that tells you to install it.

## Defining factories

Factories live in `database/factories` (local modules: `modules/<name>/database/factories`). Generate one with:

```bash
haze make:factory User                 # database/factories/UserFactory.ts
haze make:factory Post --module blog   # modules/blog/database/factories/PostFactory.ts
```

A factory is a model plus a function that returns its attributes:

```ts
// database/factories/UserFactory.ts
import { defineFactory } from '@hazejs/orm'
import { User } from '~/app/model/User'

export default defineFactory(User, ({ faker, sequence }) => ({
  name: faker.person.fullName(),
  email: sequence(n => `user${n}@example.com`),
}))
  .state('admin', { role: 'admin' })
  .state('unverified', { emailVerifiedAt: null })
```

The attributes are typed from the model's table: misspelled columns in overrides and wrong value types are compile errors, and `state()` only accepts the names you defined.

The definition receives a context:

| Field | Description |
|-------|-------------|
| `faker` | A faker instance in the configured locale |
| `sequence(n => value)` | A value from the model's sequence number. `sequence('a', 'b', 'c')` cycles through values |
| `n` | The sequence number: 1 for the first model this factory builds, and it keeps counting across calls |
| `index` | Position within the current call (`0`, `1`, `2` for `count(3)`) |

### Attribute values

Besides plain values, an attribute can be:

- **A function**, evaluated after the plain values, with them as its argument. It may be async.
- **Another factory**, which is created and replaced by its primary key. It is skipped when an override, `for()` or `has()` provides the value. `make()` and `raw()` create it too (the key has to be a real id), so they write to the database in that case.

```ts
export default defineFactory(Post, ({ faker }) => ({
  userId: UserFactory,                                     // creates an author when none is given
  title: faker.lorem.sentence(),
  slug: attributes => slugify(String(attributes.title)),
}))
```

## Using factories

```ts
import UserFactory from '~/database/factories/UserFactory'

await UserFactory.make()                       // a User, not saved
await UserFactory.make({ name: 'Ada' })        // with overrides
await UserFactory.create()                     // saved, with events and timestamps
await UserFactory.count(3).create()            // User[]
await UserFactory.createMany([{ name: 'Ada' }, { name: 'Bob' }])
await UserFactory.createMany(5)
await UserFactory.makeMany(2)
await UserFactory.raw()                        // plain attributes, for request bodies
```

`make()`, `create()` and `raw()` return an array after `count()`, and a single value otherwise. Every chained method returns a new factory, so `UserFactory` itself never changes.

When `create()` saves more than one model, or related models, it runs in a transaction: if anything fails, nothing is written.

### States

```ts
await UserFactory.state('admin').create()
await UserFactory.state({ name: 'Ada' }).create()
await UserFactory.state((attributes, { n }) => ({ email: `${attributes.name}.${n}@example.com` })).create()

// Alternate between states within one call
await UserFactory.count(4).sequence({ role: 'admin' }, { role: 'member' }).create()
await UserFactory.count(3).sequence(({ index }) => ({ name: `User ${index}` })).create() // items can be (ctx) => attributes
```

Named states are defined with `.state(name, value)` after `defineFactory()`, and applied with `.state(name)`. The value is an object or a function `(attributes, ctx) => object`.

Attributes are merged in this order: the definition, states (in the order applied), foreign keys from `for()`, then the overrides passed to `make()` / `create()`.

### Callbacks

```ts
export default defineFactory(User, ({ faker }) => ({ name: faker.person.fullName() }))
  .afterMake(user => user.hidden(['email']))
  .afterCreate(async (user) => {
    await user.profile().save({ bio: 'Hello' })
  })
```

`afterMake` runs for `make()` and also for `create()`, before saving. `afterCreate` runs after the model and its `has()` children are saved.

## Relationships

Factories read the relations you defined on the model, so foreign keys and morph types are filled in for you.

### Belongs to: `for()`

```ts
await PostFactory.for(UserFactory).create()              // creates the author
await PostFactory.for(user).create()                     // uses an existing user
await PostFactory.for(UserFactory.state('admin'), 'author').count(3).create()
await CommentFactory.for(post, 'commentable').create()   // morphTo: sets commentableType and commentableId
```

The relation name defaults to the parent model's name in camelCase (`User` → `user`); pass it when the relation is called something else. A parent factory is created once per call, and all models of that call share it. `make()` and `raw()` create the parent too, because the foreign key needs a real id.

### Has many / has one: `has()`

```ts
await UserFactory.has(PostFactory.count(3), 'posts').create()
await UserFactory.count(2).has(PostFactory.count(2)).create()   // 'posts' is guessed from Post
await UserFactory.has(ProfileFactory, 'profile').create()
await PostFactory.has(ImageFactory.count(2), 'images').create() // morphMany: type and id are set
```

`has()` works with `hasMany`, `hasOne`, `morphMany`, `morphOne` and `belongsToMany`. The default relation name is the child model's name in plural camelCase (`Post` → `posts`). Children are created after their parent, only by `create()`.

### Many to many: `hasAttached()`

```ts
await PostFactory.hasAttached(TagFactory.count(2), 'tags', { weight: 1 }).create()
await PostFactory.hasAttached(existingTags, 'tags').create()
await PostFactory.hasAttached(TagFactory.count(3), 'tags', tag => ({ weight: tag.id })).create()
```

The third argument is the pivot data, as an object or as a function of the related model (and the parent).

## Locale

Set the faker locale once in `config/database.ts`:

```ts
export default defineDatabaseConfig(() => ({
  default: 'main',
  connections: { /* ... */ },
  factories: {
    locale: 'zh_CN',
  },
}))
```

Or per factory: `UserFactory.locale('ja').create()`. Locale names follow faker's exports (`en`, `en_US`, `de`, `zh_CN`, `zh_TW`, `ja`, …); `zh-CN` works too. An unknown locale throws.

## In seeders and tests

Seeders run inside the application, so factories work there as in tests:

```ts
// database/seeders/02-demo.ts
import PostFactory from '~/database/factories/PostFactory'
import UserFactory from '~/database/factories/UserFactory'

export default async function seed(): Promise<void> {
  await UserFactory.count(10).has(PostFactory.count(3), 'posts').create()
}
```

In tests, combine them with `refreshDatabase()`; see [Testing](./testing#model-factories).

## Limitations

- Factories are for SQL models (`Model`); `MongoModel` is not supported.
- `has()` does not support `hasManyThrough` / `hasOneThrough`; create the intermediate models with `has()` on each level.
- Relation names are guessed from class names. In bundled code where class names are minified, pass the relation name explicitly.
- Sequence numbers are kept per factory for the life of the process; they are not reset between tests. Use them for uniqueness, not for exact values.
