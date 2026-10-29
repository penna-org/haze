import type { RedisConnectionName, RedisConnectionRef, RedisManager } from '@hazejs/core'
import type { Packet, Reply, Transport, TransportServer } from '../transport'
import { closeRedisClient, redisTarget, useRedisManager } from '@hazejs/core'
import { serializeError } from '../errors'
import { decode, messageId, unwrapReply, withTimeout } from '../transport'

export interface RedisTransportConfig extends RedisConnectionRef {
  driver: 'redis'
  /**
   * @hazejs/core 的 config/redis.ts 中的连接名，默认为其 default 连接（REDIS_URL）。
   * 连接的 keyPrefix 作用于请求列表，不作用于 pub/sub 频道
   */
  connection?: RedisConnectionName
  /** 内联地址（旧写法），设置后不使用命名连接；单独使用（不在应用中）时缺省为 REDIS_URL 或 redis://127.0.0.1:6379 */
  url?: string
  /** 键 / 频道前缀，默认 `haze:ms:` */
  prefix?: string
  /** 服务端同时处理的请求数，默认 10 */
  concurrency?: number
  /** 透传给 ioredis 的选项 */
  options?: Record<string, unknown>
}

interface RedisClient {
  readonly status?: string
  lpush: (key: string, value: string) => Promise<number>
  pexpire: (key: string, ms: number) => Promise<number>
  publish: (channel: string, message: string) => Promise<number>
  subscribe: (...channels: string[]) => Promise<unknown>
  brpop: (...args: Array<string | number>) => Promise<[string, string] | null>
  on: (event: string, listener: (...args: any[]) => void) => unknown
  quit: () => Promise<unknown>
  disconnect: () => void
}

const FEATURE = 'The redis microservice transport'

/**
 * Redis 传输（ioredis）：
 * - send：请求写入列表 `<prefix>req:<pattern>`，各实例以 BRPOP 竞争消费，每个请求只被一个实例处理；
 *   回复经 pub/sub 发到调用方独占的频道 `<prefix>reply:<clientId>`；
 * - emit：PUBLISH 到 `<prefix>evt:<pattern>`，每个订阅的实例都会收到（Redis pub/sub 没有队列组）。
 * 没有服务在线时请求无法立即失败，只能等到超时；过期的请求不会再被处理。
 */
export function redisTransport(config: Omit<RedisTransportConfig, 'driver'> = {}, redis?: RedisManager): Transport {
  // 应用内（MicroserviceManager 传入 RedisManager）：发布用共享的命令连接；单独使用时所有连接都归本传输并在 close() 时断开
  const shared = redis !== undefined
  const manager = redis ?? useRedisManager()
  const target = redisTarget(config)
  const command = async (): Promise<RedisClient> => (shared
    ? manager.client(target, FEATURE)
    : manager.create(target, {}, FEATURE)) as unknown as Promise<RedisClient>
  const dedicated = async (overrides: Record<string, unknown> = {}): Promise<RedisClient> =>
    manager.create(target, overrides, FEATURE) as unknown as Promise<RedisClient>
  const release = async (client: RedisClient): Promise<void> => {
    if (!shared)
      await closeRedisClient(client as never)
  }
  const prefix = config.prefix ?? 'haze:ms:'
  const clientId = messageId()
  const replyChannel = `${prefix}reply:${clientId}`
  const pending = new Map<string, (reply: Reply) => void>()
  let client: Promise<{ pub: RedisClient, sub: RedisClient }> | undefined

  const connect = (): Promise<{ pub: RedisClient, sub: RedisClient }> => client ??= (async () => {
    const pub = await command()
    const sub = await dedicated()
    sub.on('message', (channel: string, message: string) => {
      if (channel !== replyChannel)
        return
      const reply = decode<Reply>(message)
      pending.get(reply.id)?.(reply)
    })
    await sub.subscribe(replyChannel)
    return { pub, sub }
  })()

  return {
    async send(pattern, data, { timeout }) {
      const { pub } = await connect()
      const id = messageId()
      const packet: Packet & { replyTo: string } = {
        id,
        pattern,
        kind: 'request',
        data,
        replyTo: replyChannel,
        deadline: timeout > 0
          ? Date.now() + timeout
          : undefined,
      }
      const reply = new Promise<Reply>(resolve => pending.set(id, resolve))
      const key = `${prefix}req:${pattern}`
      await pub.lpush(key, JSON.stringify(packet))
      // 没有消费者时列表不会无限保留
      await pub.pexpire(key, Math.max(timeout, 60_000))
      try {
        return unwrapReply(pattern, await withTimeout(pattern, timeout, reply))
      }
      finally {
        pending.delete(id)
      }
    },

    async emit(pattern, data) {
      const { pub } = await connect()
      const packet: Packet = {
        id: messageId(),
        pattern,
        kind: 'event',
        data,
      }
      await pub.publish(`${prefix}evt:${pattern}`, JSON.stringify(packet))
    },

    async listen({ patterns, dispatch, onError }): Promise<TransportServer> {
      // BRPOP 与订阅各占一个专用连接；阻塞命令要求 maxRetriesPerRequest 为 null
      const blocking = await dedicated({ maxRetriesPerRequest: null })
      const events = await dedicated()
      const pub = await command()
      const concurrency = config.concurrency ?? 10
      const inflight = new Set<Promise<void>>()
      // 对象属性：close() 中修改，循环中读取
      const state = { running: true }

      const handle = async (packet: Packet & { replyTo?: string }): Promise<void> => {
        if (packet.deadline && packet.deadline < Date.now())
          return
        let reply: Reply
        try {
          reply = { id: packet.id, ok: true, data: await dispatch(packet) }
        }
        catch (error) {
          reply = {
            id: packet.id,
            ok: false,
            error: serializeError(error),
          }
        }
        if (packet.replyTo)
          await pub.publish(packet.replyTo, JSON.stringify(reply))
      }

      events.on('message', (_channel: string, message: string) => {
        let packet: Packet
        try {
          packet = decode<Packet>(message)
        }
        catch (error) {
          return onError(error)
        }
        dispatch(packet).catch(error => onError(error, packet))
      })
      if (patterns.length)
        await events.subscribe(...patterns.map(pattern => `${prefix}evt:${pattern}`))

      const keys = patterns.map(pattern => `${prefix}req:${pattern}`)
      const loop = (async () => {
        while (state.running && keys.length) {
          if (inflight.size >= concurrency) {
            await Promise.race(inflight)
            continue
          }
          let item: [string, string] | null
          try {
            item = await blocking.brpop(...keys, 1)
          }
          catch (error) {
            if (!state.running)
              break
            onError(error)
            // 连接已被关闭（如进程内另一个应用关闭时释放了全部 Redis 连接）：停止消费，避免空转
            if (blocking.status === 'end')
              break
            // 其它错误稍等再试，避免立即失败的命令占满事件循环
            await new Promise(resolve => setTimeout(resolve, 100))
            continue
          }
          if (!item)
            continue
          let packet: Packet
          try {
            packet = decode<Packet>(item[1])
          }
          catch (error) {
            onError(error)
            continue
          }
          const task = handle(packet).catch(error => onError(error, packet)).finally(() => inflight.delete(task))
          inflight.add(task)
        }
      })()

      return {
        async close() {
          state.running = false
          // BRPOP 最多阻塞 1 秒；直接断开阻塞连接
          blocking.disconnect()
          await loop
          await Promise.allSettled(inflight)
          await Promise.allSettled([
            closeRedisClient(events as never),
            release(pub),
          ])
        },
      }
    },

    async close() {
      if (!client)
        return
      const { pub, sub } = await client
      client = undefined
      await Promise.allSettled([
        release(pub),
        closeRedisClient(sub as never),
      ])
    },
  }
}
