import type { RedisConfig, RedisConnectionConfig, RedisConnectionName, RedisConnectionRef, ResolvedRedisConfig } from './config'
import type { RedisClient, RedisDriver } from './load'
import { Config } from '../config/config'
import { definePersistent, disposePersistent } from '../persistent'
import { getRequestStore } from '../request'
import { resolveRedisConfig } from './config'
import { loadRedis } from './load'

/**
 * 要连接的目标：连接名，或功能配置里的 `{ connection, url, options }`；
 * `client` 为已创建的实例（缓存存储的旧写法），直接使用。
 */
export type RedisTarget = RedisConnectionName | (string & {}) | { connection?: string, url?: string, options?: Record<string, unknown>, client?: unknown } | undefined

/** 功能配置中引用的连接：内联 url（旧写法）优先，否则为命名连接（缺省为默认连接） */
export function redisTarget(ref: RedisConnectionRef): RedisTarget {
  return ref.url
    ? { url: ref.url, options: ref.options }
    : { connection: ref.connection, options: ref.options }
}

export interface RedisManagerOptions {
  /** 替换 ioredis（测试中注入假的构造函数） */
  driver?: RedisDriver
}

interface Resolved {
  /** 共享连接池的键：连接名（或内联地址）+ 设置的指纹，设置变化（热更新改了配置）时建立新连接 */
  key: string
  settings: RedisConnectionConfig
  instance?: RedisClient
}

/** 断开连接：先 QUIT（等待已发出的命令），超时或失败时直接断开 */
export async function closeRedisClient(client: RedisClient | undefined): Promise<void> {
  if (!client || client.status === 'end')
    return
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      client.quit(),
      new Promise((resolve) => {
        timer = setTimeout(resolve, 2000)
      }),
    ])
  }
  catch {}
  finally {
    clearTimeout(timer)
    if (client.status !== 'end')
      client.disconnect()
  }
}

/** 共享的命令连接：按连接跨热更新复用，应用关闭（非 hmr）时断开 */
function sharedClients(): Map<string, Promise<RedisClient>> {
  return definePersistent('redis:shared', () => new Map<string, Promise<RedisClient>>(), {
    dispose: async (pool) => {
      const clients = [
        ...pool.values(),
      ]
      pool.clear()
      await Promise.all(clients.map(async client => closeRedisClient(await client.catch(() => undefined))))
    },
  })
}

/** 专用连接（订阅、阻塞命令）：使用方通常自己关闭，这里兜底在应用关闭时断开剩下的 */
function dedicatedClients(): Set<RedisClient> {
  return definePersistent('redis:dedicated', () => new Set<RedisClient>(), {
    dispose: async (clients) => {
      const list = [
        ...clients,
      ]
      clients.clear()
      await Promise.all(list.map(closeRedisClient))
    },
  })
}

function fingerprint(settings: RedisConnectionConfig): string {
  return JSON.stringify(settings, (_key, value: unknown) => typeof value === 'function'
    ? 'fn'
    : value)
}

/** 单机 / Sentinel 的 ioredis 选项（不含 url） */
export function redisOptions(settings: RedisConnectionConfig): Record<string, unknown> {
  const options: Record<string, unknown> = {}
  for (const key of [
    'host',
    'port',
    'username',
    'password',
    'db',
    'keyPrefix',
    'sentinels',
    'name',
  ] as const) {
    if (settings[key] !== undefined)
      options[key] = settings[key]
  }
  if (settings.tls) {
    options.tls = settings.tls === true
      ? {}
      : settings.tls
  }
  return {
    ...options,
    ...settings.options,
  }
}

/** 由已有实例复制一个连接（ioredis 的 Cluster.duplicate 签名不同：节点选项在 redisOptions 中） */
function duplicateWith(client: RedisClient, overrides: Record<string, unknown>): RedisClient {
  if (client.isCluster) {
    const { keyPrefix, ...rest } = overrides
    return (client.duplicate as unknown as (nodes: undefined, options: Record<string, unknown>) => RedisClient)(undefined, {
      ...('keyPrefix' in overrides && { keyPrefix }),
      redisOptions: {
        ...(client.options?.redisOptions as Record<string, unknown> | undefined),
        ...rest,
      },
    })
  }
  return client.duplicate(overrides)
}

/** 按连接设置创建 ioredis 实例；overrides 覆盖选项（`keyPrefix: undefined` 表示去掉前缀） */
function build(driver: RedisDriver, settings: RedisConnectionConfig, overrides: Record<string, unknown> = {}): RedisClient {
  if (settings.client) {
    const client = settings.client() as RedisClient
    if (!Object.keys(overrides).length)
      return client
    const copy = duplicateWith(client, overrides)
    void closeRedisClient(client)
    return copy
  }
  if (settings.cluster) {
    const { keyPrefix, ...rest } = overrides
    const options = settings.options ?? {}
    const nodeOptions: Record<string, unknown> = {}
    for (const key of ['username', 'password', 'db'] as const) {
      if (settings[key] !== undefined)
        nodeOptions[key] = settings[key]
    }
    if (settings.tls) {
      nodeOptions.tls = settings.tls === true
        ? {}
        : settings.tls
    }
    return new driver.Cluster(settings.cluster, {
      ...options,
      keyPrefix: 'keyPrefix' in overrides
        ? keyPrefix
        : settings.keyPrefix ?? options.keyPrefix,
      redisOptions: {
        ...nodeOptions,
        ...(options.redisOptions as Record<string, unknown> | undefined),
        ...rest,
      },
    })
  }
  const options = {
    ...redisOptions(settings),
    ...overrides,
  }
  return settings.url
    ? new driver.Redis(settings.url, options)
    : new driver.Redis(options)
}

/** 代理上的命令：解析共享连接后调用 */
export type RedisCommand = (...args: any[]) => Promise<any>

/** 常用命令（其它命令同样可以直接调用，返回值为 any；完整类型请用 client() 并断言为 ioredis 的 Redis） */
export interface RedisCommands {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string | number, ...args: Array<string | number>) => Promise<string | null>
  del: (...keys: string[]) => Promise<number>
  exists: (...keys: string[]) => Promise<number>
  expire: (key: string, seconds: number) => Promise<number>
  ttl: (key: string) => Promise<number>
  incr: (key: string) => Promise<number>
  incrby: (key: string, by: number) => Promise<number>
  decr: (key: string) => Promise<number>
  mget: (...keys: string[]) => Promise<Array<string | null>>
  hget: (key: string, field: string) => Promise<string | null>
  hset: (key: string, ...args: Array<string | number | Record<string, string | number>>) => Promise<number>
  hgetall: (key: string) => Promise<Record<string, string>>
  hdel: (key: string, ...fields: string[]) => Promise<number>
  lpush: (key: string, ...values: Array<string | number>) => Promise<number>
  rpush: (key: string, ...values: Array<string | number>) => Promise<number>
  lrange: (key: string, start: number, stop: number) => Promise<string[]>
  sadd: (key: string, ...members: Array<string | number>) => Promise<number>
  smembers: (key: string) => Promise<string[]>
  srem: (key: string, ...members: Array<string | number>) => Promise<number>
  publish: (channel: string, message: string) => Promise<number>
  ping: () => Promise<string>
  eval: (script: string, numkeys: number, ...args: Array<string | number>) => Promise<unknown>
  /** 任意命令：`call('JSON.GET', key)` */
  call: (command: string, ...args: Array<string | number>) => Promise<unknown>
}

/** 命名连接：直接调用命令（共享的命令连接，首次调用时建立） */
export interface RedisConnection extends RedisCommands {
  /** 底层的共享 ioredis 客户端（pipeline / multi 等非命令方法从这里取） */
  client: () => Promise<RedisClient>
  [command: string]: RedisCommand
}

function commandProxy(resolve: () => Promise<RedisClient>): RedisConnection {
  return new Proxy({} as RedisConnection, {
    get(_target, property) {
      // 不是 thenable：`await Redis.connection()` 不会误把代理当作 Promise
      if (typeof property === 'symbol' || property === 'then')
        return undefined
      if (property === 'client')
        return resolve
      return async (...args: unknown[]) => {
        const client = await resolve()
        const command = client[property]
        if (typeof command !== 'function')
          throw new TypeError(`Redis command "${property}" is not available on this client`)
        return command.apply(client, args)
      }
    },
  })
}

/**
 * Redis 连接管理（应用单例，`inject(RedisManager)`）：config/redis.ts 的命名连接。
 * - `client(name)` / `connection(name)`：共享的命令连接（每个连接一个，跨热更新复用）；
 * - `subscriber(name)` / `create(name, overrides)`：专用连接（订阅、BRPOP 等阻塞命令），由调用方关闭；
 * - `bullmq(target)`：BullMQ 用的连接选项（去掉 keyPrefix，maxRetriesPerRequest 为 null）。
 * 应用关闭（非 hmr）时断开全部连接。
 */
export class RedisManager {
  readonly #source: Config | Partial<RedisConfig> | undefined
  readonly #driver: RedisDriver | undefined
  readonly #connections = new Map<string, RedisConnection>()

  constructor(config?: Config | Partial<RedisConfig>, options: RedisManagerOptions = {}) {
    this.#source = config
    this.#driver = options.driver
    // 尽早登记持久资源：释放时按登记的逆序执行，其它功能（广播总线、Socket.IO）先于连接关闭
    sharedClients()
    dedicatedClients()
  }

  get config(): ResolvedRedisConfig {
    const source = this.#source instanceof Config
      ? this.#source.get<Partial<RedisConfig> | undefined>('redis', undefined)
      : this.#source
    return resolveRedisConfig(source)
  }

  get defaultConnection(): string {
    return this.config.default
  }

  /** 连接名（config/redis.ts；缺省时只有 default） */
  names(): string[] {
    return Object.keys(this.config.connections)
  }

  has(name: string): boolean {
    return Object.hasOwn(this.config.connections, name)
  }

  /** 连接的设置 */
  settings(name: string = this.defaultConnection): RedisConnectionConfig {
    const settings = this.config.connections[name]
    if (!settings)
      throw new Error(`Redis connection "${name}" is not defined in config/redis.ts`)
    return settings
  }

  /** 解析功能配置：client > url > connection > 默认连接；options 与 connection 一起时覆盖命名连接的选项 */
  resolve(target?: RedisTarget): Resolved {
    if (target === undefined || typeof target === 'string') {
      const name = target ?? this.defaultConnection
      const settings = this.settings(name)
      return { key: `connection:${name}:${fingerprint(settings)}`, settings }
    }
    if (target.client)
      return { key: '', settings: {}, instance: target.client as RedisClient }
    if (target.url) {
      const settings: RedisConnectionConfig = { url: target.url, options: target.options }
      return { key: `url:${fingerprint(settings)}`, settings }
    }
    const name = target.connection ?? this.defaultConnection
    const base = this.settings(name)
    const settings = target.options
      ? {
          ...base,
          options: {
            ...base.options,
            ...target.options,
          },
        }
      : base
    return { key: `connection:${name}:${fingerprint(settings)}`, settings }
  }

  async #load(feature: string): Promise<RedisDriver> {
    return this.#driver ?? loadRedis(feature)
  }

  /** 共享的命令连接（同一连接只建立一次）；不要在它上面 SUBSCRIBE / BRPOP，请用 subscriber() / create() */
  async client(target?: RedisTarget, feature = 'Redis'): Promise<RedisClient> {
    const resolved = this.resolve(target)
    if (resolved.instance)
      return resolved.instance
    const pool = sharedClients()
    let client = pool.get(resolved.key)
    if (!client) {
      client = this.#load(feature).then(driver => build(driver, resolved.settings))
      pool.set(resolved.key, client)
      client.catch(() => pool.delete(resolved.key))
    }
    return client
  }

  /** 命名连接的命令代理：`connection('cache').get('k')` */
  connection(connectionName?: RedisConnectionName): RedisConnection {
    const name: string = connectionName ?? this.defaultConnection
    let connection = this.#connections.get(name)
    if (!connection) {
      // 先校验连接名，错误在调用处抛出
      this.settings(name)
      connection = commandProxy(() => this.client(name))
      this.#connections.set(name, connection)
    }
    return connection
  }

  /** 新建一个专用连接（同一连接的设置，可覆盖选项），由调用方 quit()；应用关闭时兜底断开 */
  async create(target?: RedisTarget, overrides: Record<string, unknown> = {}, feature = 'Redis'): Promise<RedisClient> {
    const resolved = this.resolve(target)
    const client = resolved.instance
      ? duplicateWith(resolved.instance, overrides)
      : build(await this.#load(feature), resolved.settings, overrides)
    const clients = dedicatedClients()
    clients.add(client)
    client.once?.('end', () => clients.delete(client))
    return client
  }

  /** 订阅用的专用连接（SUBSCRIBE 后该连接不能再执行普通命令） */
  async subscriber(target?: RedisTarget, feature = 'Redis'): Promise<RedisClient> {
    return this.create(target, {}, feature)
  }

  /**
   * BullMQ 的 connection：单机 / Sentinel 返回选项（BullMQ 为每个 Queue / Worker 自己建立连接并关闭），
   * Cluster 与自定义客户端返回一个专用实例（Queue 共用，Worker 复制），由 close() 断开。
   * 两种情况都去掉 keyPrefix（BullMQ 不允许，改用队列的 prefix）并设置 maxRetriesPerRequest: null。
   */
  async bullmq(target?: RedisTarget, feature = 'Queue driver "redis"'): Promise<{ connection: Record<string, unknown> | RedisClient, close: () => Promise<void> }> {
    const resolved = this.resolve(target)
    if (resolved.instance || resolved.settings.client || resolved.settings.cluster) {
      const client = await this.create(target, { keyPrefix: undefined, maxRetriesPerRequest: null }, feature)
      return {
        connection: client,
        close: () => closeRedisClient(client),
      }
    }
    const { keyPrefix: _keyPrefix, ...options } = redisOptions(resolved.settings)
    return {
      connection: {
        ...(resolved.settings.url && { url: resolved.settings.url }),
        ...options,
        maxRetriesPerRequest: null,
      },
      close: async () => {},
    }
  }

  /** 断开全部连接（共享与专用，所有应用共用同一个连接池）；之后再使用会重新建立 */
  async disconnect(): Promise<void> {
    await disposePersistent('redis:dedicated')
    await disposePersistent('redis:shared')
    // 重新登记，保持释放顺序
    sharedClients()
    dedicatedClients()
  }
}

let fallback: RedisManager | undefined
let standalone: RedisManager | undefined

/** 设置请求之外使用的 Redis 管理器（应用启动时设置） */
export function setRedisManager(manager: RedisManager | undefined): void {
  fallback = manager
}

/**
 * 当前应用的 Redis 管理器：请求内取请求容器，否则取最近启动的应用；
 * 应用之外（独立脚本、单独使用的微服务传输）为只有隐式 default 连接（REDIS_URL）的管理器
 */
export function useRedisManager(): RedisManager {
  const container = getRequestStore()?.container
  if (container?.has(RedisManager))
    return container.make(RedisManager)
  return fallback ?? (standalone ??= new RedisManager())
}

/** 命名连接（默认连接）的命令代理：`await useRedis('cache').get('k')` */
export function useRedis(name?: RedisConnectionName): RedisConnection {
  return useRedisManager().connection(name)
}

export interface RedisFacade extends RedisCommands {
  /** 命名连接的命令代理 */
  connection: (name?: RedisConnectionName) => RedisConnection
  /** 共享的 ioredis 客户端 */
  client: (name?: RedisConnectionName) => Promise<RedisClient>
  /** 订阅用的专用连接（调用方 quit()） */
  subscriber: (name?: RedisConnectionName) => Promise<RedisClient>
  /** 新建专用连接（调用方 quit()） */
  create: (name?: RedisConnectionName, overrides?: Record<string, unknown>) => Promise<RedisClient>
}

const facadeMethods: Record<string, (...args: any[]) => unknown> = {
  connection: (name?: RedisConnectionName) => useRedisManager().connection(name),
  client: (name?: RedisConnectionName) => useRedisManager().client(name),
  subscriber: (name?: RedisConnectionName) => useRedisManager().subscriber(name),
  create: (name?: RedisConnectionName, overrides?: Record<string, unknown>) => useRedisManager().create(name, overrides),
}

/**
 * Redis 门面：默认连接的命令，`Redis.connection('cache')` 切换连接。
 *
 * ```ts
 * await Redis.set('visits', 0)
 * await Redis.connection('cache').get('k')
 * ```
 */
export const Redis: RedisFacade = new Proxy({} as RedisFacade, {
  get(_target, property) {
    if (typeof property === 'symbol' || property === 'then')
      return undefined
    return facadeMethods[property] ?? ((...args: unknown[]) => (useRedisManager().connection() as Record<string, RedisCommand>)[property]!(...args))
  },
})
