import type { CacheTtl } from '@hazejs/core'
import type { Column, SQLWrapper, Table } from 'drizzle-orm'
import type { Session } from '../context'
import type { ColumnKey, Direction, Insert, Paginated, Row } from '../types'
import type { BuildContext, FieldPath, SubqueryLike } from './conditions'
import { useCacheManager } from '@hazejs/core'
import { aliasedTable, and, asc, avg, count, desc, getTableColumns, getTableName, inArray, is, max, min, sql, SQL, sum } from 'drizzle-orm'
import { resolveSession } from '../context'
import { DatabaseError, ModelNotFoundException, translateDatabaseError } from '../errors'
import { affectedRows, isPlainObject, primaryKeyOf } from '../utils'
import { Conditions } from './conditions'

export interface QueryOptions {
  /** 连接名，默认使用 config/database.ts 的 default */
  connection?: string
}

export interface WriteOptions {
  /** 允许无条件更新 / 删除整张表（默认拒绝，防止误操作） */
  all?: boolean
}

export interface UpsertOptions<T extends Table> {
  /** 冲突判断的列（PostgreSQL / SQLite 需要唯一索引），默认主键；MySQL 按任意唯一键判断，忽略此项 */
  target?: ColumnKey<T> | Array<ColumnKey<T>>
  /** 冲突时更新的列，默认为传入数据中除冲突列以外的全部列 */
  update?: Array<ColumnKey<T>>
}

/** paginateX() 的游标分页结果 */
export interface CursorPaginated<T> {
  data: T[]
  perPage: number
  /** 本页最后一条的游标值，传给下一次 paginateX({ lastId }) */
  lastId: unknown
  hasMore: boolean
}

export interface PaginateXOptions {
  /** 游标列，默认主键 */
  key?: string
  /** 默认 desc（新的在前） */
  sort?: Direction
  /** 上一页返回的 lastId，首页不传 */
  lastId?: unknown
}

/** 表的连接方式 */
export type JoinType = 'inner' | 'left' | 'right' | 'full'

/** join 的表：drizzle 表，或 `[表, 别名]` */
export type JoinTable = Table | [Table, string]

type Selected = Column | SQL | SQL.Aliased
type SelectionMap = Record<string, Selected>

/** field({ ... }) 的结果类型 */
export type SelectionResult<F extends SelectionMap> = {
  [K in keyof F]: F[K] extends SQL<infer V> | SQL.Aliased<infer V>
    ? V
    : F[K] extends Column
      ? F[K]['_']['notNull'] extends true
        ? F[K]['_']['data']
        : F[K]['_']['data'] | null
      : unknown
}

interface FieldEntry {
  key: string
  build: (ctx: BuildContext) => Selected
}

interface JoinEntry {
  type: JoinType
  table: Table
  on: (ctx: BuildContext) => SQL
}

type Lazy = (ctx: BuildContext) => SQL

interface CacheOptions {
  key?: string
  ttl?: CacheTtl
  store?: string
}

const joinMethods: Record<JoinType, string> = {
  inner: 'innerJoin',
  left: 'leftJoin',
  right: 'rightJoin',
  full: 'fullJoin',
}

/**
 * ThinkPHP 风格的查询构造器，底层使用 drizzle：
 *
 * ```ts
 * await Db.table(users).where('status', 1).order('id', 'desc').paginate(1, 20)
 * ```
 */
export class QueryBuilder<T extends Table, R = Row<T>> extends Conditions<T> implements SubqueryLike {
  protected connectionName: string | undefined
  /** select 的来源（alias() 后为别名表） */
  protected source: Table
  protected orders: Lazy[] = []
  protected limitValue: number | undefined
  protected offsetValue: number | undefined
  protected fields: FieldEntry[] = []
  protected excluded: string[] | undefined
  protected joins: JoinEntry[] = []
  protected groups: Lazy[] = []
  protected havings: Lazy[] = []
  protected distinctValue = false
  protected lockMode: 'update' | 'share' | undefined
  protected unions: Array<{ all: boolean, query: SubqueryLike }> = []
  protected cacheOptions: CacheOptions | undefined
  /** inc() / dec() / exp() / data() 累积、由 update() 写入的数据 */
  protected pending: Record<string, unknown> = {}
  /** withAttr() 定义的结果字段转换 */
  protected attrs: Record<string, (value: unknown, row: Record<string, unknown>) => unknown> = {}

  constructor(table: T, options: QueryOptions = {}) {
    super(table)
    this.source = table
    this.connectionName = options.connection
  }

  /** 切换连接 */
  connection(name: string): this {
    this.connectionName = name
    return this
  }

  // ---------------------------------------------------------------- 表与连接

  /** 当前表的别名（自连接时使用）：`Db.table(users).alias('u').join([users, 'p'], 'u.parentId', 'p.id')` */
  alias(name: string): this {
    this.source = aliasedTable(this.table, name)
    this.sources = new Map(this.sources).set(name, this.source)
    return this
  }

  /**
   * 连接其它表：
   * - `join(posts, eq(users.id, posts.userId))`
   * - `join(posts, 'users.id', 'posts.userId')`、`join(posts, 'users.id', '=', 'posts.userId')`
   * - `join([posts, 'p'], 'users.id', 'p.userId')`（别名）
   *
   * 未指定 field() 时，Db.table() 的结果按表名分组：`{ users: {...}, posts: {...} }`；
   * 模型查询只取当前表的列。
   */
  join(table: JoinTable, on: SQL): this
  join(table: JoinTable, left: string, right: string): this
  join(table: JoinTable, left: string, operator: string, right: string): this
  join(table: JoinTable, ...on: [SQL] | string[]): this {
    return this.addJoin('inner', table, on)
  }

  leftJoin(table: JoinTable, on: SQL): this
  leftJoin(table: JoinTable, left: string, right: string): this
  leftJoin(table: JoinTable, left: string, operator: string, right: string): this
  leftJoin(table: JoinTable, ...on: [SQL] | string[]): this {
    return this.addJoin('left', table, on)
  }

  rightJoin(table: JoinTable, on: SQL): this
  rightJoin(table: JoinTable, left: string, right: string): this
  rightJoin(table: JoinTable, left: string, operator: string, right: string): this
  rightJoin(table: JoinTable, ...on: [SQL] | string[]): this {
    return this.addJoin('right', table, on)
  }

  /** FULL JOIN（MySQL 不支持） */
  fullJoin(table: JoinTable, on: SQL): this
  fullJoin(table: JoinTable, left: string, right: string): this
  fullJoin(table: JoinTable, left: string, operator: string, right: string): this
  fullJoin(table: JoinTable, ...on: [SQL] | string[]): this {
    return this.addJoin('full', table, on)
  }

  // ---------------------------------------------------------------- 字段

  /**
   * 指定查询的字段（多次调用会累加）：
   * - `field('id', 'name')`：当前表的列，结果有类型
   * - `field('posts.title', 'name as nickname', 'meta->city as city')`
   * - `field({ total: count(), name: users.name })`：drizzle 表达式，键为结果字段名
   */
  field<K extends ColumnKey<T>>(...keys: K[]): QueryBuilder<T, Pick<Row<T>, K>>
  field<F extends SelectionMap>(fields: F): QueryBuilder<T, SelectionResult<F>>
  field(...keys: Array<ColumnKey<T> | FieldPath | `${string} as ${string}`>): QueryBuilder<T, Record<string, any>>
  field(...args: unknown[]): QueryBuilder<T, any> {
    for (const arg of args) {
      if (isPlainObject(arg)) {
        // 表达式加上别名：结果按别名返回，也可用于 order('别名')
        for (const [key, value] of Object.entries(arg)) {
          this.fields.push({
            key,
            build: () => is(value, SQL)
              ? (value as SQL).as(key)
              : value as Selected,
          })
        }
        continue
      }
      for (const item of String(arg).split(',')) {
        const [expression, alias] = item.trim().split(/\s+as\s+/i)
        const key = alias ?? expression.split('->').at(-1)!.split('.').at(-1)!
        this.fields.push({
          key,
          build: ctx => this.fieldOf(expression, ctx),
        })
      }
    }
    return this as QueryBuilder<T, any>
  }

  /** 查询除指定列以外的全部列 */
  withoutField<K extends ColumnKey<T>>(...keys: K[]): QueryBuilder<T, Omit<Row<T>, K>> {
    this.excluded = [
      ...(this.excluded ?? []),
      ...keys,
    ]
    return this as unknown as QueryBuilder<T, Omit<Row<T>, K>>
  }

  /** 原生字段表达式：`fieldRaw('count(*)', 'total')`，或 `fieldRaw(sql\`...\`, 'alias')` */
  fieldRaw<V = unknown, K extends string = string>(expression: string | SQL, alias: K): QueryBuilder<T, R & Record<K, V>> {
    const value = (typeof expression === 'string'
      ? sql.raw(expression)
      : expression).as(alias)
    this.fields.push({
      key: alias,
      build: () => value,
    })
    return this as unknown as QueryBuilder<T, R & Record<K, V>>
  }

  /** 去重 */
  distinct(value = true): this {
    this.distinctValue = value
    return this
  }

  // ---------------------------------------------------------------- 分组、排序与分页

  /** 分组：`group('status')`、`group('status', 'role')` 或 drizzle 表达式 */
  group(...keys: Array<ColumnKey<T> | FieldPath | SQL>): this
  group(...keys: Array<string | SQL>): this {
    for (const key of keys) {
      this.groups.push(ctx => typeof key === 'string'
        ? this.fieldOf(key, ctx) as unknown as SQL
        : key)
    }
    return this
  }

  /** 分组条件：`having(sql\`count(*) > ${1}\`)`，或 `having('count(*) > ?', [1])` */
  having(condition: SQL | string, bindings: unknown[] = []): this {
    const group = this.newGroup().whereRaw(condition, bindings)
    this.havings.push(ctx => group.buildWhere(ctx)!)
    return this
  }

  /**
   * - `order('id', 'desc')`、`order('posts.id')`、`order('meta->rank')`
   * - `order({ status: 'asc', id: 'desc' })`
   * - `order(sql\`...\`)`（drizzle 表达式）
   *
   * 字段不是表的列但是 field() 的别名时按别名排序。
   */
  order(column: ColumnKey<T> | FieldPath, direction?: Direction): this
  order(column: string, direction?: Direction): this
  order(columns: Partial<Record<ColumnKey<T>, Direction>> | Record<string, Direction | undefined>): this
  order(expression: SQL): this
  order(column: string | Record<string, Direction | undefined> | SQL, direction: Direction = 'asc'): this {
    if (is(column, SQL)) {
      this.orders.push(() => column)
    }
    else if (typeof column === 'string') {
      this.orders.push((ctx) => {
        const target = this.orderTarget(column, ctx)
        return direction === 'desc'
          ? desc(target)
          : asc(target)
      })
    }
    else {
      for (const [key, dir] of Object.entries(column))
        this.order(key, dir ?? 'asc')
    }
    return this
  }

  /** 原生排序：`orderRaw('field(status, 2, 1, 0)')`、`orderRaw('length(name) desc')` */
  orderRaw(expression: string | SQL, bindings: unknown[] = []): this {
    const group = this.newGroup().whereRaw(expression, bindings)
    this.orders.push(ctx => group.buildWhere(ctx)!)
    return this
  }

  /** 按指定值的顺序排序：`orderField('status', [2, 1, 0])`（不在列表中的排在最后） */
  orderField(column: ColumnKey<T> | FieldPath, values: readonly unknown[], direction: Direction = 'asc'): this {
    this.orders.push((ctx) => {
      const field = this.fieldOf(column, ctx)
      const cases = sql.join(values.map((value, index) => sql`when ${field} = ${value} then ${sql.raw(String(index))}`), sql` `)
      const expression = sql`case ${cases} else ${sql.raw(String(values.length))} end`
      return direction === 'desc'
        ? desc(expression)
        : asc(expression)
    })
    return this
  }

  /** 随机排序 */
  orderRand(): this {
    this.orders.push(ctx => ctx.dialect === 'mysql'
      ? sql`rand()`
      : sql`random()`)
    return this
  }

  /** `limit(10)`，或 ThinkPHP 的 `limit(offset, length)` */
  limit(value: number, length?: number): this {
    if (length === undefined) {
      this.limitValue = value
    }
    else {
      this.offsetValue = value
      this.limitValue = length
    }
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

  /** 合并另一个查询的结果（字段需一致）：`union(Db.table(archived).field('id', 'name'))` */
  union(...queries: SubqueryLike[]): this {
    this.unions.push(...queries.map(query => ({ all: false, query })))
    return this
  }

  unionAll(...queries: SubqueryLike[]): this {
    this.unions.push(...queries.map(query => ({ all: true, query })))
    return this
  }

  /** 行锁：`lock()` / `lock('update')` 为 FOR UPDATE，`lock('share')` 为共享锁（SQLite 忽略，需在事务中使用） */
  lock(mode: boolean | 'update' | 'share' = true): this {
    this.lockMode = mode === true
      ? 'update'
      : mode || undefined
    return this
  }

  /**
   * 缓存查询结果（使用 @hazejs/core 的 Cache）：
   * - `cache()`：按 SQL 生成键，永久缓存
   * - `cache(60)` / `cache('10m')`：有效期
   * - `cache('users:active', '10m')`：指定键，便于更新后 `Cache.forget('users:active')`
   */
  cache(key?: string | number | boolean, ttl?: CacheTtl, store?: string): this {
    if (key === false) {
      this.cacheOptions = undefined
      return this
    }
    this.cacheOptions = typeof key === 'number'
      ? { ttl: key, store }
      : {
          key: typeof key === 'string'
            ? key
            : undefined,
          ttl,
          store,
        }
    return this
  }

  /** 结果字段转换：`withAttr('name', (value, row) => value.toUpperCase())` */
  withAttr(name: string, transform: (value: any, row: Record<string, any>) => unknown): this
  withAttr(transforms: Record<string, (value: any, row: Record<string, any>) => unknown>): this
  withAttr(name: string | Record<string, (value: any, row: Record<string, any>) => unknown>, transform?: (value: any, row: Record<string, any>) => unknown): this {
    Object.assign(this.attrs, typeof name === 'string'
      ? { [name]: transform! }
      : name)
    return this
  }

  /**
   * 移除已设置的查询选项：`removeOption('order')`；不传参数时移除除表以外的全部选项
   */
  removeOption(name?: 'where' | 'order' | 'limit' | 'field' | 'join' | 'group' | 'having' | 'distinct' | 'lock' | 'union' | 'cache' | 'data'): this {
    const all = name === undefined
    if (all || name === 'where')
      this.parts = []
    if (all || name === 'order')
      this.orders = []
    if (all || name === 'limit')
      this.limitValue = this.offsetValue = undefined
    if (all || name === 'field')
      this.resetFields()
    if (all || name === 'join')
      this.joins = []
    if (all || name === 'group')
      this.groups = []
    if (all || name === 'having')
      this.havings = []
    if (all || name === 'distinct')
      this.distinctValue = false
    if (all || name === 'lock')
      this.lockMode = undefined
    if (all || name === 'union')
      this.unions = []
    if (all || name === 'cache')
      this.cacheOptions = undefined
    if (all || name === 'data')
      this.pending = {}
    return this
  }

  // ---------------------------------------------------------------- 读取

  /** 查询全部结果 */
  async select(): Promise<R[]> {
    return this.transform(await this.selectRows())
  }

  /** 查询全部结果，为空时抛出 ModelNotFoundException（404） */
  async selectOrFail(): Promise<R[]> {
    const rows = await this.select()
    if (!rows.length)
      throw new ModelNotFoundException(this.label())
    return rows
  }

  /** 原始行（模型查询也不转换为模型） */
  async selectRows(): Promise<Array<Record<string, unknown>>> {
    const ctx = await this.context()
    return this.fetch(ctx, this.buildSelect(ctx))
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
  async value<K extends ColumnKey<T>>(column: K): Promise<Row<T>[K] | undefined>
  async value(column: FieldPath): Promise<unknown>
  async value(column: string): Promise<unknown> {
    const query = this.clone().resetFields()
    query.attrs = {}
    const [row] = await (query.field(column as never) as unknown as QueryBuilder<T>).limit(1).selectRows()
    return this.applyAttr(column.split('->').at(-1)!.split('.').at(-1)!, row)
  }

  /**
   * 某一列的全部值：`column('name')`；
   * 指定索引列时返回对象：`column('name', 'id')` → `{ 1: 'Ada' }`，`column('*', 'id')` → `{ 1: row }`
   */
  async column<K extends ColumnKey<T>>(column: K): Promise<Array<Row<T>[K]>>
  async column<K extends ColumnKey<T>>(column: K, key: ColumnKey<T>): Promise<Record<string, Row<T>[K]>>
  async column(column: '*', key: ColumnKey<T>): Promise<Record<string, R>>
  async column(column: FieldPath): Promise<unknown[]>
  async column(column: string, key?: string): Promise<unknown[] | Record<string, unknown>> {
    if (column === '*') {
      const rows = await this.select()
      return Object.fromEntries(rows.map(row => [
        String((row as Record<string, unknown>)[key!]),
        row,
      ]))
    }
    const name = column.split('->').at(-1)!.split('.').at(-1)!
    const query = this.clone().resetFields()
    query.field(column as never)
    if (key && key !== name)
      query.field(key as never)
    const rows = await query.selectRows()
    if (!key)
      return rows.map(row => this.applyAttr(name, row))
    return Object.fromEntries(rows.map(row => [
      String(row[key]),
      this.applyAttr(name, row),
    ]))
  }

  /** 记录数；指定列时统计非空值：`count('email')` */
  async count(column?: ColumnKey<T> | FieldPath): Promise<number> {
    const ctx = await this.context()
    if (this.groups.length || this.distinctValue || this.unions.length) {
      // 分组 / 去重 / 合并后的数量：对子查询计数
      const inner = this.clone()
      inner.orders = []
      inner.limitValue = inner.offsetValue = undefined
      const [row] = await ctx.db.select({
        value: count(),
      }).from(inner.buildSelect(ctx).as('aggregate'))
      return Number(row?.value ?? 0)
    }
    return Number(await this.aggregate(ctx, column
      ? count(this.fieldOf(column, ctx))
      : count()) ?? 0)
  }

  async sum(column: ColumnKey<T> | FieldPath): Promise<number> {
    const ctx = await this.context()
    return Number(await this.aggregate(ctx, sum(this.fieldOf(column, ctx))) ?? 0)
  }

  async avg(column: ColumnKey<T> | FieldPath): Promise<number | null> {
    const ctx = await this.context()
    const value = await this.aggregate(ctx, avg(this.fieldOf(column, ctx)))
    return value === null || value === undefined
      ? null
      : Number(value)
  }

  async max<K extends ColumnKey<T>>(column: K | FieldPath): Promise<Row<T>[K] | null> {
    const ctx = await this.context()
    return await this.aggregate(ctx, max(this.fieldOf(column, ctx))) as Row<T>[K] | null
  }

  async min<K extends ColumnKey<T>>(column: K | FieldPath): Promise<Row<T>[K] | null> {
    const ctx = await this.context()
    return await this.aggregate(ctx, min(this.fieldOf(column, ctx))) as Row<T>[K] | null
  }

  async exists(): Promise<boolean> {
    return (await this.clone().limit(1).selectRows()).length > 0
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

  /**
   * 游标分页（大数据量，不统计总数、不使用 offset）：
   *
   * ```ts
   * const first = await Db.table(logs).paginateX(20)
   * const next = await Db.table(logs).paginateX(20, { lastId: first.lastId })
   * ```
   */
  async paginateX(perPage = 15, options: PaginateXOptions = {}): Promise<CursorPaginated<R>> {
    const key = options.key ?? this.requirePrimaryKey()
    const sort = options.sort ?? 'desc'
    const query = this.clone()
    query.orders = []
    if (options.lastId !== undefined && options.lastId !== null) {
      query.where(key as never, sort === 'desc'
        ? '<'
        : '>', options.lastId)
    }
    const rows = await query.order(key, sort).limit(perPage + 1).select()
    const hasMore = rows.length > perPage
    const data = rows.slice(0, perPage)
    return {
      data,
      perPage,
      lastId: data.length
        ? (data.at(-1) as Record<string, unknown>)[key]
        : options.lastId,
      hasMore,
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

  /**
   * 逐条遍历（内部分批读取，内存占用恒定）：`for await (const user of User.query().cursor()) {}`
   *
   * 未指定排序且有主键时按主键分批（不受遍历期间的写入影响），否则按 offset 分批。
   */
  async* cursor(size = 200): AsyncGenerator<R, void, undefined> {
    const key = primaryKeyOf(this.table)
    if (key && !this.orders.length && !this.unions.length && !this.groups.length) {
      let last: unknown
      while (true) {
        const query = this.clone().order(key, 'asc').limit(size)
        if (last !== undefined)
          query.where(key as never, '>', last)
        const rows = await query.select()
        yield* rows
        if (rows.length < size)
          return
        last = (rows.at(-1) as Record<string, unknown>)[key]
      }
    }
    for (let page = 1; ; page++) {
      const rows = await this.clone().page(page, size).select()
      yield* rows
      if (rows.length < size)
        return
    }
  }

  /** cursor() 的别名 */
  lazy(size = 200): AsyncGenerator<R, void, undefined> {
    return this.cursor(size)
  }

  // ---------------------------------------------------------------- 写入

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

  /** insert() 的别名（ThinkPHP 写法） */
  insertAll(values: Array<Insert<T>>): Promise<Array<Row<T>>> {
    return this.insert(values)
  }

  /** 插入一条并返回主键值 */
  async insertGetId(values: Insert<T>): Promise<unknown> {
    const key = this.requirePrimaryKey()
    const [row] = await this.insert(values)
    return (row as Record<string, unknown> | undefined)?.[key]
  }

  /** 插入，忽略违反唯一约束的行，返回实际插入的行数 */
  async insertIgnore(values: Insert<T> | Array<Insert<T>>): Promise<number> {
    const list = Array.isArray(values)
      ? values
      : [values]
    if (!list.length)
      return 0
    const session = await this.session()
    const query = session.db.insert(this.table).values(list)
    return affectedRows(await this.write(() => session.dialect === 'mysql'
      ? query.ignore()
      : query.onConflictDoNothing()))
  }

  /**
   * 插入，冲突时更新（ON CONFLICT DO UPDATE / ON DUPLICATE KEY UPDATE），返回影响行数：
   *
   * ```ts
   * await Db.table(users).upsert({ email: 'ada@example.com', name: 'Ada' }, { target: 'email' })
   * ```
   */
  async upsert(values: Insert<T> | Array<Insert<T>>, options: UpsertOptions<T> = {}): Promise<number> {
    const list = (Array.isArray(values)
      ? values
      : [values]) as Array<Record<string, unknown>>
    if (!list.length)
      return 0
    const session = await this.session()
    const columns = getTableColumns(this.table)
    const target = ([] as string[]).concat(options.target ?? this.requirePrimaryKey())
    const update = options.update ?? [
      ...new Set(list.flatMap(Object.keys)),
    ].filter(key => key in columns && !target.includes(key))
    const query = session.db.insert(this.table).values(list)
    if (session.dialect === 'mysql') {
      const set = Object.fromEntries((update.length ? update : target).map(key => [key, sql`values(${sql.identifier(columns[key].name)})`]))
      return affectedRows(await this.write(() => query.onDuplicateKeyUpdate({ set })))
    }
    const conflict = target.map(key => this.columnOf(key))
    if (!update.length)
      return affectedRows(await this.write(() => query.onConflictDoNothing({ target: conflict })))
    const set = Object.fromEntries(update.map(key => [key, sql`excluded.${sql.identifier(columns[key].name)}`]))
    return affectedRows(await this.write(() => query.onConflictDoUpdate({ target: conflict, set })))
  }

  /** 按主键插入或替换（REPLACE 语义），返回影响行数 */
  replace(values: Insert<T> | Array<Insert<T>>): Promise<number> {
    return this.upsert(values)
  }

  /**
   * 把当前查询的结果插入另一张表（INSERT INTO … SELECT），field() 的键需与目标表的列一致：
   *
   * ```ts
   * await Db.table(users).where('status', 0).field({ userId: users.id, name: users.name }).selectInsert(archive)
   * ```
   */
  async selectInsert(target: Table): Promise<number> {
    const ctx = await this.context()
    const selection = this.selection(ctx)
    if (!selection)
      throw new DatabaseError('selectInsert() needs field() to pick the columns to insert')
    const columns = getTableColumns(target)
    const list = Object.keys(selection).map((key) => {
      if (!columns[key])
        throw new DatabaseError(`selectInsert(): "${key}" is not a column of "${getTableName(target)}"`)
      return sql.identifier(columns[key].name)
    })
    const query = sql`insert into ${target} (${sql.join(list, sql`, `)}) ${this.buildSelect(ctx, selection).getSQL()}`
    return affectedRows(await this.write(() => ctx.dialect === 'sqlite'
      ? ctx.db.run(query)
      : ctx.db.execute(query)))
  }

  /** 数据中带主键值时更新该行，否则插入；返回影响行数 */
  async save(values: Insert<T> | Partial<Insert<T>>): Promise<number> {
    const key = primaryKeyOf(this.table)
    const data = values as Record<string, unknown>
    if (key && data[key] !== undefined && data[key] !== null && await this.clone().where(key as never, data[key] as never).exists())
      return this.clone().update(data)
    return (await this.insert(values as Insert<T>)).length
  }

  /** 设置待更新的数据（与 update() 的参数合并） */
  data(values: Partial<Insert<T>> | Record<string, unknown>): this {
    Object.assign(this.pending, values)
    return this
  }

  /** 待更新的自增：`Db.table(users).where('id', 1).inc('score', 5).update()` */
  inc(column: ColumnKey<T>, step = 1): this {
    return this.exp(column, sql`${this.columnOf(column)} + ${step}`)
  }

  dec(column: ColumnKey<T>, step = 1): this {
    return this.exp(column, sql`${this.columnOf(column)} - ${step}`)
  }

  /** 以表达式更新某列：`exp('name', sql\`upper(${users.name})\`)` */
  exp(column: ColumnKey<T>, expression: SQL | string): this {
    this.pending[column] = typeof expression === 'string'
      ? sql.raw(expression)
      : expression
    return this
  }

  /**
   * 按当前条件更新，返回影响行数。
   * 没有条件但数据中带主键时，按主键更新：`update({ id: 1, name: 'Ada' })`
   */
  async update(values: Partial<Insert<T>> | Record<string, unknown> = {}, options: WriteOptions = {}): Promise<number> {
    let data: Record<string, unknown> = {
      ...this.pending,
      ...values,
    }
    const key = primaryKeyOf(this.table)
    const byKey = !this.hasConditions && key !== undefined && data[key] !== undefined
    const query = byKey
      ? this.clone().where(key as never, data[key] as never)
      : this
    if (byKey) {
      const { [key]: _, ...rest } = data
      data = rest
    }
    if (!Object.keys(data).length)
      throw new DatabaseError('update() called without data')
    const ctx = await query.context()
    const where = query.writableWhere('update', options, ctx)
    return affectedRows(await query.write(() => ctx.db.update(query.table).set(data).where(where)))
  }

  /**
   * 按当前条件删除，返回影响行数；
   * 也可按主键删除：`delete(1)`、`delete([1, 2])`
   */
  async delete(target: WriteOptions | unknown = {}): Promise<number> {
    const [query, options] = this.deleteTarget(target)
    const ctx = await query.context()
    const where = query.writableWhere('delete', options, ctx)
    return affectedRows(await query.write(() => ctx.db.delete(query.table).where(where)))
  }

  /** 立即执行的原子自增，返回影响行数 */
  async increment(column: ColumnKey<T>, step = 1): Promise<number> {
    const target = this.columnOf(column)
    return this.update({ [column]: sql`${target} + ${step}` })
  }

  async decrement(column: ColumnKey<T>, step = 1): Promise<number> {
    const target = this.columnOf(column)
    return this.update({ [column]: sql`${target} - ${step}` })
  }

  // ---------------------------------------------------------------- 子查询与调试

  /** 作为子查询嵌入其它查询（whereIn / whereExists / union 等内部调用） */
  buildSubquery(ctx: BuildContext): SQLWrapper {
    return this.buildSelect(ctx)
  }

  /** drizzle 子查询，用于 `(await Db.drizzle()).select().from(sub)` 这类派生表 */
  async subQuery<A extends string>(alias: A): Promise<any> {
    const ctx = await this.context()
    return this.buildSelect(ctx).as(alias)
  }

  /** 生成的 SQL 与参数（调试用，ThinkPHP 的 fetchSql） */
  async toSQL(): Promise<{ sql: string, params: unknown[] }> {
    const ctx = await this.context()
    return this.buildSelect(ctx).toSQL()
  }

  clone(): this {
    const copy = Object.create(Object.getPrototypeOf(this)) as this
    Object.assign(copy, this)
    copy.parts = [...this.parts]
    copy.orders = [...this.orders]
    copy.fields = [...this.fields]
    copy.excluded = this.excluded && [...this.excluded]
    copy.joins = [...this.joins]
    copy.groups = [...this.groups]
    copy.havings = [...this.havings]
    copy.unions = [...this.unions]
    copy.sources = new Map(this.sources)
    copy.pending = { ...this.pending }
    copy.attrs = { ...this.attrs }
    return copy
  }

  // ---------------------------------------------------------------- 内部

  /** 构造 drizzle select（plain 时不含排序、分页、合并与锁，用于聚合） */
  protected buildSelect(ctx: BuildContext, selection = this.selection(ctx), plain = false): any {
    const method = this.distinctValue
      ? 'selectDistinct'
      : 'select'
    let query = (selection
      ? ctx.db[method](selection)
      : ctx.db[method]()).from(this.source).$dynamic()
    for (const join of this.joins)
      query = query[joinMethods[join.type]](join.table, join.on(ctx))
    const where = this.scopedWhere(ctx)
    if (where)
      query = query.where(where)
    if (this.groups.length)
      query = query.groupBy(...this.groups.map(group => group(ctx)))
    if (this.havings.length)
      query = query.having(and(...this.havings.map(having => having(ctx))))
    if (plain)
      return query
    for (const { all, query: other } of this.unions) {
      query = all
        ? query.unionAll(other.buildSubquery(ctx))
        : query.union(other.buildSubquery(ctx))
    }
    if (this.orders.length)
      query = query.orderBy(...this.orders.map(order => order(ctx)))
    if (this.limitValue !== undefined)
      query = query.limit(this.limitValue)
    if (this.offsetValue !== undefined)
      query = query.offset(this.offsetValue)
    if (this.lockMode && ctx.dialect !== 'sqlite')
      query = query.for(this.lockMode)
    return query
  }

  /** 要查询的字段（undefined 为全部列） */
  protected selection(ctx: BuildContext): SelectionMap | undefined {
    const selected: SelectionMap = {}
    if (this.excluded) {
      for (const [key, column] of Object.entries(getTableColumns(this.source))) {
        if (!this.excluded.includes(key))
          selected[key] = column
      }
    }
    for (const field of this.fields)
      selected[field.key] = field.build(ctx)
    return Object.keys(selected).length
      ? selected
      : this.defaultSelection()
  }

  /** 未指定字段时的选择（模型查询在 join 时只取当前表的列） */
  protected defaultSelection(): SelectionMap | undefined {
    return undefined
  }

  protected resetFields(): this {
    this.fields = []
    this.excluded = undefined
    return this
  }

  /** 执行查询，按 cache() 设置读写缓存 */
  protected async fetch(ctx: BuildContext & { name?: string }, query: any): Promise<Array<Record<string, unknown>>> {
    if (!this.cacheOptions)
      return await query
    const options = this.cacheOptions
    const repository = useCacheManager().store(options.store)
    const key = options.key ?? `orm:${ctx.name ?? ''}:${hash(JSON.stringify(query.toSQL()))}`
    const cached = await repository.get<Array<Record<string, unknown>>>(key)
    if (cached !== undefined)
      return this.revive(cached)
    const rows: Array<Record<string, unknown>> = await query
    await repository.set(key, rows, options.ttl)
    return rows
  }

  /** 缓存以 JSON 保存：把日期列还原为 Date，BigInt 列还原为 BigInt（写入时转为字符串） */
  protected revive(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
    const reviveRow = (row: Record<string, unknown>, columns: Record<string, Column>): void => {
      for (const [key, column] of Object.entries(columns)) {
        if (column.dataType === 'date' && typeof row[key] === 'string')
          row[key] = new Date(row[key] as string)
        else if (column.dataType === 'bigint' && typeof row[key] === 'string')
          row[key] = BigInt(row[key] as string)
      }
    }
    const columns = getTableColumns(this.source)
    for (const row of rows) {
      reviveRow(row, columns)
      for (const [name, table] of this.sources) {
        if (isPlainObject(row[name]))
          reviveRow(row[name] as Record<string, unknown>, getTableColumns(table))
      }
    }
    return rows
  }

  /** 子类（ModelQuery）追加的全局条件，例如软删除 */
  protected scopedWhere(ctx: BuildContext): SQL | undefined {
    return this.buildWhere(ctx)
  }

  /** 子类（ModelQuery）把行转换为模型 */
  protected async transform(rows: Array<Record<string, unknown>>): Promise<R[]> {
    if (!Object.keys(this.attrs).length)
      return rows as R[]
    return rows.map(row => Object.fromEntries(Object.keys({
      ...row,
      ...this.attrs,
    }).map(key => [
      key,
      this.applyAttr(key, row),
    ]))) as R[]
  }

  protected applyAttr(key: string, row: Record<string, unknown> | undefined): unknown {
    if (!row)
      return undefined
    const transform = this.attrs[key]
    return transform
      ? transform(row[key], row)
      : row[key]
  }

  protected label(): string {
    return getTableName(this.table)
  }

  protected session(): Promise<Session> {
    return resolveSession(this.connectionName)
  }

  protected async context(): Promise<BuildContext & { name: string }> {
    const session = await this.session()
    return { db: session.db, dialect: session.dialect, name: session.name }
  }

  protected async aggregate(ctx: BuildContext, expression: SQL): Promise<unknown> {
    const [row] = await this.fetch(ctx, this.buildSelect(ctx, { value: expression }, true))
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

  protected writableWhere(action: string, options: WriteOptions, ctx: BuildContext): SQL | undefined {
    const where = this.scopedWhere(ctx)
    if (!where && !options.all)
      throw new DatabaseError(`Refusing to ${action} all rows of "${getTableName(this.table)}" without conditions. Pass { all: true } to confirm.`)
    return where
  }

  /** delete(1) / delete([1, 2]) / delete({ all: true }) */
  protected deleteTarget(target: unknown): [this, WriteOptions] {
    if (target === undefined || isPlainObject(target))
      return [this, (target ?? {}) as WriteOptions]
    const key = this.requirePrimaryKey()
    const query = this.clone()
    if (Array.isArray(target))
      query.whereIn(key as never, target as never)
    else
      query.where(key as never, target as never)
    return [query, {}]
  }

  protected requirePrimaryKey(): string {
    const key = primaryKeyOf(this.table)
    if (!key)
      throw new DatabaseError(`Table "${getTableName(this.table)}" has no single-column primary key`)
    return key
  }

  protected addJoin(type: JoinType, target: JoinTable, on: unknown[]): this {
    const [table, alias] = Array.isArray(target)
      ? [
          aliasedTable(target[0], target[1]),
          target[1],
        ]
      : [
          target,
          getTableName(target),
        ]
    this.sources = new Map(this.sources).set(alias, table)
    let build: (ctx: BuildContext) => SQL
    if (on.length === 1 && is(on[0], SQL)) {
      build = () => on[0] as SQL
    }
    else {
      const [left, operator, right] = on.length === 2
        ? [on[0], '=', on[1]] as string[]
        : on as string[]
      const group = this.newGroup().whereColumn(left as never, operator as never, right as never)
      build = ctx => group.buildWhere(ctx)!
    }
    this.joins.push({ type, table, on: build })
    return this
  }

  /** 排序字段：列 / 路径，或 field() 的别名 */
  protected orderTarget(key: string, ctx: BuildContext): Column | SQL {
    if (!key.includes('.') && !key.includes('->') && !(key in getTableColumns(this.source)) && this.fields.some(field => field.key === key))
      return sql`${sql.identifier(key)}`
    return this.fieldOf(key, ctx)
  }

  /** 条件分组使用 select 的来源表（alias() 后为别名表） */
  protected override newGroup(): Conditions<T> {
    return new Conditions(this.source as T, this.sources)
  }

  override columnOf(key: string): Column {
    const column = getTableColumns(this.source)[key]
    if (!column)
      throw new Error(`Unknown column "${key}" on table "${getTableName(this.table)}"`)
    return column
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

/** 缓存键用的字符串摘要（FNV-1a，不依赖 node:crypto，Edge 可用） */
function hash(value: string): string {
  let result = 0x811C9DC5
  for (let index = 0; index < value.length; index++) {
    result ^= value.charCodeAt(index)
    result = Math.imul(result, 0x01000193)
  }
  return (result >>> 0).toString(36) + value.length.toString(36)
}
