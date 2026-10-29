import { jsonReplacer } from '../utils'

/**
 * 缓存值的序列化器：`set` / `get`、标签缓存与 Redis 数据结构的每个元素都经过它。
 * 自增计数与锁不经过序列化器（原样存数字与字符串）。
 */
export interface CacheSerializer {
  serialize: (value: unknown) => string
  deserialize: (raw: string) => unknown
  /**
   * 数组中一个元素的编码（JSON 系的序列化器提供）：有它时 `push` 在驱动中直接拼接字符串，
   * redis / upstash 上用 Lua 原子完成；没有时 `push` 退回读后写
   */
  element?: (value: unknown) => string
}

/** `config/cache.ts` 的 serializer：`'typed'`（默认）、`'json'` 或自定义 */
export type CacheSerializerOption = 'json' | 'typed' | CacheSerializer

/** 顶层的 undefined 存为 null（与原来一致；读回 undefined 无法与“不存在”区分） */
function topLevel(value: unknown): unknown {
  return value === undefined
    ? null
    : value
}

/** 纯 JSON：BigInt 写为字符串（jsonReplacer），Date 读回为字符串 */
export const jsonSerializer: CacheSerializer = {
  serialize: value => JSON.stringify(topLevel(value), jsonReplacer),
  deserialize: raw => JSON.parse(raw),
  element: value => JSON.stringify([value], jsonReplacer).slice(1, -1),
}

/** 类型标记的键名；只有下面几种类型会带标记，其它值保持普通 JSON */
const TAG = '$t'

type Tagged = { [TAG]: 'Date', v: string | null }
  | { [TAG]: 'BigInt', v: string }
  | { [TAG]: 'Map', v: unknown[][] }
  | { [TAG]: 'Set', v: unknown[] }
  | { [TAG]: 'undefined' }
  | { [TAG]: 'Object', v: unknown[][] }

/**
 * replacer 中 value 已经过 toJSON（Date 已是字符串），原值从 holder（this）上取。
 * 模型等实现了 toJSON 的对象照常按 toJSON 的结果序列化。
 */
function typedReplacer(this: unknown, key: string, value: unknown): unknown {
  const raw = (this as Record<string, unknown>)[key]
  if (raw instanceof Date)
    return { [TAG]: 'Date', v: value as string | null } satisfies Tagged
  if (typeof value === 'bigint') {
    return {
      [TAG]: 'BigInt',
      v: value.toString(),
    } satisfies Tagged
  }
  if (value instanceof Map) {
    return {
      [TAG]: 'Map',
      v: [...value],
    } satisfies Tagged
  }
  if (value instanceof Set) {
    return {
      [TAG]: 'Set',
      v: [...value],
    } satisfies Tagged
  }
  // 数组与对象中的 undefined（JSON 原本写为 null / 省略）；toJSON 返回 undefined 时仍按 JSON 省略
  if (value === undefined && raw === undefined && key !== '')
    return { [TAG]: 'undefined' } satisfies Tagged
  // 用户数据本身带 `$t` 键：整体转义，避免读回时被误认为类型标记
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, TAG)) {
    return {
      [TAG]: 'Object',
      v: Object.entries(value),
    } satisfies Tagged
  }
  return value
}

/** 读回 undefined 的占位：reviver 返回 undefined 会删除属性，先占位，再由上层容器替换 */
const UNDEFINED = Symbol('undefined')

function isTagged(value: unknown): value is Tagged {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false
  const tag = (value as Record<string, unknown>)[TAG]
  if (typeof tag !== 'string')
    return false
  const keys = Object.keys(value)
  if (tag === 'undefined')
    return keys.length === 1
  return keys.length === 2 && 'v' in value && [
    'Date',
    'BigInt',
    'Map',
    'Set',
    'Object',
  ].includes(tag)
}

function restore(value: unknown): unknown {
  return value === UNDEFINED
    ? undefined
    : value
}

function deserializeTyped(raw: string): unknown {
  // 没有任何标记时就是普通 JSON（大多数值），不走 reviver
  if (!raw.includes(`"${TAG}"`))
    return JSON.parse(raw)
  // 还有多少个 undefined 占位等待所在的数组 / 对象替换（没有时不再扫描容器）
  let pending = 0
  const result = JSON.parse(raw, (_key, value: unknown) => {
    if (value === null || typeof value !== 'object')
      return value
    if (isTagged(value)) {
      switch (value[TAG]) {
        case 'Date':
          return new Date(value.v ?? Number.NaN)
        case 'BigInt':
          return BigInt(value.v)
        case 'Map':
          return new Map(value.v.map(([k, v]) => [
            restore(k),
            restore(v),
          ]))
        case 'Set':
          return new Set(value.v.map(restore))
        case 'Object':
          return Object.fromEntries(value.v.map(([k, v]) => [
            k,
            restore(v),
          ]))
        case 'undefined':
          pending++
          return UNDEFINED
      }
    }
    if (pending > 0) {
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (item === UNDEFINED) {
            value[index] = undefined
            pending--
          }
        })
      }
      else {
        for (const [key, item] of Object.entries(value)) {
          if (item === UNDEFINED) {
            (value as Record<string, unknown>)[key] = undefined
            pending--
          }
        }
      }
    }
    return value
  })
  return restore(result)
}

/**
 * 默认序列化器：JSON + 类型还原。`Date`、`BigInt`、`Map`、`Set` 以及数组 / 对象中的 `undefined`
 * 写为紧凑的标记（`{"$t":"Date","v":"2026-10-28T00:00:00.000Z"}`），读回时还原；其它值就是普通 JSON，
 * 别的语言与工具可以直接读取。原来的纯 JSON 值照常读取（向后兼容）。
 */
export const typedSerializer: CacheSerializer = {
  serialize: value => JSON.stringify(topLevel(value), typedReplacer),
  deserialize: deserializeTyped,
  element: value => JSON.stringify([value], typedReplacer).slice(1, -1),
}

export function resolveSerializer(option: CacheSerializerOption | undefined): CacheSerializer {
  if (option === undefined || option === 'typed')
    return typedSerializer
  if (option === 'json')
    return jsonSerializer
  return option
}
