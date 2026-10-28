# Requests & Validation

Every handler receives an `HttpContext`. This page covers reading input from it, handling file uploads and validating data with any [Standard Schema](https://standardschema.dev) library.

## Reading input

```ts
// app/controller/SearchController.ts
import type { HttpContext } from '@hazejs/core'

export class SearchController {
  async index(ctx: HttpContext) {
    const id = ctx.param('id') // route param: string | undefined
    const params = ctx.params() // all route params
    const page = ctx.query('page') // first value of ?page=
    const query = ctx.query() // { [key]: string | string[] }
    const token = ctx.header('authorization') // request header
    const theme = ctx.cookie('theme') // cookie
    const body = await ctx.body<{ q?: string }>() // parsed body

    return { id, params, page, query, token, theme, q: body.q, ip: ctx.ip }
  }
}
```

| Method | Returns |
|--------|---------|
| `ctx.param(name)` / `ctx.params()` | Route parameters, always strings |
| `ctx.query(name)` / `ctx.query()` | Query values. With a name, the first value if repeated |
| `await ctx.body<T>()` | Parsed body |
| `ctx.header(name)` | Header value or `undefined` |
| `ctx.cookie(name)` / `await ctx.signedCookie(name)` | Cookie value. Signed cookies return `undefined` if tampered with |
| `ctx.ip` | Client IP. Read from `X-Forwarded-For` only when `app.trustProxy` is `true` |
| `ctx.method`, `ctx.path`, `ctx.url` | Method, pathname, full `URL` |
| `ctx.req` | The Web `Request` |

### The request body

`ctx.body()` parses the body based on `content-type`:

- JSON → the parsed value;
- `application/x-www-form-urlencoded` → an object of strings;
- `multipart/form-data` → an object whose text fields are strings and whose file fields are `UploadedFile`. A repeated field name becomes an array.

The body is read once. Later calls, including the one route validation makes, return the same result. `ctx.body<T>()` only casts the type. To actually check the shape, validate it (see below).

### Body size limit

Bodies larger than `app.bodyLimit` (default `1mb`) are rejected with **413**. Change the global default in `config/app.ts`, or raise it for a single route with the `bodyLimit` middleware:

```ts
// config/app.ts
import { defineConfig, env } from '@hazejs/core'

export default defineConfig(() => ({
  name: env('APP_NAME', 'my-app'),
  bodyLimit: '2mb',
}))
```

```ts
// route/api.ts
r.post('/import', [ImportController, 'store']).middleware('bodyLimit:20mb')
```

## File uploads

For multipart requests, `ctx.file(name)` returns the first uploaded file for a field, and `ctx.files(name)` returns all of them (for `<input type="file" multiple>`). Empty file inputs are ignored.

`UploadedFile` extends the standard `File`, so `name`, `size`, `type`, `arrayBuffer()` and `stream()` all work. It adds:

| Member | Description |
|--------|-------------|
| `field` | Form field name |
| `extension` | Lowercase extension from the client file name, without the dot (`''` if none) |
| `store(dir, disk?)` | Save to a storage disk with a random name. Keeps the extension and returns the path on the disk |
| `storeAs(dir, name, disk?)` | Save with a given file name. Only the base name is used, which prevents path traversal |

```ts
// app/controller/AvatarController.ts
import type { HttpContext } from '@hazejs/core'
import { BadRequestException, Storage } from '@hazejs/core'

export class AvatarController {
  async store(ctx: HttpContext) {
    const avatar = await ctx.file('avatar')
    if (!avatar)
      throw new BadRequestException('Please choose a file')

    const path = await avatar.store('avatars', 'public') // or { disk: 's3' }
    return ctx.created({ path, url: Storage.disk('public').url(path) })
  }

  async gallery(ctx: HttpContext) {
    const photos = await ctx.files('photos')
    return Promise.all(photos.map(photo => photo.storeAs('gallery', `${crypto.randomUUID()}.${photo.extension}`)))
  }
}
```

The second argument of `store()` / `storeAs()` is a disk name or an options object (`{ disk, ... }`). Disks are configured in `config/filesystem.ts`. See [File Storage](./storage).

## Validation

hazejs validates with any library that implements Standard Schema. The templates use [valibot](https://valibot.dev), and zod and arktype work the same way. Schemas live in `app/validate/`:

```ts
// app/validate/user.ts
import * as v from 'valibot'

export const CreateUserSchema = v.object({
  name: v.pipe(v.string('Name is required'), v.trim(), v.minLength(1, 'Name cannot be empty')),
  email: v.pipe(v.string('Email is required'), v.email('Invalid email address')),
})

export const UpdateUserSchema = v.partial(CreateUserSchema)

export const UserIdParams = v.object({
  id: v.pipe(v.string(), v.transform(Number), v.integer('User ID must be an integer')),
})
```

Generate a schema file with:

```bash
npx haze make:validate User   # app/validate/user.ts with CreateUserSchema / UpdateUserSchema
```

If the project depends on zod but not valibot, the generated file uses zod.

### Validating in the handler

`validate(schema, value)` validates any value. It returns the schema's typed output, with transforms applied, or throws a `ValidationException` (422):

```ts
// app/controller/UserController.ts
import type { HttpContext } from '@hazejs/core'
import { validate } from '@hazejs/core'
import { User } from '~/app/model/User'
import { CreateUserSchema } from '~/app/validate/user'

export class UserController {
  async store(ctx: HttpContext) {
    const input = await validate(CreateUserSchema, await ctx.body())
    return ctx.created(await User.create(input))
  }
}
```

### Validating on the route

Declare schemas on the route with `.validate()`. The request is checked before the handler runs, and the output is stored in `ctx.validated`. Supported targets are `params`, `query`, `headers` and `body`. All targets are checked, and every issue is reported together in a single 422.

```ts
// route/api.ts
import * as v from 'valibot'
import { GreetSchema } from '~/app/validate/greeting'

r.post('/hello', [GreetingController, 'store']).validate({ body: GreetSchema })

r.get('/posts', [PostController, 'index']).validate({
  query: v.object({
    q: v.optional(v.string()),
    page: v.optional(v.pipe(v.string(), v.transform(Number))),
  }),
})

r.resource('/users', UserController).validateMember({ params: UserIdParams })
```

Type the context with the same schemas to get a typed `ctx.validated`:

```ts
// app/controller/GreetingController.ts
import type { HttpContext } from '@hazejs/core'
import type { GreetSchema } from '~/app/validate/greeting'

export class GreetingController {
  store(ctx: HttpContext<{ body: typeof GreetSchema }>) {
    return { message: `Hello, ${ctx.validated.body.name}!` }
  }
}
```

### Validating uploads

Because `UploadedFile` is a `File`, valibot's file actions work on multipart bodies:

```ts
// app/validate/auth.ts
import * as v from 'valibot'

export const AvatarSchema = v.object({
  avatar: v.pipe(
    v.file('Please choose an image'),
    v.mimeType(['image/png', 'image/jpeg', 'image/webp'], 'Only png / jpeg / webp'),
    v.maxSize(2 * 1024 * 1024, 'Image must be 2MB or smaller'),
  ),
})
```

### Other schema libraries

```ts
// app/validate/post.ts
import { z } from 'zod'

export const CreatePostSchema = z.object({
  title: z.string().min(1),
  tags: z.array(z.string()).default([]),
})
```

`validate()` and `.validate()` accept it unchanged.

## Validation errors

A failed validation responds with status **422** in the standard [error format](./responses). `errors` lists every issue: `target` (omitted when validating with `validate()` directly), the dotted field `path` and the `message`:

```json
{
  "code": 422,
  "message": "Validation Failed",
  "data": null,
  "errors": [
    { "target": "body", "path": "name", "message": "Name cannot be empty" },
    { "target": "body", "path": "email", "message": "Invalid email address" }
  ]
}
```

To reshape it, override `error()` in `app/response/Formatter.ts` (see [Responses](./responses)). You can also throw `new ValidationException([{ path: 'email', message: 'Already taken' }])` yourself, for example after a uniqueness check.
