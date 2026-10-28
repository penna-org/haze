import type { EventDefinition } from '../events/event'
import type { PresenceMember } from './channels'
import type { BroadcastFake, BroadcastInput, BroadcastManager } from './manager'
import { EventManager } from '../events/manager'
import { getRequestStore } from '../request'

let fallback: BroadcastManager | undefined
let token: unknown

/** @internal */
export function setBroadcastManager(manager: BroadcastManager | undefined, key: unknown): void {
  fallback = manager
  token = key
}

/** 当前应用的广播管理器：请求内取请求容器，否则取最近启动的应用 */
export function useBroadcastManager(): BroadcastManager {
  const manager = (token && getRequestStore()?.container.make(token as never)) as BroadcastManager | undefined ?? fallback
  if (!manager)
    throw new Error('Broadcasting is not available: the application has not booted')
  return manager
}

/**
 * 服务端广播：
 *
 * ```ts
 * await broadcast({ channel: privateChannel(`orders.${id}`), event: 'OrderShipped', data: { id } })
 * await broadcast({ channel: 'presence-chat.1', event: 'Typing', data, toOthers: true })
 * await broadcast(OrderShipped, { orderId: 1 })   // 使用事件的 broadcastOn / broadcastAs / broadcastWith，不执行监听器
 * ```
 */
export function broadcast(input: BroadcastInput): Promise<void>
export function broadcast<P>(event: EventDefinition<P>, payload: P): Promise<void>
export function broadcast(input: BroadcastInput | EventDefinition<any>, payload?: unknown): Promise<void> {
  return 'event' in input && typeof input.event === 'string'
    ? useBroadcastManager().broadcast(input as BroadcastInput)
    : broadcastEvent(input as EventDefinition<any>, payload)
}

/** 按事件的 broadcastOn 广播（事件名取 app/event 下的文件名） */
function broadcastEvent<P>(event: EventDefinition<P>, payload: P): Promise<void> {
  const manager = useBroadcastManager()
  const events = manager.app.container.has(EventManager)
    ? manager.app.make(EventManager)
    : undefined
  return manager.broadcastEvent(event, payload, events?.nameOf(event))
}

/**
 * 广播门面：
 *
 * ```ts
 * await Broadcast.send({ channel: 'news', event: 'Published', data })
 * const members = await Broadcast.members('presence-chat.1')
 * const fake = Broadcast.fake()
 * fake.assertBroadcastOn('private-orders.1', 'OrderShipped')
 * ```
 */
export const Broadcast = {
  send: (input: BroadcastInput): Promise<void> => useBroadcastManager().broadcast(input),
  event: <P>(event: EventDefinition<P>, payload: P): Promise<void> => broadcastEvent(event, payload),
  members: (channel: string): Promise<PresenceMember[]> => useBroadcastManager().members(channel),
  connections: (transport?: string): number => useBroadcastManager().connections(transport),
  fake: (): BroadcastFake => useBroadcastManager().fake(),
  restore: (): void => useBroadcastManager().restore(),
  manager: (): BroadcastManager => useBroadcastManager(),
}
