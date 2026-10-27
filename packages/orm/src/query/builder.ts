import type { SQL, Table } from 'drizzle-orm'
import type { Session } from '../context'
import type { ColumnKey, Direction, Insert, Paginated, Row } from '../types'
import { and, asc, avg, count, desc, getTableColumns, getTableName, inArray, is, max, min, sql, SQL as SQLClass, sum } from 'drizzle-orm'
import { resolveSession } from '../context'
import { DatabaseError, ModelNotFoundException, translateDatabaseError } from '../errors'
import { affectedRows, primaryKeyOf } from '../utils'
import { Conditions } from './conditions'

export interface QueryOptions {
  /** 连接名，默认使用 config/database.ts 的 default */
  connection?: string
}

export interface WriteOptions {
  /** 允许无条件更新 / 删除整张表（默认拒绝，防止误操作） */
  all?: boolean
}

/**
 * ThinkPHP 风格的查询构造器，底层使用 drizzle：
 *
 * ```ts
 * await Db.table(users).where('status', 1).order('id', 'desc').paginate(1, 20)
 * ```
 */
export class QueryBuilder<T extends Table, R = Row<T>> extends Conditions<T> {
  protected connectionName: string | undefined
  protected orders: SQL[] = []
  protected limitValue: number | undefined
  protected offsetValue: number | undefined
  protected fields: string[] | undefined

  constructor(table: T, options: QueryOptions = {}) {
    super(table)
    this.connectionName = options.connection
  }

  /** 切换连接 */
  connection(name: string): this {
    this.connectionName = name
    return this
  }

  /** `order('id', 'desc')`、`order({ status: 'asc', id: 'desc' })` 或 drizzle 表达式 */
  order(column: ColumnKey<T>, direction?: Direction): this
  order(columns: Partial<Record<ColumnKey<T>, Direction>>): this
  order(expression: SQL): this
  order(column: string | Record<string, Direction | undefined> | SQL, direction: Direction = 'asc'): this {
    if (is(column, SQLClass)) {
      this.orders.push(column)
    }
    else if (typeof column === 'string') {
      this.orders.push(direction === 'desc'
        ? desc(this.columnOf(column))
        : asc(this.columnOf(column)))
    }
    else {
      for (const [key, dir] of Object.entries(column))
        this.order(key as ColumnKey<T>, dir ?? 'asc')
    }
    return this
  }

  limit(value: number): this {
    this.limitValue = value
    return this
  }

  offset(value: number): this {
    this.offsetValue = value
    return this
  }

  /** 分页：page 从 1 开始 */
  page(page: number, perPage = 15): this {
    return this.limit(perPage).offset((Math.max(1, page) - 1) * perPage)
  }

  /** 只查询指定列 */
  field<K extends ColumnKey<T>>(...keys: K[]): QueryBuilder<T, Pick<Row<T>, K>> {
    this.fields = keys
    return this as unknown as QueryBuilder<T, Pick<Row<T>, K>>
  }

  /** 查询全部结果 */
  async select(): Promise<R[]> {
    const session = await this.session()
    const selection = this.fields
      ? Object.fromEntries(this.fields.map(key => [
          key,
          this.columnOf(key),
        ]))
      : undefined
    let query = (selection
      ? session.db.select(selection)
      : session.db.select()).from(this.table).$dynamic()
    const where = this.scopedWhere()
    if (where)
      query = query.where(where)
    if (this.orders.length)
      query = query.orderBy(...this.orders)
    if (this.limitValue !== undefined)
      query = query.limit(this.limitValue)
    if (this.offsetValue !== undefined)
      query = query.offset(this.offsetValue)
    return this.transform(await query)
  }

  /** 查询第一条，不存在时为 undefined */
  async find(): Promise<R | undefined> {
    const [first] = await this.clone().limit(1).select()
    return first
  }

  async findOrFail(): Promise<R> {
    const result = await this.find()
    if (result === undefined)
      throw new ModelNotFoundException(this.label())
    return result
  }

  /** 某一列的值（第一条） */
  async value<K extends ColumnKey<T>>(column: K): Promise<Row<T>[K] | undefined> {
    const row = await (this.clone() as unknown as QueryBuilder<T>).field(column).find()
    return row?.[column]
  }

  /** 某一列的全部值 */
  async column<K extends ColumnKey<T>>(column: K): Promise<Array<Row<T>[K]>> {
    const rows = await (this.clone() as unknown as QueryBuilder<T>).field(column).select()
    return rows.map(row => row[column])
  }

  async count(): Promise<number> {
    return Number(await this.aggregate(count()) ?? 0)
  }

  async sum(column: ColumnKey<T>): Promise<number> {
    return Number(await this.aggregate(sum(this.columnOf(column))) ?? 0)
  }

  async avg(column: ColumnKey<T>): Promise<number | null> {
    const value = await this.aggregate(avg(this.columnOf(column)))
    return value === null || value === undefined
      ? null
      : Number(value)
  }

  async max<K extends ColumnKey<T>>(column: K): Promise<Row<T>[K] | null> {
    return await this.aggregate(max(this.columnOf(column))) as Row<T>[K] | null
  }

  async min<K extends ColumnKey<T>>(column: K): Promise<Row<T>[K] | null> {
    return await this.aggregate(min(this.columnOf(column))) as Row<T>[K] | null
  }

  async exists(): Promise<boolean> {
    return (await this.count()) > 0
  }

  async paginate(page = 1, perPage = 15): Promise<Paginated<R>> {
    const current = Math.max(1, Math.floor(page))
    const total = await this.count()
    const data = await this.clone().page(current, perPage).select()
    return {
      data,
      total,
      page: current,
      perPage,
      lastPage: Math.max(1, Math.ceil(total / perPage)),
    }
  }

  /** 分批处理大量数据，回调返回 false 时停止 */
  async chunk(size: number, callback: (rows: R[], page: number) => unknown): Promise<void> {
    for (let page = 1; ; page++) {
      const rows = await this.clone().page(page, size).select()
      if (!rows.length || (await callback(rows, page)) === false || rows.length < size)
        return
    }
  }

  /** 插入一条或多条，返回插入后的完整记录（MySQL 通过主键回查） */
  async insert(values: Insert<T> | Array<Insert<T>>): Promise<Array<Row<T>>> {
    const list = Array.isArray(values)
      ? values
      : [values]
    if (!list.length)
      return []
    const session = await this.session()
    const query = session.db.insert(this.table).values(list)
    if (session.dialect !== 'mysql')
      return this.write(() => query.returning())

    const key = primaryKeyOf(this.table)
    const ids: Array<Record<string, unknown>> = await this.write(() => query.$returningId())
    if (!key || !ids.length)
      return []
    return session.db.select().from(this.table).where(inArray(this.columnOf(key), ids.map(id => id[key])))
  }

  /** 插入一条并返回主键值 */
  async insertGetId(values: Insert<T>): Promise<unknown> {
    const key = primaryKeyOf(this.table)
    if (!key)
      throw new DatabaseError(`Table "${getTableName(this.table)}" has no single-column primary key`)
    const [row] = await this.insert(values)
    return (row as Record<string, unknown> | undefined)?.[key]
  }

  /** 按当前条件更新，返回影响行数 */
  async update(values: Partial<Insert<T>> | Record<string, unknown>, options: WriteOptions = {}): Promise<number> {
    const where = this.writableWhere('update', options)
    const session = await this.session()
    return affectedRows(await this.write(() => session.db.update(this.table).set(values).where(where)))
  }

  /** 按当前条件删除，返回影响行数 */
  async delete(options: WriteOptions = {}): Promise<number> {
    const where = this.writableWhere('delete', options)
    const session = await this.session()
    return affectedRows(await this.write(() => session.db.delete(this.table).where(where)))
  }

  async increment(column: ColumnKey<T>, step = 1): Promise<number> {
    const target = this.columnOf(column)
    return this.update({ [column]: sql`${target} + ${step}` })
  }

  async decrement(column: ColumnKey<T>, step = 1): Promise<number> {
    const target = this.columnOf(column)
    return this.update({ [column]: sql`${target} - ${step}` })
  }

  /** 生成的 SQL 与参数（调试用） */
  async toSQL(): Promise<{ sql: string, params: unknown[] }> {
    const session = await this.session()
    let query = session.db.select().from(this.table).$dynamic()
    const where = this.scopedWhere()
    if (where)
      query = query.where(where)
    if (this.orders.length)
      query = query.orderBy(...this.orders)
    if (this.limitValue !== undefined)
      query = query.limit(this.limitValue)
    if (this.offsetValue !== undefined)
      query = query.offset(this.offsetValue)
    return query.toSQL()
  }

  clone(): this {
    const copy = Object.create(Object.getPrototypeOf(this)) as this
    Object.assign(copy, this)
    copy.parts = [...this.parts]
    copy.orders = [...this.orders]
    copy.fields = this.fields && [...this.fields]
    return copy
  }

  /** 子类（ModelQuery）追加的全局条件，例如软删除 */
  protected scopedWhere(): SQL | undefined {
    return this.buildWhere()
  }

  /** 子类（ModelQuery）把行转换为模型 */
  protected async transform(rows: Array<Record<string, unknown>>): Promise<R[]> {
    return rows as R[]
  }

  protected label(): string {
    return getTableName(this.table)
  }

  protected session(): Promise<Session> {
    return resolveSession(this.connectionName)
  }

  protected async aggregate(expression: SQL): Promise<unknown> {
    const session = await this.session()
    let query = session.db.select({ value: expression }).from(this.table).$dynamic()
    const where = this.scopedWhere()
    if (where)
      query = query.where(where)
    const [row] = await query
    return row?.value
  }

  /** 写操作：把唯一约束等数据库错误转换为框架异常（409） */
  protected async write<V>(run: () => Promise<V>): Promise<V> {
    try {
      return await run()
    }
    catch (error) {
      throw translateDatabaseError(error)
    }
  }

  protected writableWhere(action: string, options: WriteOptions): SQL | undefined {
    const where = this.scopedWhere()
    if (!where && !options.all)
      throw new DatabaseError(`Refusing to ${action} all rows of "${getTableName(this.table)}" without conditions. Pass { all: true } to confirm.`)
    return where
  }
}

/** 表是否有对应列 */
export function hasColumn(table: Table, key: string): boolean {
  return key in getTableColumns(table)
}

/** 将多个条件以 AND 合并（忽略 undefined） */
export function andAll(...conditions: Array<SQL | undefined>): SQL | undefined {
  const defined = conditions.filter((condition): condition is SQL => condition !== undefined)
  return defined.length > 1
    ? and(...defined)
    : defined[0]
}
