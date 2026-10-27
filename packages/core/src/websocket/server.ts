import type { AdapterInstance, Hooks, SyncAdapter } from 'crossws'
import type { Buffer } from 'node:buffer'
import type { IncomingMessage, Server as NodeServer } from 'node:http'
import type { Duplex } from 'node:stream'
import type { ServerPlugin } from 'srvx'
import type { Config } from '../config/config'
import type { BunSocketLike } from '../server/extensions'
import { getWebSocketHooks } from 'crossws'
import bunAdapter from 'crossws/adapters/bun'
import denoAdapter from 'crossws/adapters/deno'
import { redis } from 'crossws/sync'
import { NodeRequest } from 'srvx/node'
import { extensionFor, registerNodeServer, serverExtensions } from '../server/extensions'
import { globalStore } from '../utils'

type FetchHandler = (request: Request) => Response | Promise<Response>

export interface WebSocketConfig {
  /**
   * 多实例广播：Socket.publish / peer.publish 经 Redis pub/sub 转发到所有实例（需要 ioredis）。
   * channel 用于区分共用同一个 Redis 的不同应用。
   */
  broadcast?: { driver: 'redis', url?: string, channel?: string }
}

/** `config/websocket.ts` 的默认导出 */
export function defineWebSocketConfig(config: WebSocketConfig | (() => WebSocketConfig)): WebSocketConfig | (() => WebSocketConfig) {
  return config
}

/** 当前进程中的 crossws 适配器（Socket.publish 使用），跨热更新保留 */
const adapters = globalStore('ws:adapters', () => new Set<Pick<AdapterInstance, 'publish' | 'peers'>>())

/** @internal */
export function registerWebSocketAdapter(adapter: Pick<AdapterInstance, 'publish' | 'peers'>): () => void {
  adapters.add(adapter)
  return () => adapters.delete(adapter)
}

/**
 * 服务端广播（HTTP 接口、任务、事件监听器中使用）：
 * 发给订阅了 topic 的全部连接；配置了 broadcast 时同时转发到其它实例。
 */
export const Socket = {
  publish(topic: string, data: unknown): void {
    const message = typeof data === 'string' || data instanceof Uint8Array || data instanceof ArrayBuffer
      ? data
      : JSON.stringify(data)
    adapters.forEach(adapter => adapter.publish(topic, message))
  },
  /** 当前进程的连接数 */
  connections(): number {
    let count = 0
    adapters.forEach(adapter => adapter.peers.forEach(set => (count += set.size)))
    return count
  },
}

/** 调用应用的 fetch 取得升级请求的钩子（与 crossws 的默认解析一致：非 101 / 426 的响应拒绝升级） */
export function resolveHooks(fetch: FetchHandler): (request: Request) => Promise<Partial<Hooks>> {
  return async (request) => {
    const response = await fetch(request)
    const hooks = (response as Response & { crossws?: Partial<Hooks> }).crossws ?? getWebSocketHooks(request)
    if (hooks && (response.status === 426 || response.ok)) {
      response.body?.cancel().catch(() => {})
      return hooks
    }
    // 中间件拒绝（401 / 403 / 404 等）：以该响应拒绝升级
    return {
      upgrade: () => response,
    }
  }
}

/** 由配置创建 Redis 同步（ioredis 延迟加载） */
export function syncFromConfig(config: WebSocketConfig | undefined): SyncAdapter | undefined {
  const broadcast = config?.broadcast
  if (!broadcast)
    return undefined
  return (context) => {
    let driver: ReturnType<SyncAdapter> | undefined
    const ready = import('ioredis').then((module) => {
      const Redis = (module as unknown as { Redis?: new (url: string) => unknown, default?: new (url: string) => unknown }).Redis ?? (module as { default: new (url: string) => unknown }).default
      driver = redis({
        client: new Redis(broadcast.url ?? 'redis://127.0.0.1:6379') as never,
        channel: broadcast.channel ?? 'think:ws',
      })(context)
    }, (error) => {
      throw new Error('WebSocket broadcast "redis" requires ioredis. Install it with: pnpm add ioredis', { cause: error })
    })
    return {
      subscribe: async (deliver) => {
        await ready
        return driver!.subscribe(deliver)
      },
      publish: async (message) => {
        await ready
        return driver!.publish(message)
      },
      close: async () => {
        await ready.catch(() => {})
        await driver?.close?.()
      },
    }
  }
}

/**
 * srvx 插件：按运行时（Node / Bun / Deno）接入 WebSocket 升级。
 * fetch 为应用（或开发时热替换后的最新应用）的请求处理函数。
 */
export function webSocketPlugin(fetch: FetchHandler, config?: WebSocketConfig): ServerPlugin {
  const resolve = resolveHooks(fetch)
  const sync = syncFromConfig(config)
  const runtime = globalThis as { Bun?: unknown, Deno?: unknown }
  return (server) => {
    if (runtime.Bun) {
      const ws = bunAdapter({ resolve, sync })
      registerWebSocketAdapter(ws)
      const bunServer = (request: Request): never => (request as unknown as { runtime: { bun: { server: never } } }).runtime.bun.server
      server.options.middleware.unshift((request, next) => {
        // 服务器扩展（如 Socket.IO）的路径：交给扩展，包括它的 WebSocket 升级
        const extension = extensionFor(request.url)
        if (extension?.bun)
          return extension.bun.handle(request, bunServer(request))
        return request.headers.get('upgrade')?.toLowerCase() === 'websocket'
          ? ws.handleUpgrade(request, bunServer(request)) as Promise<Response>
          : next()
      })
      const options = server.options as { bun?: { websocket?: unknown, idleTimeout?: number } }
      options.bun ??= {}
      // Bun 只允许一组 websocket 处理器：按连接的升级方分发
      const pick = (socket: BunSocketLike): Record<string, ((...args: never[]) => unknown) | undefined> =>
        (serverExtensions().find(extension => extension.bun?.owns(socket))?.bun?.websocket ?? ws.websocket) as never
      options.bun.websocket = {
        open: (socket: BunSocketLike) => pick(socket).open?.(socket as never),
        message: (socket: BunSocketLike, message: unknown) => pick(socket).message?.(socket as never, message as never),
        close: (socket: BunSocketLike, code: number, reason: string) => pick(socket).close?.(socket as never, code as never, reason as never),
        drain: (socket: BunSocketLike) => pick(socket).drain?.(socket as never),
      }
      // 长轮询需要较长的空闲超时（Bun 默认 10 秒）
      const idle = Math.max(0, ...serverExtensions().map(extension => extension.bun?.idleTimeout ?? 0))
      if (idle)
        options.bun.idleTimeout = Math.max(options.bun.idleTimeout ?? 0, idle)
      return
    }
    if (runtime.Deno) {
      const ws = denoAdapter({ resolve, sync })
      registerWebSocketAdapter(ws)
      server.options.middleware.unshift((request, next) => request.headers.get('upgrade')?.toLowerCase() === 'websocket'
        ? ws.handleUpgrade(request, (request as unknown as { runtime: { deno: { info: never } } }).runtime.deno.info)
        : next())
      return
    }
    const upgrade = nodeUpgradeHandler(fetch, config)
    const serve = server.serve.bind(server)
    server.serve = () => {
      const node = server.node?.server as NodeServer | undefined
      if (node) {
        node.on('upgrade', upgrade)
        // 服务器扩展（如 Socket.IO）挂到同一个 http.Server
        registerNodeServer(node)
      }
      return serve()
    }
  }
}

/**
 * Node 的 upgrade 事件处理（产物服务端、Vite 开发服务器共用）。
 * Node 适配器按需加载：其内置的 ws 库在模块顶层使用 createRequire(import.meta.url)，不能在 Workers 中求值
 */
export function nodeUpgradeHandler(fetch: FetchHandler, config?: WebSocketConfig): (req: IncomingMessage, socket: Duplex, head: Buffer) => void {
  const ready = import('crossws/adapters/node').then(({ default: nodeAdapter }) => {
    const ws = nodeAdapter({
      resolve: resolveHooks(fetch),
      sync: syncFromConfig(config),
    })
    registerWebSocketAdapter(ws)
    return ws
  })
  return (req, socket, head) => {
    // 服务器扩展的路径（如 /socket.io/）由扩展自己处理升级
    if (extensionFor(req.url))
      return
    void ready.then(ws => ws.handleUpgrade(req, socket, head, new NodeRequest({
      req,
      upgrade: { socket, head },
    } as never) as unknown as Request))
  }
}

/** 读取应用的 websocket 配置 */
export function webSocketConfig(config: Config): WebSocketConfig {
  return config.get<WebSocketConfig>('websocket', {})
}
