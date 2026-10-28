import type { Application, HttpContext, Peer, WebSocketHandler } from '@hazejs/core'
import type { ExecutionResult, GraphQLSchema } from 'graphql'
import type { GraphQLHandlerOptions, SubscriptionOptions } from './execute'
import { execute, GraphQLError, subscribe } from 'graphql'
import { formatGraphQLError, reportErrors } from './errors'
import { contextFor, formatResult, isDebug, prepare } from './execute'

/** graphql-transport-ws 协议（graphql-ws 库使用的协议） */
export const GRAPHQL_TRANSPORT_WS = 'graphql-transport-ws'

/** 协议定义的关闭码 */
const Close = {
  BadRequest: 4400,
  Unauthorized: 4401,
  Forbidden: 4403,
  ConnectionInitTimeout: 4408,
  SubscriberAlreadyExists: 4409,
  TooManyInitRequests: 4429,
  InternalError: 4500,
} as const

interface Message {
  type: string
  id?: string
  payload?: Record<string, unknown>
}

function parseMessage(text: string): Message | undefined {
  try {
    const message = JSON.parse(text) as Message
    if (typeof message !== 'object' || message === null || typeof message.type !== 'string')
      return undefined
    if ((message.type === 'subscribe' || message.type === 'complete') && (typeof message.id !== 'string' || !message.id))
      return undefined
    if (message.type === 'subscribe' && (typeof message.payload !== 'object' || message.payload === null))
      return undefined
    return message
  }
  catch {
    return undefined
  }
}

function offered(request: Request): string[] {
  return (request.headers.get('sec-websocket-protocol') ?? '').split(',').map(item => item.trim()).filter(Boolean)
}

/** connection_init 的 payload 中的令牌作为 Authorization 头 */
function authorizationFrom(payload: Record<string, unknown> | undefined): string | undefined {
  const value = payload?.authorization ?? payload?.Authorization ?? payload?.token
  if (typeof value !== 'string' || !value)
    return undefined
  return /^\w+ /.test(value)
    ? value
    : `Bearer ${value}`
}

/**
 * 为一次升级请求创建 WebSocket 处理器（每个连接一个，状态保存在闭包中）。
 * 升级请求的请求级容器在升级完成后即释放，因此在 connection_init 时用 app.contextFor()
 * 按升级请求的请求头（Cookie / Authorization）加上 payload 中的令牌重新创建上下文，连接关闭时释放。
 */
export function createWebSocketHandler(schema: GraphQLSchema, options: GraphQLHandlerOptions, app: Application): WebSocketHandler {
  const settings: SubscriptionOptions = typeof options.subscriptions === 'object'
    ? options.subscriptions
    : {}
  const operations = new Map<string, AsyncGenerator<ExecutionResult, void, void> | undefined>()
  let initTimer: ReturnType<typeof setTimeout> | undefined
  let initReceived = false
  let acknowledged = false
  let connection: HttpContext | undefined
  // 按顺序处理同一连接上的消息（connection_init 的鉴权完成之前不处理后续消息）
  let queue: Promise<void> = Promise.resolve()
  let closed = false

  const send = (peer: Peer, message: Message): void => {
    if (!closed)
      peer.send(JSON.stringify(message))
  }
  const close = (peer: Peer, code: number, reason: string): void => {
    peer.close(code, reason)
  }

  const cleanup = async (): Promise<void> => {
    closed = true
    clearTimeout(initTimer)
    for (const iterator of operations.values())
      await iterator?.return?.().catch(() => {})
    operations.clear()
    await connection?.container.dispose().catch(() => {})
  }

  const init = async (peer: Peer, message: Message): Promise<void> => {
    if (initReceived)
      return close(peer, Close.TooManyInitRequests, 'Too many initialisation requests')
    initReceived = true
    clearTimeout(initTimer)
    const headers = new Headers(peer.request?.headers)
    const authorization = authorizationFrom(message.payload)
    if (authorization)
      headers.set('authorization', authorization)
    connection = app.contextFor(new Request(peer.request?.url ?? 'http://localhost/', { headers }))
    let accepted: boolean | Record<string, unknown> | void = true
    try {
      accepted = await settings.onConnect?.(connection, message.payload)
    }
    catch {
      accepted = false
    }
    if (accepted === false)
      return close(peer, Close.Forbidden, 'Forbidden')
    acknowledged = true
    send(peer, {
      type: 'connection_ack',
      ...(typeof accepted === 'object' && { payload: accepted }),
    })
  }

  const run = async (peer: Peer, id: string, payload: Record<string, unknown>): Promise<void> => {
    const http = connection!
    const sendErrors = (errors: readonly GraphQLError[]): void => {
      operations.delete(id)
      send(peer, {
        id,
        type: 'error',
        payload: errors.map(error => formatGraphQLError(error, {
          debug: isDebug(http),
          formatError: options.formatError,
        })) as never,
      })
    }
    const prepared = prepare(schema, payload, options, http)
    if (prepared.kind === 'request-error') {
      operations.delete(id)
      send(peer, { id, type: 'error', payload: prepared.errors as never })
      return
    }
    let contextValue
    try {
      contextValue = await contextFor(http, options)
    }
    catch (error) {
      const wrapped = new GraphQLError((error as Error)?.message ?? String(error), { originalError: error as Error })
      await reportErrors([wrapped], http)
      sendErrors([wrapped])
      return
    }
    const args = {
      schema,
      document: prepared.document,
      rootValue: options.rootValue,
      contextValue,
      variableValues: prepared.variables,
      operationName: prepared.operationName,
    }

    if (prepared.operation.operation !== 'subscription') {
      const result = await execute(args) as ExecutionResult
      if (!operations.has(id))
        return
      send(peer, { id, type: 'next', payload: await formatResult(result, options, http) })
      operations.delete(id)
      send(peer, { id, type: 'complete' })
      return
    }

    const result = await subscribe(args)
    if (!(Symbol.asyncIterator in result)) {
      // 订阅建立失败（如 subscribe 函数抛错）：按协议以 error 消息返回
      if (result.errors?.length && !('data' in result && result.data))
        return sendErrors(result.errors)
      send(peer, { id, type: 'next', payload: await formatResult(result, options, http) })
      operations.delete(id)
      send(peer, { id, type: 'complete' })
      return
    }
    // 订阅在建立期间已被客户端取消
    if (!operations.has(id)) {
      await result.return?.()
      return
    }
    operations.set(id, result)
    for await (const event of result) {
      if (!operations.has(id))
        break
      send(peer, { id, type: 'next', payload: await formatResult(event, options, http) })
    }
    if (operations.delete(id))
      send(peer, { id, type: 'complete' })
  }

  return {
    upgrade(request) {
      // crossws 不自动选择子协议（Node 上 handleProtocols 返回 false），由此处写入响应头
      if (!offered(request).includes(GRAPHQL_TRANSPORT_WS))
        return new Response(`Sec-WebSocket-Protocol must include ${GRAPHQL_TRANSPORT_WS}`, { status: 400 })
      return {
        headers: { 'sec-websocket-protocol': GRAPHQL_TRANSPORT_WS },
      }
    },
    open(peer) {
      initTimer = setTimeout(() => {
        if (!initReceived)
          close(peer, Close.ConnectionInitTimeout, 'Connection initialisation timeout')
      }, settings.connectionInitWaitTimeout ?? 3000)
    },
    message(peer, raw) {
      const text = raw.text()
      queue = queue.then(() => handle(peer, text)).catch((error) => {
        app.logger.error('GraphQL WebSocket message failed', error)
        close(peer, Close.InternalError, 'Internal server error')
      })
      return queue
    },
    close: cleanup,
    error: cleanup,
  }

  async function handle(peer: Peer, text: string): Promise<void> {
    const message = parseMessage(text)
    if (!message)
      return close(peer, Close.BadRequest, 'Invalid message received')
    switch (message.type) {
      case 'connection_init':
        return init(peer, message)
      case 'ping':
        return send(peer, {
          type: 'pong',
          ...(message.payload && { payload: message.payload }),
        })
      case 'pong':
        return
      case 'subscribe': {
        if (!acknowledged)
          return close(peer, Close.Unauthorized, 'Unauthorized')
        const id = message.id!
        if (operations.has(id))
          return close(peer, Close.SubscriberAlreadyExists, `Subscriber for ${id} already exists`)
        operations.set(id, undefined)
        // 不等待：订阅会一直运行，期间还要处理同一连接上的其它消息（如 complete）
        run(peer, id, message.payload!).catch((error) => {
          operations.delete(id)
          app.logger.error('GraphQL subscription failed', error)
          close(peer, Close.InternalError, 'Internal server error')
        })
        return
      }
      case 'complete': {
        const iterator = operations.get(message.id!)
        operations.delete(message.id!)
        await iterator?.return?.()
        return
      }
      default:
        return close(peer, Close.BadRequest, `Unexpected message of type ${message.type} received`)
    }
  }
}
