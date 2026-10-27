import type { InferInsertModel, InferSelectModel, Table } from 'drizzle-orm'

export type Row<T extends Table> = InferSelectModel<T>
export type Insert<T extends Table> = InferInsertModel<T>
/** 表的列名（drizzle 表定义中的属性名） */
export type ColumnKey<T extends Table> = keyof Row<T> & string

export type Operator = '=' | '!=' | '<>' | '>' | '>=' | '<' | '<=' | 'like' | 'not like' | 'in' | 'not in' | 'between' | 'not between'

export type Direction = 'asc' | 'desc'

/** 分页结果（普通对象，可直接作为响应返回） */
export interface Paginated<T> {
  data: T[]
  total: number
  page: number
  perPage: number
  lastPage: number
}

/** 不同驱动返回的 drizzle 实例类型不同，框架内部以统一接口调用 */
export type AnyDatabase = any
