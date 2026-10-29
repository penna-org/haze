import type { RedisClient } from '../redis/load'
import type { CacheTtl } from './repository'
import type { CacheCommands } from './store'
import { isPlainObject } from '../utils'
import { expireSeconds } from './drivers/redis'
import { CacheRepository, seconds } from './repository'

type Arg = string | number

/** 分数边界：数字、`'-inf'` / `'+inf'`，或 `'(5'` 表示不含 5 */
export type ScoreBound = number | '-inf' | '+inf' | `(${number}`

/** 带分数的成员 */
export interface ScoredMember<T> {
  member: T
  score: number
}

/** Redis 返回的分数（字符串，`inf` / `-inf` 表示无穷） */
function parseScore(value: unknown): number {
  const text = String(value)
  return text === 'inf' || text === '+inf'
    ? Number.POSITIVE_INFINITY
    : text === '-inf'
      ? Number.NEGATIVE_INFINITY
      : Number(text)
}

function bound(value: ScoreBound): string {
  return value === Number.POSITIVE_INFINITY
    ? '+inf'
    : value === Number.NEGATIVE_INFINITY
      ? '-inf'
      : String(value)
}

/**
 * 数据结构句柄的公共部分。键在每次调用时加前缀（含当前租户），值按存储的序列化器逐个编码；
 * 创建句柄时传入的 ttl 在每次写入后应用到整个键（`Cache.redis().list('recent', '1h')`）。
 */
abstract class CacheStructure {
  protected readonly defaultTtl: number | undefined

  constructor(protected readonly repository: RedisCacheRepository<any>, readonly name: string, ttl?: CacheTtl) {
    this.defaultTtl = seconds(ttl)
  }

  /** 存储中的实际键 */
  get key(): string {
    return this.repository.key(this.name)
  }

  protected encode(value: unknown): string {
    return this.repository.serializer.serialize(value)
  }

  protected decode<T>(raw: unknown): T | undefined {
    return raw === null || raw === undefined
      ? undefined
      : this.repository.serializer.deserialize(String(raw)) as T
  }

  protected run<R = unknown>(command: string, ...args: Arg[]): Promise<R> {
    return this.repository.command(this.name, command, ...args) as Promise<R>
  }

  /** 写命令：有有效期时与 EXPIRE 放在同一个事务中 */
  protected async write<R = unknown>(ttl: number | undefined, command: string, ...args: Arg[]): Promise<R> {
    if (ttl === undefined)
      return this.run<R>(command, ...args)
    const [result] = await this.repository.commandBatch(this.name, [
      [command, ...args],
      [
        'expire',
        expireSeconds(ttl),
      ],
    ])
    return result as R
  }

  /** 设置整个键的有效期（省略时改为永久），返回键是否存在 */
  expire(ttl?: CacheTtl): Promise<boolean> {
    return this.repository.touch(this.name, ttl)
  }

  /** 剩余秒数：永久为 undefined，不存在为 null */
  ttl(): Promise<number | undefined | null> {
    return this.repository.ttl(this.name)
  }

  async exists(): Promise<boolean> {
    return Number(await this.run('exists')) > 0
  }

  /** 删除整个键 */
  drop(): Promise<boolean> {
    return this.repository.forget(this.name)
  }
}

/** 哈希表（HSET / HGET ...）：字段名是字符串，字段值按序列化器编码 */
export class CacheHash<T = unknown> extends CacheStructure {
  async get(field: string): Promise<T | undefined> {
    return this.decode<T>(await this.run('hget', field))
  }

  /** 写一个字段，或用对象一次写多个字段 */
  set(field: string, value: T, ttl?: CacheTtl): Promise<void>
  set(record: Record<string, T>, ttl?: CacheTtl): Promise<void>
  async set(fieldOrRecord: string | Record<string, T>, ...rest: unknown[]): Promise<void> {
    const [entries, ttl] = typeof fieldOrRecord === 'string'
      ? [
          [
            [fieldOrRecord, rest[0]],
          ],
          rest[1] as CacheTtl,
        ]
      : [
          Object.entries(fieldOrRecord),
          rest[0] as CacheTtl,
        ]
    if (!entries.length)
      return
    await this.write(seconds(ttl) ?? this.defaultTtl, 'hset', ...entries.flatMap(([field, value]) => [
      field as string,
      this.encode(value),
    ]))
  }

  async all(): Promise<Record<string, T>> {
    const raw = await this.run<Record<string, string> | null>('hgetall')
    return Object.fromEntries(Object.entries(raw ?? {}).map(([field, value]) => [
      field,
      this.decode<T>(value),
    ])) as Record<string, T>
  }

  async has(field: string): Promise<boolean> {
    return Number(await this.run('hexists', field)) > 0
  }

  /** 删除字段，返回删除的个数（删除整个键用 drop()） */
  async delete(...fields: [string, ...string[]]): Promise<number> {
    if (!fields.length)
      return 0
    return Number(await this.run('hdel', ...fields))
  }

  /** 字段自增（整数用 HINCRBY，小数用 HINCRBYFLOAT），返回新值 */
  async increment(field: string, by = 1): Promise<number> {
    return Number(await this.write(this.defaultTtl, Number.isInteger(by)
      ? 'hincrby'
      : 'hincrbyfloat', field, by))
  }

  decrement(field: string, by = 1): Promise<number> {
    return this.increment(field, -by)
  }

  keys(): Promise<string[]> {
    return this.run<string[]>('hkeys')
  }

  async values(): Promise<T[]> {
    return (await this.run<string[]>('hvals')).map(value => this.decode<T>(value)!)
  }

  async length(): Promise<number> {
    return Number(await this.run('hlen'))
  }
}

/** 列表（RPUSH / LPOP ...）：push 追加到末尾，unshift 插到开头 */
export class CacheList<T = unknown> extends CacheStructure {
  /** 追加到末尾，返回新长度 */
  async push(...values: T[]): Promise<number> {
    if (!values.length)
      return this.length()
    return Number(await this.write(this.defaultTtl, 'rpush', ...values.map(value => this.encode(value))))
  }

  /** 插到开头（按参数顺序），返回新长度 */
  async unshift(...values: T[]): Promise<number> {
    if (!values.length)
      return this.length()
    return Number(await this.write(this.defaultTtl, 'lpush', ...values.reverse().map(value => this.encode(value))))
  }

  /** 取出末尾一项 */
  async pop(): Promise<T | undefined> {
    return this.decode<T>(await this.run('rpop'))
  }

  /** 取出开头一项 */
  async shift(): Promise<T | undefined> {
    return this.decode<T>(await this.run('lpop'))
  }

  /** 下标区间（闭区间，负数从末尾数），默认全部 */
  async range(start = 0, stop = -1): Promise<T[]> {
    return (await this.run<string[]>('lrange', start, stop)).map(value => this.decode<T>(value)!)
  }

  /** 全部元素，同 range() */
  all(): Promise<T[]> {
    return this.range()
  }

  async length(): Promise<number> {
    return Number(await this.run('llen'))
  }

  /** 只保留下标区间内的元素 */
  async trim(start: number, stop: number): Promise<void> {
    await this.run('ltrim', start, stop)
  }

  /** 删除等于 value 的元素：count > 0 从头删 count 个，< 0 从尾删，0（默认）删除全部；返回删除的个数 */
  async remove(value: T, count = 0): Promise<number> {
    return Number(await this.run('lrem', count, this.encode(value)))
  }

  /** 删除整个键 */
  delete(): Promise<boolean> {
    return this.drop()
  }
}

/** 集合（SADD / SMEMBERS ...）：成员按序列化后的字符串判断是否相同 */
export class CacheSet<T = unknown> extends CacheStructure {
  /** 添加成员，返回新增的个数 */
  async add(...members: T[]): Promise<number> {
    if (!members.length)
      return 0
    return Number(await this.write(this.defaultTtl, 'sadd', ...members.map(member => this.encode(member))))
  }

  async remove(...members: T[]): Promise<number> {
    if (!members.length)
      return 0
    return Number(await this.run('srem', ...members.map(member => this.encode(member))))
  }

  async has(member: T): Promise<boolean> {
    return Number(await this.run('sismember', this.encode(member))) > 0
  }

  async members(): Promise<T[]> {
    return (await this.run<string[]>('smembers')).map(member => this.decode<T>(member)!)
  }

  async size(): Promise<number> {
    return Number(await this.run('scard'))
  }

  /** 随机取出（并删除）一个成员，或 count 个 */
  pop(): Promise<T | undefined>
  pop(count: number): Promise<T[]>
  async pop(count?: number): Promise<T | undefined | T[]> {
    return this.#pick('spop', count)
  }

  /** 随机取一个成员（不删除），或 count 个 */
  random(): Promise<T | undefined>
  random(count: number): Promise<T[]>
  async random(count?: number): Promise<T | undefined | T[]> {
    return this.#pick('srandmember', count)
  }

  async #pick(command: string, count: number | undefined): Promise<T | undefined | T[]> {
    if (count === undefined)
      return this.decode<T>(await this.run(command))
    return ((await this.run<string[] | null>(command, count)) ?? []).map(member => this.decode<T>(member)!)
  }

  /** 删除整个键 */
  delete(): Promise<boolean> {
    return this.drop()
  }
}

export interface SortedSetRangeOptions {
  /** 按分数从高到低 */
  reverse?: boolean
  /** 同时返回分数：`{ member, score }` */
  withScores?: boolean
}

export interface SortedSetScoreRangeOptions extends SortedSetRangeOptions {
  /** 分页：跳过 offset 个，取 count 个 */
  limit?: { offset: number, count: number }
}

/** 有序集合（ZADD / ZRANGE ...）：成员按序列化器编码，分数保持数字 */
export class CacheSortedSet<T = string> extends CacheStructure {
  /**
   * 添加或更新分数，返回新增的个数：
   * `add(member, score, ttl?)`、`add({ alice: 10, bob: 7 })`（对象的键即成员），
   * 或 `add([[member, score], ...], ttl?)`（成员本身是数组时只能用这种写法）
   */
  add(member: T extends readonly unknown[] ? never : T, score: number, ttl?: CacheTtl): Promise<number>
  add(record: Record<string, number>): Promise<number>
  add(entries: Array<[T, number]>, ttl?: CacheTtl): Promise<number>
  async add(first: unknown, ...rest: unknown[]): Promise<number> {
    // 第二个参数是分数时总是单个成员（成员可以是对象）；数组为 entries；只有一个对象参数时为 record
    const [entries, ttl] = Array.isArray(first)
      ? [first as Array<[unknown, number]>, rest[0] as CacheTtl]
      : typeof rest[0] === 'number'
        ? [
            [
              [first, rest[0]],
            ] as Array<[unknown, number]>,
            rest[1] as CacheTtl,
          ]
        : isPlainObject(first)
          ? [
              Object.entries(first),
              undefined,
            ]
          : [
              [
                [
                  first,
                  Number(rest[0]),
                ],
              ] as Array<[unknown, number]>,
              rest[1] as CacheTtl,
            ]
    if (!entries.length)
      return 0
    return Number(await this.write(seconds(ttl) ?? this.defaultTtl, 'zadd', ...entries.flatMap(([member, score]) => [
      bound(score as ScoreBound),
      this.encode(member),
    ])))
  }

  /** 分数自增，返回新分数 */
  async increment(member: T, by = 1): Promise<number> {
    return parseScore(await this.write(this.defaultTtl, 'zincrby', by, this.encode(member)))
  }

  decrement(member: T, by = 1): Promise<number> {
    return this.increment(member, -by)
  }

  async score(member: T): Promise<number | undefined> {
    const value = await this.run('zscore', this.encode(member))
    return value === null || value === undefined
      ? undefined
      : parseScore(value)
  }

  /** 排名（从 0 开始，默认分数从低到高；reverse 为从高到低），不存在为 undefined */
  async rank(member: T, options: { reverse?: boolean } = {}): Promise<number | undefined> {
    const value = await this.run(options.reverse
      ? 'zrevrank'
      : 'zrank', this.encode(member))
    return value === null || value === undefined
      ? undefined
      : Number(value)
  }

  /** 按排名区间（闭区间，负数从末尾数）取成员 */
  range(start?: number, stop?: number, options?: SortedSetRangeOptions & { withScores?: false }): Promise<T[]>
  range(start: number, stop: number, options: SortedSetRangeOptions & { withScores: true }): Promise<ScoredMember<T>[]>
  async range(start = 0, stop = -1, options: SortedSetRangeOptions = {}): Promise<T[] | ScoredMember<T>[]> {
    const args: Arg[] = [start, stop]
    if (options.withScores)
      args.push('WITHSCORES')
    return this.#members(await this.run<string[]>(options.reverse
      ? 'zrevrange'
      : 'zrange', ...args), options.withScores)
  }

  /** 分数最高的 n 个（从高到低，带分数），排行榜常用 */
  top(n: number): Promise<ScoredMember<T>[]> {
    return n > 0
      ? this.range(0, n - 1, { reverse: true, withScores: true })
      : Promise.resolve([])
  }

  /** 按分数区间取成员（默认含边界，`'(5'` 不含；reverse 时仍写 min, max） */
  rangeByScore(min: ScoreBound, max: ScoreBound, options?: SortedSetScoreRangeOptions & { withScores?: false }): Promise<T[]>
  rangeByScore(min: ScoreBound, max: ScoreBound, options: SortedSetScoreRangeOptions & { withScores: true }): Promise<ScoredMember<T>[]>
  async rangeByScore(min: ScoreBound, max: ScoreBound, options: SortedSetScoreRangeOptions = {}): Promise<T[] | ScoredMember<T>[]> {
    const args: Arg[] = options.reverse
      ? [
          bound(max),
          bound(min),
        ]
      : [
          bound(min),
          bound(max),
        ]
    if (options.withScores)
      args.push('WITHSCORES')
    if (options.limit)
      args.push('LIMIT', options.limit.offset, options.limit.count)
    return this.#members(await this.run<string[]>(options.reverse
      ? 'zrevrangebyscore'
      : 'zrangebyscore', ...args), options.withScores)
  }

  async remove(...members: T[]): Promise<number> {
    if (!members.length)
      return 0
    return Number(await this.run('zrem', ...members.map(member => this.encode(member))))
  }

  async size(): Promise<number> {
    return Number(await this.run('zcard'))
  }

  /** 删除整个键 */
  delete(): Promise<boolean> {
    return this.drop()
  }

  #members(raw: string[], withScores: boolean | undefined): T[] | ScoredMember<T>[] {
    if (!withScores)
      return raw.map(member => this.decode<T>(member)!)
    const result: ScoredMember<T>[] = []
    for (let index = 0; index < raw.length; index += 2) {
      result.push({
        member: this.decode<T>(raw[index])!,
        score: parseScore(raw[index + 1]),
      })
    }
    return result
  }
}

/**
 * 带 Redis 数据结构的缓存存储：驱动为 redis 的存储（`Cache.store('redis')`、`Cache.redis()`）。
 * memory 驱动在进程内模拟同样的接口，供测试替代 redis 存储。
 *
 * ```ts
 * const redis = Cache.redis()
 * await redis.hash('user:1').set({ name: 'Ada', visits: 0 })
 * await redis.list('recent', '1h').push(event)
 * await redis.sortedSet('scores').add('ada', 42)
 * const top = await redis.zset('scores').top(10)
 * ```
 *
 * 注意：`set(key)` 只传一个参数时返回集合句柄，两个以上参数时仍是写缓存（`set(key, value, ttl?)`）。
 */
export class RedisCacheRepository<Handler = RedisClient> extends CacheRepository<Handler> {
  /** 驱动的数据结构命令 */
  get commands(): CacheCommands {
    if (!this.store.commands)
      throw new Error(`Cache driver "${this.store.driver}" does not support data structures`)
    return this.store.commands
  }

  /** 在键上执行一条数据结构命令（小写的 Redis 命令名，键自动加前缀，带遥测） */
  command(key: string, command: string, ...args: Arg[]): Promise<unknown> {
    const storageKey = this.key(key)
    return this.observe('command', key, () => this.commands.call(command, storageKey, ...args), undefined, command)
  }

  /** 在同一个键上依次执行多条命令（redis 为 MULTI 事务） */
  commandBatch(key: string, commands: Array<[command: string, ...args: Arg[]]>): Promise<unknown[]> {
    const storageKey = this.key(key)
    return this.observe('command', key, () => this.commands.batch(commands.map(([command, ...args]) => [command, storageKey, ...args])), undefined, commands.map(([command]) => command).join('+'))
  }

  /** 哈希表 */
  hash<T = unknown>(key: string, ttl?: CacheTtl): CacheHash<T> {
    return new CacheHash<T>(this, key, ttl)
  }

  /** 列表 */
  list<T = unknown>(key: string, ttl?: CacheTtl): CacheList<T> {
    return new CacheList<T>(this, key, ttl)
  }

  /** 只传键时返回集合句柄；传入值时写缓存（与 CacheRepository.set 相同） */
  override set<T = unknown>(key: string): CacheSet<T>
  override set(key: string, value: unknown, ttl?: CacheTtl): Promise<void>
  override set(key: string, ...rest: unknown[]): CacheSet<unknown> | Promise<void> {
    if (!rest.length)
      return new CacheSet(this, key)
    return super.set(key, rest[0], rest[1] as CacheTtl)
  }

  /** 集合（带有效期时用这个写法：`setOf('online', '5m')`） */
  setOf<T = unknown>(key: string, ttl?: CacheTtl): CacheSet<T> {
    return new CacheSet<T>(this, key, ttl)
  }

  /** 有序集合 */
  sortedSet<T = string>(key: string, ttl?: CacheTtl): CacheSortedSet<T> {
    return new CacheSortedSet<T>(this, key, ttl)
  }

  /** 同 sortedSet() */
  zset<T = string>(key: string, ttl?: CacheTtl): CacheSortedSet<T> {
    return this.sortedSet<T>(key, ttl)
  }
}

/** 是否为带 Redis 数据结构的存储（redis 驱动；memory 驱动模拟同样的接口，也返回 true） */
export function isRedisCache(repository: unknown): repository is RedisCacheRepository<any> {
  return repository instanceof RedisCacheRepository
}
