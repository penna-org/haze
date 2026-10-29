import type { Application } from '@hazejs/core'
import type { MessageHandler, MicroservicesConfig, TransportConfig } from '../src'
import { createServer } from 'node:net'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { createApplication, createToken, defineRoutes, inject, NotFoundException, RedisManager } from '@hazejs/core'
import * as v from 'valibot'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createTransport, defineMessageHandler, listenMicroservices, Microservice, MicroserviceManager, microservicesProvider, MicroserviceTimeoutError, MicroserviceUnavailableError, redisTransport, RemoteError } from '../src'

const Prefix = createToken<string>('prefix')

interface Order { id: number, item: string, quantity: number, status?: string }

/** 记录每个实例收到的事件 */
const received: Array<{ service: string, pattern: string, payload: unknown, kind: string }> = []

function orderHandlers(service: string): MessageHandler<any, any>[] {
  return [
    defineMessageHandler('orders.find', {
      schema: v.object({
        id: v.number(),
      }),
    }, async ({ id }, ctx) => {
      if (id === 404)
        throw new NotFoundException(`Order ${id} not found`)
      return {
        id,
        item: `${ctx.make(Prefix)}-book`,
        quantity: 1,
        status: service,
      }
    }),
    defineMessageHandler('orders.create', {
      schema: v.object({
        item: v.pipe(v.string(), v.minLength(2, 'item is too short')),
        quantity: v.number(),
      }),
    }, async order => ({
      id: 7,
      ...order,
      status: inject(Prefix),
    })),
    defineMessageHandler('orders.slow', async () => {
      await new Promise(resolve => setTimeout(resolve, 300))
      return { id: 1, item: 'slow', quantity: 1 }
    }),
    defineMessageHandler('orders.crash', async () => {
      throw new Error('database password is hunter2')
    }),
    defineMessageHandler('orders.created', async (payload, ctx) => {
      received.push({
        service,
        pattern: ctx.pattern,
        payload,
        kind: ctx.kind,
      })
      return 'ignored'
    }),
  ]
}

const apps: Application[] = []
afterEach(async () => {
  received.length = 0
  for (const app of apps.splice(0).reverse())
    await app.dispose()
})

async function boot(options: { service?: string, transports: Record<string, TransportConfig>, config?: Partial<MicroservicesConfig>, handlers?: MessageHandler<any, any>[], mode?: 'test' | 'production', routes?: Parameters<typeof defineRoutes>[0] }) {
  const service = options.service ?? 'orders'
  const app = await createApplication({
    mode: options.mode ?? 'test',
    env: false,
    config: {
      logger: { level: 'silent' },
      app: { debug: false },
      microservices: {
        default: Object.keys(options.transports)[0],
        timeout: 2000,
        transports: options.transports,
        ...options.config,
      },
    },
    providers: [
      microservicesProvider({ handlers: options.handlers ?? orderHandlers(service) }),
      {
        register: container => void container.instance(Prefix, service),
      },
    ],
    routes: options.routes
      ? [
          defineRoutes(options.routes),
        ]
      : [],
  })
  apps.push(app)
  return app
}

async function until(predicate: () => boolean, timeout = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeout)
      throw new Error('Timed out waiting for condition')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
}

/** 各传输共用的语义测试：请求 / 回复、错误、校验、超时、事件 */
function transportSemantics(name: string, transport: () => TransportConfig, options: { queueGroups: boolean, noResponders: boolean }) {
  async function pair(config: Partial<MicroservicesConfig> = {}) {
    const transports = {
      bus: transport(),
    }
    const server = await boot({
      service: 'orders',
      transports,
      config: { name: 'orders', ...config },
    })
    const listener = await listenMicroservices(server)
    const client = await boot({ service: 'gateway', transports, handlers: [] })
    return {
      server,
      listener,
      client: client.make(MicroserviceManager).client('bus'),
      clientApp: client,
      transports,
    }
  }

  describe(`${name} transport`, () => {
    it('sends requests and receives replies', async () => {
      const { client, listener } = await pair()
      expect(listener.patterns).toContain('orders.find')
      expect(await client.send('orders.find', { id: 1 })).toEqual({
        id: 1,
        item: 'orders-book',
        quantity: 1,
        status: 'orders',
      })
      const [first] = orderHandlers('x')
      // 用处理器定义调用：载荷与回复类型由定义推断
      expect(await client.send(first, { id: 2 })).toMatchObject({ id: 2 })
      expect(await client.send('orders.create', { item: 'pen', quantity: 3 })).toEqual({
        id: 7,
        item: 'pen',
        quantity: 3,
        status: 'orders',
      })
    })

    it('propagates remote errors and validation failures', async () => {
      const { client } = await pair()
      const notFound = await client.send('orders.find', { id: 404 }).catch(error => error)
      expect(notFound).toBeInstanceOf(RemoteError)
      expect(notFound).toMatchObject({
        status: 404,
        code: 404,
        message: 'Order 404 not found',
        pattern: 'orders.find',
      })

      const invalid = await client.send('orders.create', { item: 'x', quantity: 1 }).catch(error => error)
      expect(invalid).toMatchObject({
        status: 422,
        issues: [
          { path: 'item', message: 'item is too short' },
        ],
      })

      const crash: any = await client.send('orders.crash').catch((error: any) => error)
      expect(crash).toMatchObject({
        status: 502,
        message: 'database password is hunter2',
        remote: { name: 'Error' },
      })
      expect(crash.unhandled).toBe(true)
    })

    it('times out slow replies', async () => {
      const { client } = await pair()
      const started = Date.now()
      const error: any = await client.send('orders.slow', {}, { timeout: 100 }).catch((error: any) => error)
      expect(error).toBeInstanceOf(MicroserviceTimeoutError)
      expect(error.status).toBe(504)
      expect(Date.now() - started).toBeLessThan(290)
    })

    if (options.noResponders) {
      it('fails fast when nobody listens', async () => {
        const client = await boot({
          service: 'gateway',
          transports: {
            bus: transport(),
          },
          handlers: [],
        })
        await expect(client.make(MicroserviceManager).client().send('nobody.home', {})).rejects.toBeInstanceOf(MicroserviceUnavailableError)
      })
    }

    it('delivers events to every service, once per queue group', async () => {
      const transports = {
        bus: transport(),
      }
      const ordersA = await boot({
        service: 'orders-a',
        transports,
        config: { name: 'orders' },
      })
      const ordersB = await boot({
        service: 'orders-b',
        transports,
        config: { name: 'orders' },
      })
      const billing = await boot({
        service: 'billing',
        transports,
        config: { name: 'billing' },
      })
      for (const app of [ordersA, ordersB, billing])
        await listenMicroservices(app)
      const client = (await boot({ service: 'gateway', transports, handlers: [] })).make(MicroserviceManager).client()

      for (let i = 0; i < 4; i++)
        await client.emit('orders.created', { id: i })
      if (options.queueGroups) {
        // 每个事件：orders 组内一个实例 + billing 一个
        await until(() => received.length === 8)
        expect(received.filter(item => item.service === 'billing')).toHaveLength(4)
        expect(received.filter(item => item.service.startsWith('orders-'))).toHaveLength(4)
      }
      else {
        // Redis pub/sub：每个实例都收到
        await until(() => received.length === 12)
      }
      expect(received.every(item => item.kind === 'event' && item.pattern === 'orders.created')).toBe(true)
      expect(received.filter(item => item.service === 'billing').map(item => item.payload)).toEqual([
        { id: 0 },
        { id: 1 },
        { id: 2 },
        { id: 3 },
      ])
    })

    it('load-balances requests across instances of a service', async () => {
      const transports = {
        bus: transport(),
      }
      const a = await boot({
        service: 'orders-a',
        transports,
        config: { name: 'orders' },
      })
      const b = await boot({
        service: 'orders-b',
        transports,
        config: { name: 'orders' },
      })
      await listenMicroservices(a)
      await listenMicroservices(b)
      const client = (await boot({ service: 'gateway', transports, handlers: [] })).make(MicroserviceManager).client()
      const replies = await Promise.all(Array.from({ length: 20 }, (_, id) => client.send<Order>('orders.find', { id })))
      // 每个请求只回复一次，且由某一个实例处理
      expect(replies.map(reply => reply.id)).toEqual(Array.from({ length: 20 }, (_, id) => id))
      expect(new Set(replies.map(reply => reply.status)).size).toBeGreaterThan(0)
    })
  })
}

let channel = 0
transportSemantics('memory', () => ({ driver: 'memory', channel: `test-${++channel}` }), { queueGroups: true, noResponders: true })

describe('memory transport specifics', () => {
  it('round-robins requests and events within a queue group', async () => {
    const transports = {
      bus: { driver: 'memory', channel: 'rr' } as const,
    }
    const a = await boot({
      service: 'orders-a',
      transports,
      config: { name: 'orders' },
    })
    const b = await boot({
      service: 'orders-b',
      transports,
      config: { name: 'orders' },
    })
    await listenMicroservices(a)
    await listenMicroservices(b)
    const client = (await boot({ service: 'gateway', transports, handlers: [] })).make(MicroserviceManager).client()
    const statuses = await Promise.all([1, 2, 3, 4].map(async id => (await client.send<Order>('orders.find', { id })).status))
    expect(statuses.sort()).toEqual([
      'orders-a',
      'orders-a',
      'orders-b',
      'orders-b',
    ])
    // 未设置 name：没有队列组，每个实例都收到事件
    const solo = await boot({ service: 'solo', transports })
    await listenMicroservices(solo)
    await client.emit('orders.created', { id: 1 })
    await until(() => received.length === 2)
    expect(received.map(item => item.service).sort()).toEqual([
      expect.stringMatching(/^orders-/),
      'solo',
    ])
  })

  it('serializes payloads like a network transport', async () => {
    const transports = {
      bus: { driver: 'memory', channel: 'json' } as const,
    }
    const server = await boot({
      transports,
      handlers: [
        defineMessageHandler('echo', async payload => ({
          payload,
          at: new Date(0),
        })),
      ],
    })
    await listenMicroservices(server)
    const reply = await server.make(MicroserviceManager).client().send('echo', {
      when: new Date(0),
      skip: undefined,
    })
    expect(reply).toEqual({
      payload: { when: '1970-01-01T00:00:00.000Z' },
      at: '1970-01-01T00:00:00.000Z',
    })
  })

  it('discovers handlers from app/message, filters by transport and auto-listens', async () => {
    const handled: string[] = []
    const app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        logger: { level: 'silent' },
        microservices: {
          default: 'local',
          autoListen: true,
          listen: ['local', 'other'],
          transports: {
            local: { driver: 'memory', channel: 'discover' },
            other: { driver: 'memory', channel: 'discover-other' },
          },
        },
      },
      providers: [
        microservicesProvider(),
      ],
      discovered: {
        messages: {
          '/app/message/ping.ts': {
            default: defineMessageHandler('ping', async () => 'pong'),
          },
          '/app/message/users.ts': {
            default: [
              defineMessageHandler('users.created', { transport: 'other' }, async (payload: { id: number }, ctx) => {
                handled.push(`${ctx.transport}:${payload.id}`)
              }),
            ],
          },
        },
      },
    })
    apps.push(app)
    const manager = app.make(MicroserviceManager)
    expect(manager.handlers.map(handler => handler.pattern)).toEqual(['ping', 'users.created'])
    // 门面使用当前应用
    expect(await Microservice.send('ping')).toBe('pong')
    expect(await Microservice.client('local').send('ping')).toBe('pong')
    // users.created 只在 other 传输上处理
    await expect(Microservice.client('local').send('users.created', { id: 1 })).rejects.toBeInstanceOf(MicroserviceUnavailableError)
    await Microservice.client('other').emit('users.created', { id: 2 })
    await until(() => handled.length === 1)
    expect(handled).toEqual(['other:2'])

    await expect(createApplication({
      mode: 'test',
      env: false,
      config: {
        logger: { level: 'silent' },
        microservices: {
          transports: {
            m: { driver: 'memory' },
          },
        },
      },
      providers: [
        microservicesProvider(),
      ],
      discovered: {
        messages: {
          '/app/message/bad.ts': {
            default: () => 'nope',
          },
        },
      },
    })).rejects.toThrow('app/message/bad')
  })

  it('renders remote errors in HTTP routes (masking 5xx details outside debug)', async () => {
    const transports = {
      bus: { driver: 'memory', channel: 'http' } as const,
    }
    await listenMicroservices(await boot({ transports }))
    const gateway = await boot({
      service: 'gateway',
      transports,
      handlers: [],
      routes: (r) => {
        r.get('/orders/:id', ctx => Microservice.send('orders.find', {
          id: Number(ctx.param('id')),
        }))
        r.get('/crash', () => Microservice.send('orders.crash'))
      },
    })
    const ok = await gateway.request('/orders/5')
    expect(await ok.json()).toMatchObject({
      data: { id: 5 },
    })
    const missing = await gateway.request('/orders/404')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toMatchObject({ code: 404, message: 'Order 404 not found' })
    const crash = await gateway.request('/crash')
    expect(crash.status).toBe(502)
    expect(JSON.stringify(await crash.json())).not.toContain('hunter2')
  })

  it('dispatches to the latest application when resolve() is given (hot reload)', async () => {
    const transports = {
      bus: { driver: 'memory', channel: 'hmr' } as const,
    }
    const first = await boot({ service: 'v1', transports })
    const second = await boot({ service: 'v2', transports })
    let current = first
    await first.make(MicroserviceManager).listen({
      resolve: () => current,
    })
    const client = first.make(MicroserviceManager).client()
    expect((await client.send<Order>('orders.find', { id: 1 })).status).toBe('v1')
    current = second
    expect((await client.send<Order>('orders.find', { id: 1 })).status).toBe('v2')
  })

  it('stops listening when the application is disposed', async () => {
    const transports = {
      bus: { driver: 'memory', channel: 'dispose' } as const,
    }
    const server = await boot({ transports })
    await listenMicroservices(server)
    const client = (await boot({ service: 'gateway', transports, handlers: [] })).make(MicroserviceManager).client()
    expect(await client.send('orders.find', { id: 1 })).toMatchObject({ id: 1 })
    await server.dispose()
    apps.splice(apps.indexOf(server), 1)
    await expect(client.send('orders.find', { id: 1 })).rejects.toBeInstanceOf(MicroserviceUnavailableError)
  })
})

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

describe('grpc transport', () => {
  const protoPath = fileURLToPath(new URL('./fixtures/orders.proto', import.meta.url))
  const grpcConfig = (port: number): TransportConfig => ({
    driver: 'grpc',
    url: `127.0.0.1:${port}`,
    protoPath,
    package: 'orders',
    methods: { 'OrderService.FindOne': 'orders.find', 'OrderService.Create': 'orders.create', 'orders.OrderService.Slow': 'orders.slow' },
  })

  it('maps proto methods to message handlers', async () => {
    const port = await freePort()
    const transports = {
      grpc: grpcConfig(port),
    }
    const server = await boot({ transports })
    const listener = await listenMicroservices(server)
    expect(listener.transports).toEqual(['grpc'])
    const client = (await boot({ service: 'gateway', transports, handlers: [] })).make(MicroserviceManager).client()

    expect(await client.send('orders.find', { id: 3 })).toEqual({
      id: 3,
      item: 'orders-book',
      quantity: 1,
      status: 'orders',
    })
    // 按 proto 编解码：缺省字段取默认值
    expect(await client.send('orders.create', { item: 'pen', quantity: 2 })).toEqual({
      id: 7,
      item: 'pen',
      quantity: 2,
      status: 'orders',
    })

    const notFound = await client.send('orders.find', { id: 404 }).catch(error => error)
    expect(notFound).toBeInstanceOf(RemoteError)
    expect(notFound).toMatchObject({ status: 404, message: 'Order 404 not found' })
    const invalid = await client.send('orders.create', { item: 'x', quantity: 1 }).catch(error => error)
    expect(invalid).toMatchObject({
      status: 422,
      issues: [
        { path: 'item' },
      ],
    })

    await expect(client.send('orders.slow', { id: 1 }, { timeout: 100 })).rejects.toBeInstanceOf(MicroserviceTimeoutError)
    // 没有处理器的方法：UNIMPLEMENTED
    await expect(client.send('OrderService.Unhandled', { id: 1 })).rejects.toMatchObject({
      status: 404,
      remote: { message: 'No message handler for "OrderService.Unhandled"' },
    })
    // 流式方法与未映射的模式
    await expect(client.send('OrderService.Watch', { id: 1 })).rejects.toThrow('streaming')
    await expect(client.send('orders.nope', {})).rejects.toBeInstanceOf(MicroserviceUnavailableError)
  })

  it('reports an unavailable server', async () => {
    const port = await freePort()
    const client = (await boot({
      service: 'gateway',
      transports: {
        grpc: grpcConfig(port),
      },
      handlers: [],
    })).make(MicroserviceManager).client()
    await expect(client.send('orders.find', { id: 1 }, { timeout: 1000 })).rejects.toBeInstanceOf(MicroserviceUnavailableError)
  })
})

/** ioredis 形状的假客户端：只记录连接与选项，BRPOP 总是超时 */
class FakeRedis {
  static created: FakeRedis[] = []
  status = 'ready'
  readonly args: unknown[]
  constructor(...args: unknown[]) {
    this.args = args
    FakeRedis.created.push(this)
  }

  on() {
    return this
  }

  once() {
    return this
  }

  duplicate() {
    return new FakeRedis(...this.args)
  }

  async subscribe() {}
  async publish() {
    return 0
  }

  async brpop() {
    await new Promise(resolve => setTimeout(resolve, 5))
    return null
  }

  async quit() {
    this.status = 'end'
  }

  disconnect() {
    this.status = 'end'
  }
}

describe('redis transport connections', () => {
  const driver = { Redis: FakeRedis, Cluster: FakeRedis } as never
  const config = {
    connections: {
      default: { url: 'redis://main:6379' },
      bus: { url: 'redis://bus:6379', keyPrefix: 'ms:' },
    },
  }

  it('uses a named connection, sharing the command client inside an application', async () => {
    FakeRedis.created.length = 0
    const redis = new RedisManager(config, { driver })
    const transport = createTransport({ driver: 'redis', connection: 'bus' }, { redis })
    const server = await transport.listen({
      patterns: ['a'],
      dispatch: async () => null,
      onError: () => {},
    })
    await transport.emit('a', 1)
    // 服务端：BRPOP（maxRetriesPerRequest: null）、事件订阅、共享的发布连接；客户端：回复订阅，发布复用共享连接
    expect(FakeRedis.created.map(client => client.args)).toEqual([
      [
        'redis://bus:6379',
        { keyPrefix: 'ms:', maxRetriesPerRequest: null },
      ],
      [
        'redis://bus:6379',
        { keyPrefix: 'ms:' },
      ],
      [
        'redis://bus:6379',
        { keyPrefix: 'ms:' },
      ],
      [
        'redis://bus:6379',
        { keyPrefix: 'ms:' },
      ],
    ])
    const shared = await redis.client('bus') as unknown as FakeRedis
    await server.close()
    await transport.close()
    // 共享连接由 RedisManager 关闭，其它连接随传输关闭
    expect(FakeRedis.created.filter(client => client !== shared).every(client => client.status === 'end')).toBe(true)
    expect(shared.status).toBe('ready')
    await redis.disconnect()
    expect(shared.status).toBe('end')
  })
})

const redisUrl = process.env.HAZE_TEST_REDIS_URL
describe.runIf(redisUrl)('real redis', () => {
  transportSemantics('redis', () => ({ driver: 'redis', url: redisUrl, prefix: `test:${crypto.randomUUID()}:` }), { queueGroups: false, noResponders: false })

  // 命名连接：不写 url，使用 core 的默认连接（缺省 config/redis.ts 时读取 REDIS_URL）
  describe('named connection', () => {
    const previous = process.env.REDIS_URL
    beforeAll(() => {
      process.env.REDIS_URL = redisUrl
    })
    afterAll(() => {
      if (previous === undefined)
        delete process.env.REDIS_URL
      else
        process.env.REDIS_URL = previous
    })
    transportSemantics('redis (connection: default)', () => ({ driver: 'redis', connection: 'default', prefix: `test:${crypto.randomUUID()}:` }), { queueGroups: false, noResponders: false })

    it('works standalone (outside an application), owning its connections', async () => {
      const transport = redisTransport({ prefix: `test:${crypto.randomUUID()}:` })
      const server = await transport.listen({
        patterns: ['echo'],
        dispatch: async packet => packet.data,
        onError: () => {},
      })
      try {
        expect(await transport.send('echo', { ok: 1 }, { timeout: 2000 })).toEqual({ ok: 1 })
      }
      finally {
        await server.close()
        await transport.close()
      }
    })
  })
})

const natsUrl = process.env.HAZE_TEST_NATS_URL
describe.runIf(natsUrl)('real nats', () => {
  transportSemantics('nats', () => ({ driver: 'nats', servers: natsUrl, prefix: `test-${crypto.randomUUID()}.` }), { queueGroups: true, noResponders: true })
})
