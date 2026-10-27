/**
 * 缓存驱动接口：值为序列化后的字符串，key 已带前缀，ttl 单位为秒（undefined 表示永久）。
 * `atomic` 为 false 的驱动（Cloudflare KV）在 add / increment 上不保证原子性。
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
  close?: () => Promise<void>
}
