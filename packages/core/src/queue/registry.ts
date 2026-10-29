import type { Application } from '../application'
import type { QueueDriver } from './drivers/types'

/**
 * 其它包注册的队列驱动的配置类型（声明合并：驱动名 → 连接配置），进入 config/queue.ts 的类型：
 *
 * ```ts
 * declare module '@hazejs/core' {
 *   interface QueueDriverRegistry {
 *     database: DatabaseQueueConfig
 *   }
 * }
 * ```
 */
export interface QueueDriverRegistry {}

/** 创建驱动：name 为连接名，config 为 config/queue.ts 中该连接的配置 */
export type QueueDriverFactory = (name: string, config: any, app: Application) => QueueDriver

const kRegistry = Symbol.for('hazejs.queue.drivers')

/** 挂在 globalThis 上：注册方（@hazejs/orm 等）与 core 即使是不同的模块实例也共用一份 */
function registry(): Map<string, QueueDriverFactory> {
  const scope = globalThis as { [kRegistry]?: Map<string, QueueDriverFactory> }
  return scope[kRegistry] ??= new Map()
}

/**
 * 注册队列驱动（config/queue.ts 中 `driver: name` 的连接由它创建），通常在服务提供者的 register 中调用：
 * `registerQueueDriver('database', (name, config) => databaseQueue(name, config))`。
 * 内置的 sync / memory / redis / cloudflare 不能被覆盖。
 */
export function registerQueueDriver(name: string, factory: QueueDriverFactory): void {
  if ([
    'sync',
    'memory',
    'redis',
    'cloudflare',
  ].includes(name)) {
    throw new Error(`Queue driver "${name}" is built in and cannot be replaced`)
  }
  registry().set(name, factory)
}

/** 已注册的驱动工厂 */
export function queueDriverFactory(name: string): QueueDriverFactory | undefined {
  return registry().get(name)
}
