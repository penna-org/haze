import type { MiddlewareRef } from '../middleware/types'
import type { BroadcastBus, BroadcastBusConfig } from './bus'

export interface BroadcastingConfig {
  /** 内置接口的前缀，默认 `/broadcasting`：`POST /auth`、`GET /sse`、`/ws`（WebSocket） */
  path?: string
  /** false 时不注册内置接口（只在服务端广播，如由 Socket.IO 承载） */
  routes?: boolean
  /** 内置接口额外使用的路由中间件（全局中间件始终生效），如 `['throttle:60,60']` */
  middleware?: MiddlewareRef[]
  /**
   * 多实例总线：缺省时沿用 config/websocket.ts 的 `broadcast`（Redis），否则为进程内（memory）。
   * 也可以传入自定义的 BroadcastBus。
   */
  bus?: BroadcastBusConfig | BroadcastBus
  /** 启用的传输，默认都启用 */
  transports?: {
    ws?: boolean
    sse?: boolean
  }
  /** SSE 心跳间隔（秒或 '25s'），默认 25 秒 */
  heartbeat?: number | string
  /** 每个 SSE 连接最多订阅的频道数，默认 100 */
  maxChannels?: number
}

/** `config/broadcasting.ts` 的默认导出 */
export function defineBroadcastingConfig(config: BroadcastingConfig | (() => BroadcastingConfig)): BroadcastingConfig | (() => BroadcastingConfig) {
  return config
}
