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

/** 违反唯一约束（重复数据），渲染为 409 */
export class UniqueConstraintException extends ConflictException {
  constructor(cause: unknown) {
    super('数据已存在（违反唯一约束）', { cause })
  }
}

/** 把各数据库的唯一约束错误统一转换为 UniqueConstraintException，其余原样返回 */
export function translateDatabaseError(error: unknown): unknown {
  for (let current: any = error, depth = 0; current && depth < 5; current = current.cause, depth++) {
    const code = String(current.code ?? '')
    const message = String(current.message ?? '')
    // MongoDB 重复键：11000
    if (code === '11000' || current.code === 11000 || code === '23505' || code === 'ER_DUP_ENTRY' || current.errno === 1062 || code.startsWith('SQLITE_CONSTRAINT_UNIQUE') || code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || /UNIQUE constraint failed/.test(message))
      return new UniqueConstraintException(error)
  }
  return error
}
