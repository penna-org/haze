import type { Hooks, Message, Peer } from 'crossws'
import type { HttpContext } from '../http/context'
import type { MaybePromise } from '../utils'
import { kWebSocketHooks } from 'crossws'

export type { Message, Peer }

/**
 * WebSocket 处理器：钩子多一个参数 ctx，为升级请求的上下文（已经过全局与路由中间件，可读 ctx.auth 等）。
 * 升级请求结束后请求级容器即被释放：长连接中需要的数据请在 upgrade / open 中读取并保存。
 */
export interface WebSocketHandler {
  /** 返回 Response 拒绝升级，或返回 { headers } 附加响应头 */
  upgrade?: (request: Request, ctx: HttpContext) => MaybePromise<Response | { headers?: ConstructorParameters<typeof Headers>[0] } | void>
  open?: (peer: Peer, ctx: HttpContext) => MaybePromise<unknown>
  message?: (peer: Peer, message: Message, ctx: HttpContext) => MaybePromise<unknown>
  close?: (peer: Peer, details: { code?: number, reason?: string }, ctx: HttpContext) => MaybePromise<unknown>
  error?: (peer: Peer, error: unknown, ctx: HttpContext) => MaybePromise<unknown>
}

/** 定义 WebSocket 处理器（可放在单独文件中，路由里 `r.ws('/chat', ChatSocket)`） */
export function defineWebSocket(handler: WebSocketHandler): WebSocketHandler {
  return handler
}

/** 把处理器绑定到升级请求的上下文，转换为 crossws 钩子 */
export function toHooks(handler: WebSocketHandler, ctx: HttpContext): Partial<Hooks> {
  return {
    ...(handler.upgrade && {
      upgrade: (request: Request) => handler.upgrade!(request, ctx) as never,
    }),
    ...(handler.open && {
      open: peer => handler.open!(peer, ctx) as never,
    }),
    ...(handler.message && {
      message: (peer, message) => handler.message!(peer, message, ctx) as never,
    }),
    ...(handler.close && {
      close: (peer, details) => handler.close!(peer, details, ctx) as never,
    }),
    ...(handler.error && {
      error: (peer, error) => handler.error!(peer, error, ctx) as never,
    }),
  }
}

/**
 * 路由处理：把钩子挂在请求上（中间件重建响应也不会丢失），返回 426。
 * 由 crossws 在升级时调用应用的 fetch 取得钩子；普通 GET 请求得到 426。
 */
export function upgradeResponse(ctx: HttpContext, handler: WebSocketHandler): Response {
  const hooks = toHooks(handler, ctx)
  try {
    (ctx.req as unknown as Record<symbol, unknown>)[kWebSocketHooks] = hooks
  }
  catch {}
  return Object.assign(new Response('WebSocket upgrade is required.', { status: 426 }), { crossws: hooks })
}
