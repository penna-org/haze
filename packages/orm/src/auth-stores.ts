import type { Table } from 'drizzle-orm'
import { getTableColumns } from 'drizzle-orm'
import { QueryBuilder } from './query/builder'

// 与 @hazejs/core 的 TokenStore / PasswordResetStore / TwoFactorStore / PasskeyStore 结构一致（结构类型，不依赖 core 的导出）
// 表结构用 `haze make:auth-tables` 生成到 database/schema/auth.ts，字段名（JS 属性名）固定。

export interface AuthStoreOptions {
  /** 数据库连接名，默认 config/database.ts 的 default */
  connection?: string
}

type TableInput = Table | (() => Table)

function resolveTable(table: TableInput): Table {
  return typeof table === 'function'
    ? table()
    : table
}

function builder(table: TableInput, options: AuthStoreOptions): () => QueryBuilder<any> {
  return () => new QueryBuilder(resolveTable(table) as any, { connection: options.connection })
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined)
    return null
  return value instanceof Date
    ? value
    : new Date(value as string | number)
}

function toJson<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined)
    return fallback
  return typeof value === 'string'
    ? JSON.parse(value) as T
    : value as T
}

// ---------------------------------------------------------------- 个人访问令牌

interface PersonalAccessToken {
  id: string | number
  tokenableType: string
  tokenableId: string
  name: string
  token: string
  abilities: string[]
  lastUsedAt: Date | null
  expiresAt: Date | null
  createdAt: Date
}

type TokenChanges = Partial<Pick<PersonalAccessToken, 'name' | 'abilities' | 'lastUsedAt' | 'expiresAt'>>

export interface DatabaseTokenStore {
  create: (record: Omit<PersonalAccessToken, 'id'>) => Promise<PersonalAccessToken>
  find: (id: string) => Promise<PersonalAccessToken | undefined>
  list: (tokenableType: string, tokenableId: string) => Promise<PersonalAccessToken[]>
  update: (id: string, values: TokenChanges) => Promise<void>
  delete: (id: string) => Promise<boolean>
  deleteAll: (tokenableType: string, tokenableId: string) => Promise<number>
}

function tokenOf(row: Record<string, unknown>): PersonalAccessToken {
  return {
    id: row.id as string | number,
    tokenableType: String(row.tokenableType),
    tokenableId: String(row.tokenableId),
    name: String(row.name),
    token: String(row.token),
    abilities: toJson(row.abilities, ['*']),
    lastUsedAt: toDate(row.lastUsedAt),
    expiresAt: toDate(row.expiresAt),
    createdAt: toDate(row.createdAt) ?? new Date(0),
  }
}

/**
 * 令牌中的 ID 是字符串：主键为整数时转回数字，不是数字时返回 undefined
 * （避免 PostgreSQL 因类型不符报错，伪造的令牌应视为不存在）
 */
function keyOf(table: TableInput, id: string): string | number | undefined {
  const column = (getTableColumns(resolveTable(table)) as Record<string, { dataType?: string }>).id
  if (column?.dataType !== 'number')
    return id
  return /^\d{1,15}$/.test(id)
    ? Number(id)
    : undefined
}

/**
 * 个人访问令牌存储（config/auth.ts 的 token Guard）：
 *
 * ```ts
 * import { databaseTokenStore } from '@hazejs/orm'
 * import { personalAccessTokens } from '~/database/schema/auth'
 *
 * guards: { token: { driver: 'token', provider: 'users', store: databaseTokenStore(personalAccessTokens) } }
 * ```
 */
export function databaseTokenStore(table: TableInput, options: AuthStoreOptions = {}): DatabaseTokenStore {
  const query = builder(table, options)
  return {
    async create(record) {
      const [row] = await query().insert({ ...record })
      return tokenOf(row as Record<string, unknown>)
    },
    async find(id) {
      const key = keyOf(table, id)
      const row = key === undefined
        ? undefined
        : await query().where('id', key).find()
      return row && tokenOf(row as Record<string, unknown>)
    },
    async list(type, tokenableId) {
      const rows = await query().where('tokenableType', type).where('tokenableId', tokenableId).order('id').select()
      return (rows as Array<Record<string, unknown>>).map(tokenOf)
    },
    async update(id, values) {
      const key = keyOf(table, id)
      if (key !== undefined && Object.keys(values).length)
        await query().where('id', key).update({ ...values })
    },
    async delete(id) {
      const key = keyOf(table, id)
      return key !== undefined && (await query().where('id', key).delete()) > 0
    },
    deleteAll(type, tokenableId) {
      return query().where('tokenableType', type).where('tokenableId', tokenableId).delete()
    },
  }
}

// ---------------------------------------------------------------- 找回密码

interface PasswordResetRecord {
  token: string
  createdAt: Date
}

export interface DatabasePasswordResetStore {
  get: (email: string) => Promise<PasswordResetRecord | undefined>
  put: (email: string, record: PasswordResetRecord, ttl: number) => Promise<void>
  delete: (email: string) => Promise<void>
}

/** 找回密码的令牌存储（password_reset_tokens 表，按 email 一条） */
export function databasePasswordResetStore(table: TableInput, options: AuthStoreOptions = {}): DatabasePasswordResetStore {
  const query = builder(table, options)
  return {
    async get(email) {
      const row = await query().where('email', email).find() as Record<string, unknown> | undefined
      return row && {
        token: String(row.token),
        createdAt: toDate(row.createdAt) ?? new Date(0),
      }
    },
    async put(email, record) {
      await query().where('email', email).delete()
      await query().insert({ email, token: record.token, createdAt: record.createdAt })
    },
    async delete(email) {
      await query().where('email', email).delete()
    },
  }
}

// ---------------------------------------------------------------- 两步验证

interface TwoFactorRecord {
  secret: string
  recoveryCodes: string[]
  confirmedAt: Date | null
  lastUsedStep: number | null
}

export interface DatabaseTwoFactorStore {
  get: (userType: string, userId: string) => Promise<TwoFactorRecord | undefined>
  set: (userType: string, userId: string, record: TwoFactorRecord) => Promise<void>
  delete: (userType: string, userId: string) => Promise<void>
}

/** 两步验证存储（two_factor_secrets 表：密钥已加密，恢复码为摘要） */
export function databaseTwoFactorStore(table: TableInput, options: AuthStoreOptions = {}): DatabaseTwoFactorStore {
  const query = builder(table, options)
  const scoped = (type: string, id: string): QueryBuilder<any> => query().where('userType', type).where('userId', id)
  return {
    async get(type, id) {
      const row = await scoped(type, id).find() as Record<string, unknown> | undefined
      return row && {
        secret: String(row.secret),
        recoveryCodes: toJson(row.recoveryCodes, []),
        confirmedAt: toDate(row.confirmedAt),
        lastUsedStep: row.lastUsedStep === null || row.lastUsedStep === undefined
          ? null
          : Number(row.lastUsedStep),
      }
    },
    async set(type, id, record) {
      if (await scoped(type, id).find()) {
        await scoped(type, id).update({ ...record })
      }
      else {
        await query().insert({
          userType: type,
          userId: id,
          ...record,
          createdAt: new Date(),
        })
      }
    },
    async delete(type, id) {
      await scoped(type, id).delete()
    },
  }
}

// ---------------------------------------------------------------- 通行密钥

interface PasskeyCredential {
  id: string
  userType: string
  userId: string
  name: string | null
  publicKey: string
  counter: number
  transports: string[]
  deviceType: 'singleDevice' | 'multiDevice'
  backedUp: boolean
  aaguid: string | null
  createdAt: Date
  lastUsedAt: Date | null
}

type PasskeyChanges = Partial<Pick<PasskeyCredential, 'name' | 'counter' | 'backedUp' | 'lastUsedAt'>>

export interface DatabasePasskeyStore {
  create: (credential: PasskeyCredential) => Promise<void>
  find: (id: string) => Promise<PasskeyCredential | undefined>
  list: (userType: string, userId: string) => Promise<PasskeyCredential[]>
  update: (id: string, values: PasskeyChanges) => Promise<void>
  delete: (id: string) => Promise<boolean>
}

function credentialOf(row: Record<string, unknown>): PasskeyCredential {
  return {
    id: String(row.id),
    userType: String(row.userType),
    userId: String(row.userId),
    name: row.name === null || row.name === undefined
      ? null
      : String(row.name),
    publicKey: String(row.publicKey),
    counter: Number(row.counter ?? 0),
    transports: toJson(row.transports, []),
    deviceType: row.deviceType === 'multiDevice'
      ? 'multiDevice'
      : 'singleDevice',
    backedUp: Boolean(row.backedUp),
    aaguid: row.aaguid === null || row.aaguid === undefined
      ? null
      : String(row.aaguid),
    createdAt: toDate(row.createdAt) ?? new Date(0),
    lastUsedAt: toDate(row.lastUsedAt),
  }
}

/** 通行密钥凭据存储（webauthn_credentials 表，主键为凭据 ID） */
export function databasePasskeyStore(table: TableInput, options: AuthStoreOptions = {}): DatabasePasskeyStore {
  const query = builder(table, options)
  return {
    async create(credential) {
      await query().insert({ ...credential })
    },
    async find(id) {
      const row = await query().where('id', id).find()
      return row && credentialOf(row as Record<string, unknown>)
    },
    async list(type, userId) {
      const rows = await query().where('userType', type).where('userId', userId).order('createdAt').select()
      return (rows as Array<Record<string, unknown>>).map(credentialOf)
    },
    async update(id, values) {
      if (Object.keys(values).length)
        await query().where('id', id).update({ ...values })
    },
    async delete(id) {
      return (await query().where('id', id).delete()) > 0
    },
  }
}
