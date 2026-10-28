import type { HttpContext } from '../http/context'
import type { MaybePromise } from '../utils'

const kChannels = Symbol.for('hazejs.broadcast.channels')

export type ChannelType = 'public' | 'private' | 'presence'

/** 频道参数：`orders.{id}` 匹配 `orders.1` 时为 `{ id: '1' }` */
export type ChannelParams<Pattern extends string> = Pattern extends `${string}{${infer Name}}${infer Rest}`
  ? { [K in Name | keyof ChannelParams<Rest>]: string }
  : Record<never, string>

/** 私有频道的授权：返回真值时允许订阅 */
export type PrivateAuthorizer<U = any, P = Record<string, string>> = (user: U, params: P, ctx: HttpContext) => MaybePromise<unknown>

/** 在线频道的授权：返回成员信息（对其他成员可见）表示允许，false / null / undefined 表示拒绝 */
export type PresenceAuthorizer<U = any, P = Record<string, string>> = (user: U, params: P, ctx: HttpContext) => MaybePromise<PresenceMember | boolean | null | undefined>

/** 在线频道的成员：`id` 用于去重（同一用户多个连接只算一次），缺省为 Guard 的用户 ID */
export interface PresenceMember {
  id?: string | number
  [key: string]: unknown
}

export interface ChannelOptions {
  /** 识别用户的 Guard（任一通过即可），默认 config/auth.ts 的默认 Guard */
  guards?: string | string[]
}

export interface ChannelDefinition {
  type: 'private' | 'presence'
  pattern: string
  regex: RegExp
  keys: string[]
  authorize: PrivateAuthorizer | PresenceAuthorizer
  options: ChannelOptions
}

export interface ChannelRegistrar {
  /** 私有频道（客户端订阅 `private-<name>`）：`c.private('orders.{id}', (user, { id }) => ...)` */
  private: <Pattern extends string>(pattern: Pattern, authorize: PrivateAuthorizer<any, ChannelParams<Pattern>>, options?: ChannelOptions) => ChannelRegistrar
  /** 在线频道（客户端订阅 `presence-<name>`）：返回成员信息 `{ id, name }` 或 false */
  presence: <Pattern extends string>(pattern: Pattern, authorize: PresenceAuthorizer<any, ChannelParams<Pattern>>, options?: ChannelOptions) => ChannelRegistrar
}

export interface ChannelsDefinition {
  readonly [kChannels]: true
  readonly register: (c: ChannelRegistrar) => void
}

/**
 * 定义广播频道的授权（app/channel/*.ts 的默认导出，自动注册）：
 *
 * ```ts
 * export default defineChannels((c) => {
 *   c.private('orders.{id}', async (user, { id }) => (await Order.find(id))?.userId === user.id)
 *   c.presence('chat.{room}', user => ({ id: user.id, name: user.name }))
 * })
 * ```
 *
 * 公共频道无需定义，任何人都可以订阅。
 */
export function defineChannels(register: (c: ChannelRegistrar) => void): ChannelsDefinition {
  return { [kChannels]: true, register }
}

export function isChannels(value: unknown): value is ChannelsDefinition {
  return typeof value === 'object' && value !== null && kChannels in value
}

/** 私有频道名：`privateChannel('orders.1')` → `private-orders.1` */
export function privateChannel(name: string): string {
  return `private-${name}`
}

/** 在线频道名：`presenceChannel('chat.1')` → `presence-chat.1` */
export function presenceChannel(name: string): string {
  return `presence-${name}`
}

/** 解析频道名的类型与去掉前缀后的名字 */
export function parseChannel(channel: string): { type: ChannelType, name: string } {
  if (channel.startsWith('private-')) {
    return {
      type: 'private',
      name: channel.slice('private-'.length),
    }
  }
  if (channel.startsWith('presence-')) {
    return {
      type: 'presence',
      name: channel.slice('presence-'.length),
    }
  }
  return { type: 'public', name: channel }
}

/** 频道名的字符限制（与 Pusher 一致，另允许 `:` `@`） */
const CHANNEL_RE = /^[\w\-=@,.;:]{1,200}$/

export function isValidChannel(channel: unknown): channel is string {
  return typeof channel === 'string' && CHANNEL_RE.test(channel)
}

function compile(pattern: string): { regex: RegExp, keys: string[] } {
  const keys: string[] = []
  const source = pattern.split(/(\{\w+\})/).map((part) => {
    const match = /^\{(\w+)\}$/.exec(part)
    if (match) {
      keys.push(match[1])
      return '([^.]+)'
    }
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }).join('')
  return {
    regex: new RegExp(`^${source}$`),
    keys,
  }
}

/** 频道授权表 */
export class ChannelRegistry {
  readonly #definitions: ChannelDefinition[] = []

  get size(): number {
    return this.#definitions.length
  }

  register(definition: unknown): this {
    if (!isChannels(definition))
      throw new TypeError('app/channel/*.ts must export default defineChannels(...)')
    const registrar = {} as ChannelRegistrar
    const add = (type: 'private' | 'presence') => (pattern: string, authorize: PrivateAuthorizer | PresenceAuthorizer, options: ChannelOptions = {}): ChannelRegistrar => {
      this.#definitions.push({
        type,
        pattern,
        ...compile(pattern),
        authorize,
        options,
      })
      return registrar
    }
    registrar.private = add('private') as ChannelRegistrar['private']
    registrar.presence = add('presence') as ChannelRegistrar['presence']
    definition.register(registrar)
    return this
  }

  /** 按类型与名字查找授权定义（先定义的优先） */
  match(type: 'private' | 'presence', name: string): { definition: ChannelDefinition, params: Record<string, string> } | undefined {
    for (const definition of this.#definitions) {
      if (definition.type !== type)
        continue
      const match = definition.regex.exec(name)
      if (match) {
        const params = Object.fromEntries(definition.keys.map((key, index) => [
          key,
          decodeURIComponent(match[index + 1]),
        ]))
        return { definition, params }
      }
    }
    return undefined
  }

  patterns(): Array<{ type: string, pattern: string }> {
    return this.#definitions.map(({ type, pattern }) => ({ type, pattern }))
  }
}
