import type { ResponseConfig } from '../config/config'
import { isPlainObject } from '../utils'

/** 只包装可 JSON 序列化的“数据”，字符串、Response、流、二进制等原样返回 */
export function shouldEnvelope(value: unknown): boolean {
  return value === null
    || value === undefined
    || Array.isArray(value)
    || isPlainObject(value)
    || typeof value === 'number'
    || typeof value === 'boolean'
}

export function envelope(value: unknown, config: ResponseConfig): unknown {
  if (!shouldEnvelope(value))
    return value
  return {
    code: config.successCode,
    message: config.successMessage,
    data: value ?? null,
  }
}
