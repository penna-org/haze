import type { Application, Container, InjectionKey, Logger, MaybePromise } from '@hazejs/core'
import type { StandardSchemaV1 } from '@standard-schema/spec'

const kHandler = Symbol.for('hazejs.microservices.handler')

export type MessageKind = 'request' | 'event'

export interface MessageContext {
  /** 消息模式（如 `orders.created`） */
  readonly pattern: string
  /** request：调用方在等待回复（send）；event：不需要回复（emit） */
  readonly kind: MessageKind
  readonly id: string
  /** 收到消息的传输名（config/microservices.ts 的 transports 键） */
  readonly transport: string
  readonly app: Application
  readonly logger: Logger
  /** 本条消息的子容器（处理结束后释放），Request 作用域的服务可在此解析 */
  readonly container: Container
  make: <T>(key: InjectionKey<T>) => T
}

export interface MessageHandlerOptions<S extends StandardSchemaV1 | undefined = undefined> {
  /** 校验载荷（Standard Schema：valibot / zod / arktype …），失败时调用方收到 422 */
  schema?: S
  /** 只在这些传输上处理，默认所有监听中的传输 */
  transport?: string | string[]
}

export interface MessageHandler<P = unknown, R = unknown> {
  readonly [kHandler]: true
  readonly pattern: string
  readonly schema?: StandardSchemaV1
  readonly transports?: readonly string[]
  readonly handle: (payload: P, ctx: MessageContext) => MaybePromise<R>
}

export type PayloadOf<H> = H extends MessageHandler<infer P, any> ? P : unknown
export type ReplyOf<H> = H extends MessageHandler<any, infer R> ? Awaited<R> : unknown

/**
 * 定义消息处理器（app/message/*.ts 的默认导出，可为数组）：
 *
 * ```ts
 * // app/message/orders.ts
 * export default [
 *   // 请求 / 回复：Microservice.client('orders').send('orders.find', { id })
 *   defineMessageHandler('orders.find', { schema: v.object({ id: v.number() }) }, async ({ id }) => Order.find(id)),
 *   // 事件：Microservice.client('orders').emit('orders.created', order)，返回值被忽略
 *   defineMessageHandler('orders.created', async (order, ctx) => ctx.logger.info(`order ${order.id}`)),
 * ]
 * ```
 */
export function defineMessageHandler<P = unknown, R = unknown>(pattern: string, handle: (payload: P, ctx: MessageContext) => MaybePromise<R>): MessageHandler<P, R>
export function defineMessageHandler<S extends StandardSchemaV1, R = unknown>(pattern: string, options: MessageHandlerOptions<S> & { schema: S }, handle: (payload: StandardSchemaV1.InferOutput<S>, ctx: MessageContext) => MaybePromise<R>): MessageHandler<StandardSchemaV1.InferInput<S>, R>
export function defineMessageHandler<P = unknown, R = unknown>(pattern: string, options: MessageHandlerOptions, handle: (payload: P, ctx: MessageContext) => MaybePromise<R>): MessageHandler<P, R>
export function defineMessageHandler(pattern: string, optionsOrHandle: MessageHandlerOptions<any> | ((payload: any, ctx: MessageContext) => unknown), maybeHandle?: (payload: any, ctx: MessageContext) => unknown): MessageHandler {
  if (!pattern || typeof pattern !== 'string')
    throw new TypeError('defineMessageHandler() requires a non-empty pattern')
  const options = typeof optionsOrHandle === 'function'
    ? {}
    : optionsOrHandle
  const handle = typeof optionsOrHandle === 'function'
    ? optionsOrHandle
    : maybeHandle
  if (typeof handle !== 'function')
    throw new TypeError(`defineMessageHandler('${pattern}') requires a handler function`)
  const transports = options.transport === undefined
    ? undefined
    : Array.isArray(options.transport)
      ? options.transport
      : [options.transport]
  return {
    [kHandler]: true,
    pattern,
    schema: options.schema,
    transports,
    handle,
  }
}

export function isMessageHandler(value: unknown): value is MessageHandler {
  return typeof value === 'object' && value !== null && kHandler in value
}

/** app.discovered('messages') 的默认导出：单个处理器或数组 */
export function collectHandlers(modules: Array<[string | undefined, unknown]>): MessageHandler[] {
  const handlers: MessageHandler[] = []
  for (const [file, value] of modules) {
    const list = Array.isArray(value)
      ? value
      : [value]
    for (const item of list) {
      if (!isMessageHandler(item))
        throw new TypeError(`app/message/${file ?? '?'}: default export must be defineMessageHandler(...) or an array of them`)
      handlers.push(item)
    }
  }
  return handlers
}
