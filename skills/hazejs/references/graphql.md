# GraphQL (`@hazejs/graphql`)

GraphQL on top of graphql-js: schema-first or code-first schemas, GraphQL over HTTP with content negotiation, GraphiQL, depth / complexity limits, request-scoped batching loaders, hazejs exception → GraphQL error mapping, and `graphql-transport-ws` subscriptions. Snippets use the API-template layout (`config/*.ts`, `app/...`, `route/*.ts`, `~/` = backend `srcDir`); in vue/react projects the same files live under `server/`.

Full guide: [graphql.md](../../../docs/guide/graphql.md)

## Install and register

```bash
pnpm add @hazejs/graphql graphql      # graphql ^16.9 || ^17 is a peer dep — one shared copy
```

```ts
// app/provider/GraphQLProvider.ts   (app/provider is auto-discovered; no make:* generator for this)
import { graphqlProvider } from '@hazejs/graphql'
import schema from '~/app/graphql/schema'

export default graphqlProvider(schema, {
  middleware: ['throttle:60,1'],                 // MiddlewareRef[] — applied to both routes (and the WS upgrade)
  context: ctx => ({ tenant: ctx.header('x-tenant') ?? 'default' }),
})
// lazy: graphqlProvider(() => import('~/app/graphql/schema'))  — `{ default }` is unwrapped, loaded on first request
```

`graphqlProvider(schema, options?)` registers `GET` and `POST` at `path` (default `/graphql`), both hidden from OpenAPI (`.doc({ hidden: true })`). The routes are not inside any route group/prefix. Provider options are spread **over** `config/graphql.ts` (options win). Config is read once, at provider `register()`.

There is no conventional schema folder; `app/graphql/` is just a convention used in the docs.

## Configuration

```ts
// config/graphql.ts — optional
import { defineGraphQLConfig } from '@hazejs/graphql'

export default defineGraphQLConfig({
  path: '/graphql',
  maxDepth: 10,
  maxComplexity: 1000,
  subscriptions: { connectionInitWaitTimeout: 3000, onConnect: async ctx => (await ctx.auth.user()) !== undefined },
})
```

| Option (config + provider/handler) | Default | Notes |
| --- | --- | --- |
| `path` | `/graphql` | config + `graphqlProvider` only (not `graphqlHandler`) |
| `graphiql` | on unless app mode is `production` | `true`/`false` or `{ title, defaultQuery, defaultHeaders }` (`defaultHeaders` is a JSON **string**) |
| `introspection` | on unless app mode is `production` | off → graphql-js `NoSchemaIntrospectionCustomRule` (validation error) |
| `maxDepth` | `15` | `false` disables |
| `maxComplexity` | off | number; `false`/`0` = off |
| `subscriptions` | `false` | `true` or `{ connectionInitWaitTimeout (ms, default 3000), onConnect(ctx, payload) }` |
| `context` | — | `(ctx: HttpContext) => object \| void`, merged into the GraphQL context per operation |
| `rootValue` | — | passed to `execute` |
| `validationRules` | — | extra graphql-js `ValidationRule[]` appended to `specifiedRules` |
| `formatError` | — | `(formatted, error) => GraphQLFormattedError`, applied to parse / validation / execution / context errors; transport errors (400 bad params or missing query, 405, 406, 413, 415) bypass it |
| `middleware` | `[]` | provider only |

"Production" means the application mode (`app.mode === 'production'`), not `app.debug`.

## Schema-first

```ts
// app/graphql/schema.ts
import { UnauthorizedException } from '@hazejs/core'
import { defineSchema } from '@hazejs/graphql'
import { GraphQLScalarType } from 'graphql'
import { Post } from '~/app/model/Post'

export default defineSchema({
  typeDefs: /* GraphQL */ `
    scalar Upper
    enum Role { ADMIN MEMBER }
    type User { id: Int!, name: String!, role: Role! }
    type Post { id: Int!, title: String!, author: User! }
    type Query { posts(first: Int): [Post!]!, post(id: Int!): Post }
    type Mutation { createPost(title: String!): Post! }
  `,
  resolvers: {
    Upper: new GraphQLScalarType({ name: 'Upper', serialize: v => String(v).toUpperCase() }),
    Role: { ADMIN: 'admin', MEMBER: 'member' },          // enum internal values
    Query: {
      posts: {                                           // object form: resolve / subscribe / complexity
        resolve: (_src, args: { first?: number }) => Post.query().limit(args.first ?? 10).get(),
        complexity: ({ args, childComplexity }) => Number(args.first ?? 10) * childComplexity,
      },
      post: (_src, args: { id: number }) => Post.find(args.id),
    },
    Mutation: {
      createPost: async (_src, args: { title: string }, ctx) => {
        const user = await ctx.auth.user()
        if (!user)
          throw new UnauthorizedException()
        return Post.create({ title: args.title, userId: user.id })
      },
    },
  },
})
```

| Resolver entry | Meaning |
| --- | --- |
| `field: (source, args, ctx, info) => value` | plain resolver; `ctx` is `GraphQLContext` |
| `field: { resolve?, subscribe?, complexity? }` | `subscribe` returns `AsyncIterable`; `complexity: number \| ({ args, childComplexity }) => number` |
| `__resolveType(value, ctx, info)` | interfaces / unions → concrete type name |
| `__isTypeOf(value, ctx, info)` | object types |
| `ScalarName: new GraphQLScalarType({...})` | custom scalar impl (SDL description kept) |
| `EnumName: { VALUE: internal }` | enum internal values |

- `typeDefs`: `string | DocumentNode | Array<string | DocumentNode>`; `resolvers`: object or array (merged in order, per type).
- Splitting: modules may use `extend type Query { ... }` / `Mutation` / `Subscription` without the base type — empty root types are added automatically.
- Startup throws on resolvers for an unknown type, an unknown field, an unknown enum value, or a scalar resolver that is not a `GraphQLScalarType`.

```ts
import * as posts from './posts'   // export const typeDefs = `extend type Query { posts: [Post!]! } ...`; export const resolvers = {...}
import * as users from './users'
export default defineSchema({ typeDefs: [users.typeDefs, posts.typeDefs], resolvers: [users.resolvers, posts.resolvers] })
```

## Code-first

`defineSchema()` also accepts a `GraphQLSchemaConfig` (→ `new GraphQLSchema(config)`) or an existing `GraphQLSchema` (returned as is). The helpers are thin graphql-js wrappers that type `ctx` as `GraphQLContext`, and mix freely with native constructors.

```ts
import { defineSchema, field, inputType, list, nonNull, objectType } from '@hazejs/graphql'
import { GraphQLInt, GraphQLString } from 'graphql'
import { User } from '~/app/model/User'

const UserType = objectType<User>({
  name: 'User',
  fields: () => ({ id: { type: nonNull(GraphQLInt) }, name: { type: nonNull(GraphQLString) } }),
})
const NewUser = inputType({ name: 'NewUser', fields: { name: { type: nonNull(GraphQLString) } } })

export default defineSchema({
  query: objectType({
    name: 'Query',
    fields: {
      users: field({ type: list(UserType), resolve: () => User.all(), complexity: 5 }), // → extensions.complexity
      me: field({ type: UserType, resolve: (_s, _a, ctx) => ctx.auth.user() }),
    },
  }),
  mutation: objectType({
    name: 'Mutation',
    fields: { addUser: field({ type: UserType, args: { input: { type: nonNull(NewUser) } }, resolve: (_s, { input }) => User.create(input) }) },
  }),
})
```

`nonNull(T)` → `T!`, `list(T)` → `[T]`. Code-first complexity can also be set as `extensions: { complexity }`.

## Resolver context (`GraphQLContext`)

| Member | Description |
| --- | --- |
| `ctx.http` | the `HttpContext` (in subscriptions: a context rebuilt at `connection_init`) |
| `ctx.auth` | getter for `http.auth` — `await ctx.auth.user()`, `ctx.auth.guard('web')` |
| `ctx.can(...)` / `ctx.authorize(...)` | bound `http.can` / `http.authorize` (throws 403 → `FORBIDDEN`) |
| `ctx.inject(Token)` | `http.make(Token)` — request container; works in subscriptions too |
| `ctx.loader(Definition)` | one loader instance per definition per context (per request / per WS operation) |
| your fields | returned by the `context` option |

```ts
declare module '@hazejs/graphql' {
  interface GraphQLContext { tenant: string }
}
```

- Resolvers run inside the HTTP request, so the global `inject()`, `useContext()` and request-scoped services work for queries/mutations over HTTP. In subscriptions (and any WS operation) use `ctx.inject()`.
- An `HttpException` thrown from `context()` ends the HTTP request with that status and a `{ errors: [...] }` body (500 for other errors).
- Route middleware such as `auth` rejects with the normal hazejs JSON error **before** GraphQL runs. For a public schema with protected fields, leave the route open and check `ctx.auth` / `ctx.authorize()` in resolvers.

## Batching with loaders

```ts
// app/graphql/loaders.ts — define at module top level
import { defineLoader } from '@hazejs/graphql'
import { User } from '~/app/model/User'

export const UserById = defineLoader(async (ids: readonly number[]) => {
  const users = await User.query().whereIn('id', ids).get()
  return new Map(users.map(u => [u.id, u]))     // or an array in key order (entries may be Error)
})

// resolvers
Post: { author: (post, _args, ctx) => ctx.loader(UserById).load(post.userId) }
```

| API | Notes |
| --- | --- |
| `defineLoader(batchFn, options?)` | reusable definition; instances via `ctx.loader(def)` |
| `createLoader(batchFn \| definition, options?)` | standalone instance (outside GraphQL, tests) |
| `load(key)` / `loadMany(keys)` | `loadMany` resolves failed keys to `Error` instead of rejecting |
| `prime(key, value)` | seeds cache only if the key is not cached yet |
| `clear(key)` / `clearAll()` | e.g. after a mutation; all return the loader (chainable) |
| options | `maxBatchSize` (unlimited), `cache` (`true`), `cacheKey: key => C` (object keys), `schedule(dispatch)` (default: after microtasks, via `process.nextTick`) |

Batch results: a `Map` (missing keys resolve to `undefined`) or an array of the **same length** as `keys` (otherwise every key rejects with `TypeError`). A thrown batch rejects all keys and nothing is cached, so they can be retried.

## Subscriptions

Enable `subscriptions` (config or options). WebSocket upgrades on the same path speak `graphql-transport-ws` (clients: `graphql-ws`, Apollo, urql) through the same route + middleware.

```ts
// app/graphql/pubsub.ts
import { createPubSub } from '@hazejs/graphql'
export const pubsub = createPubSub<{ postCreated: Post }>()

// resolvers
Mutation: { createPost: async (_s, args) => { const post = await Post.create(args); pubsub.publish('postCreated', post); return post } },
Subscription: {
  postCreated: {
    subscribe: () => pubsub.subscribe('postCreated', { filter: post => post.published }), // filter optional, may be async
    resolve: (post: Post) => post,   // async generators work too as `subscribe`
  },
},
```

`PubSub`: `publish(topic, payload)`, `subscribe(topic, { filter? })` → `AsyncIterableIterator`, `listenerCount(topic?)`. In-process only.

```ts
// client
import { createClient } from 'graphql-ws'
const client = createClient({ url: 'wss://example.com/graphql', connectionParams: { authorization: `Bearer ${token}` } })
```

- Auth: upgrade-request headers/cookies are reused; `authorization` / `Authorization` / `token` in the `connection_init` payload becomes the `Authorization` header (`Bearer ` added if no scheme). So `ctx.auth` works.
- `onConnect(ctx, payload)`: `false` (or throwing) closes with **4403**; returning an object sends it as the `connection_ack` payload.
- Close codes: 4400 invalid message, 4401 `subscribe` before ack, 4408 no `connection_init` within `connectionInitWaitTimeout` (3000 ms), 4409 duplicate operation id, 4429 second `connection_init`, 4500 internal error.
- Upgrade without `Sec-WebSocket-Protocol: graphql-transport-ws` → 400; upgrade with subscriptions off → 400. Queries/mutations over the socket also work. Subscription operations over HTTP are rejected (`BAD_REQUEST`).
- Runtimes: `haze dev`, node / bun / deno / docker builds. vercel / netlify / aws-lambda reject upgrades (426). On Cloudflare the build only auto-enables its WebSocket Durable Object when a route file contains `.ws(`; the provider does not, so you'd need `cloudflare: { websocket: true }` in `haze.config.ts` (untested path).

## GraphQL over HTTP

- `POST`, `Content-Type: application/json`, body `{ query, variables?, operationName?, extensions? }`; other content types → 415; body read via `ctx.body()` so `bodyLimit` applies (413).
- `GET ?query=&operationName=&variables=<json>&extensions=<json>`; queries only — mutation over GET → 405 `Allow: POST`. Other methods → 405.
- GET with `Accept: text/html` and no `query` param → GraphiQL page (if enabled). GraphiQL loads pinned versions from esm.sh with SRI (`GRAPHIQL_VERSIONS`).

| `Accept` | Response type | Status |
| --- | --- | --- |
| `application/graphql-response+json` | same | 400 for parse / validation / missing query / bad variables / variable coercion; 200 once execution starts |
| `application/json`, `application/*`, `*/*`, missing | `application/json` | 200 for any GraphQL-level request error (legacy behaviour) |
| none of these | — | 406 |

Always 400 regardless of `Accept`: invalid JSON body, non-object body, invalid JSON in GET `variables`/`extensions`.

## Errors

Throw hazejs exceptions as in controllers; they become GraphQL errors with `extensions`:

| Thrown | `extensions` |
| --- | --- |
| `UnauthorizedException` | `{ code: 'UNAUTHENTICATED', status: 401 }` |
| `ForbiddenException`, failed `ctx.authorize()` | `{ code: 'FORBIDDEN', status: 403 }` |
| `NotFoundException` | `{ code: 'NOT_FOUND', status: 404 }` |
| 409 / 419 / 429 | `CONFLICT` / `CSRF_TOKEN_MISMATCH` / `TOO_MANY_REQUESTS` |
| `ValidationException`, failed `validate()` | `{ code: 'BAD_USER_INPUT', status: 422, issues: [{ path, message }] }` |
| `BusinessException(10001, '…')` | `{ code: 'BUSINESS_ERROR', status: 200, errorCode: 10001 }` |
| other `HttpException` | string `code` option if given, else from status (other 4xx `BAD_REQUEST`, 5xx `INTERNAL_SERVER_ERROR`); `data` included |
| `GraphQLError` (e.g. `graphqlError()`) | kept as is |
| anything else | `{ code: 'INTERNAL_SERVER_ERROR' }`, message → `Internal Server Error` unless `app.debug` |

Request-level codes: `GRAPHQL_PARSE_FAILED`, `GRAPHQL_VALIDATION_FAILED`, `OPERATION_RESOLUTION_FAILURE`, `DEPTH_LIMIT_EXCEEDED`, `COMPLEXITY_LIMIT_EXCEEDED` (with `complexity`, `maxComplexity`), `BAD_REQUEST`, `METHOD_NOT_ALLOWED`, `NOT_ACCEPTABLE`. Constants: `ErrorCode`; helper `codeForStatus(status)`. Unknown errors and 5xx go to `ExceptionHandler.report()`; < 500 HTTP exceptions are not reported.

```ts
import { validate } from '@hazejs/core'
import { graphqlError } from '@hazejs/graphql'
import * as v from 'valibot'

const CreatePost = v.object({ title: v.pipe(v.string(), v.minLength(3)) })
// Mutation.createPost:
const input = await validate(CreatePost, args)                         // 422 → BAD_USER_INPUT + issues
if (await Post.where('title', input.title).exists())
  throw graphqlError('Title already taken', 'TITLE_TAKEN', { field: 'title' }) // (message, code, extraExtensions?)
```

## Limits and security

- **Depth** (`maxDepth`, default 15): each nested field adds 1; fragments are followed, inline fragments add nothing. `{ posts { author { posts { id } } } }` = 4.
- **Complexity** (`maxComplexity`, off by default): each field costs `1 + children`; a numeric `complexity` replaces the `1` (children still added); a function `({ args, childComplexity }) => n` replaces the whole field cost (args include resolved variables).
- Introspection fields (`__schema`, `__type`, …) are excluded from both limits; introspection itself is governed by `introspection`.
- `depthLimit(n)` and `complexityLimit(n, variables?)` are exported graphql-js `ValidationRule` factories.
- No `@defer`/`@stream`, persisted queries, file uploads or batched (array) requests.

## Mount manually

```ts
// route/api.ts
import { defineRoutes } from '@hazejs/core'
import { graphqlHandler } from '@hazejs/graphql'
import schema from '~/app/graphql/schema'

const graphql = graphqlHandler(schema, { maxDepth: 8, subscriptions: true }) // GraphQLHandlerOptions — does NOT read config/graphql.ts

export default defineRoutes((r) => {
  r.get('/graphql', graphql).middleware('throttle:60,1').doc({ hidden: true })  // GET also handles WS upgrades
  r.post('/graphql', graphql).middleware('throttle:60,1').doc({ hidden: true })
})
```

Do not also register `graphqlProvider` for the same path. Other exports: `negotiate(accept)`, `renderGraphiQL(opts)`, `formatGraphQLError(error, { debug, formatError })`, `createWebSocketHandler(schema, options, app)`, `GRAPHQL_TRANSPORT_WS`, `isLoaderDefinition`.

## Testing

```ts
// tests/graphql.test.ts
import { useTestApp } from '@hazejs/testing'
import { expect, it } from 'vitest'

const t = useTestApp({ configOverrides: { graphql: { maxDepth: 5 } } }) // deep-merged over config/*.ts

it('returns the current user', async () => {
  const res = await (await t.actingAs({ id: 1 })).post('/graphql', { query: '{ me { id } }' }) // JSON body by default
  expect(res.status).toBe(200)
  expect(res.body).toEqual({ data: { me: { id: 1 } } })
})

it('maps errors', async () => {
  const res = await t.post('/graphql', { query: 'mutation($t: String!) { createPost(title: $t) { id } }', variables: { t: 'x' } },
    { headers: { accept: 'application/graphql-response+json' } })
  expect(res.body.errors[0].extensions.code).toBe('UNAUTHENTICATED')
})
```

- The test client sends no `Accept`, so request errors come back as **200** with `errors`; send `accept: application/graphql-response+json` to assert 400s.
- Test mode is not production: GraphiQL and introspection are on.
- Unit-test loaders with `createLoader(definition)`; subscriptions need a real server (`app.serve({ port: 0 })`) plus a `graphql-transport-ws` WebSocket client — the in-process client is HTTP-only.

## Gotchas

- GraphiQL and introspection are **off in production mode** by default; set `introspection: true` for a public API. GraphiQL needs browser access to esm.sh.
- Missing `Accept` / `application/json` → validation errors are HTTP 200. Don't treat status as success; check `errors`.
- `createPubSub()` is per process. With several instances, fan events out (Redis pub/sub, microservice `emit`, broadcasting) and call `publish` on each instance.
- In subscriptions there is no surrounding request: use `ctx.inject()` / `ctx.http`, not global `inject()`/`useContext()`. The `context()` factory runs per operation with the connection's context.
- Route middleware like `auth` on the GraphQL route blocks everything (including introspection and GraphiQL) with a REST-style error, not a GraphQL error body.
- `maxComplexity: 0` means "off", not "reject everything". A function `complexity` must add `childComplexity` itself.
- Resolver typos (unknown type/field/enum value) throw at schema build — i.e. when the provider registers, or on first request for a lazy schema.
- `graphqlHandler()` ignores `config/graphql.ts`; pass options explicitly. Batched/array requests and file uploads are unsupported.
- Loader instances are per request — never create one at module scope with `createLoader` for request data (cross-user cache leak); use `defineLoader` + `ctx.loader`.
