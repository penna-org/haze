import { isPlainObject } from '../utils'

/**
 * 只格式化可 JSON 序列化的“数据”：普通对象、数组、数字、布尔、null，以及实现了 toJSON() 的对象
 * （如 ORM 模型、Date）；字符串、Response、流、二进制等原样输出
 */
export function isFormattable(value: unknown): boolean {
  return value === null
    || value === undefined
    || Array.isArray(value)
    || isPlainObject(value)
    || typeof value === 'number'
    || typeof value === 'bigint'
    || typeof value === 'boolean'
    || (typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function')
}

const kRaw = Symbol.for('hazejs.raw')

export interface RawValue<T = unknown> {
  readonly [kRaw]: true
  readonly value: T
}

/** 跳过统一响应格式，按原样输出：`return raw({ ok: true })` */
export function raw<T>(value: T): RawValue<T> {
  return { [kRaw]: true, value }
}

export function isRaw(value: unknown): value is RawValue {
  return typeof value === 'object' && value !== null && kRaw in value
}

const buffered = new WeakSet<Response>()

/**
 * 标记一次性生成（不是流）的 Response：视图、缓存命中等。请求作用域据此不为它推迟释放请求容器
 * （未标记、带响应体又没有 Content-Length 的 Response 按流式响应处理）
 * @internal
 */
export function markBuffered(response: Response): Response {
  buffered.add(response)
  return response
}

/** @internal */
export function isBufferedResponse(response: Response): boolean {
  return buffered.has(response)
}
