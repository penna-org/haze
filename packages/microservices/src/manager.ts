import type { Application, ConfigInput, ServiceProvider } from '@hazejs/core'
import type { MessageHandler, PayloadOf, ReplyOf } from './handler'
import type { Packet, Transport, TransportServer } from './transport'
import type { GrpcTransportConfig } from './transports/grpc'
import type { MemoryTransportConfig } from './transports/memory'
import type { NatsTransportConfig } from './transports/nats'
import type { RedisTransportConfig } from './transports/redis'
import { RedisManager, useApp, validate } from '@hazejs/core'
import { NoHandlerError } from './errors'
import { collectHandlers } from './handler'
import { grpcTransport } from './transports/grpc'
import { memoryTransport } from './transports/memory'
import { natsTransport } from './transports/nats'
import { redisTransport } from './transports/redis'

/** 自定义传输：`{ driver: 'custom', create: () => myTransport }` */
export interface CustomTransportConfig {
  driver: 'custom'
  create: () => Transport
  queue?: string
}

export type TransportConfig = MemoryTransportConfig | RedisTransportConfig | NatsTransportConfig | GrpcTransportConfig | CustomTransportConfig

export interface MicroservicesConfig {
  /** 默认传输（Microservice.send / emit 与 client() 不传名字时使用） */
  default?: string
  /**
   * 本服务的名字，作为 NATS / 内存传输的队列组：同名实例之间负载均衡，不同服务各收到一份事件。
   * 不设置时每个实例都会收到每条消息（请求只采用第一份回复）。
   */
  name?: string
  /** send 的默认超时（毫秒），默认 5000 */
  timeout?: number
  /** 监听哪些传输（haze microservice:listen 与 autoListen），默认只监听 default */
  listen?: string[]
  /** 应用启动时即开始监听（单体部署、测试），默认 false */
  autoListen?: boolean
  transports: Record<string, TransportConfig>
}

/** `config/microservices.ts` 的默认导出 */
export function defineMicroservicesConfig(config: MicroservicesConfig | (() => MicroservicesConfig)): ConfigInput<MicroservicesConfig> {
  return config
}

export interface CreateTransportOptions {
  /** 应用的 Redis 连接管理器：redis 传输按名字使用 config/redis.ts 的连接并共用命令连接 */
  redis?: RedisManager
}

/** 按配置创建传输（也可以在 hazejs 之外单独使用） */
export function createTransport(config: TransportConfig, options: CreateTransportOptions = {}): Transport {
  switch (config.driver) {
    case 'memory':
      return memoryTransport(config)
    case 'redis':
      return redisTransport(config, options.redis)
    case 'nats':
      return natsTransport(config)
    case 'grpc':
      return grpcTransport(config)
    case 'custom':
      return config.create()
    default:
      throw new Error(`Unknown microservice transport driver "${(config as { driver: string }).driver}"`)
  }
}

type PatternInput = string | MessageHandler<any, any>

export interface SendOptions {
  /** 超时（毫秒），默认取配置的 timeout（5000）；0 表示不限 */
  timeout?: number
}

/** 调用其它服务 */
export interface MicroserviceClient {
  /** 请求 / 回复：传入处理器定义时，载荷与返回值类型从定义推断 */
  send: (<H extends MessageHandler<any, any>>(handler: H, data: PayloadOf<H>, options?: SendOptions) => Promise<ReplyOf<H>>)
    & (<T = unknown>(pattern: string, data?: unknown, options?: SendOptions) => Promise<T>)
  /** 事件：发出即返回，不等待处理结果 */
  emit: (pattern: PatternInput, data?: unknown) => Promise<void>
}

function patternOf(input: PatternInput): string {
  return typeof input === 'string'
    ? input
    : input.pattern
}

export function createClient(transport: Transport, defaults: { timeout?: number } = {}): MicroserviceClient {
  return {
    send: ((pattern: PatternInput, data?: unknown, options: SendOptions = {}) =>
      transport.send(patternOf(pattern), data, { timeout: options.timeout ?? defaults.timeout ?? 5000 })) as MicroserviceClient['send'],
    emit: (pattern, data) => transport.emit(patternOf(pattern), data),
  }
}

export interface ListenMicroservicesOptions {
  /** 要监听的传输，默认配置的 listen（或 default） */
  transports?: string[]
  /** 每条消息从这里取应用（开发时 haze microservice:listen 传入热替换后的最新应用） */
  resolve?: () => Application | undefined
}

export interface MicroserviceListener {
  readonly transports: readonly string[]
  readonly patterns: readonly string[]
  close: () => Promise<void>
}

/** 应用级的微服务管理器：传输（客户端连接）、处理器与监听 */
export class MicroserviceManager {
  readonly app: Application
  readonly config: MicroservicesConfig
  readonly handlers: MessageHandler[]
  readonly #transports = new Map<string, Transport>()
  readonly #listeners = new Set<MicroserviceListener>()

  constructor(app: Application, handlers: MessageHandler[] = []) {
    this.app = app
    this.config = app.config.get<MicroservicesConfig>('microservices', { transports: {} })
    this.config.transports ??= {}
    this.handlers = handlers
  }

  get defaultTransport(): string {
    const name = this.config.default ?? Object.keys(this.config.transports)[0]
    if (!name)
      throw new Error('No microservice transports configured: add config/microservices.ts')
    return name
  }

  /** 传输实例（客户端连接按需建立，随应用关闭） */
  transport(name: string = this.defaultTransport): Transport {
    let transport = this.#transports.get(name)
    if (!transport) {
      const config = this.config.transports[name]
      if (!config)
        throw new Error(`Microservice transport "${name}" is not configured in config/microservices.ts`)
      transport = createTransport(config, {
        redis: this.app.container.has(RedisManager)
          ? this.app.make(RedisManager)
          : undefined,
      })
      this.#transports.set(name, transport)
    }
    return transport
  }

  client(name?: string): MicroserviceClient {
    return createClient(this.transport(name), { timeout: this.config.timeout })
  }

  /** 某个传输上要处理的处理器 */
  handlersFor(transport: string): MessageHandler[] {
    return this.handlers.filter(handler => !handler.transports || handler.transports.includes(transport))
  }

  /** 执行一条收到的消息：查找处理器 → 校验载荷 → 在子容器中执行 */
  async dispatch(transport: string, packet: Packet): Promise<unknown> {
    const handler = this.handlersFor(transport).find(item => item.pattern === packet.pattern)
    if (!handler)
      throw new NoHandlerError(packet.pattern)
    const payload = handler.schema
      ? await validate(handler.schema, packet.data)
      : packet.data
    const container = this.app.container.createChild()
    try {
      const ctx = {
        pattern: packet.pattern,
        kind: packet.kind,
        id: packet.id,
        transport,
        app: this.app,
        logger: this.app.logger.child({ pattern: packet.pattern, transport }),
        container,
        make: <T>(key: Parameters<typeof container.make<T>>[0]) => container.make<T>(key),
      }
      return await container.call(() => handler.handle(payload, ctx))
    }
    finally {
      await container.dispose()
    }
  }

  /** 开始监听（haze microservice:listen、worker 入口或 autoListen） */
  async listen(options: ListenMicroservicesOptions = {}): Promise<MicroserviceListener> {
    const names = options.transports ?? this.config.listen ?? [this.defaultTransport]
    const servers: TransportServer[] = []
    const patterns = new Set<string>()
    const current = (): MicroserviceManager => {
      const app = options.resolve?.() ?? this.app
      return app === this.app
        ? this
        : app.make(MicroserviceManager)
    }
    try {
      for (const name of names) {
        const transportConfig = this.config.transports[name]
        const transport = this.transport(name)
        const handled = [
          ...new Set(this.handlersFor(name).map(handler => handler.pattern)),
        ]
        handled.forEach(pattern => patterns.add(pattern))
        servers.push(await transport.listen({
          patterns: handled,
          queue: (transportConfig as { queue?: string }).queue ?? this.config.name,
          // 每条消息使用最新的应用（开发时代码修改后无需重启；新增的模式需要重启监听）
          dispatch: packet => current().dispatch(name, packet),
          onError: (error, packet) => this.app.logger.error(`Microservice message${packet
            ? ` "${packet.pattern}"`
            : ''} on ${name} failed`, error),
        }))
      }
    }
    catch (error) {
      await Promise.allSettled(servers.map(server => server.close()))
      throw error
    }
    const listener: MicroserviceListener = {
      transports: names,
      patterns: [...patterns],
      close: async () => {
        this.#listeners.delete(listener)
        await Promise.allSettled(servers.map(server => server.close()))
      },
    }
    this.#listeners.add(listener)
    return listener
  }

  /** 关闭监听与客户端连接 */
  async close(): Promise<void> {
    await Promise.allSettled([...this.#listeners].map(listener => listener.close()))
    await Promise.allSettled([
      ...this.#transports.values(),
    ].map(transport => transport.close()))
    this.#transports.clear()
  }
}

export interface MicroservicesProviderOptions {
  /** 额外的处理器（不经过 app/message 目录发现，如测试中） */
  handlers?: MessageHandler[]
}

/**
 * 微服务提供者（app/provider/MicroserviceProvider.ts：`export default microservicesProvider()`）：
 * 读取 config/microservices.ts 与 app/message/*.ts 的处理器，注册 MicroserviceManager；
 * autoListen 时随应用启动监听，应用关闭时断开所有连接。
 */
export function microservicesProvider(options: MicroservicesProviderOptions = {}): ServiceProvider {
  let manager: MicroserviceManager | undefined
  return {
    register(container, app) {
      manager = new MicroserviceManager(app, [
        ...collectHandlers(app.discovered('messages')),
        ...options.handlers ?? [],
      ])
      container.instance(MicroserviceManager, manager)
    },
    async boot() {
      if (manager?.config.autoListen)
        await manager.listen()
    },
    async shutdown() {
      await manager?.close()
    },
  }
}

/** 在应用中开始监听（worker 入口：`await listenMicroservices(app)`） */
export function listenMicroservices(app: Application, options: ListenMicroservicesOptions = {}): Promise<MicroserviceListener> {
  return managerOf(app).listen(options)
}

function managerOf(app: Application): MicroserviceManager {
  if (!app.container.has(MicroserviceManager))
    throw new Error('Microservices are not configured: add microservicesProvider() in app/provider')
  return app.make(MicroserviceManager)
}

function manager(): MicroserviceManager {
  return managerOf(useApp())
}

/**
 * 门面：
 *
 * ```ts
 * const order = await Microservice.client('orders').send('orders.find', { id: 1 }, { timeout: 3000 })
 * await Microservice.emit('orders.created', order) // 默认传输
 * ```
 */
export const Microservice = {
  client: (name?: string): MicroserviceClient => manager().client(name),
  send: ((pattern: PatternInput, data?: unknown, options?: SendOptions) => manager().client().send(pattern as string, data, options)) as MicroserviceClient['send'],
  emit: (pattern: PatternInput, data?: unknown): Promise<void> => manager().client().emit(pattern, data),
}
