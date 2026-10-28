import type { ConfigInput, MiddlewareRef, ServiceProvider } from '@hazejs/core'
import type { GraphQLHandlerOptions, SchemaInput, SubscriptionOptions } from './execute'
import type { GraphiQLOptions } from './graphiql'
import { defineRoutes } from '@hazejs/core'
import { graphqlHandler } from './http'

/** `config/graphql.ts` */
export interface GraphQLConfig {
  /** 路径，默认 `/graphql` */
  path?: string
  /** GraphiQL，默认非生产环境开启 */
  graphiql?: boolean | GraphiQLOptions
  /** 内省，默认非生产环境开启 */
  introspection?: boolean
  /** 最大查询深度，默认 15；false 关闭 */
  maxDepth?: number | false
  /** 最大复杂度，默认不限制 */
  maxComplexity?: number | false
  /** 订阅（同一路径上的 WebSocket），默认关闭 */
  subscriptions?: boolean | SubscriptionOptions
}

/** `config/graphql.ts` 的默认导出 */
export function defineGraphQLConfig(config: GraphQLConfig | (() => GraphQLConfig)): ConfigInput<GraphQLConfig> {
  return config
}

export interface GraphQLProviderOptions extends GraphQLHandlerOptions {
  /** 覆盖 config/graphql.ts 的 path */
  path?: string
  /** 路由中间件（如 throttle、可选的 authenticate） */
  middleware?: MiddlewareRef[]
}

/**
 * GraphQL 服务提供者（app/provider/GraphQLProvider.ts）：
 *
 * ```ts
 * import { graphqlProvider } from '@hazejs/graphql'
 * import schema from '~/app/graphql/schema'
 *
 * export default graphqlProvider(schema, { context: ctx => ({ tenant: ctx.header('x-tenant') }) })
 * ```
 *
 * 在 config/graphql.ts 的 path（默认 /graphql）注册 GET 与 POST 路由；选项优先于配置文件。
 * schema 也可以是返回 schema（或 `import()`）的函数，第一次请求时加载。
 */
export function graphqlProvider(schema: SchemaInput, options: GraphQLProviderOptions = {}): ServiceProvider {
  return {
    register(_container, app) {
      const { path: configPath, ...config } = app.config.get<GraphQLConfig>('graphql', {})
      const { path = configPath ?? '/graphql', middleware = [], ...rest } = options
      const handler = graphqlHandler(schema, {
        ...config,
        ...rest,
      })
      app.router.load(defineRoutes((r) => {
        // GraphQL 端点不出现在 OpenAPI 文档中
        r.get(path, handler).middleware(...middleware).doc({ hidden: true })
        r.post(path, handler).middleware(...middleware).doc({ hidden: true })
      }))
    },
  }
}
