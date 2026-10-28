import type { PresenceMember } from './channels'
import type { BroadcastMessage } from './hub'
import { definePersistent } from '../persistent'
import { globalStore } from '../utils'
import { localHub } from './hub'

/** 在线频道的成员存储：按连接记录成员，按成员 id 去重 */
export interface PresenceStore {
  /** 加入：first 表示该成员（按 id）此前不在频道中；members 为加入后的成员列表 */
  join: (channel: string, socketId: string, member: PresenceMember) => Promise<{ first: boolean, members: PresenceMember[] }>
  /** 离开：last 表示该成员的最后一个连接已离开 */
  leave: (channel: string, socketId: string) => Promise<{ last: boolean, member?: PresenceMember }>
  members: (channel: string) => Promise<PresenceMember[]>
}

/** 广播总线：把消息送到所有实例（每个实例再投递给本进程的连接） */
export interface BroadcastBus {
  readonly driver: string
  publish: (message: BroadcastMessage) => Promise<void>
  readonly presence: PresenceStore
}

export interface MemoryBusConfig {
  driver: 'memory'
}

export interface RedisBusConfig {
  driver: 'redis'
  /** 默认 redis://127.0.0.1:6379 */
  url?: string
  /** pub/sub 频道与在线成员的键前缀，默认 `haze:broadcast`；多个应用共用 Redis 时请区分 */
  prefix?: string
}

export type BroadcastBusConfig = MemoryBusConfig | RedisBusConfig

const memberKey = (member: PresenceMember): string => String(member.id)

/** 按成员 id 去重（保留第一次出现的信息） */
export function uniqueMembers(members: PresenceMember[]): PresenceMember[] {
  const seen = new Map<string, PresenceMember>()
  for (const member of members) {
    if (!seen.has(memberKey(member)))
      seen.set(memberKey(member), member)
  }
  return [
    ...seen.values(),
  ]
}

/** 进程内总线：直接投递给本进程的连接（单实例、开发与测试） */
export function memoryBus(): BroadcastBus {
  const channels = globalStore('broadcast:presence', () => new Map<string, Map<string, PresenceMember>>())
  return {
    driver: 'memory',
    async publish(message) {
      localHub.deliver(message)
    },
    presence: {
      async join(channel, socketId, member) {
        let entries = channels.get(channel)
        if (!entries)
          channels.set(channel, entries = new Map())
        const first = ![
          ...entries.values(),
        ].some(item => memberKey(item) === memberKey(member))
        entries.set(socketId, member)
        return {
          first,
          members: uniqueMembers([
            ...entries.values(),
          ]),
        }
      },
      async leave(channel, socketId) {
        const entries = channels.get(channel)
        const member = entries?.get(socketId)
        if (!entries || !member)
          return { last: false }
        entries.delete(socketId)
        if (!entries.size)
          channels.delete(channel)
        const last = ![
          ...entries.values(),
        ].some(item => memberKey(item) === memberKey(member))
        return { last, member }
      },
      async members(channel) {
        return uniqueMembers([
          ...channels.get(channel)?.values() ?? [],
        ])
      },
    },
  }
}

interface RedisLike {
  publish: (channel: string, message: string) => Promise<number>
  subscribe: (channel: string) => Promise<unknown>
  on: (event: 'message', listener: (channel: string, message: string) => void) => unknown
  hvals: (key: string) => Promise<string[]>
  multi: () => RedisMulti
  duplicate: () => RedisLike
  quit: () => Promise<unknown>
}

interface RedisMulti {
  hvals: (key: string) => RedisMulti
  hget: (key: string, field: string) => RedisMulti
  hset: (key: string, field: string, value: string) => RedisMulti
  hdel: (key: string, field: string) => RedisMulti
  exec: () => Promise<Array<[Error | null, unknown]> | null>
}

interface RedisConnections {
  ready: Promise<{ pub: RedisLike, sub: RedisLike }>
}

/** 加载 ioredis（可选依赖），连接跨热更新复用，订阅一次后直接投递给本进程的连接表 */
function redisConnections(url: string, channel: string): RedisConnections {
  return definePersistent<RedisConnections>(`broadcast:redis:${url}:${channel}`, () => {
    const ready = import('ioredis').then(async (module) => {
      const Redis = (module as unknown as { Redis?: new (url: string) => RedisLike }).Redis ?? (module as unknown as { default: new (url: string) => RedisLike }).default
      const pub = new Redis(url)
      const sub = pub.duplicate()
      sub.on('message', (from, raw) => {
        if (from !== channel)
          return
        try {
          localHub.deliver(JSON.parse(raw) as BroadcastMessage)
        }
        catch {}
      })
      await sub.subscribe(channel)
      return { pub, sub }
    }, (error) => {
      throw new Error('Broadcast bus "redis" requires ioredis. Install it with: pnpm add ioredis', { cause: error })
    })
    // 避免未使用时的未处理拒绝
    ready.catch(() => {})
    return { ready }
  }, {
    dispose: async ({ ready }) => {
      const connections = await ready.catch(() => undefined)
      await Promise.all([
        connections?.pub.quit(),
        connections?.sub.quit(),
      ].map(item => item?.catch(() => {})))
    },
  })
}

/** Redis 总线：pub/sub 转发到所有实例，在线成员存在 Hash 中（`<prefix>:presence:<channel>`） */
export function redisBus(config: Omit<RedisBusConfig, 'driver'> = {}): BroadcastBus {
  const prefix = config.prefix ?? 'haze:broadcast'
  const { ready } = redisConnections(config.url ?? 'redis://127.0.0.1:6379', prefix)
  const key = (channel: string): string => `${prefix}:presence:${channel}`
  const parse = (values: unknown): PresenceMember[] => (Array.isArray(values)
    ? values
    : []).map(value => JSON.parse(String(value)) as PresenceMember)
  const run = async (build: (multi: RedisMulti) => RedisMulti): Promise<unknown[]> => {
    const { pub } = await ready
    const results = await build(pub.multi()).exec()
    return (results ?? []).map(([error, value]) => {
      if (error)
        throw error
      return value
    })
  }
  return {
    driver: 'redis',
    async publish(message) {
      const { pub } = await ready
      await pub.publish(prefix, JSON.stringify(message))
    },
    presence: {
      async join(channel, socketId, member) {
        // 原子地读取加入前的成员并写入
        const [before] = await run(multi => multi.hvals(key(channel)).hset(key(channel), socketId, JSON.stringify(member)))
        const existing = parse(before)
        const first = !existing.some(item => memberKey(item) === memberKey(member))
        return {
          first,
          members: uniqueMembers([...existing, member]),
        }
      },
      async leave(channel, socketId) {
        const [raw, , after] = await run(multi => multi.hget(key(channel), socketId).hdel(key(channel), socketId).hvals(key(channel)))
        if (typeof raw !== 'string')
          return { last: false }
        const member = JSON.parse(raw) as PresenceMember
        const last = !parse(after).some(item => memberKey(item) === memberKey(member))
        return { last, member }
      },
      async members(channel) {
        const { pub } = await ready
        return uniqueMembers(parse(await pub.hvals(key(channel))))
      },
    },
  }
}
