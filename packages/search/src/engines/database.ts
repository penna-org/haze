import type { Dialect, ModelQuery } from '@hazejs/orm'
import type { Column, SQL } from 'drizzle-orm'
import type { DocumentKey, SearchDocument, SearchEngine, SearchIndex, SearchQuery, SearchResult } from '../engine'
import type { SearchableModel } from '../searchable'
import { Db, dialectOf, ModelQuery as Query, resolveSession, useDatabaseManager } from '@hazejs/orm'
import { getTableColumns, getTableName, sql } from 'drizzle-orm'
import { tokenize } from '../engine'

export type DatabaseSearchMode = 'fulltext' | 'like'

/** database 引擎的全局默认值（config/search.ts 的 engines.database） */
export interface DatabaseEngineConfig {
  /** 搜索方式：`fulltext`（默认，需要全文索引）或 `like`（任意数据库，无需索引，适合小表） */
  mode?: DatabaseSearchMode
  /** PostgreSQL 的文本搜索配置（regconfig），默认 `english` */
  language?: string
  /** MySQL 的 MATCH 模式：`natural`（默认）或 `boolean` */
  mysqlMode?: 'natural' | 'boolean'
}

/** 模型级的 database 引擎选项（searchable(Model, { database: {...} })） */
export interface DatabaseSearchOptions extends DatabaseEngineConfig {
  /** 参与搜索的字段（模型属性名），默认 settings.searchable，否则为表中的全部字符串列 */
  columns?: string[]
  /** PostgreSQL：已有的 tsvector 列（如生成列），设置后直接使用该列，不再计算表达式 */
  vectorColumn?: string
  /** 全文索引名，默认 `<表名>_search` */
  indexName?: string
  /** SQLite FTS5 */
  fts?: {
    /** 虚拟表名，默认 `<表名>_fts` */
    table?: string
    /**
     * - `triggers`（默认）：外部内容表（content=表），由触发器在增删改时同步，只能索引表中的列
     * - `engine`：独立的 FTS 表，由模型事件写入 toSearchable() 的字段（可索引计算字段）
     */
    sync?: 'triggers' | 'engine'
    /** 分词器，默认 `unicode61`；中文等无空格语言可用 `trigram` */
    tokenize?: string
  }
}

interface Resolved {
  model: SearchableModel
  table: SearchableModel['table']
  tableName: string
  columns: Record<string, Column>
  primaryKey: string
  /** 搜索字段（模型属性名） */
  fields: string[]
  options: DatabaseSearchOptions
}

const LANGUAGE_RE = /^\w+$/

function resolve(index: SearchIndex, defaults: DatabaseEngineConfig): Resolved {
  const model = index.model
  if (!model)
    throw new Error(`Search index "${index.name}": the database engine needs the model (it cannot run from a queued job)`)
  const columns = getTableColumns(model.table)
  const primaryKey = model.primaryKeyName()
  if (!primaryKey)
    throw new Error(`${model.name}: the database search engine needs a single-column primary key`)
  const options: DatabaseSearchOptions = {
    ...defaults,
    ...index.database,
  }
  const fields = options.columns
    ?? index.settings.searchable
    ?? Object.entries(columns).filter(([key, column]) => column.dataType === 'string' && key !== primaryKey).map(([key]) => key)
  if (!fields.length)
    throw new Error(`${model.name}: no searchable columns (set settings.searchable or database.columns)`)
  // triggers 模式与 MySQL / PostgreSQL 直接搜索表中的列；engine 模式的 FTS 表可以有计算字段
  if (options.fts?.sync !== 'engine') {
    for (const field of fields) {
      if (!(field in columns))
        throw new Error(`${model.name}: searchable column "${field}" does not exist on table "${getTableName(model.table)}"`)
    }
  }
  return {
    model,
    table: model.table,
    tableName: getTableName(model.table),
    columns,
    primaryKey,
    fields,
    options,
  }
}

const ftsTableOf = (r: Resolved): string => r.options.fts?.table ?? `${r.tableName}_fts`
const indexNameOf = (r: Resolved): string => r.options.indexName ?? `${r.tableName}_search`

function languageOf(r: Resolved): string {
  const language = r.options.language ?? 'english'
  if (!LANGUAGE_RE.test(language))
    throw new Error(`Invalid PostgreSQL text search configuration "${language}"`)
  return language
}

/** PostgreSQL 的 tsvector 表达式：查询与表达式索引必须完全一致才能使用索引 */
function pgVector(r: Resolved): SQL {
  if (r.options.vectorColumn)
    return sql`${r.columns[r.options.vectorColumn]}`
  const parts = r.fields.map(field => sql`coalesce(${r.columns[field]}, '')`)
  return sql`to_tsvector(${sql.raw(`'${languageOf(r)}'::regconfig`)}, ${sql.join(parts, sql` || ' ' || `)})`
}

/** FTS5 查询：每个词加引号（避免语法错误），最后一个词前缀匹配（trigram 分词器本身就是子串匹配） */
function ftsQuery(text: string, raw: boolean, prefix: boolean): string {
  if (raw)
    return text
  const terms = tokenize(text)
  return terms.map((term, index) => `"${term.replace(/"/g, '""')}"${prefix && index === terms.length - 1
    ? '*'
    : ''}`).join(' ')
}

const escapeLike = (value: string): string => value.replace(/[!%_]/g, char => `!${char}`)

interface Condition {
  where: SQL
  /** 按相关度排序（未指定 orderBy 时使用） */
  rank?: SQL
}

function condition(r: Resolved, dialect: Dialect, mode: DatabaseSearchMode, text: string, options: Record<string, unknown>): Condition | undefined {
  if (mode === 'like') {
    const terms = text.split(/\s+/).filter(Boolean)
    if (!terms.length)
      return undefined
    const operator = sql.raw(dialect === 'postgres'
      ? 'ilike'
      : 'like')
    return {
      where: sql.join(terms.map(term => sql`(${sql.join(r.fields.map(field => sql`${r.columns[field]} ${operator} ${`%${escapeLike(term)}%`} escape '!'`), sql` or `)})`), sql` and `),
    }
  }
  switch (dialect) {
    case 'mysql': {
      const match = sql`match(${sql.join(r.fields.map(field => r.columns[field]), sql`, `)}) against(${text} ${sql.raw((options.mysqlMode ?? r.options.mysqlMode) === 'boolean'
        ? 'in boolean mode'
        : 'in natural language mode')})`
      return { where: match, rank: sql`${match} desc` }
    }
    case 'postgres': {
      const vector = pgVector(r)
      const query = sql`websearch_to_tsquery(${sql.raw(`'${languageOf(r)}'::regconfig`)}, ${text})`
      return { where: sql`${vector} @@ ${query}`, rank: sql`ts_rank(${vector}, ${query}) desc` }
    }
    case 'sqlite': {
      const match = ftsQuery(text, options.raw === true, !(r.options.fts?.tokenize ?? '').startsWith('trigram'))
      if (!match)
        return undefined
      const fts = sql.identifier(ftsTableOf(r))
      const key = r.columns[r.primaryKey]
      return {
        where: sql`${key} in (select rowid from ${fts} where ${fts} match ${match})`,
        // bm25 越小越相关
        rank: sql`(select bm25(${fts}) from ${fts} where ${fts}.rowid = ${key} and ${fts} match ${match}) asc`,
      }
    }
    default:
      throw new Error(`The database search engine does not support ${dialect}`)
  }
}

async function dialectOfModel(model: SearchableModel): Promise<Dialect> {
  return (await resolveSession(model.connection)).dialect
}

function quote(dialect: Dialect, name: string): string {
  return dialect === 'mysql'
    ? `\`${name.replace(/`/g, '``')}\``
    : `"${name.replace(/"/g, '""')}"`
}

/**
 * 全文索引的 DDL（`haze search:sync-settings` 执行，也可复制到自定义迁移中）：
 * - MySQL：FULLTEXT 索引
 * - PostgreSQL：tsvector 表达式（或 vectorColumn）上的 GIN 索引
 * - SQLite：FTS5 虚拟表；triggers 模式另有 3 个同步触发器与一次 rebuild
 *
 * like 模式不需要索引，返回空数组。
 */
export function databaseIndexStatements(index: SearchIndex, dialect: Dialect, defaults: DatabaseEngineConfig = {}): string[] {
  const r = resolve(index, defaults)
  if (r.options.mode === 'like')
    return []
  const q = (name: string): string => quote(dialect, name)
  const db = (field: string): string => r.columns[field]!.name
  switch (dialect) {
    case 'mysql':
      return [`alter table ${q(r.tableName)} add fulltext index ${q(indexNameOf(r))} (${r.fields.map(field => q(db(field))).join(', ')})`]
    case 'postgres': {
      const expression = r.options.vectorColumn
        ? q(db(r.options.vectorColumn))
        : `to_tsvector('${languageOf(r)}'::regconfig, ${r.fields.map(field => `coalesce(${q(db(field))}, '')`).join(` || ' ' || `)})`
      return [`create index if not exists ${q(indexNameOf(r))} on ${q(r.tableName)} using gin (${expression})`]
    }
    case 'sqlite': {
      const fts = ftsTableOf(r)
      const tokenizer = (r.options.fts?.tokenize ?? 'unicode61').replace(/'/g, '\'\'')
      if (r.options.fts?.sync === 'engine')
        return [`create virtual table if not exists ${q(fts)} using fts5(${r.fields.map(q).join(', ')}, tokenize='${tokenizer}')`]
      const cols = r.fields.map(field => q(db(field)))
      const key = q(db(r.primaryKey))
      const values = (prefix: string): string => cols.map(col => `${prefix}.${col}`).join(', ')
      const content = r.tableName.replace(/'/g, '\'\'')
      const rowid = db(r.primaryKey).replace(/'/g, '\'\'')
      return [
        `create virtual table if not exists ${q(fts)} using fts5(${cols.join(', ')}, content='${content}', content_rowid='${rowid}', tokenize='${tokenizer}')`,
        `create trigger if not exists ${q(`${fts}_ai`)} after insert on ${q(r.tableName)} begin insert into ${q(fts)}(rowid, ${cols.join(', ')}) values (new.${key}, ${values('new')}); end`,
        `create trigger if not exists ${q(`${fts}_ad`)} after delete on ${q(r.tableName)} begin insert into ${q(fts)}(${q(fts)}, rowid, ${cols.join(', ')}) values ('delete', old.${key}, ${values('old')}); end`,
        `create trigger if not exists ${q(`${fts}_au`)} after update on ${q(r.tableName)} begin insert into ${q(fts)}(${q(fts)}, rowid, ${cols.join(', ')}) values ('delete', old.${key}, ${values('old')}); insert into ${q(fts)}(rowid, ${cols.join(', ')}) values (new.${key}, ${values('new')}); end`,
        `insert into ${q(fts)}(${q(fts)}) values ('rebuild')`,
      ]
    }
    default:
      throw new Error(`The database search engine does not support ${dialect}`)
  }
}

/** 删除全文索引的 DDL（迁移的 down） */
export function dropDatabaseIndexStatements(index: SearchIndex, dialect: Dialect, defaults: DatabaseEngineConfig = {}): string[] {
  const r = resolve(index, defaults)
  if (r.options.mode === 'like')
    return []
  const q = (name: string): string => quote(dialect, name)
  switch (dialect) {
    case 'mysql':
      return [`alter table ${q(r.tableName)} drop index ${q(indexNameOf(r))}`]
    case 'postgres':
      return [`drop index if exists ${q(indexNameOf(r))}`]
    case 'sqlite': {
      const fts = ftsTableOf(r)
      return [
        ...['ai', 'ad', 'au'].map(suffix => `drop trigger if exists ${q(`${fts}_${suffix}`)}`),
        `drop table if exists ${q(fts)}`,
      ]
    }
    default:
      return []
  }
}

/**
 * database 引擎：直接在模型的表上搜索，结果就是模型（自动应用软删除、全局作用域与租户隔离）。
 * MySQL 用 `MATCH … AGAINST`，PostgreSQL 用 `to_tsvector @@ websearch_to_tsquery`，SQLite 用 FTS5，
 * 或用 `mode: 'like'` 退化为 LIKE。
 */
export class DatabaseEngine implements SearchEngine {
  readonly driver = 'database'

  constructor(readonly config: DatabaseEngineConfig = {}) {}

  async search(index: SearchIndex, query: SearchQuery): Promise<SearchResult> {
    const r = resolve(index, this.config)
    const dialect = await dialectOfModel(r.model)
    const builder = new Query(r.model) as ModelQuery<any>
    const text = query.query.trim()
    const mode = (query.options.mode as DatabaseSearchMode | undefined) ?? r.options.mode ?? 'fulltext'
    const matched = text
      ? condition(r, dialect, mode, text, query.options)
      : undefined
    if (matched)
      builder.where(matched.where as never)
    for (const filter of query.filters) {
      if (filter.type === 'eq')
        builder.where(filter.field as never, filter.value as never)
      else if (filter.type === 'in')
        builder.whereIn(filter.field as never, filter.values as never)
      else
        builder.whereNotIn(filter.field as never, filter.values as never)
    }
    for (const { field, direction } of query.sort)
      builder.order(field as never, direction)
    if (!query.sort.length && matched?.rank)
      builder.order(matched.rank)
    ;(query.options.modelQuery as ((query: ModelQuery<any>) => unknown) | undefined)?.(builder)

    let models: Array<{ getKey: () => unknown }>
    let total: number
    if (query.withTotal) {
      const page = await builder.paginate(query.page, query.perPage)
      models = page.data
      total = page.total
    }
    else {
      models = await builder.page(query.page, query.perPage).select()
      total = models.length
    }
    return {
      hits: models.map(model => ({
        key: model.getKey() as DocumentKey,
      })),
      total,
      raw: models,
      models,
    }
  }

  async update(index: SearchIndex, documents: SearchDocument[]): Promise<void> {
    const r = this.#engineSynced(index)
    if (!r || !documents.length)
      return
    const db = Db.connection(r.model.connection ?? useDatabaseManager().defaultConnection)
    const fts = sql.identifier(ftsTableOf(r))
    await db.execute(sql`delete from ${fts} where rowid in (${sql.join(documents.map(document => sql`${document.key}`), sql`, `)})`)
    for (const document of documents) {
      const values = r.fields.map(field => sql`${textValue(document.data[field])}`)
      await db.execute(sql`insert into ${fts}(rowid, ${sql.join(r.fields.map(field => sql.identifier(field)), sql`, `)}) values (${document.key}, ${sql.join(values, sql`, `)})`)
    }
  }

  async delete(index: SearchIndex, keys: DocumentKey[]): Promise<void> {
    const r = this.#engineSynced(index)
    if (!r || !keys.length)
      return
    await Db.connection(r.model.connection ?? useDatabaseManager().defaultConnection)
      .execute(sql`delete from ${sql.identifier(ftsTableOf(r))} where rowid in (${sql.join(keys.map(key => sql`${key}`), sql`, `)})`)
  }

  async flush(index: SearchIndex): Promise<void> {
    const r = resolve(index, this.config)
    if (r.options.mode === 'like' || await dialectOfModel(r.model) !== 'sqlite')
      return
    const db = Db.connection(r.model.connection ?? useDatabaseManager().defaultConnection)
    const fts = sql.identifier(ftsTableOf(r))
    if (r.options.fts?.sync === 'engine')
      await db.execute(sql`delete from ${fts}`)
    else
      await db.execute(sql`insert into ${fts}(${fts}) values ('delete-all')`)
  }

  /** 创建全文索引（已存在时跳过） */
  async syncSettings(index: SearchIndex): Promise<void> {
    const r = resolve(index, this.config)
    const dialect = await dialectOfModel(r.model)
    const db = Db.connection(r.model.connection ?? useDatabaseManager().defaultConnection)
    if (dialect === 'mysql' && r.options.mode !== 'like') {
      const [existing] = await db.execute<{ count: number }>(sql`select count(*) as count from information_schema.statistics where table_schema = database() and table_name = ${r.tableName} and index_name = ${indexNameOf(r)}`)
      if (Number(existing?.count) > 0)
        return
    }
    for (const statement of databaseIndexStatements(index, dialect, this.config))
      await db.execute(sql.raw(statement))
  }

  /**
   * 由数据库自己重建索引：MySQL / PostgreSQL 的索引始终同步、SQLite 触发器模式执行 rebuild，返回 true；
   * SQLite engine 模式需要逐条写入文档，返回 false。
   */
  async rebuild(index: SearchIndex): Promise<boolean> {
    const r = resolve(index, this.config)
    if (r.options.mode === 'like')
      return true
    const dialect = await dialectOfModel(r.model)
    if (dialect !== 'sqlite')
      return true
    if (r.options.fts?.sync === 'engine')
      return false
    const fts = sql.identifier(ftsTableOf(r))
    await Db.connection(r.model.connection ?? useDatabaseManager().defaultConnection).execute(sql`insert into ${fts}(${fts}) values ('rebuild')`)
    return true
  }

  /** 只有 SQLite engine 模式需要由模型事件写入 */
  #engineSynced(index: SearchIndex): Resolved | undefined {
    if (index.database?.fts?.sync !== 'engine' || !index.model)
      return undefined
    const r = resolve(index, this.config)
    const driver = useDatabaseManager().connectionConfig(useDatabaseManager().resolveName(r.model.connection)).driver
    return dialectOf(driver) === 'sqlite' && r.options.mode !== 'like'
      ? r
      : undefined
  }
}

function textValue(value: unknown): string | null {
  if (value === undefined || value === null)
    return null
  if (Array.isArray(value))
    return value.map(item => textValue(item) ?? '').join(' ')
  return typeof value === 'object'
    ? JSON.stringify(value)
    : String(value)
}

export function databaseEngine(config: DatabaseEngineConfig = {}): DatabaseEngine {
  return new DatabaseEngine(config)
}
