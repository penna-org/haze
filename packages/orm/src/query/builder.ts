import type { CacheTtl } from '@hazejs/core'
import type { Column, SQLWrapper, Table } from 'drizzle-orm'
import type { Session } from '../context'
import type { AnyDatabase, ColumnKey, Direction, Insert, Paginated, Row } from '../types'
import type { BuildContext, FieldPath, SubqueryLike } from './conditions'
import { useCacheManager } from '@hazejs/core'
import { aliasedTable, and, asc, avg, count, desc, getTableColumns, getTableName, inArray, is, max, min, sql, SQL, sum } from 'drizzle-orm'
import { inTransaction, resolveSession } from '../context'
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

export interface UpdateOptions extends WriteOptions {
  /** 返回更新后的行（PostgreSQL / SQLite 使用 RETURNING；MySQL 不支持） */
  returning?: boolean
}

export interface InsertOptions {
  /** false 时不返回行，只返回插入的条数（MySQL 也不再按主键回查），适合日志等热路径 */
  returning?: boolean
}

/** insert() / Model.create() 的值：每列可以是值或 drizzle SQL 表达式 */
export type InsertValues<T extends Table> = { [K in keyof Insert<T>]: Insert<T>[K] | SQL }

/** update() 的值：列值或 drizzle SQL 表达式（值为 undefined 的键会被忽略） */
export type UpdateValues<T extends Table> = Partial<InsertValues<T>> | Record<string, unknown>

export interface UpsertOptions<T extends Table> {
  /** 冲突判断的列（PostgreSQL / SQLite 需要唯一索引），默认主键；MySQL 按任意唯一键判断，忽略此项 */
  target?: ColumnKey<T> | Array<ColumnKey<T>>
  /**
   * 冲突时更新的列：
   * - 列名数组：取本次要插入的值（默认为传入数据中除冲突列以外的全部列）
   * - `{ 列: 值 | SQL 表达式 }`：例如 `{ attempts: sql\`${jobs.attempts} + 1\` }`（表达式中的列指已存在的行）
   */
  update?: Array<ColumnKey<T>> | { [K in ColumnKey<T>]?: Row<T>[K] | SQL }
  /** 只在条件成立时更新（`ON CONFLICT … DO UPDATE … WHERE`，PostgreSQL / SQLite） */
  where?: SQL
  /** 返回插入或更新后的行（PostgreSQL / SQLite；冲突后没有更新的行不返回） */
  returning?: boolean
}

/** 行锁模式：`no key update` / `key share` 仅 PostgreSQL */
export type LockMode = 'update' | 'share' | 'no key update' | 'key share'

export interface LockOptions {
  /** 跳过已被锁住的行（`SKIP LOCKED`，PostgreSQL / MySQL 8） */
  skipLocked?: boolean
  /** 行已被锁住时立即报错而不等待（`NOWAIT`，PostgreSQL / MySQL 8） */
  noWait?: boolean
}

export interface SelectInsertOptions {
  /** 忽略违反唯一约束的行（PostgreSQL / SQLite：ON CONFLICT DO NOTHING；MySQL：INSERT IGNORE） */
  ignore?: boolean
}

/** toSQL() 的结果 */
export interface SqlPreview {
  sql: string
  params: unknown[]
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

type Selected = Column | SQL | SQL.Aliased | Table
type SelectionMap = Record<string, Selected>

/**
 * field({ ... }) 的结果类型。N 为结果中可能为 null 的表名（左连接 / 右连接 / 全连接引入），
 * 这些表的列总是可空；值为整张表时结果为该表的行对象（可空的表为 `行 | null`）
 */
export type SelectionResult<F extends SelectionMap, N extends string = never> = {
  [K in keyof F]: F[K] extends SQL<infer V> | SQL.Aliased<infer V>
    ? V
    : F[K] extends Column
      ? F[K]['_']['tableName'] extends N
        ? F[K]['_']['data'] | null
        : F[K]['_']['notNull'] extends true
          ? F[K]['_']['data']
          : F[K]['_']['data'] | null
      : F[K] extends Table
        ? F[K]['_']['name'] extends N
          ? Row<F[K]> | null
          : Row<F[K]>
        : unknown
}

/**
 * 联表的类型标记（只存在于类型中）：已连接的表名与结果中可能为 null 的表名。
 * join 系列方法返回 `this & JoinMarker<...>`，之后的 `field({ ... })` 据此把可空表的列标为 `T | null`
 */
export interface JoinMarker<J extends string, N extends string> {
  readonly '~joined': { [K in J]: true }
  readonly '~nullable': { [K in N]: true }
}

type JoinedOf<S> = S extends { readonly '~joined': infer X } ? keyof X & string : never
type NullableOf<S> = S extends { readonly '~nullable': infer X } ? keyof X & string : never
type JoinNameOf<J> = (J extends readonly [infer X, string] ? X : J) extends infer X extends Table ? X['_']['name'] : never
type TableNameOf<T extends Table> = T['_']['name']

/** value() / column() 可用的结果字段（field() 的别名等）；模型查询的结果是模型，不在此列 */
type ResultKey<R> = R extends { readonly '~table': any } ? never : keyof R & string

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
  protected lockMode: LockMode | undefined
  protected lockOptions: LockOptions = {}
  protected unions: Array<{ all: boolean, query: SubqueryLike }> = []
  protected cacheOptions: CacheOptions | undefined
  /** 读写分离：读取也使用写库 */
  protected forceWriter = false
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

  /** 读写分离：本查询的读取使用写库（例如刚写入后需要立即读到的数据） */
  useWriter(value = true): this {
    this.forceWriter = value
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
  join<J extends JoinTable>(table: J, on: SQL): this & JoinMarker<JoinNameOf<J>, never>
  join<J extends JoinTable>(table: J, left: string, right: string): this & JoinMarker<JoinNameOf<J>, never>
  join<J extends JoinTable>(table: J, left: string, operator: string, right: string): this & JoinMarker<JoinNameOf<J>, never>
  join(table: JoinTable, ...on: [SQL] | string[]): this {
    return this.addJoin('inner', table, on)
  }

  /** LEFT JOIN：之后 `field({ ... })` 结果中被连接表的列为 `T | null` */
  leftJoin<J extends JoinTable>(table: J, on: SQL): this & JoinMarker<JoinNameOf<J>, JoinNameOf<J>>
  leftJoin<J extends JoinTable>(table: J, left: string, right: string): this & JoinMarker<JoinNameOf<J>, JoinNameOf<J>>
  leftJoin<J extends JoinTable>(table: J, left: string, operator: string, right: string): this & JoinMarker<JoinNameOf<J>, JoinNameOf<J>>
  leftJoin(table: JoinTable, ...on: [SQL] | string[]): this {
    return this.addJoin('left', table, on)
  }

  /** RIGHT JOIN：之后 `field({ ... })` 结果中主表与之前连接的表的列为 `T | null` */
  rightJoin<J extends JoinTable>(table: J, on: SQL): this & JoinMarker<JoinNameOf<J>, TableNameOf<T> | JoinedOf<this>>
  rightJoin<J extends JoinTable>(table: J, left: string, right: string): this & JoinMarker<JoinNameOf<J>, TableNameOf<T> | JoinedOf<this>>
  rightJoin<J extends JoinTable>(table: J, left: string, operator: string, right: string): this & JoinMarker<JoinNameOf<J>, TableNameOf<T> | JoinedOf<this>>
  rightJoin(table: JoinTable, ...on: [SQL] | string[]): this {
    return this.addJoin('right', table, on)
  }

  /** FULL JOIN（MySQL 不支持）：之后 `field({ ... })` 结果中所有表的列为 `T | null` */
  fullJoin<J extends JoinTable>(table: J, on: SQL): this & JoinMarker<JoinNameOf<J>, TableNameOf<T> | JoinedOf<this> | JoinNameOf<J>>
  fullJoin<J extends JoinTable>(table: J, left: string, right: string): this & JoinMarker<JoinNameOf<J>, TableNameOf<T> | JoinedOf<this> | JoinNameOf<J>>
  fullJoin<J extends JoinTable>(table: J, left: string, operator: string, right: string): this & JoinMarker<JoinNameOf<J>, TableNameOf<T> | JoinedOf<this> | JoinNameOf<J>>
  fullJoin(table: JoinTable, ...on: [SQL] | string[]): this {
    return this.addJoin('full', table, on)
  }

  // ---------------------------------------------------------------- 字段

  /**
   * 指定查询的字段（多次调用会累加）：
   * - `field('id', 'name')`：当前表的列，结果有类型
   * - `field('posts.title', 'name as nickname', 'meta->city as city')`
   * - `field({ total: count(), name: users.name })`：drizzle 表达式，键为结果字段名
   * - `field({ log: logs, userName: users.name })`：值为整张表时，结果中 `log` 为该表的行对象
   *
   * 链式调用 leftJoin() / rightJoin() / fullJoin() 之后，可能为 null 的表的列在结果类型中为 `T | null`
   */
  field<K extends ColumnKey<T>>(...keys: K[]): QueryBuilder<T, Pick<Row<T>, K>>
  field<F extends SelectionMap, S = this>(this: S, fields: F): QueryBuilder<T, SelectionResult<F, NullableOf<S>>>
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
   * - `order(sql\`...\`)`、`order(sql\`...\`, 'desc')`（drizzle 表达式；不传方向时原样使用）
   *
   * 字段不是表的列但是 field() 的别名时按别名排序。
   */
  order(column: ColumnKey<T> | FieldPath, direction?: Direction): this
  order(column: string, direction?: Direction): this
  order(columns: Partial<Record<ColumnKey<T>, Direction>> | Record<string, Direction | undefined>): this
  order(expression: SQL, direction?: Direction): this
  order(column: string | Record<string, Direction | undefined> | SQL, direction?: Direction): this {
    if (is(column, SQL)) {
      this.orders.push(() => direction === 'desc'
        ? desc(column)
        : direction === 'asc'
          ? asc(column)
          : column)
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

  /**
   * 行锁（需在事务中使用，SQLite 忽略）：
   * - `lock()` / `lock('update')`：FOR UPDATE；`lock('share')`：共享锁
   * - `lock('no key update')` / `lock('key share')`：PostgreSQL 的弱锁
   * - `lock('update', { skipLocked: true })` / `{ noWait: true }`：SKIP LOCKED / NOWAIT（PostgreSQL / MySQL 8）
   */
  lock(mode: boolean | LockMode = true, options: LockOptions = {}): this {
    this.lockMode = mode === true
      ? 'update'
      : mode || undefined
    this.lockOptions = this.lockMode
      ? { ...options }
      : {}
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
    if (all || name === 'lock') {
      this.lockMode = undefined
      this.lockOptions = {}
    }
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

  /** 某一列的值（第一条）；也可以是 field() 定义的别名：`field({ total: count() }).value('total')` */
  async value<K extends ColumnKey<T>>(column: K): Promise<Row<T>[K] | undefined>
  async value<K extends ResultKey<R>>(column: K): Promise<R[K] | undefined>
  async value(column: FieldPath): Promise<unknown>
  async value(column: string): Promise<unknown> {
    const query = this.clone().resetFields()
    query.attrs = {}
    query.pickField(column, this.fields)
    const [row] = await query.limit(1).selectRows()
    return this.applyAttr(column.split('->').at(-1)!.split('.').at(-1)!, row)
  }

  /**
   * 某一列的全部值：`column('name')`；
   * 指定索引列时返回对象：`column('name', 'id')` → `{ 1: 'Ada' }`，`column('*', 'id')` → `{ 1: row }`
   */
  async column<K extends ColumnKey<T>>(column: K): Promise<Array<Row<T>[K]>>
  async column<K extends ColumnKey<T>>(column: K, key: ColumnKey<T> | ResultKey<R>): Promise<Record<string, Row<T>[K]>>
  async column(column: '*', key: ColumnKey<T> | ResultKey<R>): Promise<Record<string, R>>
  async column<K extends ResultKey<R>>(column: K): Promise<Array<R[K]>>
  async column<K extends ResultKey<R>>(column: K, key: ColumnKey<T> | ResultKey<R>): Promise<Record<string, R[K]>>
  async column(column: FieldPath, key?: string): Promise<unknown[]>
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
    query.pickField(column, this.fields)
    if (key && key !== name)
      query.pickField(key, this.fields)
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

  /** 是否有符合条件的数据（`select 1 … limit 1`，不读取整行） */
  async exists(): Promise<boolean> {
    const query = this.clone().limit(1)
    // 合并 / 去重时 select 1 会改变语义，having 可能引用 field() 的别名：仍按原字段读取
    if (this.unions.length || this.distinctValue || (this.havings.length && this.fields.length))
      return (await query.selectRows()).length > 0
    query.orders = []
    const ctx = await query.context()
    return (await query.fetch(ctx, query.buildSelect(ctx, { exists: sql`1` }))).length > 0
  }

  /**
   * 分页：`{ data, total, page, perPage, lastPage }`。
   * 不在事务中时统计与取数据并行；在事务中时依次执行，total 为 0 时不再取数据
   */
  async paginate(page = 1, perPage = 15): Promise<Paginated<R>> {
    const current = Math.max(1, Math.floor(page))
    const query = this.clone().page(current, perPage)
    let total: number
    let data: R[]
    if (inTransaction(this.connectionName)) {
      total = await this.count()
      data = total > 0
        ? await query.select()
        : []
    }
    else {
      [total, data] = await Promise.all([
        this.count(),
        query.select(),
      ])
    }
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

  /**
   * 插入一条或多条，返回插入后的完整记录（MySQL 通过主键回查）；
   * `insert(values, { returning: false })` 不返回行，只返回插入的条数。值可以是 drizzle SQL 表达式
   */
  async insert(values: InsertValues<T> | Array<InsertValues<T>>, options: InsertOptions & { returning: false }): Promise<number>
  async insert(values: InsertValues<T> | Array<InsertValues<T>>, options?: InsertOptions & { returning?: true }): Promise<Array<Row<T>>>
  async insert(values: InsertValues<T> | Array<InsertValues<T>>, options: InsertOptions = {}): Promise<Array<Row<T>> | number> {
    const list = Array.isArray(values)
      ? values
      : [values]
    if (!list.length) {
      return options.returning === false
        ? 0
        : []
    }
    const session = await this.session()
    const query = session.db.insert(this.table).values(list)
    if (options.returning === false)
      return affectedRows(await this.write(() => query))
    if (session.dialect !== 'mysql')
      return this.write(() => query.returning())

    const key = primaryKeyOf(this.table)
    const ids: Array<Record<string, unknown>> = await this.write(() => query.$returningId())
    if (!key || !ids.length)
      return []
    return session.db.select().from(this.table).where(inArray(this.columnOf(key), ids.map(id => id[key])))
  }

  /** insert() 的别名（ThinkPHP 写法） */
  insertAll(values: Array<InsertValues<T>>): Promise<Array<Row<T>>> {
    return this.insert(values)
  }

  /** 插入一条并返回主键值 */
  async insertGetId(values: InsertValues<T>): Promise<unknown> {
    const key = this.requirePrimaryKey()
    const [row] = await this.insert(values)
    return (row as Record<string, unknown> | undefined)?.[key]
  }

  /** 插入，忽略违反唯一约束的行，返回实际插入的行数 */
  async insertIgnore(values: InsertValues<T> | Array<InsertValues<T>>): Promise<number> {
    const list = Array.isArray(values)
      ? values
      : [values]
    if (!list.length)
      return 0
    const session = await this.session()
    // MySQL 的 ignore() 在 insert 构造器上（values 之前）
    return affectedRows(await this.write(() => session.dialect === 'mysql'
      ? session.db.insert(this.table).ignore().values(list)
      : session.db.insert(this.table).values(list).onConflictDoNothing()))
  }

  /**
   * 插入，冲突时更新（ON CONFLICT DO UPDATE / ON DUPLICATE KEY UPDATE），返回影响行数；
   * `{ returning: true }` 时返回插入或更新后的行（PostgreSQL / SQLite）：
   *
   * ```ts
   * await Db.table(users).upsert({ email: 'ada@example.com', name: 'Ada' }, { target: 'email' })
   * await Db.table(jobs).upsert(job, { target: 'key', update: { attempts: sql`${jobs.attempts} + 1` }, where: sql`${jobs.status} <> 'done'` })
   * ```
   */
  async upsert(values: InsertValues<T> | Array<InsertValues<T>>, options: UpsertOptions<T> & { returning: true }): Promise<Array<Row<T>>>
  async upsert(values: InsertValues<T> | Array<InsertValues<T>>, options?: UpsertOptions<T> & { returning?: false }): Promise<number>
  async upsert(values: InsertValues<T> | Array<InsertValues<T>>, options: UpsertOptions<T> = {}): Promise<number | Array<Row<T>>> {
    const list = (Array.isArray(values)
      ? values
      : [values]) as Array<Record<string, unknown>>
    if (!list.length) {
      return options.returning
        ? []
        : 0
    }
    const session = await this.session()
    const columns = getTableColumns(this.table)
    const target = ([] as string[]).concat(options.target ?? this.requirePrimaryKey())
    const query = session.db.insert(this.table).values(list)
    const explicit = isPlainObject(options.update)
      ? options.update as Record<string, unknown>
      : undefined
    const update = explicit
      ? Object.keys(explicit)
      : (options.update as string[] | undefined) ?? [
          ...new Set(list.flatMap(Object.keys)),
        ].filter(key => key in columns && !target.includes(key))
    if (session.dialect === 'mysql') {
      if (options.where)
        throw new DatabaseError('upsert({ where }) is not supported on MySQL (ON DUPLICATE KEY UPDATE has no WHERE)')
      if (options.returning)
        throw new DatabaseError('upsert({ returning: true }) is not supported on MySQL')
      const set = explicit ?? Object.fromEntries((update.length ? update : target).map(key => [key, sql`values(${sql.identifier(columnName(session.db, columns[key]))})`]))
      return affectedRows(await this.write(() => query.onDuplicateKeyUpdate({ set })))
    }
    const conflict = target.map(key => this.columnOf(key))
    const statement = update.length
      ? query.onConflictDoUpdate({
          target: conflict,
          set: explicit ?? Object.fromEntries(update.map(key => [key, sql`excluded.${sql.identifier(columnName(session.db, columns[key]))}`])),
          ...(options.where && { setWhere: options.where }),
        })
      : query.onConflictDoNothing({ target: conflict })
    if (options.returning)
      return this.write(() => statement.returning())
    return affectedRows(await this.write(() => statement))
  }

  /** 按主键插入或替换（REPLACE 语义），返回影响行数 */
  replace(values: InsertValues<T> | Array<InsertValues<T>>): Promise<number> {
    return this.upsert(values)
  }

  /**
   * 把当前查询的结果插入另一张表（INSERT INTO … SELECT），field() 的键需与目标表的列一致：
   *
   * ```ts
   * await Db.table(users).where('status', 0).field({ userId: users.id, name: users.name }).selectInsert(archive)
   * await query.selectInsert(archive, { ignore: true }) // 忽略违反唯一约束的行
   * ```
   */
  async selectInsert(target: Table, options: SelectInsertOptions = {}): Promise<number> {
    const ctx = await this.context(true)
    const selection = this.selection(ctx)
    if (!selection)
      throw new DatabaseError('selectInsert() needs field() to pick the columns to insert')
    const columns = getTableColumns(target)
    const list = Object.keys(selection).map((key) => {
      if (!columns[key])
        throw new DatabaseError(`selectInsert(): "${key}" is not a column of "${getTableName(target)}"`)
      return sql.identifier(columnName(ctx.db, columns[key]))
    })
    const select = this.buildSelect(ctx, selection).getSQL()
    const query = !options.ignore
      ? sql`insert into ${target} (${sql.join(list, sql`, `)}) ${select}`
      : ctx.dialect === 'mysql'
        ? sql`insert ignore into ${target} (${sql.join(list, sql`, `)}) ${select}`
        // SQLite 的 INSERT … SELECT … ON CONFLICT 需要 SELECT 带 WHERE 才能消除语法歧义：包一层派生表
        : sql`insert into ${target} (${sql.join(list, sql`, `)}) select * from (${select}) as ${sql.identifier('selected')} where true on conflict do nothing`
    return affectedRows(await this.write(() => ctx.dialect === 'sqlite'
      ? ctx.db.run(query)
      : ctx.db.execute(query)))
  }

  /** 数据中带主键值时更新该行，否则插入；返回影响行数 */
  async save(values: InsertValues<T> | Partial<InsertValues<T>>): Promise<number> {
    const key = primaryKeyOf(this.table)
    const data = values as Record<string, unknown>
    if (key && data[key] !== undefined && data[key] !== null && await this.clone().useWriter().where(key as never, data[key] as never).exists())
      return this.clone().update(data)
    return (await this.insert(values as InsertValues<T>)).length
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
   * 按当前条件更新，返回影响行数；`{ returning: true }` 时返回更新后的行（PostgreSQL / SQLite）。
   * 没有条件但数据中带主键时，按主键更新：`update({ id: 1, name: 'Ada' })`。
   * 值为 undefined 的键会被忽略，全部忽略后没有数据时抛出 DatabaseError
   */
  async update(values: UpdateValues<T>, options: UpdateOptions & { returning: true }): Promise<Array<Row<T>>>
  async update(values?: UpdateValues<T>, options?: UpdateOptions & { returning?: false }): Promise<number>
  async update(values: UpdateValues<T> = {}, options: UpdateOptions = {}): Promise<number | Array<Row<T>>> {
    const { statement } = await this.updateStatement(values, options)
    const result: any = await this.write(() => statement)
    return options.returning
      ? result
      : affectedRows(result)
  }

  /**
   * 按当前条件删除，返回影响行数；
   * 也可按主键删除：`delete(1)`、`delete([1, 2])`
   */
  async delete(target: WriteOptions | unknown = {}): Promise<number> {
    const { statement } = await this.deleteStatement(target)
    return affectedRows(await this.write(() => statement))
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

  /**
   * 生成的 SQL 与参数（调试用，ThinkPHP 的 fetchSql），不执行：
   * - `toSQL()`：查询
   * - `toSQL('insert', values)`、`toSQL('update', values)`、`toSQL('delete')`：与对应写操作执行的语句相同
   */
  async toSQL(action?: 'select'): Promise<SqlPreview>
  async toSQL(action: 'insert', values: InsertValues<T> | Array<InsertValues<T>>, options?: InsertOptions): Promise<SqlPreview>
  async toSQL(action: 'update', values?: UpdateValues<T>, options?: UpdateOptions): Promise<SqlPreview>
  async toSQL(action: 'delete', target?: WriteOptions | unknown): Promise<SqlPreview>
  async toSQL(action: 'select' | 'insert' | 'update' | 'delete' = 'select', values?: unknown, options?: unknown): Promise<SqlPreview> {
    const preview = (statement: { toSQL: () => SqlPreview }): SqlPreview => {
      const { sql, params } = statement.toSQL()
      return { sql, params }
    }
    switch (action) {
      case 'insert': {
        const session = await this.session()
        const query = session.db.insert(this.table).values(([] as unknown[]).concat(values))
        return preview(session.dialect === 'mysql' || (options as InsertOptions | undefined)?.returning === false
          ? query
          : query.returning())
      }
      case 'update':
        return preview((await this.updateStatement((values ?? {}) as UpdateValues<T>, (options ?? {}) as UpdateOptions)).statement)
      case 'delete':
        return preview((await this.deleteStatement(values ?? {})).statement)
      default: {
        const ctx = await this.context()
        return preview(this.buildSelect(ctx))
      }
    }
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
      query = query.for(this.lockMode, lockConfig(this.lockMode, this.lockOptions, ctx.dialect))
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

  /**
   * 当前连接的会话：写入使用写库；读取（read）在配置了读写分离时可使用副本，
   * useWriter() 与 lock() 的读取仍走写库
   */
  protected session(read = false): Promise<Session> {
    return resolveSession(this.connectionName, {
      read,
      writer: this.forceWriter || this.lockMode !== undefined,
    })
  }

  /** 构造查询的上下文，write 为 true 时使用写库 */
  protected async context(write = false): Promise<BuildContext & { name: string }> {
    const session = await this.session(!write)
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

  /**
   * update() 执行的 drizzle 语句（不执行）。
   * 包在对象中返回：drizzle 的查询是 thenable，直接从 async 函数返回会被执行
   */
  protected async updateStatement(values: UpdateValues<T>, options: UpdateOptions): Promise<{ statement: any }> {
    // 值为 undefined 的键忽略（与 drizzle 一致），避免全部为 undefined 时由 drizzle 报 “No values to set”
    let data: Record<string, unknown> = Object.fromEntries(Object.entries({
      ...this.pending,
      ...values,
    }).filter(([, value]) => value !== undefined))
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
    const ctx = await query.context(true)
    const where = query.writableWhere('update', options, ctx)
    let statement = ctx.db.update(query.table).set(data).where(where)
    if (options.returning) {
      if (ctx.dialect === 'mysql')
        throw new DatabaseError('update({ returning: true }) is not supported on MySQL')
      statement = statement.returning()
    }
    return { statement }
  }

  /** delete() 执行的 drizzle 语句（模型查询在软删除时为 update） */
  protected deleteStatement(target: unknown): Promise<{ statement: any }> {
    return this.hardDeleteStatement(target)
  }

  /** 物理删除的 drizzle 语句 */
  protected async hardDeleteStatement(target: unknown): Promise<{ statement: any }> {
    const [query, options] = this.deleteTarget(target)
    const ctx = await query.context(true)
    const where = query.writableWhere('delete', options, ctx)
    return {
      statement: ctx.db.delete(query.table).where(where),
    }
  }

  /** value() / column() 取单个字段：field() 定义的别名沿用原表达式，其余按字段解析 */
  protected pickField(name: string, fields: FieldEntry[]): void {
    const defined = !name.includes('.') && !name.includes('->') && !(name in getTableColumns(this.source))
      ? fields.find(field => field.key === name)
      : undefined
    if (defined)
      this.fields.push(defined)
    else
      this.field(name as never)
  }

  /**
   * update() / delete() 的条件：只看用户给出的条件（where / 主键），
   * 模型自动附加的软删除过滤、多租户与全局作用域不算，避免它们让整表写入绕过 { all: true }
   */
  protected writableWhere(action: string, options: WriteOptions, ctx: BuildContext): SQL | undefined {
    if (!this.buildWhere(ctx) && !options.all)
      throw new DatabaseError(`Refusing to ${action} all rows of "${getTableName(this.table)}" without conditions. Pass { all: true } to confirm.`)
    return this.scopedWhere(ctx)
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

/** drizzle 的 for() 配置：检查方言是否支持锁模式与选项 */
function lockConfig(mode: LockMode, options: LockOptions, dialect: string): { skipLocked?: boolean, noWait?: boolean } {
  if (dialect === 'mysql' && mode !== 'update' && mode !== 'share')
    throw new DatabaseError(`lock('${mode}') is only supported on PostgreSQL`)
  if (options.skipLocked && options.noWait)
    throw new DatabaseError('lock(): skipLocked and noWait cannot be used together')
  return {
    ...(options.skipLocked && { skipLocked: true }),
    ...(options.noWait && { noWait: true }),
  }
}

/** 数据库中的列名：连接配置了 casing 时按它转换没有写列名的字段（与 drizzle 生成 SQL 时一致） */
function columnName(db: AnyDatabase, column: Column): string {
  const casing = (db as { dialect?: { casing?: { getColumnCasing?: (column: Column) => string } } }).dialect?.casing
  return casing?.getColumnCasing?.(column) ?? column.name
}
