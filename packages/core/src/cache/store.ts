/**
 * Redis 风格的数据结构命令（hash / list / set / sorted set 与键的过期）：
 * redis 驱动直接在共享连接上执行，memory 驱动在进程内模拟（供测试使用）。
 * 命令名为小写的 Redis 命令，第一个参数是已带前缀的键，返回值与 ioredis 相同（字符串、数字、数组或 null）。
 */
export interface CacheCommands {
  call: (command: string, key: string, ...args: Array<string | number>) => Promise<unknown>
  /** 依次执行多条命令（redis 为 MULTI 事务），返回各自的结果 */
  batch: (commands: Array<[command: string, key: string, ...args: Array<string | number>]>) => Promise<unknown[]>
}

/**
 * 标签缓存的键索引（可选）：写入带标签的值时把键记到每个标签下，clear() 时删除这些键并释放内存。
 * 没有它时标签缓存只靠版本号失效，旧值留到过期为止。
 */
export interface CacheTagIndex {
  /** 把 key 记到各个索引键下；ttl 为值的有效期（秒，undefined 为永久） */
  track: (indexKeys: string[], key: string, ttl: number | undefined) => Promise<void>
  /** 删除各索引记下的键以及索引本身 */
  flush: (indexKeys: string[]) => Promise<void>
}

/**
 * 缓存驱动接口：值为序列化后的字符串，key 已带前缀，ttl 单位为秒（undefined 表示永久）。
 * `atomic` 为 false 的驱动（Cloudflare KV）在 add / increment / push 上不保证原子性。
 * 带 `?` 的是可选能力，缺少时上层退回通用实现或抛出“不支持”。
 */
export interface CacheStore {
  readonly driver: string
  readonly atomic: boolean
  get: (key: string) => Promise<string | undefined>
  set: (key: string, value: string, ttl?: number) => Promise<void>
  /** 不存在时写入，返回是否写入 */
  add: (key: string, value: string, ttl?: number) => Promise<boolean>
  delete: (key: string) => Promise<boolean>
  /** 自增（不存在时从 0 开始）；ttl 只在键新建时设置。返回新值与剩余秒数（永久为 undefined） */
  increment: (key: string, by: number, ttl?: number) => Promise<{ value: number, ttl: number | undefined }>
  /** 值等于 expected 时删除（锁的持有者校验释放），返回是否删除 */
  deleteIf: (key: string, expected: string) => Promise<boolean>
  /** 删除前缀下的全部键 */
  clear: (prefix: string) => Promise<void>
  /** 剩余秒数：永久为 undefined，不存在为 null */
  ttl?: (key: string) => Promise<number | undefined | null>
  /** 只修改有效期（undefined 为改为永久），返回键是否存在 */
  touch?: (key: string, ttl: number | undefined) => Promise<boolean>
  /**
   * 向 JSON 数组追加一个已编码的元素（数组中的一项，不含方括号），不存在时新建 `[element]`；
   * ttl 为 undefined 时保留原有效期（新建时为永久）。值不是数组时抛错
   */
  push?: (key: string, element: string, ttl?: number) => Promise<void>
  /** 底层客户端（ioredis 实例、Upstash 客户端、内存 Map、KV 绑定） */
  handler?: () => unknown
  /** Redis 风格的数据结构命令（redis 与 memory） */
  commands?: CacheCommands
  /** 标签缓存的键索引（redis） */
  tags?: CacheTagIndex
  close?: () => Promise<void>
}

/** push 遇到的值不是数组 */
export function notAnArray(key: string): TypeError {
  return new TypeError(`Cache item "${key}" is not an array`)
}

/**
 * 在 JSON 数组字符串末尾追加一个元素（memory / kv 的 push，与 Lua 脚本的规则相同）：
 * 只认以 `[` 开头、`]` 结尾的值（序列化器写出的数组两端没有空白）
 */
export function appendElement(key: string, current: string | undefined, element: string): string {
  if (current === undefined)
    return `[${element}]`
  if (!current.startsWith('[') || !current.endsWith(']'))
    throw notAnArray(key)
  return current === '[]'
    ? `[${element}]`
    : `${current.slice(0, -1)},${element}]`
}
