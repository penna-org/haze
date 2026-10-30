import process from 'node:process'

/** Cluster / Sentinel 的节点地址 */
export interface RedisNode {
  host: string
  port: number
}

/**
 * 一个 Redis 连接（ioredis）。三种写法任选其一：
 * - 单机：`url`（`redis://` / `rediss://`）或 host / port / password / username / db / tls；
 * - Cluster：`cluster` 节点列表（`options` 为 ioredis 的 ClusterOptions，节点选项放在 `options.redisOptions`）；
 * - Sentinel：`sentinels` + `name`（主节点名）；
 * - 自定义：`client` 工厂，每次调用返回新的 ioredis 实例（共享连接与专用连接都由它创建）。
 */
export interface RedisConnectionConfig {
  url?: string
  host?: string
  port?: number
  username?: string
  password?: string
  db?: number
  /** true 或 ioredis 的 tls 选项（`rediss://` 地址无需设置） */
  tls?: boolean | Record<string, unknown>
  /**
   * 键前缀（ioredis 的 keyPrefix）：只作用于键，不作用于 pub/sub 的频道名；
   * BullMQ 不允许 keyPrefix，队列改用自己的 prefix
   */
  keyPrefix?: string
  /** Cluster 的启动节点 */
  cluster?: Array<RedisNode | string>
  /** Sentinel 节点 */
  sentinels?: RedisNode[]
  /** Sentinel 的主节点名 */
  name?: string
  /** 透传给 ioredis 的其它选项（Cluster 时为 ClusterOptions） */
  options?: Record<string, unknown>
  /** 自定义客户端工厂：`() => new Redis(...)` */
  client?: () => unknown
}

export interface RedisConfig<Name extends string = string> {
  /** 默认连接，默认 `default`（不存在时取第一个连接） */
  default?: Name
  connections: Record<Name, RedisConnectionConfig>
}

/**
 * 生成的 Redis 连接（haze typegen 根据 config/redis.ts 写入 `connections`）。与 GeneratedConfig 分开：
 * config/cache.ts 等配置文件引用连接名（`connection: 'default'`）时，若经由 GeneratedConfig 推导，
 * 配置类型会互相引用而无法推断
 */
export interface GeneratedRedisConnections {}

/**
 * 已命名的连接：生成过配置类型（config/redis.ts）时为连接名的联合，否则为 string。
 * 缺省 config/redis.ts 时只有隐式的 `default`。
 */
export type RedisConnectionName = GeneratedRedisConnections extends { connections: infer C }
  ? keyof C & string
  : string

/**
 * 引用 Redis 连接的功能配置（缓存、队列、WebSocket、广播、Socket.IO、微服务）共用的字段。
 * 优先级：`client`（只有缓存支持）> `url` > `connection` > config/redis.ts 的默认连接。
 */
export interface RedisConnectionRef {
  /** config/redis.ts 中的连接名，默认为其 default 连接 */
  connection?: RedisConnectionName
  /** 内联地址（兼容旧写法）：设置后不使用命名连接 */
  url?: string
  /** 透传给 ioredis 的选项：与 url 一起时为内联连接的选项，与 connection 一起时覆盖命名连接的选项 */
  options?: Record<string, unknown>
}

/** `config/redis.ts` 的默认导出；连接名会进入生成的类型（`connection: 'cache'` 有补全与检查） */
export function defineRedisConfig<const C extends Record<string, RedisConnectionConfig>>(
  config: RedisConfig<keyof C & string> & { connections: C } | (() => RedisConfig<keyof C & string> & { connections: C }),
): RedisConfig<keyof C & string> & { connections: C } | (() => RedisConfig<keyof C & string> & { connections: C }) {
  return config
}

export const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379'

export interface ResolvedRedisConfig {
  default: string
  connections: Record<string, RedisConnectionConfig>
}

/** 缺省 config/redis.ts 时的隐式配置：default 连接读取 REDIS_URL（在 .env 加载之后求值） */
export function implicitRedisConfig(): ResolvedRedisConfig {
  return {
    default: 'default',
    connections: {
      default: { url: process.env.REDIS_URL || DEFAULT_REDIS_URL },
    },
  }
}

/** 规范化：未设置 default 时取 `default`，不存在则取第一个连接 */
export function resolveRedisConfig(config: Partial<RedisConfig> | undefined): ResolvedRedisConfig {
  if (!config?.connections || !Object.keys(config.connections).length)
    return implicitRedisConfig()
  const names = Object.keys(config.connections)
  return {
    default: config.default ?? (names.includes('default')
      ? 'default'
      : names[0]!),
    connections: config.connections,
  }
}
