/** ioredis 客户端的结构（core 不依赖 ioredis 的类型；需要完整类型时断言为 `import('ioredis').Redis`） */
export interface RedisClient {
  readonly status?: string
  readonly options?: { keyPrefix?: string, [key: string]: unknown }
  duplicate: (options?: Record<string, unknown>) => RedisClient
  quit: () => Promise<unknown>
  disconnect: () => void
  on: (event: string, listener: (...args: any[]) => void) => unknown
  once: (event: string, listener: (...args: any[]) => void) => unknown
  [command: string]: any
}

export type RedisConstructor = new (...args: any[]) => RedisClient

/** ioredis 模块中用到的两个构造函数 */
export interface RedisDriver {
  Redis: RedisConstructor
  Cluster: RedisConstructor
}

let loading: Promise<RedisDriver> | undefined

/**
 * 加载 ioredis（可选依赖，只加载一次）。所有经 TCP 访问 Redis 的功能共用这一个入口，
 * 缺失时统一提示：`<feature> requires ioredis. Install it with: pnpm add ioredis`
 */
export async function loadRedis(feature = 'Redis'): Promise<RedisDriver> {
  try {
    // 静态的 import('ioredis') 便于构建工具追踪到产物中
    return await (loading ??= import('ioredis').then((module) => {
      const value = module as unknown as { Redis?: RedisConstructor, Cluster?: RedisConstructor, default?: RedisConstructor & { Cluster?: RedisConstructor } }
      const Redis = (value.Redis ?? value.default)!
      return {
        Redis,
        Cluster: (value.Cluster ?? value.default?.Cluster)!,
      }
    }))
  }
  catch (error) {
    loading = undefined
    throw new Error(`${feature} requires ioredis. Install it with: pnpm add ioredis`, { cause: error })
  }
}
