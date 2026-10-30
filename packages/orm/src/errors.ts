import { ConflictException, NotFoundException } from '@hazejs/core'

/** findOrFail() 未找到数据，渲染为 404 */
export class ModelNotFoundException extends NotFoundException {
  readonly model: string

  constructor(model: string, key?: unknown) {
    super(key === undefined
      ? `${model} 不存在`
      : `${model} ${String(key)} 不存在`)
    this.model = model
  }
}

export class DatabaseError extends Error {
  override name = 'DatabaseError'
}

/** 乐观锁冲突：保存时记录已被其他请求修改，渲染为 409 */
export class OptimisticLockException extends ConflictException {
  readonly model: string

  constructor(model: string) {
    super(`${model} 已被修改，请刷新后重试`)
    this.model = model
  }
}

/** 从驱动错误中解析出的唯一约束信息（各数据库提供的信息不同，取不到的为 undefined） */
export interface UniqueViolation {
  /** 约束 / 索引名：PostgreSQL 的 constraint，MySQL 的 key，MongoDB 的索引名（SQLite 不提供） */
  constraint?: string
  /** 表名（MongoDB 为集合名） */
  table?: string
  /** 冲突的列（数据库中的列名）：PostgreSQL 从 detail 解析，SQLite 从错误消息解析，MongoDB 取 keyPattern */
  columns?: string[]
  /** 驱动给出的详细说明：PostgreSQL 的 detail（`Key (email)=(a@b.c) already exists.`），其余为驱动的错误消息 */
  detail?: string
}

/**
 * 违反唯一约束（重复数据），渲染为 409，响应的 code 为 `'unique_violation'`。
 * 默认消息可通过 i18n 的 `http.unique_violation` 翻译；`constraint` / `table` / `columns` / `detail` 来自驱动错误
 * （只用于判断与日志，默认不输出到响应中）。
 */
export class UniqueConstraintException extends ConflictException implements UniqueViolation {
  readonly constraint?: string
  readonly table?: string
  readonly columns?: string[]
  readonly detail?: string

  constructor(cause: unknown, info: UniqueViolation = uniqueViolationOf(cause) ?? {}) {
    super('数据已存在（违反唯一约束）', { cause, code: 'unique_violation' })
    this.constraint = info.constraint
    this.table = info.table
    this.columns = info.columns
    this.detail = info.detail
  }
}

const SQLITE_UNIQUE = /UNIQUE constraint failed: ([^:]+)/
const MYSQL_DUPLICATE = /Duplicate entry .* for key '([^']+)'/
const MONGO_DUPLICATE = /collection: (\S+) index: (\S+)/

/** 沿 cause 链找到驱动的唯一约束错误并解析；不是唯一约束错误时返回 undefined */
export function uniqueViolationOf(error: unknown): UniqueViolation | undefined {
  for (let current: any = error, depth = 0; current && depth < 5; current = current.cause, depth++) {
    const code = String(current.code ?? '')
    const message = String(current.message ?? '')
    // PostgreSQL：node-postgres / PGlite 为 constraint / table / detail，postgres.js 为 constraint_name / table_name
    if (code === '23505') {
      const detail: string | undefined = current.detail ?? undefined
      const columns = /^Key \((.+?)\)=/.exec(detail ?? '')?.[1]?.split(/,\s*/).map(unquote)
      return clean({
        constraint: current.constraint ?? current.constraint_name,
        table: current.table ?? current.table_name,
        columns,
        detail: detail ?? message,
      })
    }
    // MySQL：Duplicate entry 'x' for key 'users.users_email_unique'（8.0.19 起带表名前缀）
    if (code === 'ER_DUP_ENTRY' || current.errno === 1062) {
      const detail = String(current.sqlMessage ?? message)
      const key = MYSQL_DUPLICATE.exec(detail)?.[1]
      const dot = key?.indexOf('.') ?? -1
      return clean({
        constraint: key && dot !== -1
          ? key.slice(dot + 1)
          : key,
        table: key && dot !== -1
          ? key.slice(0, dot)
          : undefined,
        detail,
      })
    }
    // MongoDB 重复键：11000
    if (code === '11000' || current.code === 11000) {
      const match = MONGO_DUPLICATE.exec(message)
      const collection = match?.[1]
      return clean({
        constraint: match?.[2],
        table: collection?.slice(collection.indexOf('.') + 1),
        columns: mongoKeys(current, message),
        detail: message,
      })
    }
    // SQLite / libsql / D1：UNIQUE constraint failed: users.email, users.name
    const sqlite = SQLITE_UNIQUE.exec(message)
    if (sqlite || code.startsWith('SQLITE_CONSTRAINT_UNIQUE') || code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      const targets = sqlite?.[1].trim().split(/,\s*/) ?? []
      return clean({
        table: targets[0]?.includes('.')
          ? targets[0].slice(0, targets[0].lastIndexOf('.'))
          : undefined,
        columns: targets.length
          ? targets.map(target => target.slice(target.lastIndexOf('.') + 1))
          : undefined,
        detail: message,
      })
    }
  }
  return undefined
}

/** 把各数据库的唯一约束错误统一转换为 UniqueConstraintException，其余原样返回 */
export function translateDatabaseError(error: unknown): unknown {
  if (error instanceof UniqueConstraintException)
    return error
  const info = uniqueViolationOf(error)
  return info
    ? new UniqueConstraintException(error, info)
    : error
}

/** MongoDB 重复键的字段：keyPattern / keyValue（不同驱动版本位置不同），否则从消息的 `dup key: { email: "a" }` 解析 */
function mongoKeys(error: any, message: string): string[] | undefined {
  const pattern = error.keyPattern ?? error.keyValue ?? error.errorResponse?.keyPattern ?? error.errorResponse?.keyValue
  if (pattern && typeof pattern === 'object')
    return Object.keys(pattern)
  const keys = /dup key: \{ (.*) \}/.exec(message)?.[1]
  return keys
    ? [
        ...keys.matchAll(/(?:^|, )([\w.$]+): /g),
      ].map(match => match[1])
    : undefined
}

function unquote(value: string): string {
  return value.replace(/^"(.*)"$/, '$1')
}

function clean(info: UniqueViolation): UniqueViolation {
  return Object.fromEntries(Object.entries(info).filter(([, value]) => value !== undefined && value !== null && value !== '')) as UniqueViolation
}
