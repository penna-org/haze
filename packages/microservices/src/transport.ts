import type { SerializedError } from './errors'
import type { MessageKind } from './handler'
import { MicroserviceTimeoutError, RemoteError } from './errors'

/** 线路上的消息 */
export interface Packet {
  id: string
  pattern: string
  kind: MessageKind
  data: unknown
  /** 请求的截止时间（毫秒时间戳），过期的请求不再处理 */
  deadline?: number
}

export type Reply = { id: string, ok: true, data: unknown } | { id: string, ok: false, error: SerializedError }

/** 服务端收到消息后的处理（由框架提供）：返回回复数据，抛出的错误回传给调用方 */
export type Dispatch = (packet: Packet) => Promise<unknown>

export interface ListenOptions {
  /** 要订阅的消息模式（gRPC 按 proto 中的方法，不使用此列表） */
  patterns: string[]
  dispatch: Dispatch
  /** 队列组：同组的实例之间负载均衡，不同组各收到一份事件 */
  queue?: string
  /** 记录错误（事件处理失败等） */
  onError: (error: unknown, packet?: Packet) => void
}

export interface TransportServer {
  close: () => Promise<void>
}

/** 传输层：客户端发送（send / emit）与服务端监听 */
export interface Transport {
  /** 请求 / 回复：resolve 为回复数据；远端错误为 RemoteError，超时为 MicroserviceTimeoutError */
  send: (pattern: string, data: unknown, options: { timeout: number }) => Promise<unknown>
  /** 事件：发出即返回，不等待处理 */
  emit: (pattern: string, data: unknown) => Promise<void>
  listen: (options: ListenOptions) => Promise<TransportServer>
  /** 关闭客户端连接（监听由 listen 返回的 TransportServer 关闭） */
  close: () => Promise<void>
}

export const encoder = new TextEncoder()
export const decoder = new TextDecoder()

export function encode(value: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(value))
}

export function decode<T>(data: Uint8Array | string): T {
  return JSON.parse(typeof data === 'string'
    ? data
    : decoder.decode(data)) as T
}

export function messageId(): string {
  return crypto.randomUUID()
}

/** 回复 → 结果；远端错误转为 RemoteError */
export function unwrapReply(pattern: string, reply: Reply): unknown {
  if (reply.ok)
    return reply.data
  throw new RemoteError(pattern, reply.error)
}

/** 带超时的等待；超时后调用 onTimeout 清理 */
export function withTimeout<T>(pattern: string, timeout: number, promise: Promise<T>, onTimeout?: () => void): Promise<T> {
  if (!Number.isFinite(timeout) || timeout <= 0)
    return promise
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout?.()
        reject(new MicroserviceTimeoutError(pattern, timeout))
      }, timeout)
    }),
  ]).finally(() => clearTimeout(timer))
}

/** 动态导入可选依赖（静态的 import() 便于构建工具追踪），缺失时给出安装提示 */
export async function importOptional<T>(load: () => Promise<T>, name: string, driver: string): Promise<T> {
  try {
    return await load()
  }
  catch (error) {
    throw new Error(`The ${driver} microservice transport requires "${name}". Install it with: pnpm add ${name}`, { cause: error })
  }
}
