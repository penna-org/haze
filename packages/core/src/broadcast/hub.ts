import { globalStore } from '../utils'

/**
 * 推送给客户端的消息（三种传输的格式一致）：
 * - 业务事件：`{ event: 'OrderShipped', channel: 'private-orders.1', data }`
 * - 框架事件以 `haze:` 开头：connected / subscribed / subscription_error / member_added / member_removed / pong
 */
export interface BroadcastEnvelope {
  event: string
  channel?: string
  data?: unknown
  [key: string]: unknown
}

/** 一条广播（经总线在实例间传递，JSON） */
export interface BroadcastMessage {
  /** 去重用的消息 ID */
  id: string
  channels: string[]
  event: string
  data?: unknown
  /** 不发给该连接（toOthers / 客户端事件的发送者） */
  except?: string
}

/** 某个传输上的一个客户端连接 */
export interface HubConnection {
  readonly id: string
  /** ws / sse / socket.io */
  readonly transport: string
  send: (envelope: BroadcastEnvelope) => void
}

interface Hub {
  channels: Map<string, Set<HubConnection>>
  connections: Map<string, { connection: HubConnection, channels: Set<string> }>
  /** 最近投递过的消息 ID：同一进程中有多个订阅者时（热更新、测试中的多个应用）只投递一次 */
  seen: Set<string>
}

/** 本进程的连接表，跨热更新保留（旧连接在热更新后仍能收到广播） */
function hub(): Hub {
  return globalStore('broadcast:hub', () => ({
    channels: new Map(),
    connections: new Map(),
    seen: new Set(),
  }))
}

const SEEN_LIMIT = 2000

function detach(state: Hub, channel: string, connection: HubConnection): void {
  const set = state.channels.get(channel)
  if (!set)
    return
  set.delete(connection)
  if (!set.size)
    state.channels.delete(channel)
}

export const localHub = {
  add(connection: HubConnection): void {
    hub().connections.set(connection.id, {
      connection,
      channels: new Set(),
    })
  },

  /** 移除连接，返回它订阅过的频道 */
  remove(id: string): string[] {
    const state = hub()
    const entry = state.connections.get(id)
    if (!entry)
      return []
    state.connections.delete(id)
    for (const channel of entry.channels)
      detach(state, channel, entry.connection)
    return [...entry.channels]
  },

  join(id: string, channel: string): boolean {
    const state = hub()
    const entry = state.connections.get(id)
    if (!entry || entry.channels.has(channel))
      return false
    entry.channels.add(channel)
    let set = state.channels.get(channel)
    if (!set)
      state.channels.set(channel, set = new Set())
    set.add(entry.connection)
    return true
  },

  leave(id: string, channel: string): boolean {
    const state = hub()
    const entry = state.connections.get(id)
    if (!entry?.channels.delete(channel))
      return false
    detach(state, channel, entry.connection)
    return true
  },

  subscribed(id: string, channel: string): boolean {
    return hub().connections.get(id)?.channels.has(channel) ?? false
  },

  channelsOf(id: string): string[] {
    return [
      ...hub().connections.get(id)?.channels ?? [],
    ]
  },

  /** 投递到本进程订阅了这些频道的连接 */
  deliver(message: BroadcastMessage): number {
    const state = hub()
    if (state.seen.has(message.id))
      return 0
    state.seen.add(message.id)
    if (state.seen.size > SEEN_LIMIT)
      state.seen.delete(state.seen.values().next().value!)
    let delivered = 0
    for (const channel of message.channels) {
      for (const connection of state.channels.get(channel) ?? []) {
        if (connection.id === message.except)
          continue
        try {
          connection.send({ event: message.event, channel, data: message.data })
          delivered++
        }
        catch {}
      }
    }
    return delivered
  },

  /** 本进程的连接数（可按传输过滤） */
  count(transport?: string): number {
    let count = 0
    for (const { connection } of hub().connections.values()) {
      if (!transport || connection.transport === transport)
        count++
    }
    return count
  },
}
