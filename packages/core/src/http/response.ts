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
    || typeof value === 'boolean'
    || (typeof value === 'object' && typeof (value as { toJSON?: unknown }).toJSON === 'function')
}

const kRaw = Symbol.for('think-h3.raw')

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
