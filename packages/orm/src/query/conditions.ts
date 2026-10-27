import type { Column, SQL, Table } from 'drizzle-orm'
import type { ColumnKey, Operator, Row } from '../types'
import {
  and,
  between,
  eq,
  getTableColumns,
  getTableName,
  gt,
  gte,
  inArray,
  is,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  notBetween,
  notInArray,
  notLike,
  or,
  SQL as SQLClass,
} from 'drizzle-orm'
import { isPlainObject } from '../utils'

/** `{ status: 1, role: ['admin', 'owner'], deletedAt: null }`：数组为 IN，null 为 IS NULL */
export type WhereObject<T extends Table> = { [K in ColumnKey<T>]?: Row<T>[K] | Array<Row<T>[K]> | null }

export type WhereCondition<T extends Table> = SQL | WhereObject<T> | ((group: Conditions<T>) => unknown)

interface Part {
  bool: 'and' | 'or'
  sql: SQL
}

/** 条件构造：多次 where 以 AND 连接，orWhere 以 OR 连接（从左到右），回调参数用于分组 */
export class Conditions<T extends Table> {
  readonly table: T
  protected parts: Part[] = []

  constructor(table: T) {
    this.table = table
  }

  /**
   * - `where('status', 1)` / `where('age', '>', 18)`
   * - `where({ status: 1, role: ['a', 'b'] })`
   * - `where(eq(users.id, 1))`（drizzle 表达式）
   * - `where(q => q.where('a', 1).orWhere('b', 2))`（括号分组）
   */
  where(condition: WhereCondition<T>): this
  where<K extends ColumnKey<T>>(column: K, value: Row<T>[K] | Array<Row<T>[K]> | null): this
  where<K extends ColumnKey<T>>(column: K, operator: Operator, value: unknown): this
  where(...args: unknown[]): this {
    return this.addCondition('and', args)
  }

  orWhere(condition: WhereCondition<T>): this
  orWhere<K extends ColumnKey<T>>(column: K, value: Row<T>[K] | Array<Row<T>[K]> | null): this
  orWhere<K extends ColumnKey<T>>(column: K, operator: Operator, value: unknown): this
  orWhere(...args: unknown[]): this {
    return this.addCondition('or', args)
  }

  whereIn<K extends ColumnKey<T>>(column: K, values: ReadonlyArray<Row<T>[K]>): this {
    return this.pushCondition('and', inArray(this.columnOf(column), values as unknown[]))
  }

  whereNotIn<K extends ColumnKey<T>>(column: K, values: ReadonlyArray<Row<T>[K]>): this {
    return this.pushCondition('and', notInArray(this.columnOf(column), values as unknown[]))
  }

  whereNull(column: ColumnKey<T>): this {
    return this.pushCondition('and', isNull(this.columnOf(column)))
  }

  whereNotNull(column: ColumnKey<T>): this {
    return this.pushCondition('and', isNotNull(this.columnOf(column)))
  }

  whereBetween<K extends ColumnKey<T>>(column: K, range: [Row<T>[K], Row<T>[K]]): this {
    return this.pushCondition('and', between(this.columnOf(column), range[0], range[1]))
  }

  whereNotBetween<K extends ColumnKey<T>>(column: K, range: [Row<T>[K], Row<T>[K]]): this {
    return this.pushCondition('and', notBetween(this.columnOf(column), range[0], range[1]))
  }

  whereLike(column: ColumnKey<T>, pattern: string): this {
    return this.pushCondition('and', like(this.columnOf(column), pattern))
  }

  whereNotLike(column: ColumnKey<T>, pattern: string): this {
    return this.pushCondition('and', notLike(this.columnOf(column), pattern))
  }

  /** 条件成立时才应用：`.when(keyword, q => q.whereLike('name', `%${keyword}%`))` */
  when<V>(value: V, callback: (query: this, value: NonNullable<V>) => unknown): this {
    if (value !== undefined && value !== null && value !== false && value !== '')
      callback(this, value as NonNullable<V>)
    return this
  }

  /** 当前条件组合成的 SQL（无条件时为 undefined） */
  buildWhere(): SQL | undefined {
    let result: SQL | undefined
    for (const part of this.parts) {
      result = result === undefined
        ? part.sql
        : part.bool === 'and'
          ? and(result, part.sql)
          : or(result, part.sql)
    }
    return result
  }

  get hasConditions(): boolean {
    return this.parts.length > 0
  }

  /** 列名 → drizzle 列对象 */
  columnOf(key: string): Column {
    const column = getTableColumns(this.table)[key]
    if (!column)
      throw new Error(`Unknown column "${key}" on table "${getTableName(this.table)}"`)
    return column
  }

  // 不使用 #私有成员：clone() 通过原型复制实例，私有成员会失去品牌检查
  protected addCondition(bool: Part['bool'], args: unknown[]): this {
    const condition = this.parseCondition(args)
    return condition
      ? this.pushCondition(bool, condition)
      : this
  }

  protected pushCondition(bool: Part['bool'], sql: SQL): this {
    this.parts.push({ bool, sql })
    return this
  }

  protected parseCondition(args: unknown[]): SQL | undefined {
    if (args.length === 1) {
      const [condition] = args
      if (typeof condition === 'function') {
        const group = new Conditions(this.table)
        condition(group)
        return group.buildWhere()
      }
      if (is(condition, SQLClass))
        return condition as SQL
      if (isPlainObject(condition))
        return and(...Object.entries(condition).map(([key, value]) => this.compare(key, '=', value)))
      throw new TypeError('where() expects a column, an object, a drizzle SQL expression or a callback')
    }
    if (args.length === 2)
      return this.compare(args[0] as string, '=', args[1])
    return this.compare(args[0] as string, args[1] as Operator, args[2])
  }

  protected compare(key: string, operator: Operator, value: unknown): SQL {
    const column = this.columnOf(key)
    switch (operator) {
      case '=':
        if (value === null)
          return isNull(column)
        return Array.isArray(value)
          ? inArray(column, value)
          : eq(column, value)
      case '!=':
      case '<>':
        if (value === null)
          return isNotNull(column)
        return Array.isArray(value)
          ? notInArray(column, value)
          : ne(column, value)
      case '>': return gt(column, value)
      case '>=': return gte(column, value)
      case '<': return lt(column, value)
      case '<=': return lte(column, value)
      case 'like': return like(column, value as string)
      case 'not like': return notLike(column, value as string)
      case 'in': return inArray(column, value as unknown[])
      case 'not in': return notInArray(column, value as unknown[])
      case 'between': return between(column, (value as unknown[])[0], (value as unknown[])[1])
      case 'not between': return notBetween(column, (value as unknown[])[0], (value as unknown[])[1])
      default:
        throw new Error(`Unsupported operator "${String(operator)}"`)
    }
  }
}
