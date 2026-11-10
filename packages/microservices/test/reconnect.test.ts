import { copyFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { RedisManager } from '@hazejs/core'
import { describe, expect, it, vi } from 'vitest'
import { createTransport, grpcTransport, MicroserviceUnavailableError, natsTransport } from '../src'

const nats = vi.hoisted(() => ({
  attempts: 0,
  failures: 0,
  connections: [] as Array<{ published: string[], close: () => void }>,
}))

vi.mock('@nats-io/transport-node', () => ({
  connect: async () => {
    nats.attempts++
    if (nats.failures > 0) {
      nats.failures--
      throw new Error('CONNECTION_REFUSED')
    }
    let close!: () => void
    const closed = new Promise<void>(resolve => close = resolve)
    const connection = {
      published: [] as string[],
      close,
      closed: () => closed,
      publish: (subject: string) => void connection.published.push(subject),
      drain: async () => close(),
    }
    nats.connections.push(connection)
    return connection
  },
}))

describe('nats transport connection cache', () => {
  it('retries after a failed first connect and reconnects once the connection closes', async () => {
    nats.failures = 1
    const transport = natsTransport()
    await expect(transport.emit('a', 1)).rejects.toThrow('CONNECTION_REFUSED')
    // 失败的连接不被缓存
    await transport.emit('a', 1)
    await transport.emit('b', 1)
    expect(nats.attempts).toBe(2)
    expect(nats.connections[0].published).toEqual(['a', 'b'])

    // 连接关闭（重连耗尽等）后，下次调用建立新连接
    nats.connections[0].close()
    await new Promise(resolve => setTimeout(resolve, 0))
    await transport.emit('c', 1)
    expect(nats.attempts).toBe(3)
    expect(nats.connections[1].published).toEqual(['c'])
    await transport.close()
  })
})

describe('grpc transport load cache', () => {
  it('retries loading the proto after a failure', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'haze-grpc-'))
    const protoPath = join(directory, 'orders.proto')
    const transport = grpcTransport({
      url: '127.0.0.1:1',
      protoPath,
      package: 'orders',
      methods: { 'OrderService.FindOne': 'orders.find' },
    })
    try {
      await expect(transport.send('orders.find', { id: 1 }, { timeout: 500 })).rejects.toThrow(/ENOENT|no such file/i)
      await copyFile(fileURLToPath(new URL('./fixtures/orders.proto', import.meta.url)), protoPath)
      // proto 已可读：不再返回缓存的加载失败，而是真正发起调用（服务器不可用）
      await expect(transport.send('orders.find', { id: 1 }, { timeout: 500 })).rejects.toBeInstanceOf(MicroserviceUnavailableError)
    }
    finally {
      await transport.close()
      await rm(directory, { recursive: true, force: true })
    }
  })
})

/** ioredis 形状的假客户端，可注入失败 */
class FlakyRedis {
  static created: FlakyRedis[] = []
  static failSubscribe = 0
  static failPush = 0
  status = 'ready'
  listeners: Array<(channel: string, message: string) => void> = []
  channels: string[] = []
  pushed: string[] = []
  constructor() {
    FlakyRedis.created.push(this)
  }

  on(event: string, listener: (channel: string, message: string) => void) {
    if (event === 'message')
      this.listeners.push(listener)
    return this
  }

  once() {
    return this
  }

  duplicate() {
    return new FlakyRedis()
  }

  async subscribe(channel: string) {
    if (FlakyRedis.failSubscribe > 0) {
      FlakyRedis.failSubscribe--
      throw new Error('subscribe failed')
    }
    this.channels.push(channel)
  }

  async lpush(_key: string, value: string) {
    if (FlakyRedis.failPush > 0) {
      FlakyRedis.failPush--
      throw new Error('lpush failed')
    }
    this.pushed.push(value)
    return 1
  }

  async pexpire() {
    return 1
  }

  async quit() {
    this.status = 'end'
  }

  disconnect() {
    this.status = 'end'
  }
}

describe('redis transport failures', () => {
  it('reconnects after a failed connect, tolerates lpush failures and garbage replies', async () => {
    const uncaught: unknown[] = []
    const onUncaught = (error: unknown): void => void uncaught.push(error)
    process.on('uncaughtException', onUncaught)
    const redis = new RedisManager({
      connections: {
        default: { url: 'redis://main:6379' },
      },
    }, {
      driver: { Redis: FlakyRedis, Cluster: FlakyRedis } as never,
    })
    const transport = createTransport({ driver: 'redis' }, { redis })
    try {
      FlakyRedis.failSubscribe = 1
      await expect(transport.send('a', 1, { timeout: 50 })).rejects.toThrow('subscribe failed')
      // 建立到一半的订阅连接被关闭，且失败不被缓存
      const failed = FlakyRedis.created.find(client => client.status === 'end')
      expect(failed).toBeDefined()

      FlakyRedis.failPush = 1
      await expect(transport.send('a', 1, { timeout: 50 })).rejects.toThrow('lpush failed')

      const sending = transport.send('a', { n: 1 }, { timeout: 500 })
      const sub = FlakyRedis.created.find(client => client.channels.length)!
      const pub = await redis.client() as unknown as FlakyRedis
      await vi.waitFor(() => expect(pub.pushed).toHaveLength(1))
      const packet = JSON.parse(pub.pushed[0]) as { id: string, replyTo: string }
      // 无法解析的回复被丢弃，不抛到事件循环
      for (const listener of sub.listeners)
        listener(packet.replyTo, 'not json')
      for (const listener of sub.listeners)
        listener(packet.replyTo, JSON.stringify({ id: packet.id, ok: true, data: 'pong' }))
      expect(await sending).toBe('pong')
      expect(uncaught).toEqual([])
    }
    finally {
      process.off('uncaughtException', onUncaught)
      await transport.close()
      await redis.disconnect()
    }
  })
})
