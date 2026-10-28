# @hazejs/graphql

GraphQL for hazejs: schema-first (`typeDefs` + `resolvers`) or code-first (graphql-js) schemas, GraphQL over HTTP (GET / POST, `application/graphql-response+json`), GraphiQL, depth and complexity limits, batching loaders, error mapping and `graphql-transport-ws` subscriptions.

## Install

```bash
pnpm add @hazejs/graphql graphql
```

## Usage

```ts
// app/provider/GraphQLProvider.ts
import { defineSchema, graphqlProvider } from '@hazejs/graphql'

const schema = defineSchema({
  typeDefs: `type Query { me: User } type User { id: Int!, name: String! }`,
  resolvers: {
    Query: {
      me: (_, __, ctx) => ctx.auth.user()
    },
  },
})

// GET / POST /graphql (config/graphql.ts), GraphiQL outside production
export default graphqlProvider(schema)
```

Part of [hazejs](https://github.com/penna-org/haze) — see the main README for documentation.

## License

[MIT](./LICENSE)
