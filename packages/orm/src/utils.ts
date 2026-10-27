import type { Column, Table } from 'drizzle-orm'
import { getTableColumns } from 'drizzle-orm'

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object')
    return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

const primaryKeys = new WeakMap<Table, string | undefined>()

/** 单列主键的属性名（复合主键返回 undefined） */
export function primaryKeyOf(table: Table): string | undefined {
  if (!primaryKeys.has(table)) {
    const keys = Object.entries(getTableColumns(table)).filter(([, column]) => column.primary).map(([key]) => key)
    primaryKeys.set(table, keys.length === 1
      ? keys[0]
      : undefined)
  }
  return primaryKeys.get(table)
}

/** 按列的数据类型生成“当前时间”：Date / ISO 字符串 / 毫秒数 */
export function nowFor(column: Column): unknown {
  const now = new Date()
  switch (column.dataType) {
    case 'string': return now.toISOString()
    case 'number': return now.getTime()
    default: return now
  }
}

/** 各驱动的“影响行数”字段不同 */
export function affectedRows(result: any): number {
  const value = result?.rowsAffected ?? result?.affectedRows ?? result?.[0]?.affectedRows ?? result?.count ?? result?.rowCount ?? 0
  return Number(value)
}

export function pascalCase(value: string): string {
  return value.replace(/[-_\s]+(.)?/g, (_, char: string | undefined) => (char ?? '').toUpperCase()).replace(/^./, char => char.toUpperCase())
}
