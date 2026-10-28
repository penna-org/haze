import type { HttpContext } from '../http/context'
import type { TokenGuardConfig } from './config'
import type { ResolvedProvider, UserRef } from './support'
import { definePersistent } from '../persistent'
import { safeEqual } from '../security/key'
import { parseDuration } from '../utils'
import { authConfigOf, randomToken, resolveProvider, sha256 } from './support'

/** 个人访问令牌的存储记录（token 为明文密钥的 SHA-256 摘要） */
export interface PersonalAccessToken {
  id: string | number
  /** 用户类型，默认为 provider 名（多种用户共用一张表时区分） */
  tokenableType: string
  tokenableId: string
  name: string
  token: string
  abilities: string[]
  lastUsedAt: Date | null
  expiresAt: Date | null
  createdAt: Date
}

export type NewTokenRecord = Omit<PersonalAccessToken, 'id'>

/**
 * 令牌存储。框架提供 `memoryTokenStore()`（测试 / 单实例），
 * `@hazejs/orm` 的 `databaseTokenStore(() => personalAccessTokens)` 存到 personal_access_tokens 表。
 */
export interface TokenStore {
  create: (record: NewTokenRecord) => Promise<PersonalAccessToken>
  find: (id: string) => Promise<PersonalAccessToken | undefined>
  list: (tokenableType: string, tokenableId: string) => Promise<PersonalAccessToken[]>
  update: (id: string, values: Partial<Pick<PersonalAccessToken, 'name' | 'abilities' | 'lastUsedAt' | 'expiresAt'>>) => Promise<void>
  /** 删除一个令牌，返回是否存在 */
  delete: (id: string) => Promise<boolean>
  /** 删除用户的全部令牌，返回删除数量 */
  deleteAll: (tokenableType: string, tokenableId: string) => Promise<number>
}

/** 进程内存的令牌存储（跨热更新保留，多实例之间不共享） */
export function memoryTokenStore(name = 'default'): TokenStore {
  const state = definePersistent(`auth:tokens:${name}`, () => ({
    seq: 0,
    rows: new Map<string, PersonalAccessToken>(),
  }))
  const copy = (row: PersonalAccessToken): PersonalAccessToken => ({
    ...row,
    abilities: [...row.abilities],
  })
  return {
    async create(record) {
      const row = {
        ...record,
        abilities: [...record.abilities],
        id: ++state.seq,
      }
      state.rows.set(String(row.id), row)
      return copy(row)
    },
    async find(id) {
      const row = state.rows.get(id)
      return row && copy(row)
    },
    async list(type, tokenableId) {
      return [
        ...state.rows.values(),
      ]
        .filter(row => row.tokenableType === type && row.tokenableId === tokenableId)
        .map(copy)
    },
    async update(id, values) {
      const row = state.rows.get(id)
      if (row)
        Object.assign(row, values)
    },
    async delete(id) {
      return state.rows.delete(id)
    },
    async deleteAll(type, tokenableId) {
      let count = 0
      for (const [id, row] of state.rows) {
        if (row.tokenableType === type && row.tokenableId === tokenableId) {
          state.rows.delete(id)
          count++
        }
      }
      return count
    },
  }
}

export interface CreateTokenOptions {
  /** 能力列表，默认 `['*']`（全部） */
  abilities?: string[]
  /** 过期时间点；与 expiresIn 二选一，都省略时取 Guard 的 expiresIn（未配置则永不过期） */
  expiresAt?: Date | null
  expiresIn?: string | number
}

/** 新签发的令牌：plainTextToken（`id|secret`）只在此时可见，之后只保存摘要 */
export interface NewAccessToken {
  plainTextToken: string
  accessToken: PersonalAccessToken
}

/** 能力匹配：`*` 表示全部，`posts:*` 匹配 `posts:` 开头的能力 */
export function abilityMatches(granted: readonly string[], ability: string): boolean {
  return granted.some(item => item === '*'
    || item === ability
    || (item.endsWith(':*') && ability.startsWith(item.slice(0, -1))))
}

/** 令牌是否具备该能力 */
export function tokenCan(token: Pick<PersonalAccessToken, 'abilities'>, ability: string): boolean {
  return abilityMatches(token.abilities, ability)
}

/** last_used_at 的最短写入间隔（毫秒），避免每个请求都写库 */
const TOUCH_INTERVAL = 60_000

/**
 * 个人访问令牌（Laravel Sanctum 风格）：签发、校验、列出与吊销。
 * 一般通过 token Guard（`ctx.auth.tokens()`）或 `PersonalAccessTokens` 门面使用。
 */
export class TokenRepository<U = unknown> {
  readonly #store: TokenStore
  readonly #users: ResolvedProvider<U>
  readonly #config: TokenGuardConfig

  constructor(store: TokenStore, users: ResolvedProvider<U>, config: TokenGuardConfig) {
    this.#store = store
    this.#users = users
    this.#config = config
  }

  get store(): TokenStore {
    return this.#store
  }

  /** 为用户签发令牌：`await tokens.create(user, 'cli', { abilities: ['posts:write'], expiresIn: '30d' })` */
  async create(user: U, name: string, options: CreateTokenOptions = {}): Promise<NewAccessToken> {
    const ref = this.#users.ref(user)
    const secret = `${this.#config.prefix ?? ''}${randomToken(30)}`
    const expiresIn = options.expiresIn ?? this.#config.expiresIn
    const expiresAt = options.expiresAt !== undefined
      ? options.expiresAt
      : expiresIn !== undefined
        ? new Date(Date.now() + parseDuration(expiresIn) * 1000)
        : null
    const accessToken = await this.#store.create({
      tokenableType: ref.type,
      tokenableId: ref.id,
      name,
      token: await sha256(secret),
      abilities: options.abilities ?? ['*'],
      lastUsedAt: null,
      expiresAt,
      createdAt: new Date(),
    })
    return {
      plainTextToken: `${accessToken.id}|${secret}`,
      accessToken,
    }
  }

  /** 用户的全部令牌（不含明文） */
  list(user: U): Promise<PersonalAccessToken[]> {
    const ref = this.#users.ref(user)
    return this.#store.list(ref.type, ref.id)
  }

  /** 吊销一个令牌；传入 user 时只能吊销属于该用户的令牌 */
  async revoke(id: string | number, user?: U): Promise<boolean> {
    if (user !== undefined) {
      const token = await this.#store.find(String(id))
      const ref = this.#users.ref(user)
      if (!token || !owns(token, ref))
        return false
    }
    return this.#store.delete(String(id))
  }

  /** 吊销用户的全部令牌，返回数量 */
  revokeAll(user: U): Promise<number> {
    const ref = this.#users.ref(user)
    return this.#store.deleteAll(ref.type, ref.id)
  }

  /** 按明文令牌查找有效记录（摘要比对、过期检查）；无效时返回 undefined */
  async find(plainTextToken: string): Promise<PersonalAccessToken | undefined> {
    const separator = plainTextToken.indexOf('|')
    if (separator <= 0)
      return undefined
    const id = plainTextToken.slice(0, separator)
    // ID 只能是存储生成的简单值，其余直接视为无效（不查询存储）
    if (!/^[\w-]{1,64}$/.test(id))
      return undefined
    const token = await this.#store.find(id)
    if (!token || !safeEqual(token.token, await sha256(plainTextToken.slice(separator + 1))))
      return undefined
    if (token.expiresAt && new Date(token.expiresAt).getTime() <= Date.now())
      return undefined
    return token
  }

  /** 校验令牌并取得用户；顺带更新 last_used_at */
  async authenticate(plainTextToken: string): Promise<{ user: U, token: PersonalAccessToken } | undefined> {
    const token = await this.find(plainTextToken)
    if (!token || token.tokenableType !== this.#users.type)
      return undefined
    const user = await this.#users.provider.retrieveById(token.tokenableId) ?? undefined
    if (user === undefined)
      return undefined
    const now = new Date()
    if (!token.lastUsedAt || now.getTime() - new Date(token.lastUsedAt).getTime() > TOUCH_INTERVAL) {
      await this.#store.update(String(token.id), { lastUsedAt: now })
      token.lastUsedAt = now
    }
    return { user, token }
  }
}

function owns(token: PersonalAccessToken, ref: UserRef): boolean {
  return token.tokenableType === ref.type && token.tokenableId === ref.id
}

/** 解析 token Guard 的存储：未配置时为进程内存（按 Guard 名区分） */
export function tokenStoreOf(name: string, config: TokenGuardConfig): TokenStore {
  return config.store ?? memoryTokenStore(name)
}

/** 由 Guard 配置创建令牌仓库 */
export function tokenRepository<U = unknown>(guard?: string): TokenRepository<U> {
  const auth = authConfigOf()
  const name = guard ?? Object.keys(auth.guards).find(key => auth.guards[key].driver === 'token')
  const config = name === undefined
    ? undefined
    : auth.guards[name]
  if (!name || config?.driver !== 'token') {
    throw new Error(guard
      ? `Auth guard "${guard}" is not a token guard`
      : 'No token guard is defined in config/auth.ts (driver: \'token\')')
  }
  return new TokenRepository<U>(tokenStoreOf(name, config), resolveProvider<U>(auth, config.provider, config.type), config)
}

/**
 * 个人访问令牌门面（请求内外均可使用；`guard` 省略时取第一个 token Guard）：
 *
 * ```ts
 * const { plainTextToken } = await PersonalAccessTokens.create(user, 'cli', { abilities: ['posts:write'] })
 * await PersonalAccessTokens.revokeAll(user)
 * ```
 */
export const PersonalAccessTokens = {
  create: <U>(user: U, name: string, options?: CreateTokenOptions & { guard?: string }): Promise<NewAccessToken> =>
    tokenRepository<U>(options?.guard).create(user, name, options),
  list: <U>(user: U, guard?: string): Promise<PersonalAccessToken[]> => tokenRepository<U>(guard).list(user),
  revoke: <U>(id: string | number, user?: U, guard?: string): Promise<boolean> => tokenRepository<U>(guard).revoke(id, user),
  revokeAll: <U>(user: U, guard?: string): Promise<number> => tokenRepository<U>(guard).revokeAll(user),
  find: (plainTextToken: string, guard?: string): Promise<PersonalAccessToken | undefined> => tokenRepository(guard).find(plainTextToken),
  repository: <U = unknown>(guard?: string): TokenRepository<U> => tokenRepository<U>(guard),
}

/**
 * `createAccessToken(user, 'cli', { abilities })`：PersonalAccessTokens.create 的快捷函数
 * （不叫 createToken：与容器的 createToken() 同名）
 */
export function createAccessToken<U>(user: U, name: string, options?: CreateTokenOptions & { guard?: string }): Promise<NewAccessToken> {
  return PersonalAccessTokens.create(user, name, options)
}

/** 从 Authorization: Bearer 读取令牌 */
export function bearerToken(ctx: HttpContext): string | undefined {
  const header = ctx.header('authorization')
  const match = header && /^Bearer\s+(\S+)$/i.exec(header)
  return match?.[1]
}
