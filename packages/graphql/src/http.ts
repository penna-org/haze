import type { HttpContext } from '@hazejs/core'
import type { ExecutionResult, GraphQLSchema } from 'graphql'
import type { GraphQLHandlerOptions, GraphQLParams, RequestFailure, SchemaInput } from './execute'
import { Application, upgradeResponse } from '@hazejs/core'
import { execute, GraphQLError } from 'graphql'
import { formatGraphQLError, reportErrors } from './errors'
import { contextFor, effective, formatResult, isDebug, prepare, resolveSchemaInput } from './execute'
import { renderGraphiQL } from './graphiql'
import { createWebSocketHandler } from './ws'

const GRAPHQL_RESPONSE = 'application/graphql-response+json'
const JSON_TYPE = 'application/json'

type MediaType = typeof GRAPHQL_RESPONSE | typeof JSON_TYPE

/**
 * GraphQL over HTTP 的内容协商：
 * - Accept 包含 application/graphql-response+json → 使用该类型，请求错误返回 4xx；
 * - application/json、通配符或未提供 Accept → application/json（旧客户端，结果总是 200）；
 * - 两者都不接受 → 406。
 */
export function negotiate(accept: string | undefined): MediaType | undefined {
  if (!accept)
    return JSON_TYPE
  const types = accept.split(',')
    .map((part, index) => {
      const [type = '', ...params] = part.split(';').map(item => item.trim().toLowerCase())
      const q = params.find(param => param.startsWith('q='))
      return {
        type,
        q: q
          ? Number(q.slice(2))
          : 1,
        index,
      }
    })
    .filter(item => item.q > 0)
    .sort((a, b) => b.q - a.q || a.index - b.index)
  for (const { type } of types) {
    if (type === GRAPHQL_RESPONSE)
      return GRAPHQL_RESPONSE
    if (type === JSON_TYPE || type === 'application/*' || type === '*/*')
      return JSON_TYPE
  }
  return undefined
}

function respond(body: unknown, status: number, type: MediaType, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': `${type}; charset=utf-8`, ...headers },
  })
}

function requestError(failure: RequestFailure, type: MediaType): Response {
  // application/json：格式正确的请求总是 200（规范对旧客户端的要求）；405 / 415 等协议错误保持原状态
  const status = type === JSON_TYPE && failure.status === 400
    ? 200
    : failure.status
  return respond({ errors: failure.errors }, status, type, failure.headers)
}

function parseJson(value: string | null, name: string): { value?: unknown, error?: string } {
  if (value === null || value === '')
    return {}
  try {
    return {
      value: JSON.parse(value),
    }
  }
  catch {
    return { error: `${name} must be valid JSON` }
  }
}

function wantsHtml(ctx: HttpContext): boolean {
  const accept = ctx.header('accept') ?? ''
  return accept.includes('text/html')
}

async function readParams(ctx: HttpContext): Promise<GraphQLParams | { status: number, message: string, headers?: Record<string, string> }> {
  if (ctx.method === 'GET') {
    const search = ctx.url.searchParams
    const variables = parseJson(search.get('variables'), 'variables')
    const extensions = parseJson(search.get('extensions'), 'extensions')
    const error = variables.error ?? extensions.error
    if (error)
      return { status: 400, message: error }
    return {
      query: search.get('query') ?? undefined,
      operationName: search.get('operationName') || undefined,
      variables: variables.value,
      extensions: extensions.value,
    }
  }
  if (ctx.method !== 'POST') {
    return {
      status: 405,
      message: `Method ${ctx.method} is not allowed`,
      headers: { allow: 'GET, POST' },
    }
  }
  const contentType = (ctx.header('content-type') ?? '').split(';')[0].trim().toLowerCase()
  if (contentType !== JSON_TYPE)
    return { status: 415, message: 'Content-Type must be application/json' }
  let body: unknown
  try {
    // 经 ctx.body() 读取：遵循 bodyLimit（超出时 413），多次读取返回同一结果
    body = await ctx.body()
  }
  catch (error) {
    const status = (error as { status?: number }).status
    return status === 413
      ? { status, message: 'Request body is too large' }
      : { status: 400, message: 'Request body must be valid JSON' }
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return { status: 400, message: 'Request body must be a JSON object' }
  return body as GraphQLParams
}

/** 上下文工厂等执行前抛出的异常：HttpException 按其状态码返回 */
async function contextError(error: unknown, ctx: HttpContext, options: GraphQLHandlerOptions, type: MediaType): Promise<Response> {
  const wrapped = error instanceof GraphQLError
    ? error
    : new GraphQLError((error as Error)?.message ?? String(error), { originalError: error as Error })
  await reportErrors([wrapped], ctx)
  const formatted = formatGraphQLError(wrapped, {
    debug: isDebug(ctx),
    formatError: options.formatError,
  })
  const status = typeof formatted.extensions?.status === 'number'
    ? formatted.extensions.status
    : 500
  return respond({
    errors: [formatted],
  }, status, type)
}

/**
 * GraphQL 路由处理器（GET 与 POST 都可挂载）：
 *
 * ```ts
 * r.get('/graphql', graphqlHandler(schema))
 * r.post('/graphql', graphqlHandler(schema))
 * ```
 *
 * GET 只能执行 query；浏览器访问（Accept: text/html，无 query 参数）时返回 GraphiQL；
 * 开启 subscriptions 时，同一路径的 WebSocket 升级请求按 graphql-transport-ws 协议处理。
 */
export function graphqlHandler(schema: SchemaInput, options: GraphQLHandlerOptions = {}): (ctx: HttpContext) => Promise<Response> {
  const getSchema = resolveSchemaInput(schema)
  return async (ctx) => {
    const resolved: GraphQLSchema = await getSchema()

    if (ctx.method === 'GET' && ctx.header('upgrade')?.toLowerCase() === 'websocket') {
      if (!options.subscriptions)
        return new Response('GraphQL subscriptions are not enabled', { status: 400 })
      return upgradeResponse(ctx, createWebSocketHandler(resolved, options, ctx.make(Application)))
    }

    if (ctx.method === 'GET' && !ctx.url.searchParams.has('query') && wantsHtml(ctx) && effective(options, ctx).graphiql) {
      const graphiql = typeof options.graphiql === 'object'
        ? options.graphiql
        : {}
      return new Response(renderGraphiQL({
        ...graphiql,
        endpoint: ctx.path,
        subscriptions: Boolean(options.subscriptions),
      }), {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    }

    const type = negotiate(ctx.header('accept'))
    if (!type) {
      return respond({
        errors: [
          {
            message: `Accept must include ${GRAPHQL_RESPONSE} or ${JSON_TYPE}`,
            extensions: { code: 'NOT_ACCEPTABLE' },
          },
        ],
      }, 406, JSON_TYPE)
    }

    const params = await readParams(ctx)
    if ('status' in params && typeof params.status === 'number') {
      return respond({
        errors: [
          {
            message: params.message,
            extensions: { code: 'BAD_REQUEST' },
          },
        ],
      }, params.status, type, params.headers)
    }

    const prepared = prepare(resolved, params as GraphQLParams, options, ctx)
    if (prepared.kind === 'request-error')
      return requestError(prepared, type)

    const operation = prepared.operation.operation
    if (ctx.method === 'GET' && operation !== 'query') {
      return respond({
        errors: [
          {
            message: `Can only perform a ${operation} operation from a POST request`,
            extensions: { code: 'METHOD_NOT_ALLOWED' },
          },
        ],
      }, 405, type, { allow: 'POST' })
    }
    if (operation === 'subscription') {
      return requestError({
        kind: 'request-error',
        status: 400,
        errors: [
          {
            message: 'Subscriptions are only supported over WebSocket (graphql-transport-ws)',
            extensions: { code: 'BAD_REQUEST' },
          },
        ],
      }, type)
    }

    let contextValue
    try {
      contextValue = await contextFor(ctx, options)
    }
    catch (error) {
      return contextError(error, ctx, options, type)
    }

    const result = await execute({
      schema: resolved,
      document: prepared.document,
      rootValue: options.rootValue,
      contextValue,
      variableValues: prepared.variables,
      operationName: prepared.operationName,
    }) as ExecutionResult
    const body = await formatResult(result, options, ctx)
    // 变量强制转换失败等情况没有 data：属于请求错误
    const status = type === GRAPHQL_RESPONSE && !('data' in result)
      ? 400
      : 200
    return respond(body, status, type)
  }
}
