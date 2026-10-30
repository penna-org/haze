import type { Column, SQL, SQLWrapper, Table } from 'drizzle-orm'
import type { Dialect } from '../config'
import type { AnyDatabase, ColumnKey, Operator, Row } from '../types'
import type { TimeInput, TimeKeyword, TimeUnit } from './time'
import {
  and,
  between,
  eq,
  exists,
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
  not,
  notBetween,
  notExists,
  notInArray,
  notLike,
  or,
  sql,
  SQL as SQLClass,
} from 'drizzle-orm'
import { isPlainObject, timeFor } from '../utils'
import { addTime, isTimeKeyword, keywordRange, periodOf, toDate } from './time'

/** 构造 SQL 时的上下文：查询执行时才确定方言与 drizzle 实例 */
export interface BuildContext {
  db: AnyDatabase
  dialect: Dialect
}

/** 可作为子查询的对象（QueryBuilder / ModelQuery） */
export interface SubqueryLike {
  buildSubquery: (ctx: BuildContext) => SQLWrapper
}

/**
 * 字段写法：
 * - `name`：当前表的列（有类型提示）
 * - `posts.title`：join 的表（表名或别名）的列
 * - `meta->address->city`：JSON 列中的路径
 */
export type FieldPath = `${string}.${string}` | `${string}->${string}`

/** `{ status: 1, role: ['admin', 'owner'], deletedAt: null }`：数组为 IN，null 为 IS NULL */
export type WhereObject<T extends Table> = { [K in ColumnKey<T>]?: Row<T>[K] | Array<Row<T>[K]> | null }

/** ThinkPHP 的数组条件：`[['status', '=', 1], ['age', '>', 18]]` */
export type WhereTuple<T extends Table> = [ColumnKey<T> | FieldPath, unknown] | [ColumnKey<T> | FieldPath, Operator, unknown]

export type WhereCondition<T extends Table> = SQL | WhereObject<T> | Array<WhereTuple<T>> | ((group: Conditions<T>) => unknown)

type Fragment = (ctx: BuildContext) => SQL | undefined

interface Part {
  bool: 'and' | 'or'
  build: Fragment
}

/** join 的表：别名 / 表名 → 表 */
export type Sources = Map<string, Table>

const operators = new Set(['=', '!=', '<>', '>', '>=', '<', '<='])

function isSubquery(value: unknown): value is SubqueryLike {
  return typeof (value as SubqueryLike | undefined)?.buildSubquery === 'function'
}

/** 条件构造：多次 where 以 AND 连接，orWhere 以 OR 连接（从左到右），回调参数用于分组 */
export class Conditions<T extends Table> {
  readonly table: T
  protected parts: Part[] = []
  /** 当前表与 join 的表（按名称 / 别名查找 `posts.title` 这类字段） */
  protected sources: Sources

  constructor(table: T, sources?: Sources) {
    this.table = table
    this.sources = sources ?? new Map([
      [
        getTableName(table),
        table,
      ],
    ])
  }

  /**
   * - `where('status', 1)` / `where('age', '>', 18)`
   * - `where({ status: 1, role: ['a', 'b'] })`
   * - `where([['status', '=', 1], ['age', '>', 18]])`
   * - `where(eq(users.id, 1))`（drizzle 表达式）
   * - `where(q => q.where('a', 1).orWhere('b', 2))`（括号分组）
   * - `where('id', 'in', Db.table(posts).field('userId'))`（子查询）
   * - `where(and(a, cond ? b : undefined))`：drizzle 的 `and()` / `or()` 可能返回 undefined，此时忽略该条件
   */
  where(condition: WhereCondition<T> | undefined): this
  where<K extends ColumnKey<T>>(column: K, value: Row<T>[K] | Array<Row<T>[K]> | null | SubqueryLike): this
  where<K extends ColumnKey<T>>(column: K, operator: Operator, value: unknown): this
  where(column: FieldPath, value: unknown): this
  where(column: FieldPath, operator: Operator, value: unknown): this
  where(...args: unknown[]): this {
    return this.addCondition('and', args)
  }

  orWhere(condition: WhereCondition<T> | undefined): this
  orWhere<K extends ColumnKey<T>>(column: K, value: Row<T>[K] | Array<Row<T>[K]> | null | SubqueryLike): this
  orWhere<K extends ColumnKey<T>>(column: K, operator: Operator, value: unknown): this
  orWhere(column: FieldPath, value: unknown): this
  orWhere(column: FieldPath, operator: Operator, value: unknown): this
  orWhere(...args: unknown[]): this {
    return this.addCondition('or', args)
  }

  /** orWhere() 的别名（ThinkPHP 写法） */
  whereOr(condition: WhereCondition<T> | undefined): this
  whereOr<K extends ColumnKey<T>>(column: K, value: Row<T>[K] | Array<Row<T>[K]> | null | SubqueryLike): this
  whereOr<K extends ColumnKey<T>>(column: K, operator: Operator, value: unknown): this
  whereOr(column: FieldPath, value: unknown): this
  whereOr(column: FieldPath, operator: Operator, value: unknown): this
  whereOr(...args: unknown[]): this {
    return this.addCondition('or', args)
  }

  /** 对一组条件取反：`whereNot(q => q.where('status', 0).orWhere('age', '<', 18))` */
  whereNot(condition: WhereCondition<T> | undefined): this {
    if (condition === undefined)
      return this
    const build = this.parseCondition([condition])
    return this.pushFragment('and', (ctx) => {
      const inner = build(ctx)
      return inner && not(inner)
    })
  }

  whereIn<K extends ColumnKey<T>>(column: K | FieldPath, values: ReadonlyArray<Row<T>[K]> | SubqueryLike | SQLWrapper): this {
    return this.pushFragment('and', ctx => inArray(this.fieldOf(column, ctx) as Column, this.listOrSubquery(values, ctx) as unknown[]))
  }

  whereNotIn<K extends ColumnKey<T>>(column: K | FieldPath, values: ReadonlyArray<Row<T>[K]> | SubqueryLike | SQLWrapper): this {
    return this.pushFragment('and', ctx => notInArray(this.fieldOf(column, ctx) as Column, this.listOrSubquery(values, ctx) as unknown[]))
  }

  whereNull(column: ColumnKey<T> | FieldPath): this {
    return this.pushFragment('and', ctx => isNull(this.fieldOf(column, ctx)))
  }

  whereNotNull(column: ColumnKey<T> | FieldPath): this {
    return this.pushFragment('and', ctx => isNotNull(this.fieldOf(column, ctx)))
  }

  whereBetween<K extends ColumnKey<T>>(column: K | FieldPath, range: [Row<T>[K], Row<T>[K]]): this {
    return this.pushFragment('and', ctx => between(this.fieldOf(column, ctx), range[0], range[1]))
  }

  whereNotBetween<K extends ColumnKey<T>>(column: K | FieldPath, range: [Row<T>[K], Row<T>[K]]): this {
    return this.pushFragment('and', ctx => notBetween(this.fieldOf(column, ctx), range[0], range[1]))
  }

  whereLike(column: ColumnKey<T> | FieldPath, pattern: string): this {
    return this.pushFragment('and', ctx => like(this.fieldOf(column, ctx), pattern))
  }

  whereNotLike(column: ColumnKey<T> | FieldPath, pattern: string): this {
    return this.pushFragment('and', ctx => notLike(this.fieldOf(column, ctx), pattern))
  }

  /** 子查询有结果：`whereExists(Db.table(posts).whereColumn('posts.userId', 'users.id'))` */
  whereExists(query: SubqueryLike | SQLWrapper): this {
    return this.pushFragment('and', ctx => exists(this.subqueryOf(query, ctx) as SQL))
  }

  whereNotExists(query: SubqueryLike | SQLWrapper): this {
    return this.pushFragment('and', ctx => notExists(this.subqueryOf(query, ctx) as SQL))
  }

  /** 比较两个字段：`whereColumn('updatedAt', '>', 'createdAt')`、`whereColumn('posts.userId', 'users.id')` */
  whereColumn(left: ColumnKey<T> | FieldPath, right: ColumnKey<T> | FieldPath): this
  whereColumn(left: ColumnKey<T> | FieldPath, operator: Operator, right: ColumnKey<T> | FieldPath): this
  whereColumn(left: string, operator: string, right?: string): this {
    const [op, target] = right === undefined
      ? ['=', operator]
      : [operator, right]
    if (!operators.has(op))
      throw new Error(`Unsupported operator "${op}" for whereColumn()`)
    return this.pushFragment('and', ctx => sql`${this.fieldOf(left, ctx)} ${sql.raw(op)} ${this.fieldOf(target, ctx)}`)
  }

  /**
   * 原生条件：`whereRaw(sql\`${users.age} > ${18}\`)`，或 `whereRaw('age > ? and status = ?', [18, 1])`
   * （字符串中的 `?` 依次绑定参数，其余部分原样拼入，不要拼接用户输入）
   */
  whereRaw(condition: SQL | string, bindings: unknown[] = []): this {
    return this.pushFragment('and', () => rawCondition(condition, bindings))
  }

  orWhereRaw(condition: SQL | string, bindings: unknown[] = []): this {
    return this.pushFragment('or', () => rawCondition(condition, bindings))
  }

  /** 字段 + 原生表达式：`whereExp('id', '> 10')`、`whereExp('score', sql\`> ${min}\`)` */
  whereExp(column: ColumnKey<T> | FieldPath, expression: SQL | string): this {
    return this.pushFragment('and', ctx => sql`${this.fieldOf(column, ctx)} ${typeof expression === 'string'
      ? sql.raw(expression)
      : expression}`)
  }

  /** 逗号分隔的字段中包含某个值（MySQL 为 FIND_IN_SET） */
  whereFindInSet(column: ColumnKey<T> | FieldPath, value: string | number): this {
    return this.pushFragment('and', (ctx) => {
      const field = this.fieldOf(column, ctx)
      return ctx.dialect === 'mysql'
        ? sql`find_in_set(${String(value)}, ${field})`
        : sql`(',' || ${field} || ',') like ${`%,${String(value)},%`}`
    })
  }

  /** JSON 数组列包含某个值：`whereJsonContains('tags', 'orm')` */
  whereJsonContains(column: ColumnKey<T> | FieldPath, value: unknown): this {
    return this.pushFragment('and', ctx => jsonContains(this.fieldOf(column, ctx), value, ctx.dialect))
  }

  orWhereJsonContains(column: ColumnKey<T> | FieldPath, value: unknown): this {
    return this.pushFragment('or', ctx => jsonContains(this.fieldOf(column, ctx), value, ctx.dialect))
  }

  // ---------------------------------------------------------------- 时间条件

  /**
   * - `whereTime('createdAt', '>=', '2024-01-01')`
   * - `whereTime('createdAt', 'today')`：关键字 today / yesterday / week / last week / month / last month / year / last year
   */
  whereTime(column: ColumnKey<T> | FieldPath, keyword: TimeKeyword): this
  whereTime(column: ColumnKey<T> | FieldPath, operator: Operator, value: TimeInput): this
  whereTime(column: ColumnKey<T> | FieldPath, operator: string, value?: TimeInput): this {
    if (value === undefined) {
      if (!isTimeKeyword(operator))
        throw new TypeError(`whereTime(): unknown keyword "${operator}"`)
      const [start, end] = keywordRange(operator)
      return this.whereTimeRange(column, start, end)
    }
    return this.pushFragment('and', (ctx) => {
      const field = this.fieldOf(column, ctx)
      if (operator === 'between' || operator === 'not between') {
        const [from, to] = value as unknown as [TimeInput, TimeInput]
        const range = [
          timeFor(field, toDate(from)),
          timeFor(field, toDate(to)),
        ] as const
        return operator === 'between'
          ? between(field, range[0], range[1])
          : notBetween(field, range[0], range[1])
      }
      if (!operators.has(operator))
        throw new Error(`Unsupported operator "${operator}" for whereTime()`)
      return sql`${field} ${sql.raw(operator)} ${bindTime(field, toDate(value))}`
    })
  }

  /** 时间在区间内（含两端）：`whereBetweenTime('createdAt', '2024-01-01', '2024-06-30 23:59:59')` */
  whereBetweenTime(column: ColumnKey<T> | FieldPath, start: TimeInput, end: TimeInput): this {
    return this.pushFragment('and', (ctx) => {
      const field = this.fieldOf(column, ctx)
      return between(field, timeFor(field, toDate(start)), timeFor(field, toDate(end)))
    })
  }

  whereNotBetweenTime(column: ColumnKey<T> | FieldPath, start: TimeInput, end: TimeInput): this {
    return this.pushFragment('and', (ctx) => {
      const field = this.fieldOf(column, ctx)
      return notBetween(field, timeFor(field, toDate(start)), timeFor(field, toDate(end)))
    })
  }

  /** 某一天（默认今天）：`whereDay('createdAt')`、`whereDay('createdAt', 'yesterday')`、`whereDay('createdAt', '2024-05-01')` */
  whereDay(column: ColumnKey<T> | FieldPath, day: 'today' | 'yesterday' | TimeInput = 'today'): this {
    const [start, end] = day === 'today' || day === 'yesterday'
      ? keywordRange(day)
      : periodOf('day', day)
    return this.whereTimeRange(column, start, end)
  }

  /** 某一周（周一开始，默认本周）：`whereWeek('createdAt', 'last week')` */
  whereWeek(column: ColumnKey<T> | FieldPath, week: 'this week' | 'last week' | TimeInput = 'this week'): this {
    const [start, end] = week === 'this week' || week === 'last week'
      ? periodOf('week', undefined, week === 'last week'
          ? -1
          : 0)
      : periodOf('week', week)
    return this.whereTimeRange(column, start, end)
  }

  /** 某个月（默认本月）：`whereMonth('createdAt', '2024-05')`、`whereMonth('createdAt', 'last month')` */
  whereMonth(column: ColumnKey<T> | FieldPath, month: 'this month' | 'last month' | TimeInput = 'this month'): this {
    const [start, end] = month === 'this month' || month === 'last month'
      ? periodOf('month', undefined, month === 'last month'
          ? -1
          : 0)
      : periodOf('month', month)
    return this.whereTimeRange(column, start, end)
  }

  /** 某一年（默认今年）：`whereYear('createdAt', 2024)`、`whereYear('createdAt', 'last year')` */
  whereYear(column: ColumnKey<T> | FieldPath, year: 'this year' | 'last year' | number | TimeInput = 'this year'): this {
    const [start, end] = year === 'this year' || year === 'last year'
      ? periodOf('year', undefined, year === 'last year'
          ? -1
          : 0)
      : periodOf('year', typeof year === 'number' && year < 10000
          ? new Date(year, 0, 1)
          : year)
    return this.whereTimeRange(column, start, end)
  }

  /** 从某个时间开始的若干个周期：`whereTimeInterval('createdAt', '2024-05-01', 'day', 7)`（step 为负时向前） */
  whereTimeInterval(column: ColumnKey<T> | FieldPath, start: TimeInput, unit: TimeUnit = 'day', step = 1): this {
    const from = toDate(start)
    const to = addTime(from, unit, step)
    return step >= 0
      ? this.whereTimeRange(column, from, to)
      : this.whereTimeRange(column, to, from)
  }

  /**
   * 条件成立时才应用：`.when(keyword, q => q.whereLike('name', `%${keyword}%`))`，可传入不成立时的回调。
   * 跳过的“空值”是 undefined、null、false 与 ''（0 与空数组不跳过）；三态布尔等只需跳过 undefined / null 时用 whenDefined()
   */
  when<V>(value: V, callback: (query: this, value: NonNullable<V>) => unknown, otherwise?: (query: this) => unknown): this {
    if (value !== undefined && value !== null && value !== false && value !== '')
      callback(this, value as NonNullable<V>)
    else
      otherwise?.(this)
    return this
  }

  /** 只在值不是 undefined / null 时应用（false、0、'' 照常应用）：`.whenDefined(enabled, (q, value) => q.where('enabled', value))` */
  whenDefined<V>(value: V, callback: (query: this, value: NonNullable<V>) => unknown, otherwise?: (query: this) => unknown): this {
    if (value !== undefined && value !== null)
      callback(this, value as NonNullable<V>)
    else
      otherwise?.(this)
    return this
  }

  /** 当前条件组合成的 SQL（无条件时为 undefined） */
  buildWhere(ctx: BuildContext): SQL | undefined {
    let result: SQL | undefined
    for (const part of this.parts) {
      const condition = part.build(ctx)
      if (!condition)
        continue
      result = result === undefined
        ? condition
        : part.bool === 'and'
          ? and(result, condition)
          : or(result, condition)
    }
    return result
  }

  get hasConditions(): boolean {
    return this.parts.length > 0
  }

  /** 当前表的列名 → drizzle 列对象 */
  columnOf(key: string): Column {
    const column = getTableColumns(this.table)[key]
    if (!column)
      throw new Error(`Unknown column "${key}" on table "${getTableName(this.table)}"`)
    return column
  }

  /**
   * 字段 → 列或 SQL 表达式（支持 `posts.title` 与 JSON 路径 `meta->city`）。
   * JSON 路径返回 SQL，类型上标注为 Column 以便直接传给 drizzle 的条件函数
   */
  fieldOf(key: string, ctx: BuildContext): Column {
    const [path, ...json] = key.split('->')
    const dot = path.indexOf('.')
    let column: Column | undefined
    if (dot === -1) {
      column = this.columnOf(path)
    }
    else {
      const source = this.sources.get(path.slice(0, dot))
      const name = path.slice(dot + 1)
      column = source && getTableColumns(source)[name]
      if (!column)
        throw new Error(`Unknown column "${path}" (join the table first, or use a drizzle column)`)
    }
    return json.length
      ? jsonPath(column!, json, ctx.dialect) as unknown as Column
      : column!
  }

  /** 新的条件分组（共享 join 的表） */
  protected newGroup(): Conditions<T> {
    return new Conditions(this.table, this.sources)
  }

  // 不使用 #私有成员：clone() 通过原型复制实例，私有成员会失去品牌检查
  protected addCondition(bool: Part['bool'], args: unknown[]): this {
    // where(and(...)) 中 and() / or() 没有条件时返回 undefined：忽略
    if (args.length === 1 && args[0] === undefined)
      return this
    return this.pushFragment(bool, this.parseCondition(args))
  }

  protected pushCondition(bool: Part['bool'], condition: SQL): this {
    return this.pushFragment(bool, () => condition)
  }

  protected pushFragment(bool: Part['bool'], build: Fragment): this {
    this.parts.push({ bool, build })
    return this
  }

  protected whereTimeRange(column: string, start: Date, end: Date): this {
    return this.pushFragment('and', (ctx) => {
      const field = this.fieldOf(column, ctx)
      return and(gte(field, timeFor(field, start)), lt(field, timeFor(field, end)))
    })
  }

  protected parseCondition(args: unknown[]): Fragment {
    if (args.length === 1) {
      const [condition] = args
      if (typeof condition === 'function') {
        const group = this.newGroup()
        condition(group)
        return ctx => group.buildWhere(ctx)
      }
      if (is(condition, SQLClass))
        return () => condition as SQL
      if (Array.isArray(condition)) {
        const items = condition.map(item => this.parseCondition(item as unknown[]))
        return ctx => and(...items.map(item => item(ctx)))
      }
      if (isPlainObject(condition))
        return ctx => and(...Object.entries(condition).map(([key, value]) => this.compare(key, '=', value, ctx)))
      throw new TypeError('where() expects a column, an object, an array, a drizzle SQL expression or a callback')
    }
    if (args.length === 2)
      return ctx => this.compare(args[0] as string, '=', args[1], ctx)
    return ctx => this.compare(args[0] as string, args[1] as Operator, args[2], ctx)
  }

  protected compare(key: string, operator: Operator, value: unknown, ctx: BuildContext): SQL {
    const [field, target] = adaptJson(this.fieldOf(key, ctx), isSubquery(value)
      ? value.buildSubquery(ctx)
      : value)
    switch (operator) {
      case '=':
        if (target === null)
          return isNull(field)
        return Array.isArray(target)
          ? inArray(field, target)
          : eq(field, target)
      case '!=':
      case '<>':
        if (target === null)
          return isNotNull(field)
        return Array.isArray(target)
          ? notInArray(field, target)
          : ne(field, target)
      case '>': return gt(field, target)
      case '>=': return gte(field, target)
      case '<': return lt(field, target)
      case '<=': return lte(field, target)
      case 'like': return like(field, target as string)
      case 'not like': return notLike(field, target as string)
      case 'in': return inArray(field, target as unknown[])
      case 'not in': return notInArray(field, target as unknown[])
      case 'between': return between(field, (target as unknown[])[0], (target as unknown[])[1])
      case 'not between': return notBetween(field, (target as unknown[])[0], (target as unknown[])[1])
      default:
        throw new Error(`Unsupported operator "${String(operator)}"`)
    }
  }

  protected listOrSubquery(values: unknown, ctx: BuildContext): unknown {
    if (isSubquery(values))
      return values.buildSubquery(ctx)
    return values
  }

  protected subqueryOf(query: SubqueryLike | SQLWrapper, ctx: BuildContext): SQLWrapper {
    return isSubquery(query)
      ? query.buildSubquery(ctx)
      : query
  }
}

/** 标记 PostgreSQL 的 JSON 文本表达式（`#>>` 的结果总是 text） */
const jsonText = new WeakSet<SQL>()

/** PostgreSQL JSON 路径与数字 / 布尔比较时转换类型 */
function adaptJson(field: Column, value: unknown): [Column, unknown] {
  if (!is(field, SQLClass) || !jsonText.has(field as unknown as SQL))
    return [field, value]
  const sample = Array.isArray(value)
    ? value[0]
    : value
  if (typeof sample === 'number')
    return [sql`(${field})::numeric` as unknown as Column, value]
  if (typeof sample === 'boolean') {
    return [
      field,
      Array.isArray(value)
        ? value.map(String)
        : String(value),
    ]
  }
  return [field, value]
}

/** 原生 SQL 中的时间参数：按列的类型编码（列对象由 drizzle 编码，Date 直接作为参数） */
function bindTime(field: Column | SQL, time: Date): unknown {
  const value = timeFor(field, time)
  return is(field, SQLClass)
    ? value
    : sql.param(value, field as Column)
}

const segmentPattern = /^[\w$-]+$/

/** `meta->address->city` → 各方言的 JSON 取值表达式 */
function jsonPath(column: Column, segments: string[], dialect: Dialect): SQL {
  for (const segment of segments) {
    if (!segmentPattern.test(segment))
      throw new Error(`Invalid JSON path segment "${segment}"`)
  }
  if (dialect === 'postgres') {
    const text = sql`(${column} #>> ${sql.raw(`'{${segments.join(',')}}'`)})`
    jsonText.add(text)
    return text
  }
  const path = sql.raw(`'$.${segments.join('.')}'`)
  return dialect === 'mysql'
    ? sql`json_unquote(json_extract(${column}, ${path}))`
    : sql`json_extract(${column}, ${path})`
}

function jsonContains(field: Column | SQL, value: unknown, dialect: Dialect): SQL {
  switch (dialect) {
    case 'mysql': return sql`json_contains(${field}, ${JSON.stringify(value)})`
    case 'postgres': return sql`(${field})::jsonb @> ${JSON.stringify([value])}::jsonb`
    default: return sql`exists (select 1 from json_each(${field}) where json_each.value = ${value})`
  }
}

/** `'age > ? and status = ?'` + 参数 → SQL */
function rawCondition(condition: SQL | string, bindings: unknown[]): SQL {
  if (typeof condition !== 'string')
    return condition
  const pieces = condition.split('?')
  if (pieces.length - 1 !== bindings.length)
    throw new Error(`whereRaw(): ${pieces.length - 1} placeholder(s) but ${bindings.length} binding(s)`)
  const chunks: SQL[] = [
    sql.raw(pieces[0]),
  ]
  bindings.forEach((value, index) => chunks.push(sql`${value}`, sql.raw(pieces[index + 1])))
  return sql.join(chunks)
}
