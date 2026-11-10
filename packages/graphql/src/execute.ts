import type { HttpContext, MaybePromise } from '@hazejs/core'
import type { DocumentNode, ExecutionResult, GraphQLError, GraphQLFormattedError, GraphQLSchema, OperationDefinitionNode, ValidationRule } from 'graphql'
import type { ContextFactory, GraphQLContext } from './context'
import type { FormatError } from './errors'
import type { GraphiQLOptions } from './graphiql'
import { Application } from '@hazejs/core'
import { getOperationAST, NoSchemaIntrospectionCustomRule, parse, specifiedRules, validate } from 'graphql'
import { createContext } from './context'
import { ErrorCode, formatGraphQLError, reportErrors } from './errors'
import { complexityLimit, depthLimit } from './limits'

export interface SubscriptionOptions {
  /** connection_init 的等待时间（毫秒），默认 3000 */
  connectionInitWaitTimeout?: number
  /**
   * 收到 connection_init 时调用：返回 false 拒绝（关闭码 4403），返回对象作为 connection_ack 的 payload。
   * `payload` 中的 `authorization` / `token` 会作为 Authorization 请求头，ctx.auth 即可识别用户。
   */
  onConnect?: (ctx: HttpContext, payload: Record<string, unknown> | undefined) => MaybePromise<boolean | Record<string, unknown> | void>
  /** 单个连接上同时进行的操作（订阅）数上限，默认 100；超出的 subscribe 以 error 消息拒绝 */
  maxSubscriptionsPerConnection?: number
}

export interface GraphQLHandlerOptions {
  /** 额外的上下文字段：`context: ctx => ({ tenant: ctx.header('x-tenant') })` */
  context?: ContextFactory
  rootValue?: unknown
  /** GraphiQL 页面（浏览器 GET 访问），默认非生产环境开启 */
  graphiql?: boolean | GraphiQLOptions
  /** 内省查询，默认非生产环境开启 */
  introspection?: boolean
  /** 最大查询深度，默认 15；false 关闭 */
  maxDepth?: number | false
  /** 最大复杂度（字段默认各计 1），默认不限制 */
  maxComplexity?: number | false
  /** 追加的校验规则 */
  validationRules?: ValidationRule[]
  /** 调整返回给客户端的错误 */
  formatError?: FormatError
  /** 订阅：同一路径上的 WebSocket（graphql-transport-ws 协议），默认关闭 */
  subscriptions?: boolean | SubscriptionOptions
}

export type SchemaInput = GraphQLSchema | (() => MaybePromise<GraphQLSchema | { default: GraphQLSchema }>)

export interface GraphQLParams {
  query?: unknown
  variables?: unknown
  operationName?: unknown
  extensions?: unknown
}

/** 请求错误：在执行之前失败（参数非法、解析或校验失败），HTTP 层据此决定状态码 */
export interface RequestFailure {
  kind: 'request-error'
  /** 400 / 405 等；graphql-response+json 时使用 */
  status: number
  errors: GraphQLFormattedError[]
  headers?: Record<string, string>
}

export interface Prepared {
  kind: 'prepared'
  document: DocumentNode
  operation: OperationDefinitionNode
  variables: Record<string, unknown> | undefined
  operationName: string | undefined
}

export function resolveSchemaInput(input: SchemaInput): () => Promise<GraphQLSchema> {
  let cached: Promise<GraphQLSchema> | undefined
  return () => cached ??= (async () => {
    if (typeof input !== 'function')
      return input
    const value = await input()
    return 'default' in value && !('getQueryType' in value)
      ? value.default
      : value as GraphQLSchema
  })()
}

function failure(status: number, message: string, code: string, headers?: Record<string, string>): RequestFailure {
  return {
    kind: 'request-error',
    status,
    errors: [
      {
        message,
        extensions: { code },
      },
    ],
    headers,
  }
}

function isMode(ctx: HttpContext, mode: string): boolean {
  try {
    return ctx.make(Application).mode === mode
  }
  catch {
    return false
  }
}

export function isDebug(ctx: HttpContext): boolean {
  return Boolean(ctx.config.get<boolean>('app.debug', false))
}

/** 本次执行的选项（未设置时按应用模式取默认值） */
export function effective(options: GraphQLHandlerOptions, ctx: HttpContext): { introspection: boolean, graphiql: boolean } {
  const production = isMode(ctx, 'production')
  return {
    introspection: options.introspection ?? !production,
    graphiql: options.graphiql === undefined
      ? !production
      : options.graphiql !== false,
  }
}

interface Validated {
  document: DocumentNode
  errors: readonly GraphQLError[]
}

/** 每组（schema, options）缓存的文档数，以及参与缓存的查询长度上限（过长的查询每次重新解析，避免缓存占用过多内存） */
const DOCUMENT_CACHE_SIZE = 500
const DOCUMENT_CACHE_MAX_QUERY_LENGTH = 20_000

/**
 * 解析 + 静态校验结果的缓存：按 schema 与 options 对象分开（HMR 换了 schema、或多个端点各自的 schema 互不混用），
 * 内层是按查询字符串的 LRU。依赖变量的复杂度检查不在其中，每次请求单独执行。
 */
const documentCache = new WeakMap<GraphQLSchema, WeakMap<GraphQLHandlerOptions, Map<string, Validated>>>()
/** 每个 options 对象的静态校验规则（不必每次请求重建数组），按是否允许内省分两份 */
const staticRules = new WeakMap<GraphQLHandlerOptions, Map<string, ValidationRule[]>>()

function rulesFor(options: GraphQLHandlerOptions, introspection: boolean): { key: string, rules: ValidationRule[] } {
  const depth = options.maxDepth === false
    ? false
    : options.maxDepth ?? 15
  // maxDepth 进入键：options 对象被原地修改时不会用到旧规则
  const key = `${introspection ? 1 : 0}:${depth}`
  let byKey = staticRules.get(options)
  if (!byKey)
    staticRules.set(options, byKey = new Map())
  let rules = byKey.get(key)
  if (!rules) {
    rules = [
      ...specifiedRules,
      ...(options.validationRules ?? []),
    ]
    if (depth !== false)
      rules.push(depthLimit(depth))
    if (!introspection)
      rules.push(NoSchemaIntrospectionCustomRule)
    byKey.set(key, rules)
  }
  return { key, rules }
}

/** 解析并做静态校验（带缓存）；解析失败时抛出 GraphQLError */
function parseAndValidate(schema: GraphQLSchema, query: string, options: GraphQLHandlerOptions, introspection: boolean): Validated {
  const { key, rules } = rulesFor(options, introspection)
  const cacheable = query.length <= DOCUMENT_CACHE_MAX_QUERY_LENGTH
  let byOptions = documentCache.get(schema)
  if (!byOptions)
    documentCache.set(schema, byOptions = new WeakMap())
  let cache = byOptions.get(options)
  if (!cache)
    byOptions.set(options, cache = new Map())
  const cacheKey = `${key}:${query}`
  const hit = cache.get(cacheKey)
  if (hit) {
    // LRU：命中的移到最后
    cache.delete(cacheKey)
    cache.set(cacheKey, hit)
    return hit
  }
  const document = parse(query)
  const entry: Validated = {
    document,
    errors: validate(schema, document, rules),
  }
  if (cacheable) {
    cache.set(cacheKey, entry)
    if (cache.size > DOCUMENT_CACHE_SIZE)
      cache.delete(cache.keys().next().value!)
  }
  return entry
}

/** 解析参数、解析文档、校验，确定要执行的操作 */
export function prepare(schema: GraphQLSchema, params: GraphQLParams, options: GraphQLHandlerOptions, ctx: HttpContext): Prepared | RequestFailure {
  const { query, operationName, variables } = params
  if (typeof query !== 'string' || !query.trim())
    return failure(400, 'Missing query', ErrorCode.BAD_REQUEST)
  if (operationName != null && typeof operationName !== 'string')
    return failure(400, 'operationName must be a string', ErrorCode.BAD_REQUEST)
  if (variables != null && (typeof variables !== 'object' || Array.isArray(variables)))
    return failure(400, 'variables must be an object', ErrorCode.BAD_REQUEST)

  let document: DocumentNode
  let errors: readonly GraphQLError[]
  try {
    ({ document, errors } = parseAndValidate(schema, query, options, effective(options, ctx).introspection))
  }
  catch (error) {
    return {
      kind: 'request-error',
      status: 400,
      errors: [
        formatGraphQLError(error as GraphQLError, {
          debug: isDebug(ctx),
          formatError: options.formatError,
        }),
      ],
    }
  }
  // 复杂度依赖本次请求的变量，不能缓存；仅在静态校验通过后计算
  if (!errors.length && options.maxComplexity) {
    errors = validate(schema, document, [
      complexityLimit(options.maxComplexity, (variables ?? {}) as Record<string, unknown>),
    ])
  }
  if (errors.length) {
    return {
      kind: 'request-error',
      status: 400,
      errors: errors.map(error => formatGraphQLError(error, {
        debug: isDebug(ctx),
        formatError: options.formatError,
      })),
    }
  }

  const operation = getOperationAST(document, operationName ?? undefined)
  if (!operation) {
    return failure(400, operationName
      ? `Unknown operation named "${operationName}"`
      : 'Must provide operation name if query contains multiple operations', ErrorCode.OPERATION_RESOLUTION_FAILURE)
  }
  return {
    kind: 'prepared',
    document,
    operation,
    variables: (variables ?? undefined) as Record<string, unknown> | undefined,
    operationName: (operationName ?? undefined) as string | undefined,
  }
}

export function contextFor(http: HttpContext, options: GraphQLHandlerOptions, extra?: Record<string, unknown>): Promise<GraphQLContext> {
  return createContext(http, options.context, extra)
}

/** 执行结果中的错误 → 响应格式，并上报未知错误 */
export async function formatResult(result: ExecutionResult, options: GraphQLHandlerOptions, ctx: HttpContext): Promise<Record<string, unknown>> {
  await reportErrors(result.errors, ctx)
  const debug = isDebug(ctx)
  return {
    ...(result.errors?.length && {
      errors: result.errors.map(error => formatGraphQLError(error, { debug, formatError: options.formatError })),
    }),
    ...('data' in result && { data: result.data }),
    ...(result.extensions && { extensions: result.extensions }),
  }
}
