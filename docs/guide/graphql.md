# GraphQL

`@hazejs/graphql` serves a GraphQL API from your hazejs app. It builds on the official [graphql-js](https://github.com/graphql/graphql-js) library and adds the parts a backend needs: schema-first or code-first schemas, GraphQL over HTTP with content negotiation, GraphiQL, depth and complexity limits, request-scoped batching loaders, error mapping for hazejs exceptions, and subscriptions over WebSocket.

::: tip Paths
Examples on this page use the API template layout (`app/...`, `config/...`). In a full-stack project these live under `server/`.
:::

## Installation

```bash
pnpm add @hazejs/graphql graphql
```

`graphql` (v16 or v17) is a peer dependency, so your schema and the server share one copy of graphql-js.

Register the provider with your schema:

```ts
// app/provider/GraphQLProvider.ts
import { graphqlProvider } from '@hazejs/graphql'
import schema from '~/app/graphql/schema'

// GET and POST /graphql; GraphiQL in the browser outside production
export default graphqlProvider(schema)
```

## Defining a schema

### Schema-first

`defineSchema({ typeDefs, resolvers })` builds an executable schema from SDL:

```ts
// app/graphql/schema.ts
import { UnauthorizedException } from '@hazejs/core'
import { defineSchema } from '@hazejs/graphql'
import { Post } from '~/app/model/Post'

export default defineSchema({
  typeDefs: /* GraphQL */ `
    type Post { id: Int!, title: String!, author: User! }
    type User { id: Int!, name: String! }
    type Query {
      posts: [Post!]!
      post(id: Int!): Post
    }
    type Mutation { createPost(title: String!): Post! }
  `,
  resolvers: {
    Query: {
      posts: () => Post.query().get(),
      post: (_source, args: { id: number }) => Post.find(args.id),
    },
    Mutation: {
      createPost: async (_source, args: { title: string }, ctx) => {
        const user = await ctx.auth.user()
        if (!user)
          throw new UnauthorizedException()
        return Post.create({ title: args.title, userId: user.id })
      },
    },
  },
})
```

Resolvers receive `(source, args, ctx, info)` as in graphql-js; `ctx` is the [GraphQL context](#context). A resolver can be a function or an object:

| Form | Use |
| --- | --- |
| `field: (source, args, ctx, info) => value` | Plain field resolver |
| `field: { resolve, subscribe, complexity }` | Subscription fields (`subscribe`) and a [complexity](#limits-and-security) |
| `__resolveType(value, ctx)` | Interfaces and unions: return the concrete type name |
| `__isTypeOf(value, ctx)` | Object types implementing an interface |
| `Scalar: new GraphQLScalarType({...})` | Custom scalar implementation |
| `Enum: { ADMIN: 'admin' }` | Internal values of an enum |

Resolvers for a type or field that is not in the SDL throw at startup, so typos do not go unnoticed.

To split a large schema, pass arrays. Modules can use `extend type Query`; the root types are created for you:

```ts
// app/graphql/schema.ts
import { defineSchema } from '@hazejs/graphql'
import * as posts from './posts'
import * as users from './users'

// posts.ts: export const typeDefs = `extend type Query { posts: [Post!]! } ...`; export const resolvers = {...}
export default defineSchema({
  typeDefs: [users.typeDefs, posts.typeDefs],
  resolvers: [users.resolvers, posts.resolvers],
})
```

### Code-first

`defineSchema()` also accepts a graphql-js `GraphQLSchemaConfig` (or an existing `GraphQLSchema`), so any graphql-js schema works as is. The helpers `objectType`, `inputType`, `field`, `nonNull` and `list` are thin wrappers that type the resolver context:

```ts
// app/graphql/schema.ts
import { defineSchema, field, list, nonNull, objectType } from '@hazejs/graphql'
import { GraphQLInt, GraphQLString } from 'graphql'
import { User } from '~/app/model/User'

const UserType = objectType<User>({
  name: 'User',
  fields: () => ({
    id: { type: nonNull(GraphQLInt) },
    name: { type: nonNull(GraphQLString) },
  }),
})

export default defineSchema({
  query: objectType({
    name: 'Query',
    fields: {
      users: field({ type: list(UserType), resolve: () => User.all() }),
      me: field({ type: UserType, resolve: (_source, _args, ctx) => ctx.auth.user() }),
    },
  }),
})
```

## Serving

### Provider and configuration

`graphqlProvider(schema, options?)` registers `GET` and `POST` routes at the configured path. `config/graphql.ts` is optional:

```ts
// config/graphql.ts
import { defineGraphQLConfig } from '@hazejs/graphql'

export default defineGraphQLConfig({
  path: '/graphql',
  maxDepth: 10,
  maxComplexity: 1000,
  subscriptions: true,
})
```

| Option | Default | Description |
| --- | --- | --- |
| `path` | `/graphql` | Endpoint path |
| `graphiql` | on outside production | GraphiQL page for browsers; `{ title, defaultQuery, defaultHeaders }` to customise |
| `introspection` | on outside production | Allow `__schema` / `__type` queries |
| `maxDepth` | `15` | Maximum query depth; `false` disables the check |
| `maxComplexity` | off | Maximum query complexity |
| `subscriptions` | `false` | Subscriptions over WebSocket on the same path; `{ connectionInitWaitTimeout, onConnect }` |

The provider options take everything above plus `context`, `formatError`, `rootValue`, `validationRules`, and `middleware` (route middleware such as `'throttle:60,1'`). Options passed to the provider override the config file. The schema can be a function that returns it (or a dynamic `import()`); it is loaded on the first request.

### Route helper

To control routing yourself, mount `graphqlHandler()`:

```ts
// route/api.ts
import { defineRoutes } from '@hazejs/core'
import { graphqlHandler } from '@hazejs/graphql'
import schema from '~/app/graphql/schema'

const graphql = graphqlHandler(schema, { maxDepth: 8 })

export default defineRoutes((r) => {
  r.get('/graphql', graphql).middleware('throttle:60,1')
  r.post('/graphql', graphql).middleware('throttle:60,1')
})
```

### GraphQL over HTTP

The handler follows the [GraphQL over HTTP](https://graphql.github.io/graphql-over-http/) specification:

- `POST` with `Content-Type: application/json` and a body of `{ query, variables?, operationName?, extensions? }`. Other content types get `415`.
- `GET` with `query`, `operationName`, and JSON-encoded `variables` / `extensions` in the query string. GET can only run queries; a mutation gets `405` with `Allow: POST`.
- The response media type follows `Accept`:

| `Accept` | Response | Status codes |
| --- | --- | --- |
| `application/graphql-response+json` | same type | `400` for parse, validation and variable errors; `200` once execution started (field errors are in `errors`) |
| `application/json`, `*/*` or missing | `application/json` | `200` for every well-formed request, as legacy clients expect |
| anything else | | `406` |

Malformed requests (invalid JSON, missing `query`, non-object `variables`) get `400` either way. Subscriptions over HTTP are rejected; use WebSocket.

## Context

Every resolver receives the GraphQL context as its third argument:

| Member | Description |
| --- | --- |
| `ctx.http` | The hazejs [`HttpContext`](./requests) of the request |
| `ctx.auth` | Same as `http.auth`: `await ctx.auth.user()`, `ctx.auth.guard('web')` (see [Authentication](./authentication)) |
| `ctx.can(...)` / `ctx.authorize(...)` | [Authorization](./authorization) checks; `authorize` throws `403` |
| `ctx.inject(Token)` | Resolve from the request's [container](./container) |
| `ctx.loader(Definition)` | The request's [loader](#batching-with-loaders) instance |

Resolvers run inside the request, so `inject()`, `useContext()` and request-scoped services work as they do in controllers.

Add your own fields with the `context` option and declare them with declaration merging:

```ts
// app/provider/GraphQLProvider.ts
import { graphqlProvider } from '@hazejs/graphql'
import schema from '~/app/graphql/schema'

declare module '@hazejs/graphql' {
  interface GraphQLContext {
    tenant: string
  }
}

export default graphqlProvider(schema, {
  context: ctx => ({ tenant: ctx.header('x-tenant') ?? 'default' }),
})
```

An `HttpException` thrown by `context()` (say `UnauthorizedException`) ends the request with that status and a GraphQL error body.

::: tip Authentication
Route middleware such as `authenticate()` rejects with the regular hazejs JSON error before GraphQL runs. To keep a public schema with some protected fields, leave the route open and check `ctx.auth` / `ctx.authorize()` in the resolvers.
:::

## Batching with loaders

Resolving `author` for each of 50 posts would run 50 queries (the N+1 problem). A loader collects the keys requested during one tick and loads them in a single batch. `createLoader` is built in, with the same semantics as DataLoader and no dependency:

```ts
// app/graphql/loaders.ts
import { defineLoader } from '@hazejs/graphql'
import { User } from '~/app/model/User'

// Return values in key order, or a Map keyed by id
export const UserById = defineLoader(async (ids: readonly number[]) => {
  const users = await User.query().whereIn('id', ids).get()
  return new Map(users.map(user => [user.id, user]))
})
```

```ts
// resolvers
Post: {
  author: (post, _args, ctx) => ctx.loader(UserById).load(post.userId),
},
```

`ctx.loader(definition)` returns one instance per request, so results are cached within a request and never shared between users.

| API | Description |
| --- | --- |
| `load(key)` / `loadMany(keys)` | Load one or several keys; `loadMany` resolves failed keys to `Error` |
| `prime(key, value)` | Seed the cache |
| `clear(key)` / `clearAll()` | Drop cached results, for example after a mutation |
| options | `maxBatchSize`, `cache: false`, `cacheKey: key => string` for object keys, `schedule` |

The batch function may return an array with one entry per key (entries can be `Error`) or a `Map`. Use `createLoader(fn, options)` directly when you need a loader outside GraphQL.

## Errors

Throw hazejs exceptions in resolvers as you would in controllers. They are converted to GraphQL errors with `extensions.code`:

| Thrown | `extensions` |
| --- | --- |
| `UnauthorizedException` | `{ code: 'UNAUTHENTICATED', status: 401 }` |
| `ForbiddenException`, failed `ctx.authorize()` | `{ code: 'FORBIDDEN', status: 403 }` |
| `NotFoundException` | `{ code: 'NOT_FOUND', status: 404 }` |
| `ValidationException`, `validate()` failure | `{ code: 'BAD_USER_INPUT', status: 422, issues: [{ path, message }] }` |
| `TooManyRequestsException` | `{ code: 'TOO_MANY_REQUESTS', status: 429 }` |
| `BusinessException(10001, '…')` | `{ code: 'BUSINESS_ERROR', status: 200, errorCode: 10001 }` |
| other `HttpException` | `code` from the status (a string `code` option wins), plus `data` |
| `GraphQLError` | kept as is, including its `extensions` |
| anything else | `{ code: 'INTERNAL_SERVER_ERROR' }`; the message is replaced with `Internal Server Error` unless `app.debug` is on |

Parse and validation errors have `GRAPHQL_PARSE_FAILED` / `GRAPHQL_VALIDATION_FAILED`; the limits below add `DEPTH_LIMIT_EXCEEDED` and `COMPLEXITY_LIMIT_EXCEEDED`. Unexpected errors and 5xx exceptions are passed to the [`ExceptionHandler`](./errors)'s `report()`.

```ts
import { validate } from '@hazejs/core'
import { graphqlError } from '@hazejs/graphql'
import * as v from 'valibot'

const CreatePost = v.object({ title: v.pipe(v.string(), v.minLength(3)) })

export const resolvers = {
  Mutation: {
    createPost: async (_source, args) => {
      const input = await validate(CreatePost, args) // 422 → BAD_USER_INPUT with issues
      if (await Post.where('title', input.title).exists())
        throw graphqlError('Title already taken', 'TITLE_TAKEN')
      return Post.create(input)
    },
  },
}
```

`formatError(formatted, error)` lets you adjust every error before it is sent.

## Limits and security

- **Depth.** `maxDepth` (default 15) counts nested selections, following fragments. `{ posts { author { posts { id } } } }` has depth 4.
- **Complexity.** `maxComplexity` adds up a cost for each selected field: 1 plus the cost of its children by default. Give expensive or paginated fields their own cost:

  ```ts
  // schema-first
  Query: {
    posts: {
      resolve: (_source, args) => Post.query().limit(args.first).get(),
      complexity: ({ args, childComplexity }) => Number(args.first ?? 10) * childComplexity,
    },
  },
  // code-first: field({ type, resolve, complexity: 5 })
  ```

- **Introspection** and **GraphiQL** are off when the app runs in production mode. Set `introspection: true` to keep schema discovery for a public API.
- Introspection fields are not counted by the depth and complexity limits.
- Add your own graphql-js rules with `validationRules`.

GraphiQL is loaded from esm.sh with pinned versions and Subresource Integrity hashes (exported as `GRAPHIQL_VERSIONS`); the browser needs access to that CDN.

## Subscriptions

With `subscriptions: true`, WebSocket upgrades on the GraphQL path speak the [`graphql-transport-ws`](https://github.com/enisdenjo/graphql-ws/blob/master/PROTOCOL.md) protocol used by the `graphql-ws` client, Apollo Client and urql. The upgrade runs through the same route and middleware as the HTTP endpoint, on top of hazejs [WebSocket support](./websocket).

```ts
// app/graphql/pubsub.ts
import { createPubSub } from '@hazejs/graphql'

export const pubsub = createPubSub<{ postCreated: Post }>()
```

```ts
// resolvers
Mutation: {
  createPost: async (_source, args) => {
    const post = await Post.create(args)
    pubsub.publish('postCreated', post)
    return post
  },
},
Subscription: {
  postCreated: {
    subscribe: () => pubsub.subscribe('postCreated'),
    resolve: (post: Post) => post,
  },
},
```

`subscribe` can return any `AsyncIterable`, so an async generator works too. `pubsub.subscribe(topic, { filter })` drops events per subscriber.

On the client:

```ts
import { createClient } from 'graphql-ws'

const client = createClient({
  url: 'wss://example.com/graphql',
  connectionParams: { authorization: `Bearer ${token}` },
})
```

Authentication: browser cookies and the upgrade request's headers are available, and an `authorization` (or `token`) field in the `connection_init` payload is applied as the `Authorization` header. So `ctx.auth` works in subscription resolvers. `onConnect` can reject a connection:

```ts
// config/graphql.ts
import { defineGraphQLConfig } from '@hazejs/graphql'

export default defineGraphQLConfig({
  subscriptions: {
    // false closes the connection with 4403
    onConnect: async ctx => (await ctx.auth.user()) !== undefined,
  },
})
```

Queries and mutations sent over the socket are executed too. Inside subscriptions, use `ctx.inject()` rather than the global `inject()`: there is no HTTP request around them.

## Testing

```ts
// tests/graphql.test.ts
import { issueTestCredentials } from '@hazejs/core'
import { expect, it } from 'vitest'
import { createApp } from './app'

it('returns the current user', async () => {
  const app = await createApp()
  const credentials = await issueTestCredentials(app, { id: 1 })
  const res = await app.request('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...credentials },
    body: JSON.stringify({ query: '{ me { id } }' }),
  })
  expect(await res.json()).toEqual({ data: { me: { id: 1 } } })
})
```

## Limitations

- `createPubSub()` is in-process. With several instances, broadcast the event between them (for example through Redis or [microservice](./microservices) events) and call `publish` on each.
- No `@defer` / `@stream`, persisted queries, file uploads or batched (array) requests.
- Subscriptions need a runtime with hazejs WebSocket support (Node, Bun, Deno); see [WebSocket](./websocket) for Cloudflare and serverless platforms.
