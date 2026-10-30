# OpenAPI

Routes in hazejs are data, so the framework can describe your API without extra annotations. It builds an **OpenAPI 3.1** document from the registered routes and the `.validate()` schemas, serves it with a docs page (Scalar or Swagger UI), and generates a typed client for your frontend.

```ts
// route/api.ts
import { defineRoutes } from '@hazejs/core'
import { PostController } from '~/app/controller/PostController'
import { CreatePostSchema, PostSchema } from '~/app/validate/post'

export default defineRoutes((r) => {
  r.post('/posts', [PostController, 'store'])
    .name('posts.store')
    .middleware('auth')
    .validate({ body: CreatePostSchema })
    .doc({ summary: 'Create a post', response: PostSchema, status: 201 })
})
```

Open `http://localhost:3000/docs` in development to browse the API, or fetch `/openapi.json`.

## Setup

The docs are on by default in every mode except production. Add `config/openapi.ts` only if you want to change something:

```ts
// config/openapi.ts
import { defineOpenAPIConfig } from '@hazejs/core'

export default defineOpenAPIConfig({
  info: { version: '1.2.0', description: 'Blog API' },
  servers: [{ url: 'https://api.example.com' }],
  ui: 'scalar',
})
```

| Option | Default | Description |
| --- | --- | --- |
| `enabled` | `true` except in production | Serve the JSON and the docs page |
| `path` | `'/openapi.json'` | URL of the JSON document |
| `docsPath` | `'/docs'` | URL of the docs page; `false` serves only the JSON |
| `ui` | `'scalar'` | `'scalar'` or `'swagger'` |
| `uiOptions` | — | Extra configuration passed to Scalar or Swagger UI |
| `info` | `title` from `app.name`, `version: '1.0.0'` | The OpenAPI `info` object |
| `servers` | `app.url` (`APP_URL`) | The OpenAPI `servers` list |
| `tags` | — | Tag descriptions, e.g. `[{ name: 'posts', description: 'Blog posts' }]` |
| `envelope` | `app.response.envelope` | How success responses are wrapped; see [Response envelope](#response-envelope) |
| `securitySchemes` | from `config/auth.ts` | Extra or replacement security schemes |
| `include` | — | `(route) => boolean` filter for the routes that are documented |

The docs page loads Scalar or Swagger UI from jsDelivr with a pinned version, so nothing is added to your dependencies. The page needs internet access in the browser.

::: tip Valibot schemas
Libraries that implement Standard JSON Schema (zod 4, arktype, …) are converted directly. Valibot needs its converter:

```bash
pnpm add @valibot/to-json-schema
```

Without it the document is still generated, but valibot schemas show up as "any value".
:::

::: warning Full-stack projects
In a [full-stack](./fullstack) project the backend only receives requests under its prefix (`/api` by default). Move the docs under it: `path: '/api/openapi.json'`, `docsPath: '/api/docs'`.
:::

To publish the docs in production, set `enabled: true` and protect the page if needed.

## What is generated

Each route becomes an operation:

- **Path**: `:id` becomes `{id}`, prefixes from groups and [apps](./multi-app) are included. WebSocket routes and `r.any()` routes are skipped.
- **operationId**: the route name (`api.posts.show`), otherwise built from method and path (`getApiPostsById`).
- **Tags**: the first path segment, skipping `api` and version segments such as `v1` (`/api/v1/posts/:id` → `posts`).
- **Parameters**: path parameters from `.validate({ params })` (or plain strings), plus one parameter per property of the `query` and `headers` schemas, with `required` and `description` taken from the schema. Query and header schemas describe the *input* type, before any transform.
- **Request body**: the `body` schema as `application/json`, or `multipart/form-data` when it contains files (`v.file()`, `v.blob()`, `z.file()`).
- **Responses**:
  - the success response, wrapped in the response envelope;
  - `422` with the [validation error](./requests#validation-errors) shape when the route has `.validate()`;
  - `401` when the route uses the `auth` middleware;
  - `403` when it uses `can:` or `guest`.
- **Security**: the `auth` middleware adds a security requirement for its guards. JWT guards become an HTTP bearer scheme, session guards a cookie scheme (`haze_session`), each named after the guard. `auth:api,web` accepts either. Without `config/auth.ts` a generic `bearerAuth` scheme is used.

Schemas that use `$defs` are moved to `components.schemas`, so references keep working.

## Documenting routes

`.doc()` adds documentation to a route. Like `.validate()`, it can be chained and called more than once.

```ts
// route/api.ts
r.get('/posts/:id', [PostController, 'show'])
  .name('posts.show')
  .validate({ params: PostIdParams })
  .doc({
    summary: 'Show a post',
    description: 'Returns a published post.',
    tags: ['Blog'],
    response: PostSchema,
    responses: { 404: { description: 'Post not found' } },
  })

r.get('/internal/metrics', [MetricsController, 'index']).doc({ hidden: true })
```

| Field | Description |
| --- | --- |
| `summary`, `description` | Shown in the docs page |
| `tags` | Replaces the default tag |
| `deprecated` | Marks the operation as deprecated |
| `operationId` | Replaces the route name |
| `hidden` | Leaves the route out of the document |
| `response` | Schema of the success data (the `data` field of the envelope). Standard Schema or plain JSON Schema |
| `status` | Status code of the success response, default `200`. `204` documents a response without a body |
| `responses` | Extra responses: `{ 404: { description, schema?, contentType? } }`. These schemas are not wrapped |
| `contentType` | Request body content type, when the default is wrong |
| `security` | Replaces the security requirement; `[]` means no authentication |
| `extensions` | Specification extensions copied onto the operation, e.g. `{ 'x-permission': ['user:delete'] }` |

Resource routes accept `tags`, `deprecated` and `hidden` for all their routes:

```ts
// route/api.ts
r.resource('/posts', PostController).doc({ tags: ['Posts'] })
```

## Response envelope {#response-envelope}

Success responses are documented as `{ code, message, data }` (see [Responses](./responses)), with `data` described by `.doc({ response })`. Routes with `.meta({ envelope: false })` and apps with `app.response.envelope: false` are documented without it.

If you replaced the format with `app/response/Formatter.ts`, describe it with a function:

```ts
// config/openapi.ts
import { defineOpenAPIConfig } from '@hazejs/core'

export default defineOpenAPIConfig({
  envelope: data => ({
    type: 'object',
    properties: { success: { type: 'boolean' }, result: data },
    required: ['success', 'result'],
  }),
})
```

## Exporting the document

`haze openapi` boots the app like `haze route:list` and prints the document. Use it to commit the spec or to feed code generators:

```bash
npx haze openapi                      # print to stdout
npx haze openapi --output openapi.json
```

In code, call `generateOpenAPI()` after the app has booted:

```ts
// tests/openapi.test.ts
import { generateOpenAPI } from '@hazejs/core'

const document = await generateOpenAPI(app, { info: { version: '2.0.0' } })
```

## Typed client

`haze typegen`, which `haze dev` runs automatically, also generates a client for every **named** route:

- `.haze/types/haze.d.ts` gets the method, path, inputs and output type of each route (`interface GeneratedRoutes`).
- `.haze/routes.ts` gets the runtime route list (name → method and path) that the client needs.

```ts
// src/api.ts
import { createClient } from '@hazejs/core/client'
import { routes } from '../.haze/routes'

export const api = createClient({
  routes,
  headers: () => ({ authorization: `Bearer ${localStorage.getItem('token')}` }),
})
```

```ts
// src/pages/post.ts
import { api } from '../api'

const post = await api('api.posts.show', { params: { id: 1 } })
const posts = await api('api.posts.index', { query: { page: 2 } })
await api('api.posts.store', { body: { title: 'Hello' } })
```

The client builds the URL from the route path, sends `body` as JSON (or as `multipart/form-data` when it contains a `File` or `Blob`), and returns the unwrapped `data`. `api.url(name, { params, query })` only builds the URL.

`@hazejs/core/client` only uses `fetch` and contains no server code, so it is safe to bundle into the frontend.

### Types

- **Inputs** come from the `.validate()` schemas. Schemas exported from a `validate`, `validator` or `schema` directory under `app/` (for example `app/validate/post.ts`) are referenced directly, so the input type is exactly the schema's input type. Inline schemas are converted through JSON Schema, which covers objects, arrays, enums and unions. Without a schema, path parameters are `string | number`.
- **Output** is the return type of the controller method, as it looks after JSON serialization: `raw()` is unwrapped, models and dates become their `toJSON()` result, and methods are dropped. Closure handlers have the output type `unknown`.

The frontend's `tsconfig` must include `.haze/types/**/*.d.ts`. Output types point at your controller files, so the frontend's TypeScript also needs to resolve the backend's imports. In the `vue` and `react` templates, add the `~/*` path from `tsconfig.server.json` to `tsconfig.app.json`.

### Options

| Option | Default | Description |
| --- | --- | --- |
| `routes` | required | The route list from `.haze/routes.ts` |
| `baseURL` | `''` (same origin) | Prefix for every URL, e.g. `https://api.example.com` |
| `headers` | — | Headers for every request, or a function (possibly async) that returns them |
| `fetch` | `globalThis.fetch` | Custom `fetch`, for SSR or tests |
| `credentials` | `'same-origin'` | Passed to `fetch`; use `'include'` for cross-origin cookies |
| `envelope` | `true` | Set to `false` when `app.response.envelope` is `false` |
| `unwrap` | — | `(body, response) => data` for a custom response formatter |

Per request you can pass `headers`, `signal` and `init` (other `fetch` options) next to `params`, `query` and `body`.

### Errors

Responses outside the 2xx range throw a `ClientError`. It has `status`, the parsed `body`, `code`, `message` and, for 422 responses, the validation `errors`:

```ts
// src/pages/new-post.ts
import { ClientError } from '@hazejs/core/client'
import { api } from '../api'

try {
  await api('api.posts.store', { body: { title: '' } })
}
catch (error) {
  if (error instanceof ClientError && error.status === 422)
    console.log(error.errors) // [{ target: 'body', path: 'title', message: '...' }]
}
```
