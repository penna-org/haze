import type { Application } from '@hazejs/core'
import type { GraphQLHandlerOptions, SchemaInput } from '../src'
import { BusinessException, createApplication, createToken, defineAbilities, defineRoutes, defineUserProvider, deny, inject, issueTestCredentials, NotFoundException, validate } from '@hazejs/core'
import { GraphQLInt, GraphQLScalarType, GraphQLSchema, GraphQLString } from 'graphql'
import * as v from 'valibot'
import { afterEach, describe, expect, it } from 'vitest'
import { createLoader, createPubSub, defineLoader, defineSchema, field, GRAPHIQL_VERSIONS, graphqlHandler, graphqlProvider, list, negotiate, nonNull, objectType } from '../src'

interface User { id: number, name: string, role: 'admin' | 'member' }
interface Post { id: number, title: string, authorId: number }

const users: User[] = [
  { id: 1, name: 'Ada', role: 'admin' },
  { id: 2, name: 'Bob', role: 'member' },
  { id: 3, name: 'Cy', role: 'member' },
]
const posts: Post[] = [
  { id: 1, title: 'Hello', authorId: 1 },
  { id: 2, title: 'GraphQL', authorId: 2 },
  { id: 3, title: 'Loaders', authorId: 1 },
  { id: 4, title: 'Batching', authorId: 3 },
]

const Greeting = createToken<string>('greeting')
class GreetingService {
  greet(name: string) {
    return `Hello ${name}`
  }
}

const batches: number[][] = []
const UserById = defineLoader(async (ids: readonly number[]) => {
  batches.push([...ids])
  return new Map(users.filter(user => ids.includes(user.id)).map(user => [user.id, user]))
})

const pubsub = createPubSub<{ postAdded: Post }>()

const typeDefs = /* GraphQL */ `
  scalar Upper
  enum Role { ADMIN MEMBER }
  type User { id: Int!, name: String!, role: Role!, shout: Upper! }
  type Post { id: Int!, title: String!, author: User! }
  type Query {
    hello(name: String): String!
    posts: [Post!]!
    me: User
    secret: String
    missing: String
    broken: String
    business: String
    greet(name: String!): String
    injected: String!
    deep: Post
  }
  type Mutation { addPost(title: String!, authorId: Int!): Post! }
  type Subscription { postAdded: Post!, countdown(from: Int!): Int! }
`

const schema = defineSchema({
  typeDefs,
  resolvers: [
    {
      Upper: new GraphQLScalarType({
        name: 'Upper',
        serialize: value => String(value).toUpperCase(),
      }),
      Role: { ADMIN: 'admin', MEMBER: 'member' },
      User: {
        shout: (user: User) => user.name,
      },
      Post: {
        author: (post: Post, _args, ctx) => ctx.loader(UserById).load(post.authorId),
      },
      Query: {
        hello: (_source, args: { name?: string }) => `Hello ${args.name ?? 'world'}`,
        posts: () => posts,
        me: async (_source, _args, ctx) => (await ctx.auth.user()) ?? null,
        secret: async (_source, _args, ctx) => {
          await ctx.authorize('admin.access')
          return 'top secret'
        },
        missing: () => {
          throw new NotFoundException('Post 9 not found')
        },
        broken: () => {
          throw new Error('database password is hunter2')
        },
        business: () => {
          throw new BusinessException(10001, 'Insufficient balance')
        },
        greet: async (_source, args: { name: string }) => {
          const { name } = await validate(v.object({
            name: v.pipe(v.string(), v.minLength(3, 'name is too short')),
          }), args)
          return inject(GreetingService).greet(name)
        },
        injected: (_source, _args, ctx) => ctx.inject(Greeting),
        deep: () => posts[0],
      },
    },
    {
      Mutation: {
        addPost: (_source, args: { title: string, authorId: number }) => {
          const post = { id: posts.length + 1, title: args.title, authorId: args.authorId }
          posts.push(post)
          pubsub.publish('postAdded', post)
          return post
        },
      },
      Subscription: {
        postAdded: {
          subscribe: () => pubsub.subscribe('postAdded'),
          resolve: (post: Post) => post,
        },
        countdown: {
          async* subscribe(_source: unknown, args: { from: number }) {
            for (let n = args.from; n >= 0; n--)
              yield { countdown: n }
          },
        },
      },
    },
  ],
})

const apps: Application[] = []
afterEach(async () => {
  batches.length = 0
  for (const app of apps.splice(0))
    await app.dispose()
})

async function boot(options: GraphQLHandlerOptions & { mode?: 'test' | 'production', schema?: SchemaInput, config?: Record<string, unknown> } = {}) {
  const { mode = 'test', schema: input = schema, config = {}, ...handlerOptions } = options
  const handler = graphqlHandler(input, handlerOptions)
  const app = await createApplication({
    mode,
    env: false,
    policies: [
      defineAbilities({
        'admin.access': (user: User) => user.role === 'admin' || deny('Admins only'),
      }),
    ],
    config: {
      logger: { level: 'silent' },
      app: {
        key: 'k'.repeat(32),
        debug: false,
      },
      auth: {
        default: 'api',
        guards: {
          api: { driver: 'jwt', provider: 'users' },
        },
        providers: {
          users: defineUserProvider<User>({
            retrieveById: id => users.find(user => user.id === Number(id)),
            retrieveByCredentials: () => undefined,
            validateCredentials: () => false,
            getId: user => user.id,
          }),
        },
      },
      ...config,
    },
    providers: [
      {
        register: container => void container.instance(Greeting, 'from the container'),
      },
    ],
    routes: [
      defineRoutes((r) => {
        r.get('/graphql', handler)
        r.post('/graphql', handler)
      }),
    ],
  })
  apps.push(app)
  return app
}

function post(app: Application, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/graphql', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'accept': 'application/graphql-response+json', ...headers },
    body: JSON.stringify(body),
  })
}

async function gql(app: Application, query: string, variables?: Record<string, unknown>, headers?: Record<string, string>) {
  const res = await post(app, { query, variables }, headers)
  return { status: res.status, body: await res.json() as { data?: any, errors: any[] } }
}

describe('schema-first queries and mutations', () => {
  it('runs queries with variables, custom scalars and enum values', async () => {
    const app = await boot()
    const res = await post(app, {
      query: 'query Q($name: String) { hello(name: $name) }',
      variables: { name: 'haze' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/graphql-response+json; charset=utf-8')
    expect(await res.json()).toEqual({
      data: { hello: 'Hello haze' },
    })

    const { body } = await gql(app, '{ posts { title author { name role shout } } }')
    expect(body.data.posts[0]).toEqual({
      title: 'Hello',
      author: { name: 'Ada', role: 'ADMIN', shout: 'ADA' },
    })
  })

  it('runs mutations over POST and rejects them over GET', async () => {
    const app = await boot()
    const { body } = await gql(app, 'mutation($t: String!) { addPost(title: $t, authorId: 2) { id title author { name } } }', { t: 'New' })
    expect(body.data.addPost).toMatchObject({
      title: 'New',
      author: { name: 'Bob' },
    })
    posts.pop()

    const res = await app.request(`/graphql?query=${encodeURIComponent('mutation { addPost(title: "x", authorId: 1) { id } }')}`, {
      headers: { accept: 'application/graphql-response+json' },
    })
    expect(res.status).toBe(405)
    expect(res.headers.get('allow')).toBe('POST')
  })

  it('serves GET queries with JSON-encoded variables', async () => {
    const app = await boot()
    const query = encodeURIComponent('query($name: String) { hello(name: $name) }')
    const variables = encodeURIComponent(JSON.stringify({ name: 'GET' }))
    const res = await app.request(`/graphql?query=${query}&variables=${variables}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/json; charset=utf-8')
    expect(await res.json()).toEqual({
      data: { hello: 'Hello GET' },
    })

    const bad = await app.request(`/graphql?query=${query}&variables=%7Bnope`)
    expect(bad.status).toBe(400)
  })

  it('supports code-first schemas built with graphql-js', async () => {
    const UserType = objectType<User>({
      name: 'User',
      fields: {
        id: {
          type: nonNull(GraphQLInt),
        },
        name: { type: GraphQLString },
      },
    })
    const codeFirst = defineSchema({
      query: objectType({
        name: 'Query',
        fields: {
          users: field({
            type: list(UserType),
            resolve: () => users,
          }),
          upper: field<unknown, { text: string }>({
            type: GraphQLString,
            args: {
              text: {
                type: nonNull(GraphQLString),
              },
            },
            resolve: (_source, args, ctx) => `${args.text.toUpperCase()} ${ctx.inject(Greeting)}`,
          }),
        },
      }),
    })
    const app = await boot({ schema: codeFirst })
    const { body } = await gql(app, '{ users { id name } upper(text: "hi") }')
    expect(body.data).toEqual({
      users: users.map(({ id, name }) => ({ id, name })),
      upper: 'HI from the container',
    })

    // 原生 GraphQLSchema 与懒加载函数同样可用
    const lazy = await boot({
      schema: async () => ({
        default: new GraphQLSchema({
          query: objectType({
            name: 'Query',
            fields: {
              ok: {
                type: GraphQLString,
                resolve: () => 'yes',
              },
            },
          }),
        }),
      }),
    })
    expect((await gql(lazy, '{ ok }')).body.data).toEqual({ ok: 'yes' })
  })

  it('rejects resolvers for unknown types or fields', () => {
    expect(() => defineSchema({
      typeDefs: 'type Query { a: String }',
      resolvers: {
        Query: {
          b: () => 1,
        },
      },
    })).toThrow('Query.b')
    expect(() => defineSchema({
      typeDefs: 'type Query { a: String }',
      resolvers: { Nope: {} },
    })).toThrow('"Nope"')
    // 只有 extend type Query 的模块也能组合
    const merged = defineSchema({
      typeDefs: ['extend type Query { a: String }', 'extend type Query { b: String }'],
      resolvers: [
        {
          Query: {
            a: () => 'a',
          },
        },
        {
          Query: {
            b: () => 'b',
          },
        },
      ],
    })
    expect(Object.keys(merged.getQueryType()!.getFields())).toEqual(['a', 'b'])
  })
})

describe('graphql over http', () => {
  it('negotiates the response media type', async () => {
    expect(negotiate(undefined)).toBe('application/json')
    expect(negotiate('*/*')).toBe('application/json')
    expect(negotiate('application/json;q=0.5, application/graphql-response+json')).toBe('application/graphql-response+json')
    expect(negotiate('application/graphql-response+json;q=0.1, application/json')).toBe('application/json')
    expect(negotiate('text/plain')).toBeUndefined()

    const app = await boot()
    const invalid = { query: '{ nope }' }
    // graphql-response+json：校验失败为 400
    const strict = await post(app, invalid)
    expect(strict.status).toBe(400)
    expect((await strict.json() as any).errors[0].extensions.code).toBe('GRAPHQL_VALIDATION_FAILED')
    // application/json：格式正确的请求总是 200
    const legacy = await post(app, invalid, { accept: 'application/json' })
    expect(legacy.status).toBe(200)
    expect(legacy.headers.get('content-type')).toBe('application/json; charset=utf-8')

    expect((await post(app, { query: '{' })).status).toBe(400)
    expect((await post(app, { query: '{ hello }' }, { accept: 'text/plain' })).status).toBe(406)
    const form = await app.request('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: '{ hello }',
    })
    expect(form.status).toBe(415)
    const notJson = await app.request('/graphql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{oops',
    })
    expect(notJson.status).toBe(400)
    expect((await post(app, {})).status).toBe(400)
    // 变量类型错误：没有 data，属于请求错误
    const coercion = await post(app, {
      query: 'query($name: String!) { hello(name: $name) }',
      variables: { name: 5 },
    })
    expect(coercion.status).toBe(400)
  })

  it('serves GraphiQL to browsers outside production, from pinned CDN versions', async () => {
    const app = await boot({ subscriptions: true })
    const res = await app.request('/graphql', {
      headers: { accept: 'text/html,application/xhtml+xml' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
    const html = await res.text()
    expect(html).toContain(`https://esm.sh/graphiql@${GRAPHIQL_VERSIONS.graphiql}`)
    expect(html).toContain(`https://esm.sh/react@${GRAPHIQL_VERSIONS.react}`)
    expect(html).toContain('"endpoint":"/graphql"')
    expect(html).toContain('graphql-ws@')
    expect(html).toContain('integrity')
  })

  it('disables GraphiQL and introspection in production by default', async () => {
    const app = await boot({ mode: 'production' })
    const res = await app.request('/graphql', {
      headers: { accept: 'text/html' },
    })
    expect(res.headers.get('content-type')).not.toContain('text/html')
    const { status, body } = await gql(app, '{ __schema { queryType { name } } }')
    expect(status).toBe(400)
    expect(body.errors[0].message).toContain('introspection')

    const enabled = await boot({ mode: 'production', introspection: true })
    expect((await gql(enabled, '{ __schema { queryType { name } } }')).body.data.__schema.queryType.name).toBe('Query')
    // 开发 / 测试环境默认允许内省
    const test = await boot()
    expect((await gql(test, '{ __type(name: "Post") { name } }')).body.data.__type.name).toBe('Post')
  })
})

describe('context and errors', () => {
  it('exposes ctx.auth, ctx.can / authorize and the container to resolvers', async () => {
    const app = await boot()
    expect((await gql(app, '{ me { name } }')).body.data.me).toBeNull()

    const ada = await issueTestCredentials(app, users[0])
    expect((await gql(app, '{ me { name } secret }', {}, ada)).body.data).toEqual({
      me: { name: 'Ada' },
      secret: 'top secret',
    })

    const bob = await issueTestCredentials(app, users[1])
    const { status, body } = await gql(app, '{ secret me { name } }', {}, bob)
    expect(status).toBe(200)
    expect(body.data).toEqual({
      secret: null,
      me: { name: 'Bob' },
    })
    expect(body.errors[0]).toMatchObject({
      message: 'Admins only',
      path: ['secret'],
      extensions: { code: 'FORBIDDEN', status: 403 },
    })

    const container = await gql(app, '{ injected greet(name: "Ada") }')
    expect(container.body.data).toEqual({ injected: 'from the container', greet: 'Hello Ada' })
  })

  it('merges the context factory and maps thrown exceptions to status codes', async () => {
    const app = await boot({
      context: (ctx) => {
        if (ctx.header('x-tenant') === 'blocked')
          throw new NotFoundException('Unknown tenant')
        return {
          tenant: ctx.header('x-tenant'),
        }
      },
      schema: defineSchema({
        typeDefs: 'type Query { tenant: String }',
        resolvers: {
          Query: {
            tenant: (_s, _a, ctx) => (ctx as unknown as { tenant: string }).tenant,
          },
        },
      }),
    })
    expect((await gql(app, '{ tenant }', {}, { 'x-tenant': 'acme' })).body.data).toEqual({ tenant: 'acme' })
    const blocked = await gql(app, '{ tenant }', {}, { 'x-tenant': 'blocked' })
    expect(blocked.status).toBe(404)
    expect(blocked.body.errors[0].extensions).toMatchObject({ code: 'NOT_FOUND', status: 404 })
  })

  it('maps HttpException, validation and unknown errors to GraphQL errors', async () => {
    const app = await boot()
    const { body } = await gql(app, '{ missing broken business greet(name: "x") hello }')
    expect(body.data).toEqual({
      missing: null,
      broken: null,
      business: null,
      greet: null,
      hello: 'Hello world',
    })
    const byField = Object.fromEntries(body.errors!.map(error => [error.path[0], error]))
    expect(byField.missing).toMatchObject({
      message: 'Post 9 not found',
      extensions: { code: 'NOT_FOUND', status: 404 },
    })
    // 非调试模式隐藏未知错误的消息
    expect(byField.broken).toMatchObject({
      message: 'Internal Server Error',
      extensions: { code: 'INTERNAL_SERVER_ERROR' },
    })
    expect(byField.business.extensions).toEqual({ code: 'BUSINESS_ERROR', status: 200, errorCode: 10001 })
    expect(byField.greet).toMatchObject({
      message: 'Validation Failed',
      extensions: {
        code: 'BAD_USER_INPUT',
        status: 422,
        issues: [
          { path: 'name', message: 'name is too short' },
        ],
      },
    })

    const debug = await boot({
      config: {
        app: {
          key: 'k'.repeat(32),
          debug: true,
        },
      },
      formatError: formatted => ({
        ...formatted,
        extensions: { ...formatted.extensions, formatted: true },
      }),
    })
    const shown = await gql(debug, '{ broken }')
    expect(shown.body.errors![0]).toMatchObject({
      message: 'database password is hunter2',
      extensions: { code: 'INTERNAL_SERVER_ERROR', formatted: true },
    })
  })
})

describe('limits', () => {
  it('rejects queries deeper than maxDepth, counting fragments', async () => {
    const app = await boot({ maxDepth: 2 })
    expect((await gql(app, '{ deep { author { name } } }')).body.errors![0]).toMatchObject({
      message: 'Query depth 3 exceeds the maximum allowed depth of 2',
      extensions: { code: 'DEPTH_LIMIT_EXCEEDED' },
    })
    const viaFragment = await gql(app, 'query { deep { ...P } } fragment P on Post { author { id } }')
    expect(viaFragment.body.errors![0].extensions.code).toBe('DEPTH_LIMIT_EXCEEDED')
    expect((await gql(app, '{ deep { title } }')).body.data).toEqual({
      deep: { title: 'Hello' },
    })
  })

  it('rejects queries above maxComplexity using field complexity', async () => {
    const paged = defineSchema({
      typeDefs: 'type Item { id: Int } type Query { items(first: Int!): [Item!]! }',
      resolvers: {
        Query: {
          items: {
            resolve: (_s: unknown, args: { first: number }) => Array.from({ length: args.first }, (_, id) => ({ id })),
            complexity: ({ args, childComplexity }) => Number(args.first) * childComplexity,
          },
        },
      },
    })
    const app = await boot({ schema: paged, maxComplexity: 50 })
    expect((await gql(app, '{ items(first: 10) { id } }')).body.data.items).toHaveLength(10)
    const { status, body } = await gql(app, 'query($n: Int!) { items(first: $n) { id } }', { n: 100 })
    expect(status).toBe(400)
    expect(body.errors![0].extensions).toMatchObject({ code: 'COMPLEXITY_LIMIT_EXCEEDED', complexity: 100, maxComplexity: 50 })
  })
})

describe('loaders', () => {
  it('batches author lookups into one call per request', async () => {
    const app = await boot()
    const { body } = await gql(app, '{ posts { title author { name } } }')
    expect(body.data.posts.map((p: any) => p.author.name)).toEqual(['Ada', 'Bob', 'Ada', 'Cy'])
    expect(batches).toEqual([
      [1, 2, 3],
    ])
    await gql(app, '{ posts { author { id } } }')
    // 每个请求一个 Loader 实例，不跨请求缓存
    expect(batches).toHaveLength(2)
  })

  it('createLoader supports arrays, errors, maxBatchSize, priming and cache keys', async () => {
    const calls: string[][] = []
    const loader = createLoader(async (keys: readonly string[]) => {
      calls.push([...keys])
      return keys.map(key => key === 'bad'
        ? new Error(`no ${key}`)
        : key.toUpperCase())
    }, { maxBatchSize: 2 })
    const results = await Promise.all([
      loader.load('a'),
      loader.load('b'),
      loader.load('c'),
      loader.load('a'),
    ])
    expect(results).toEqual(['A', 'B', 'C', 'A'])
    expect(calls).toEqual([
      ['a', 'b'],
      ['c'],
    ])
    await expect(loader.load('bad')).rejects.toThrow('no bad')
    expect(await loader.loadMany(['a', 'bad'])).toEqual([
      'A',
      expect.any(Error),
    ])
    loader.prime('z', 'primed')
    expect(await loader.load('z')).toBe('primed')
    loader.clear('a')
    await loader.load('a')
    expect(calls.at(-1)).toEqual(['a'])

    const byObject = createLoader(async (keys: ReadonlyArray<{ id: number }>) => keys.map(key => key.id * 2), {
      cacheKey: key => key.id,
    })
    expect(await Promise.all([
      byObject.load({ id: 1 }),
      byObject.load({ id: 1 }),
    ])).toEqual([2, 2])

    const wrongLength = createLoader(async () => [1])
    await expect(Promise.all([
      wrongLength.load(1),
      wrongLength.load(2),
    ])).rejects.toThrow('same length')
  })
})

describe('provider', () => {
  it('mounts GET and POST routes at config/graphql.ts path', async () => {
    const app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        logger: { level: 'silent' },
        graphql: { path: '/api/gql', maxDepth: 1 },
      },
      providers: [
        graphqlProvider(schema),
      ],
    })
    apps.push(app)
    const res = await app.request('/api/gql', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: '{ hello }' }),
    })
    expect(await res.json()).toEqual({
      data: { hello: 'Hello world' },
    })
    const deep = await app.request(`/api/gql?query=${encodeURIComponent('{ deep { id } }')}`)
    expect((await deep.json() as any).errors[0].extensions.code).toBe('DEPTH_LIMIT_EXCEEDED')
    expect(app.router.list().filter(route => route.path === '/api/gql').map(route => route.method).sort()).toEqual(['GET', 'POST'])
  })
})

describe('subscriptions (graphql-transport-ws)', () => {
  const cleanup: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse())
      await fn()
  })

  async function serve(options: GraphQLHandlerOptions = {}) {
    const app = await boot({ subscriptions: true, ...options })
    const server = app.serve({ port: 0, hostname: '127.0.0.1', silent: true })
    await server.ready()
    const url = server.url!.replace(/\/$/, '').replace('http', 'ws')
    apps.splice(apps.indexOf(app), 1)
    cleanup.push(async () => {
      await server.close(true)
      await app.dispose()
    })
    return { app, url: `${url}/graphql` }
  }
  function connect(url: string, protocol = 'graphql-transport-ws') {
    const ws = new WebSocket(url, protocol)
    const messages: any[] = []
    const waiters: Array<() => void> = []
    let closed: { code: number, reason: string } | undefined
    ws.addEventListener('message', (event) => {
      messages.push(JSON.parse(String(event.data)))
      waiters.splice(0).forEach(fn => fn())
    })
    ws.addEventListener('close', (event) => {
      closed = { code: event.code, reason: event.reason }
      waiters.splice(0).forEach(fn => fn())
    })
    cleanup.push(async () => ws.close())
    const until = async (predicate: () => boolean) => {
      while (!predicate())
        await new Promise<void>(resolve => waiters.push(resolve))
    }
    return {
      ws,
      messages,
      opened: new Promise((resolve, reject) => {
        ws.addEventListener('open', resolve)
        ws.addEventListener('error', reject)
      }),
      send: (message: unknown) => ws.send(JSON.stringify(message)),
      next: async (count: number) => {
        await until(() => messages.length >= count)
        return messages.slice(0, count)
      },
      closed: async () => {
        await until(() => closed !== undefined)
        return closed!
      },
    }
  }

  it('acknowledges, streams subscription events and completes', async () => {
    const { url } = await serve()
    const client = connect(url)
    await client.opened
    expect(client.ws.protocol).toBe('graphql-transport-ws')
    client.send({ type: 'connection_init' })
    client.send({ type: 'ping' })
    client.send({
      id: '1',
      type: 'subscribe',
      payload: { query: 'subscription { countdown(from: 2) }' },
    })
    expect(await client.next(6)).toEqual([
      { type: 'connection_ack' },
      { type: 'pong' },
      {
        id: '1',
        type: 'next',
        payload: {
          data: { countdown: 2 },
        },
      },
      {
        id: '1',
        type: 'next',
        payload: {
          data: { countdown: 1 },
        },
      },
      {
        id: '1',
        type: 'next',
        payload: {
          data: { countdown: 0 },
        },
      },
      { id: '1', type: 'complete' },
    ])
  })

  it('pushes pubsub events to subscribers until the client completes', async () => {
    const { app, url } = await serve()
    const client = connect(url)
    await client.opened
    client.send({ type: 'connection_init' })
    client.send({
      id: 'a',
      type: 'subscribe',
      payload: { query: 'subscription { postAdded { title author { name } } }' },
    })
    await client.next(1)
    while (pubsub.listenerCount('postAdded') === 0)
      await new Promise(resolve => setTimeout(resolve, 5))
    // 普通的 HTTP mutation 触发推送
    await gql(app, 'mutation { addPost(title: "Live", authorId: 3) { id } }')
    posts.pop()
    expect((await client.next(2))[1]).toEqual({
      id: 'a',
      type: 'next',
      payload: {
        data: {
          postAdded: {
            title: 'Live',
            author: { name: 'Cy' },
          },
        },
      },
    })
    client.send({ id: 'a', type: 'complete' })
    while (pubsub.listenerCount('postAdded') > 0)
      await new Promise(resolve => setTimeout(resolve, 5))
    // 查询也可以经 WebSocket 执行
    client.send({
      id: 'q',
      type: 'subscribe',
      payload: { query: '{ hello(name: "ws") }' },
    })
    expect((await client.next(4)).slice(2)).toEqual([
      {
        id: 'q',
        type: 'next',
        payload: {
          data: { hello: 'Hello ws' },
        },
      },
      { id: 'q', type: 'complete' },
    ])
  })

  it('authenticates with the connection_init payload and validates operations', async () => {
    const { app, url } = await serve({
      subscriptions: {
        onConnect: async ctx => (await ctx.auth.user()) !== undefined || false,
      },
    })
    const anonymous = connect(url)
    await anonymous.opened
    anonymous.send({ type: 'connection_init' })
    expect((await anonymous.closed()).code).toBe(4403)

    const { authorization } = await issueTestCredentials(app, users[0])
    const client = connect(url)
    await client.opened
    client.send({
      type: 'connection_init',
      payload: { authorization },
    })
    client.send({
      id: '1',
      type: 'subscribe',
      payload: { query: '{ me { name } }' },
    })
    client.send({
      id: '2',
      type: 'subscribe',
      payload: { query: '{ nope }' },
    })
    const messages = await client.next(4)
    expect(messages).toContainEqual({
      id: '1',
      type: 'next',
      payload: {
        data: {
          me: { name: 'Ada' },
        },
      },
    })
    expect(messages.find(message => message.id === '2')).toMatchObject({
      type: 'error',
      payload: [
        {
          extensions: { code: 'GRAPHQL_VALIDATION_FAILED' },
        },
      ],
    })
  })

  it('closes on protocol violations', async () => {
    const { url } = await serve()
    const early = connect(url)
    await early.opened
    early.send({
      id: '1',
      type: 'subscribe',
      payload: { query: '{ hello }' },
    })
    expect((await early.closed()).code).toBe(4401)

    const twice = connect(url)
    await twice.opened
    twice.send({ type: 'connection_init' })
    twice.send({ type: 'connection_init' })
    expect((await twice.closed()).code).toBe(4429)

    const garbage = connect(url)
    await garbage.opened
    garbage.ws.send('not json')
    expect((await garbage.closed()).code).toBe(4400)

    const wrong = new WebSocket(url, 'graphql-ws')
    await expect(new Promise((resolve, reject) => {
      wrong.addEventListener('open', resolve)
      wrong.addEventListener('error', reject)
    })).rejects.toBeTruthy()
  })

  it('times out connections that never initialise', async () => {
    const { url } = await serve({
      subscriptions: { connectionInitWaitTimeout: 50 },
    })
    const client = connect(url)
    await client.opened
    expect((await client.closed()).code).toBe(4408)
  })
})
