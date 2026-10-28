import type { Column, Table } from 'drizzle-orm'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { DatabaseError } from '../errors'
import { primaryKeyOf } from '../utils'

export interface TimestampOptions {
  createdAt?: string | false
  updatedAt?: string | false
}

/** 模型类上的静态配置 */
export interface ModelSettings {
  readonly name: string
  table: Table
  connection?: string
  softDelete: boolean | string
  timestamps: boolean | TimestampOptions
  hidden: readonly string[]
  append: readonly string[]
  readonly?: readonly string[]
  optimLock?: boolean | string
}

export interface ModelMeta {
  table: Table
  tableName: string
  columns: Record<string, Column>
  primaryKey: string | undefined
  softDelete: string | undefined
  createdAt: string | undefined
  updatedAt: string | undefined
  /** 乐观锁版本列 */
  lockVersion: string | undefined
}

const cache = new WeakMap<object, ModelMeta>()

/** 解析并缓存模型元数据（主键、软删除列、时间戳列） */
export function metaOf(model: ModelSettings): ModelMeta {
  const cached = cache.get(model)
  if (cached)
    return cached
  if (!model.table)
    throw new DatabaseError(`Model ${model.name} has no table. Use: class ${model.name} extends Model.define(table) {}`)

  const columns = getTableColumns(model.table)
  const pick = (key: string | false | undefined, fallback: string, required: boolean): string | undefined => {
    if (key === false)
      return undefined
    const name = key ?? fallback
    if (name in columns)
      return name
    if (required || key)
      throw new DatabaseError(`Model ${model.name}: column "${name}" does not exist on table "${getTableName(model.table)}"`)
    return undefined
  }

  const timestamps: TimestampOptions = model.timestamps === false
    ? { createdAt: false, updatedAt: false }
    : model.timestamps === true
      ? {}
      : model.timestamps
  const meta: ModelMeta = {
    table: model.table,
    tableName: getTableName(model.table),
    columns,
    primaryKey: primaryKeyOf(model.table),
    softDelete: model.softDelete
      ? pick(typeof model.softDelete === 'string'
          ? model.softDelete
          : undefined, 'deletedAt', true)
      : undefined,
    // 时间戳列不存在时自动忽略
    createdAt: pick(timestamps.createdAt, 'createdAt', false),
    updatedAt: pick(timestamps.updatedAt, 'updatedAt', false),
    lockVersion: model.optimLock
      ? pick(typeof model.optimLock === 'string'
          ? model.optimLock
          : undefined, 'lockVersion', true)
      : undefined,
  }
  cache.set(model, meta)
  return meta
}
