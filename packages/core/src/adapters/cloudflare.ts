import { DurableObject } from 'cloudflare:workers'
import cloudflareAdapter from 'crossws/adapters/cloudflare'
import { registerWebSocketAdapter, resolveHooks } from '../websocket/server'

export interface WebSocketDurableObjectOptions {
  /** 应用的请求处理（在 DO 中解析升级请求的钩子，含中间件） */
  fetch: (request: Request) => Promise<Response>
  /** 注册 Workers 绑定（DO 构造时调用） */
  bind: (env: unknown) => void
  /** wrangler.json 中 durable_objects 的绑定名，默认 THINK_WEBSOCKET */
  bindingName?: string
}

/**
 * Cloudflare Workers 的 WebSocket（crossws + Durable Object）：所有连接在同一个 DO 中，
 * 订阅与广播全局生效；Socket.publish 在 Worker 中经 RPC 转发到 DO。
 * cloudflare 预设的入口自动使用，`@think-h3/core/cloudflare` 只能在 Workers 中导入。
 */
export interface WebSocketDurableObject {
  /** Worker 的 fetch 中：升级请求交给 DO */
  handleUpgrade: (request: Request, env: unknown, ctx: unknown) => Promise<Response>
  /** 由入口以 wrangler.json 中的 class_name 导出 */
  ThinkWebSocket: abstract new (state: DurableObjectState, env: unknown) => unknown
}

export function createWebSocketDurableObject(options: WebSocketDurableObjectOptions): WebSocketDurableObject {
  const ws = cloudflareAdapter({
    bindingName: options.bindingName ?? 'THINK_WEBSOCKET',
    resolve: resolveHooks(options.fetch),
  })
  registerWebSocketAdapter(ws)

  class ThinkWebSocket extends DurableObject {
    constructor(state: DurableObjectState, env: unknown) {
      super(state, env as never)
      options.bind(env)
      ws.handleDurableInit(this as never, state as never, env)
    }

    override fetch(request: Request): Promise<Response> {
      return ws.handleDurableUpgrade(this as never, request)
    }

    override webSocketMessage(client: WebSocket, message: ArrayBuffer | string): Promise<void> {
      return ws.handleDurableMessage(this as never, client as never, message)
    }

    webSocketPublish(topic: string, data: unknown, publishOptions: unknown): Promise<void> {
      return ws.handleDurablePublish(this as never, topic, data, publishOptions)
    }

    override webSocketClose(client: WebSocket, code: number, reason: string, wasClean: boolean): Promise<void> {
      return ws.handleDurableClose(this as never, client as never, code, reason, wasClean)
    }
  }

  return {
    handleUpgrade: (request: Request, env: unknown, ctx: unknown): Promise<Response> => ws.handleUpgrade(request, env, ctx as never),
    ThinkWebSocket,
  }
}
