import type { Packet, Reply, Transport, TransportServer } from '../transport'
import { MicroserviceTimeoutError, MicroserviceUnavailableError, serializeError } from '../errors'
import { decode, encode, importOptional, messageId, unwrapReply } from '../transport'

export interface NatsTransportConfig {
  driver: 'nats'
  /** 服务器地址，默认 nats://127.0.0.1:4222 */
  servers?: string | string[]
  /** 主题前缀，默认无（模式 `orders.created` 即主题） */
  prefix?: string
  /** 队列组，默认取 config/microservices.ts 的 name */
  queue?: string
  /** 透传给 connect() 的选项（user / pass / token / tls 等） */
  options?: Record<string, unknown>
}

interface NatsMsg {
  data: Uint8Array
  reply?: string
  respond: (data?: Uint8Array) => boolean
}

interface NatsConnection {
  publish: (subject: string, data?: Uint8Array) => void
  request: (subject: string, data?: Uint8Array, options?: { timeout: number }) => Promise<NatsMsg>
  subscribe: (subject: string, options: { queue?: string, callback: (error: Error | null, msg: NatsMsg) => void }) => { unsubscribe: () => void, drain: () => Promise<void> }
  flush: () => Promise<void>
  drain: () => Promise<void>
  close: () => Promise<void>
}

type Connect = (options: Record<string, unknown>) => Promise<NatsConnection>

/** 官方 @nats-io/transport-node（nats.js v3）；兼容旧的 nats 包（v2，已弃用） */
async function loadConnect(): Promise<Connect> {
  try {
    return (await import('@nats-io/transport-node') as unknown as { connect: Connect }).connect
  }
  catch (error) {
    try {
      return (await import('nats' as string) as { connect: Connect }).connect
    }
    catch {
      return (await importOptional<{ connect: Connect }>(() => Promise.reject(error), '@nats-io/transport-node', 'nats')).connect
    }
  }
}

function errorCode(error: unknown): string {
  const value = error as { code?: unknown, name?: unknown, message?: unknown }
  return `${String(value?.code ?? '')} ${String(value?.name ?? '')} ${String(value?.message ?? '')}`.toLowerCase()
}

/**
 * NATS 传输：
 * - send：NATS 请求 / 回复（request + respond），没有订阅者时立即失败（no responders → 503）；
 * - emit：publish；
 * - 服务端按队列组订阅：同组实例之间负载均衡，不同组（不同服务）各收到一份事件。
 */
export function natsTransport(config: Omit<NatsTransportConfig, 'driver'> = {}): Transport {
  const prefix = config.prefix ?? ''
  const connectOptions = { servers: config.servers ?? 'nats://127.0.0.1:4222', ...config.options }
  let connection: Promise<NatsConnection> | undefined
  const connect = (): Promise<NatsConnection> => connection ??= loadConnect().then(connect => connect(connectOptions))

  return {
    async send(pattern, data, { timeout }) {
      const nc = await connect()
      const packet: Packet = {
        id: messageId(),
        pattern,
        kind: 'request',
        data,
        deadline: timeout > 0
          ? Date.now() + timeout
          : undefined,
      }
      let msg: NatsMsg
      try {
        msg = await nc.request(`${prefix}${pattern}`, encode(packet), {
          timeout: timeout > 0
            ? timeout
            : 2_147_483_647,
        })
      }
      catch (error) {
        const code = errorCode(error)
        if (code.includes('503') || code.includes('no responders') || code.includes('noresponders'))
          throw new MicroserviceUnavailableError(pattern)
        if (code.includes('timeout'))
          throw new MicroserviceTimeoutError(pattern, timeout)
        throw error
      }
      return unwrapReply(pattern, decode<Reply>(msg.data))
    },

    async emit(pattern, data) {
      const nc = await connect()
      const packet: Packet = {
        id: messageId(),
        pattern,
        kind: 'event',
        data,
      }
      nc.publish(`${prefix}${pattern}`, encode(packet))
    },

    async listen({ patterns, dispatch, queue, onError }): Promise<TransportServer> {
      const connectFn = await loadConnect()
      const nc = await connectFn(connectOptions)
      const inflight = new Set<Promise<void>>()
      const subscriptions = patterns.map(pattern => nc.subscribe(`${prefix}${pattern}`, {
        queue,
        callback: (error, msg) => {
          if (error)
            return onError(error)
          let packet: Packet
          try {
            packet = decode<Packet>(msg.data)
          }
          catch (decodeError) {
            return onError(decodeError)
          }
          // 有 reply 主题的才是请求；事件不回复
          const isRequest = Boolean(msg.reply) && packet.kind === 'request'
          if (isRequest && packet.deadline && packet.deadline < Date.now())
            return
          const task = dispatch(packet).then(
            (result) => {
              if (isRequest)
                msg.respond(encode({ id: packet.id, ok: true, data: result } satisfies Reply))
            },
            (dispatchError) => {
              if (isRequest) {
                msg.respond(encode({
                  id: packet.id,
                  ok: false,
                  error: serializeError(dispatchError),
                } satisfies Reply))
              }
              else {
                onError(dispatchError, packet)
              }
            },
          ).finally(() => inflight.delete(task))
          inflight.add(task)
        },
      }))
      // 确保订阅已在服务器生效，listen() 返回后即可收到消息
      await nc.flush()
      return {
        async close() {
          // 先停止订阅，等执行中的处理器回复完，再关闭连接
          await Promise.allSettled(subscriptions.map(subscription => subscription.drain()))
          await Promise.allSettled(inflight)
          await nc.drain().catch(() => nc.close())
        },
      }
    },

    async close() {
      if (!connection)
        return
      const nc = await connection.catch(() => undefined)
      connection = undefined
      await nc?.drain().catch(() => nc.close())
    },
  }
}
