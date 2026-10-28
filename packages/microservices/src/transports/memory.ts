import type { Dispatch, ListenOptions, Packet, Reply, Transport, TransportServer } from '../transport'
import { MicroserviceUnavailableError, serializeError } from '../errors'
import { messageId, unwrapReply, withTimeout } from '../transport'

export interface MemoryTransportConfig {
  driver: 'memory'
  /** 总线名：同名的客户端与服务端互通，默认 default */
  channel?: string
  /** 队列组，默认取 config/microservices.ts 的 name */
  queue?: string
}

interface Subscriber {
  queue: string | undefined
  dispatch: Dispatch
  onError: ListenOptions['onError']
}

interface Bus {
  /** pattern → 订阅者 */
  subscribers: Map<string, Subscriber[]>
  /** 轮询计数（按 pattern + 组） */
  cursor: Map<string, number>
}

/** 进程级总线（跨热替换、跨多个应用实例共享） */
function bus(channel: string): Bus {
  const key = Symbol.for('hazejs.microservices.memory')
  const g = globalThis as unknown as Record<symbol, Map<string, Bus> | undefined>
  const buses = g[key] ??= new Map()
  let current = buses.get(channel)
  if (!current) {
    buses.set(channel, current = {
      subscribers: new Map(),
      cursor: new Map(),
    })
  }
  return current
}

function pick(bus: Bus, key: string, list: Subscriber[]): Subscriber {
  const index = (bus.cursor.get(key) ?? 0) % list.length
  bus.cursor.set(key, index + 1)
  return list[index]
}

/** 与真实传输一致：经过 JSON 序列化（日期变为字符串，函数与 undefined 丢失） */
function clone<T>(value: T): T {
  return value === undefined
    ? value
    : JSON.parse(JSON.stringify(value)) as T
}

/**
 * 进程内传输（测试、单体应用中模拟服务拆分）：
 * - send：在所有订阅者中轮询选一个处理，没有订阅者时立即抛出 MicroserviceUnavailableError；
 * - emit：每个队列组选一个订阅者（同组负载均衡，不同组各收一份），未设置队列组的订阅者都会收到。
 */
export function memoryTransport(config: Omit<MemoryTransportConfig, 'driver'> = {}): Transport {
  const current = bus(config.channel ?? 'default')

  return {
    async send(pattern, data, { timeout }) {
      const list = current.subscribers.get(pattern)
      if (!list?.length)
        throw new MicroserviceUnavailableError(pattern)
      const subscriber = pick(current, `request:${pattern}`, list)
      const packet: Packet = {
        id: messageId(),
        pattern,
        kind: 'request',
        data: clone(data),
        deadline: timeout > 0
          ? Date.now() + timeout
          : undefined,
      }
      const reply = (async (): Promise<Reply> => {
        // 异步投递，与网络传输的时序一致
        await Promise.resolve()
        try {
          return {
            id: packet.id,
            ok: true,
            data: clone(await subscriber.dispatch(packet)),
          }
        }
        catch (error) {
          return {
            id: packet.id,
            ok: false,
            error: clone(serializeError(error)),
          }
        }
      })()
      return unwrapReply(pattern, await withTimeout(pattern, timeout, reply))
    },

    async emit(pattern, data) {
      const list = current.subscribers.get(pattern) ?? []
      // 每个队列组选一个；没有队列组的订阅者各自收到
      const groups = new Map<string, Subscriber[]>()
      const targets: Subscriber[] = []
      for (const subscriber of list) {
        if (subscriber.queue === undefined) {
          targets.push(subscriber)
        }
        else {
          groups.set(subscriber.queue, [
            ...groups.get(subscriber.queue) ?? [],
            subscriber,
          ])
        }
      }
      for (const [queue, members] of groups)
        targets.push(pick(current, `event:${pattern}:${queue}`, members))
      for (const subscriber of targets) {
        const packet: Packet = {
          id: messageId(),
          pattern,
          kind: 'event',
          data: clone(data),
        }
        queueMicrotask(() => {
          subscriber.dispatch(packet).catch(error => subscriber.onError(error, packet))
        })
      }
    },

    async listen(options): Promise<TransportServer> {
      const subscriber: Subscriber = { queue: options.queue, dispatch: options.dispatch, onError: options.onError }
      for (const pattern of options.patterns) {
        const list = current.subscribers.get(pattern) ?? []
        list.push(subscriber)
        current.subscribers.set(pattern, list)
      }
      return {
        async close() {
          for (const pattern of options.patterns) {
            const list = current.subscribers.get(pattern)?.filter(item => item !== subscriber) ?? []
            if (list.length)
              current.subscribers.set(pattern, list)
            else
              current.subscribers.delete(pattern)
          }
        },
      }
    },

    async close() {},
  }
}
