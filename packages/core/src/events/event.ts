import type { Application } from '../application'
import type { Logger } from '../logger'
import type { Backoff } from '../queue/job'
import type { MaybePromise } from '../utils'
import { useEventManager } from './context'

const kEvent = Symbol.for('hazejs.event')
const kListener = Symbol.for('hazejs.listener')

/** 触发事件时同时广播到频道（见 Broadcasting） */
export interface EventBroadcastOptions<P = void> {
  /** 广播到的频道（如 `privateChannel('orders.1')`），返回空时不广播 */
  broadcastOn?: (payload: P) => string | string[] | undefined | null
  /** 客户端收到的事件名，默认为事件名（app/event 下的文件名） */
  broadcastAs?: string | ((payload: P) => string)
  /** 广播的数据，默认为 payload */
  broadcastWith?: (payload: P) => unknown
  /** 返回 false 时不广播 */
  broadcastWhen?: (payload: P) => boolean
}

export interface EventOptions<P = void> extends EventBroadcastOptions<P> {
  /** 事件名，默认 app/event 下的文件名 */
  name?: string
  /**
   * 在数据库事务中触发时，推迟到最外层事务提交后再执行监听器与广播（回滚时丢弃）；不在事务中时立即触发。
   * 需要注册了事务实现的数据库包（@hazejs/orm）
   */
  afterCommit?: boolean
}

export interface EventDefinition<P = void> extends EventBroadcastOptions<P> {
  readonly [kEvent]: true
  /** 事件名，默认 app/event 下的文件名 */
  readonly name?: string
  /** 处于数据库事务中时推迟到提交后触发 */
  readonly afterCommit?: boolean
  /** 触发事件：依次执行同步监听器（一个失败不影响其余，错误记录日志），排队监听器投递到队列；无载荷的事件可以省略 payload */
  emit: (...args: EmitArgs<P>) => Promise<void>
}

/**
 * 定义事件（app/event/*.ts 的默认导出，文件名即事件名）：
 *
 * ```ts
 * export default defineEvent<{ userId: number }>()
 * await UserRegistered.emit({ userId: 1 })
 * ```
 *
 * 声明 `broadcastOn` 时，触发事件会同时广播到这些频道（在监听器之前，Events.fake() 时不广播）：
 *
 * ```ts
 * export default defineEvent<{ orderId: number }>({
 *   broadcastOn: ({ orderId }) => privateChannel(`orders.${orderId}`),
 * })
 * ```
 */
export function defineEvent<P = void>(options: EventOptions<P> = {}): EventDefinition<P> {
  const event: EventDefinition<P> = {
    ...options,
    [kEvent]: true,
    name: options.name,
    emit: (...args) => useEventManager().emit(event, ...args),
  }
  return event
}

/** `emit()` 的参数：载荷类型为 void / undefined 时可以省略 */
export type EmitArgs<P> = [P] extends [void | undefined]
  ? [payload?: P]
  : [payload: P]

export function isEvent(value: unknown): value is EventDefinition<any> {
  return typeof value === 'object' && value !== null && kEvent in value
}

export interface ListenerContext {
  /** 事件名 */
  event: string
  app: Application
  logger: Logger
  /** 排队执行时为第几次执行，同步执行时为 1 */
  attempt: number
}

/** 排队执行的选项（与 defineJob 相同的重试语义） */
export interface QueuedListenerOptions {
  tries?: number
  backoff?: Backoff
  timeout?: string | number
  queue?: string
  connection?: string
  /** 延迟执行：秒数 / '10m' */
  delay?: string | number
}

export interface ListenerOptions {
  /** 排队异步执行（payload 以 JSON 传递，建议传 ID 而非模型实例） */
  queue?: boolean | QueuedListenerOptions
}

/** 返回 false 时不再执行后续的同步监听器 */
export type ListenerHandler<P> = (payload: P, ctx: ListenerContext) => MaybePromise<unknown>

export interface ListenerDefinition<P = unknown> {
  readonly [kListener]: true
  readonly events: EventDefinition<P>[]
  readonly handle: ListenerHandler<P>
  readonly options: ListenerOptions
  /** 监听器名，默认 app/listener 下的文件名 */
  readonly name?: string
}

/**
 * 定义监听器（app/listener/*.ts 的默认导出，自动注册）：
 *
 * ```ts
 * export default defineListener(UserRegistered, async ({ userId }, ctx) => { ... }, { queue: { tries: 3 } })
 * ```
 */
/** 事件的 payload 类型（监听多个事件时为联合类型） */
export type PayloadOf<E> = E extends EventDefinition<infer P> ? P : never

export function defineListener<E extends EventDefinition<any>>(event: E | E[], handle: ListenerHandler<PayloadOf<E>>, options: ListenerOptions & { name?: string } = {}): ListenerDefinition<PayloadOf<E>> {
  const { name, ...rest } = options
  return {
    [kListener]: true,
    events: (Array.isArray(event)
      ? event
      : [event]) as EventDefinition<any>[],
    handle,
    options: rest,
    name,
  }
}

export function isListener(value: unknown): value is ListenerDefinition<any> {
  return typeof value === 'object' && value !== null && kListener in value
}
