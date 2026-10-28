# API Resources

An API resource is a transformation layer between your models and your JSON responses. It decides which fields go out, renames or formats them, hides data the viewer shouldn't see, and keeps pagination information intact — in one place, instead of in every controller.

```ts
// app/resource/UserResource.ts
import type { User } from '~/app/model/User'
import { defineResource, when, whenLoaded } from '@hazejs/core'
import { PostResource } from '~/app/resource/PostResource'

export const UserResource = defineResource((user: User, ctx) => ({
  id: user.id,
  name: user.name,
  email: when(ctx.can('update', user), user.email),
  posts: whenLoaded('posts', PostResource),
  createdAt: user.createdAt,
}))
```

```ts
// app/controller/UserController.ts
export class UserController {
  async index(ctx: HttpContext) {
    return UserResource.collection(await User.with('posts').paginate(Number(ctx.query('page') ?? 1), 20))
  }

  async show(ctx: HttpContext) {
    return UserResource.make(await User.findOrFail(ctx.param('id')))
  }
}
```

Generate one with `haze make:resource User` (creates `app/resource/UserResource.ts`).

## Defining a resource

`defineResource(transform, options?)` takes a function that receives the item and the current `HttpContext` and returns a plain object. Values can be:

- plain values and nested objects / arrays,
- promises — they are awaited, and sibling fields resolve in parallel,
- other resources (`PostResource.make(post)`, `PostResource.collection(posts)`),
- conditional values (`when`, `whenLoaded`, `whenNotNull`, `merge`), which disappear from the output when their condition fails.

The transform itself may be `async`. Model instances and dates inside the output are serialized with their `toJSON()` as usual.

## Returning resources

| Call | Output |
|------|--------|
| `UserResource.make(user)` | the transformed object (`null` for `null` / `undefined`) |
| `UserResource.collection(users)` | an array |
| `UserResource.collection(await User.paginate(page, 20))` | `{ data, meta, links }` |
| `UserResource.collection(await Db.table(logs).paginateX(20))` | `{ data, meta, links }` with cursor info |

Return the result from a controller directly. It goes through the [response envelope](./responses) like any other data:

```json
{
  "code": 0,
  "message": "ok",
  "data": {
    "data": [{ "id": 2, "name": "Bob" }],
    "meta": { "total": 41, "page": 2, "perPage": 20, "lastPage": 3, "from": 21, "to": 40 },
    "links": {
      "first": "/api/users?page=1",
      "last": "/api/users?page=3",
      "prev": "/api/users?page=1",
      "next": "/api/users?page=3"
    }
  }
}
```

With the envelope disabled (`.meta({ envelope: false })` or `app.response.envelope: false`), a paginated collection is returned as `{ data, meta, links }` and a single resource as the object itself.

Pagination links reuse the current path and query string, replacing only `page` (`lastId` for cursor pagination). Change the parameter names with the `pageName` / `cursorName` options.

`make()` and `collection()` return a lazy, awaitable value. You can `await` it to get plain data, for example in tests or to embed it elsewhere:

```ts
const data = await UserResource.make(user)   // { id, name, ... }
```

### Extra top-level data

`additional()` adds keys next to the result. Single items and arrays are wrapped in `{ data }`; paginated results get the keys next to `data`, `meta` and `links`:

```ts
return UserResource.collection(page).additional({ filters: { role } })
// { data: [...], meta: {...}, links: {...}, filters: { role: 'admin' } }
```

## Conditional fields

| Helper | Output |
|--------|--------|
| `when(condition, value, fallback?)` | `value` when true; otherwise `fallback`, or the field is removed. The condition may be a promise, e.g. `ctx.can(...)` |
| `whenNotNull(value)` | the value unless it is `null` / `undefined` |
| `whenLoaded('posts', PostResource?)` | the relation when it was eager-loaded (`with()` / `load()`), transformed by the resource or a function |
| `...merge(condition?, { ... })` | spreads several fields at once, only when the condition holds |

Values can be functions, which are only evaluated when the condition holds:

```ts
defineResource((user: User, ctx) => ({
  id: user.id,
  stats: when(ctx.query('include') === 'stats', () => loadStats(user.id)),
  ...merge(user.role === 'admin', () => ({ permissions: user.permissions })),
}))
```

`whenLoaded('posts')` uses the item being transformed, so call it before the first `await` in an async transform. After an `await`, pass the item explicitly: `whenLoaded(user, 'posts', PostResource)`. Checking for loaded relations avoids accidental N+1 queries.

## Using resources outside requests

Resources also work in jobs, commands and mails, as long as the transform doesn't touch `ctx` (accessing it outside a request throws). Pagination links are then relative to the query string only (`?page=2`).

## Types and OpenAPI

The output type is inferred from the transform: promises are unwrapped, nested resources resolved, and conditional fields become optional. Use `ResourceData<typeof UserResource>` to name it. The typed client (`@hazejs/core/client`) sees the same type.

For [OpenAPI](./openapi), give the resource a schema and reference it in `.doc()`:

```ts
export const UserResource = defineResource(transform, {
  schema: v.object({ id: v.number(), name: v.string() }),
})

r.get('/users/:id', [UserController, 'show']).doc({ response: UserResource.schema })
```
