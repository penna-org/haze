import type { CacheCommands } from '../store'
import type { MemoryCacheEntry, MemoryStructure } from './memory'

export function wrongType(): Error {
  return new Error('WRONGTYPE Operation against a key holding the wrong kind of value')
}

type Arg = string | number

/** Redis 的下标区间（闭区间，负数从末尾数）转为 slice 的起止 */
function bounds(length: number, start: number, stop: number): [number, number] {
  const from = start < 0
    ? Math.max(length + start, 0)
    : start
  const to = stop < 0
    ? length + stop
    : Math.min(stop, length - 1)
  return from > to || from >= length
    ? [0, 0]
    : [from, to + 1]
}

/** ZRANGEBYSCORE 的边界：`-inf` / `+inf` / `(5`（不含）/ `5` */
function scoreBound(value: Arg): { score: number, exclusive: boolean } {
  const text = String(value)
  const exclusive = text.startsWith('(')
  const body = exclusive
    ? text.slice(1)
    : text
  const score = body === '+inf' || body === 'inf'
    ? Number.POSITIVE_INFINITY
    : body === '-inf'
      ? Number.NEGATIVE_INFINITY
      : Number(body)
  return { score, exclusive }
}

/** Redis 返回的分数是字符串（与 ioredis 一致） */
function score(value: number): string {
  return value === Number.POSITIVE_INFINITY
    ? 'inf'
    : value === Number.NEGATIVE_INFINITY
      ? '-inf'
      : String(value)
}

function randomItems<T>(items: T[], count: number): T[] {
  const copy = [
    ...items,
  ]
  for (let index = copy.length - 1; index > 0; index--) {
    const other = Math.floor(Math.random() * (index + 1))
    ;[copy[index], copy[other]] = [copy[other]!, copy[index]!]
  }
  return copy.slice(0, count)
}

/**
 * 进程内模拟的 Redis 数据结构命令（memory 驱动，供测试替代 redis 存储）。
 * 只实现缓存数据结构用到的命令，返回值的形状与 ioredis 相同；结构为空时删除键，与 Redis 一致。
 */
export function memoryCommands(
  read: (key: string) => MemoryCacheEntry | undefined,
  write: (key: string, value: MemoryCacheEntry['value'], ttl?: number) => void,
  remove: (key: string) => boolean,
): CacheCommands {
  /** 取某种结构；create 为 true 时不存在则新建（保留永久） */
  function structure<T extends MemoryStructure['type']>(key: string, type: T, create: boolean): Extract<MemoryStructure, { type: T }> | undefined {
    const entry = read(key)
    if (entry) {
      if (typeof entry.value === 'string' || entry.value.type !== type)
        throw wrongType()
      return entry.value as Extract<MemoryStructure, { type: T }>
    }
    if (!create)
      return undefined
    const value = {
      type,
      data: type === 'list'
        ? []
        : type === 'set'
          ? new Set()
          : new Map(),
    } as Extract<MemoryStructure, { type: T }>
    write(key, value)
    return value
  }
  /** 结构为空时删除键 */
  function prune(key: string, value: MemoryStructure): void {
    const size = Array.isArray(value.data)
      ? value.data.length
      : value.data.size
    if (size === 0)
      remove(key)
  }
  /** 有序集合按分数升序、同分按成员排序 */
  function sorted(key: string): Array<[string, number]> {
    return [
      ...structure(key, 'zset', false)?.data ?? [],
    ].sort((a, b) => a[1] - b[1] || (a[0] < b[0]
      ? -1
      : a[0] > b[0]
        ? 1
        : 0))
  }
  function withScores(items: Array<[string, number]>, flag: boolean): string[] {
    return flag
      ? items.flatMap(([member, value]) => [
          member,
          score(value),
        ])
      : items.map(([member]) => member)
  }

  function run(command: string, key: string, args: Arg[]): unknown {
    switch (command) {
      // 键
      case 'exists':
        return read(key)
          ? 1
          : 0
      case 'del':
        return read(key) && remove(key)
          ? 1
          : 0
      case 'expire': {
        const entry = read(key)
        if (!entry)
          return 0
        entry.expiresAt = Date.now() + Number(args[0]) * 1000
        return 1
      }
      case 'persist': {
        const entry = read(key)
        if (!entry || entry.expiresAt === undefined)
          return 0
        entry.expiresAt = undefined
        return 1
      }
      case 'ttl': {
        const entry = read(key)
        return !entry
          ? -2
          : entry.expiresAt === undefined
            ? -1
            : Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000))
      }

      // hash
      case 'hget':
        return structure(key, 'hash', false)?.data.get(String(args[0])) ?? null
      case 'hset': {
        const hash = structure(key, 'hash', true)!
        let added = 0
        for (let index = 0; index < args.length; index += 2) {
          const field = String(args[index])
          if (!hash.data.has(field))
            added++
          hash.data.set(field, String(args[index + 1]))
        }
        return added
      }
      case 'hgetall':
        return Object.fromEntries(structure(key, 'hash', false)?.data ?? [])
      case 'hexists':
        return structure(key, 'hash', false)?.data.has(String(args[0]))
          ? 1
          : 0
      case 'hdel': {
        const hash = structure(key, 'hash', false)
        if (!hash)
          return 0
        const removed = args.filter(field => hash.data.delete(String(field))).length
        prune(key, hash)
        return removed
      }
      case 'hincrby':
      case 'hincrbyfloat': {
        const hash = structure(key, 'hash', true)!
        const field = String(args[0])
        const next = Number(hash.data.get(field) ?? 0) + Number(args[1])
        if (Number.isNaN(next))
          throw new TypeError('ERR hash value is not a number')
        hash.data.set(field, String(next))
        return command === 'hincrby'
          ? next
          : String(next)
      }
      case 'hkeys':
        return [
          ...structure(key, 'hash', false)?.data.keys() ?? [],
        ]
      case 'hvals':
        return [
          ...structure(key, 'hash', false)?.data.values() ?? [],
        ]
      case 'hlen':
        return structure(key, 'hash', false)?.data.size ?? 0

      // list
      case 'rpush':
      case 'lpush': {
        const list = structure(key, 'list', true)!
        const values = args.map(String)
        if (command === 'rpush')
          list.data.push(...values)
        else
          list.data.unshift(...values.reverse())
        return list.data.length
      }
      case 'rpop':
      case 'lpop': {
        const list = structure(key, 'list', false)
        if (!list)
          return null
        const value = command === 'rpop'
          ? list.data.pop()
          : list.data.shift()
        prune(key, list)
        return value ?? null
      }
      case 'lrange': {
        const list = structure(key, 'list', false)?.data ?? []
        return list.slice(...bounds(list.length, Number(args[0]), Number(args[1])))
      }
      case 'llen':
        return structure(key, 'list', false)?.data.length ?? 0
      case 'ltrim': {
        const list = structure(key, 'list', false)
        if (list) {
          list.data = list.data.slice(...bounds(list.data.length, Number(args[0]), Number(args[1])))
          prune(key, list)
        }
        return 'OK'
      }
      case 'lrem': {
        const list = structure(key, 'list', false)
        if (!list)
          return 0
        const count = Number(args[0])
        const value = String(args[1])
        let removed = 0
        const limit = count === 0
          ? Number.POSITIVE_INFINITY
          : Math.abs(count)
        const order = count < 0
          ? [
              ...list.data.keys(),
            ].reverse()
          : [
              ...list.data.keys(),
            ]
        const drop = new Set<number>()
        for (const index of order) {
          if (removed >= limit)
            break
          if (list.data[index] === value) {
            drop.add(index)
            removed++
          }
        }
        list.data = list.data.filter((_, index) => !drop.has(index))
        prune(key, list)
        return removed
      }

      // set
      case 'sadd': {
        const set = structure(key, 'set', true)!
        let added = 0
        for (const member of args.map(String)) {
          if (!set.data.has(member)) {
            set.data.add(member)
            added++
          }
        }
        return added
      }
      case 'srem': {
        const set = structure(key, 'set', false)
        if (!set)
          return 0
        const removed = args.filter(member => set.data.delete(String(member))).length
        prune(key, set)
        return removed
      }
      case 'sismember':
        return structure(key, 'set', false)?.data.has(String(args[0]))
          ? 1
          : 0
      case 'smembers':
        return [
          ...structure(key, 'set', false)?.data ?? [],
        ]
      case 'scard':
        return structure(key, 'set', false)?.data.size ?? 0
      case 'spop':
      case 'srandmember': {
        const set = structure(key, 'set', false)
        const picked = randomItems([
          ...set?.data ?? [],
        ], args.length
          ? Number(args[0])
          : 1)
        if (set && command === 'spop') {
          for (const member of picked)
            set.data.delete(member)
          prune(key, set)
        }
        return args.length
          ? picked
          : picked[0] ?? null
      }

      // sorted set
      case 'zadd': {
        const zset = structure(key, 'zset', true)!
        let added = 0
        for (let index = 0; index < args.length; index += 2) {
          const member = String(args[index + 1])
          if (!zset.data.has(member))
            added++
          zset.data.set(member, scoreBound(args[index]!).score)
        }
        return added
      }
      case 'zincrby': {
        const zset = structure(key, 'zset', true)!
        const member = String(args[1])
        const next = (zset.data.get(member) ?? 0) + Number(args[0])
        zset.data.set(member, next)
        return score(next)
      }
      case 'zscore': {
        const value = structure(key, 'zset', false)?.data.get(String(args[0]))
        return value === undefined
          ? null
          : score(value)
      }
      case 'zrank':
      case 'zrevrank': {
        const items = sorted(key)
        if (command === 'zrevrank')
          items.reverse()
        const index = items.findIndex(([member]) => member === String(args[0]))
        return index < 0
          ? null
          : index
      }
      case 'zrange':
      case 'zrevrange': {
        const items = sorted(key)
        if (command === 'zrevrange')
          items.reverse()
        return withScores(items.slice(...bounds(items.length, Number(args[0]), Number(args[1]))), args.includes('WITHSCORES'))
      }
      case 'zrangebyscore':
      case 'zrevrangebyscore': {
        // zrevrangebyscore 的参数顺序是 max min
        const [lower, upper] = command === 'zrangebyscore'
          ? [
              scoreBound(args[0]!),
              scoreBound(args[1]!),
            ]
          : [
              scoreBound(args[1]!),
              scoreBound(args[0]!),
            ]
        let items = sorted(key).filter(([, value]) => (lower.exclusive
          ? value > lower.score
          : value >= lower.score) && (upper.exclusive
          ? value < upper.score
          : value <= upper.score))
        if (command === 'zrevrangebyscore')
          items.reverse()
        const limit = args.indexOf('LIMIT')
        if (limit >= 0) {
          const offset = Number(args[limit + 1])
          const count = Number(args[limit + 2])
          items = items.slice(offset, count < 0
            ? undefined
            : offset + count)
        }
        return withScores(items, args.includes('WITHSCORES'))
      }
      case 'zrem': {
        const zset = structure(key, 'zset', false)
        if (!zset)
          return 0
        const removed = args.filter(member => zset.data.delete(String(member))).length
        prune(key, zset)
        return removed
      }
      case 'zcard':
        return structure(key, 'zset', false)?.data.size ?? 0
      default:
        throw new Error(`Memory cache: unsupported command "${command}"`)
    }
  }

  return {
    async call(command, key, ...args) {
      return run(command, key, args)
    },
    // 同步依次执行，等价于事务
    async batch(commands) {
      return commands.map(([command, key, ...args]) => run(command, key, args))
    },
  }
}
