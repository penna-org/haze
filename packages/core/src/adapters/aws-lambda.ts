import { Buffer } from 'node:buffer'
import { setClientAddress } from '../http/client-ip'

/**
 * AWS Lambda 适配：API Gateway HTTP API（v2）、REST API（v1）、ALB 与 Lambda Function URL 事件
 * ↔ Web Request / Response。
 */

type FetchHandler = (request: Request) => Promise<Response> | Response

export interface LambdaEvent {
  /** v2 / Function URL 为 '2.0' */
  version?: string
  // v2
  rawPath?: string
  rawQueryString?: string
  cookies?: string[]
  requestContext?: {
    http?: { method: string, sourceIp?: string }
    /** v1（REST API）事件的客户端地址 */
    identity?: { sourceIp?: string }
    domainName?: string
  }
  // v1 / ALB
  httpMethod?: string
  path?: string
  queryStringParameters?: Record<string, string | undefined> | null
  multiValueQueryStringParameters?: Record<string, string[] | undefined> | null
  multiValueHeaders?: Record<string, string[] | undefined> | null
  // 通用
  headers?: Record<string, string | undefined> | null
  body?: string | null
  isBase64Encoded?: boolean
}

export interface LambdaResult {
  statusCode: number
  headers?: Record<string, string>
  multiValueHeaders?: Record<string, string[]>
  cookies?: string[]
  body: string
  isBase64Encoded: boolean
}

/**
 * 创建 Lambda handler；`getHandler` 在首次调用时执行（冷启动时创建应用）
 *
 * ```ts
 * export const handler = createLambdaHandler(async () => (await createApp()).fetch)
 * ```
 */
export function createLambdaHandler(getHandler: () => Promise<FetchHandler> | FetchHandler): (event: LambdaEvent, context?: unknown) => Promise<LambdaResult> {
  let handler: Promise<FetchHandler> | undefined
  return async (event) => {
    handler ??= Promise.resolve(getHandler())
    const response = await (await handler)(lambdaEventToRequest(event))
    return responseToLambdaResult(response, event.version === '2.0')
  }
}

export function lambdaEventToRequest(event: LambdaEvent): Request {
  const v2 = event.version === '2.0'
  const headers = new Headers()
  if (event.multiValueHeaders) {
    for (const [key, values] of Object.entries(event.multiValueHeaders))
      values?.forEach(value => headers.append(key, value))
  }
  else {
    for (const [key, value] of Object.entries(event.headers ?? {})) {
      if (value !== undefined)
        headers.set(key, value)
    }
  }
  // v2 把 Cookie 单独放在 cookies 数组中
  if (v2 && event.cookies?.length)
    headers.set('cookie', event.cookies.join('; '))

  const method = (v2 ? event.requestContext?.http?.method : event.httpMethod) ?? 'GET'
  const path = (v2 ? event.rawPath : event.path) ?? '/'
  const host = headers.get('host') ?? event.requestContext?.domainName ?? 'localhost'
  const protocol = headers.get('x-forwarded-proto') ?? 'https'
  const url = new URL(`${protocol}://${host}${path}`)

  if (v2) {
    url.search = event.rawQueryString ?? ''
  }
  else if (event.multiValueQueryStringParameters) {
    for (const [key, values] of Object.entries(event.multiValueQueryStringParameters))
      values?.forEach(value => url.searchParams.append(key, value))
  }
  else {
    for (const [key, value] of Object.entries(event.queryStringParameters ?? {})) {
      if (value !== undefined)
        url.searchParams.append(key, value)
    }
  }

  const hasBody = event.body != null && method !== 'GET' && method !== 'HEAD'
  const body = hasBody
    ? (event.isBase64Encoded
        ? new Uint8Array(Buffer.from(event.body!, 'base64'))
        : event.body!)
    : undefined
  // API Gateway / Function URL 给出的客户端地址（ALB 事件没有，位于 ALB 之后请开启 trustProxy）
  const sourceIp = v2
    ? event.requestContext?.http?.sourceIp
    : event.requestContext?.identity?.sourceIp
  return setClientAddress(new Request(url, { method, headers, body }), sourceIp)
}

const TEXT_TYPE = /^(?:text\/|application\/(?:json|xml|javascript|x-www-form-urlencoded|.*\+json|.*\+xml))/

export async function responseToLambdaResult(response: Response, v2: boolean): Promise<LambdaResult> {
  const contentType = response.headers.get('content-type') ?? ''
  const isText = !contentType || TEXT_TYPE.test(contentType)
  const buffer = new Uint8Array(await response.arrayBuffer())
  // Lambda 只运行在 Node.js，二进制直接用 Buffer 编码（避免大文件展开参数导致栈溢出）
  const body = isText
    ? new TextDecoder().decode(buffer)
    : Buffer.from(buffer).toString('base64')
  const cookies = response.headers.getSetCookie()

  if (v2) {
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie')
        headers[key] = value
    })
    return {
      statusCode: response.status,
      headers,
      cookies,
      body,
      isBase64Encoded: !isText,
    }
  }

  const multiValueHeaders: Record<string, string[]> = {}
  response.headers.forEach((value, key) => {
    if (key !== 'set-cookie')
      multiValueHeaders[key] = [value]
  })
  if (cookies.length)
    multiValueHeaders['set-cookie'] = cookies
  return {
    statusCode: response.status,
    multiValueHeaders,
    body,
    isBase64Encoded: !isText,
  }
}

/**
 * Web Request → API Gateway HTTP API（v2）事件：本地预览 / 测试中调用 Lambda handler
 */
export async function requestToLambdaEvent(request: Request): Promise<LambdaEvent> {
  const url = new URL(request.url)
  const headers: Record<string, string> = {}
  request.headers.forEach((value, key) => {
    if (key !== 'cookie')
      headers[key] = value
  })
  headers.host ??= url.host
  const cookie = request.headers.get('cookie')
  const body = request.body
    ? Buffer.from(await request.arrayBuffer())
    : undefined
  return {
    version: '2.0',
    rawPath: url.pathname,
    rawQueryString: url.search.slice(1),
    ...(cookie && {
      cookies: cookie.split(/;\s*/),
    }),
    headers,
    requestContext: {
      http: { method: request.method, sourceIp: '127.0.0.1' },
      domainName: url.host,
    },
    ...(body?.length && {
      body: body.toString('base64'),
      isBase64Encoded: true,
    }),
  }
}

/** Lambda 返回结果（v1 / v2）→ Web Response */
export function lambdaResultToResponse(result: LambdaResult): Response {
  const headers = new Headers()
  for (const [key, value] of Object.entries(result.headers ?? {}))
    headers.set(key, value)
  for (const [key, values] of Object.entries(result.multiValueHeaders ?? {}))
    values.forEach(value => headers.append(key, value))
  result.cookies?.forEach(cookie => headers.append('set-cookie', cookie))
  const empty = result.statusCode === 204 || result.statusCode === 304
  const body = empty
    ? null
    : result.isBase64Encoded
      ? new Uint8Array(Buffer.from(result.body, 'base64'))
      : result.body
  return new Response(body, { status: result.statusCode, headers })
}
