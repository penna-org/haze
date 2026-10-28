import type { Model, ModelClass, ModelQuery } from '@hazejs/orm'
import type { SearchQueueConfig } from './config'
import type { DocumentKey, IndexSettings, SearchDocument, SearchEngine, SearchIndex } from './engine'
import type { DatabaseSearchOptions } from './engines/database'
import type { SearchManager } from './manager'
import { AsyncLocalStorage } from 'node:async_hooks'
import { currentTenancy, defineJob, Queue } from '@hazejs/core'
import { observeModel, useDatabaseManager } from '@hazejs/orm'
import { getTableColumns, getTableName } from 'drizzle-orm'
import { SearchBuilder } from './builder'
import { useSearchManager } from './manager'

/** 可搜索的模型类 */
export type SearchableModel<M extends Model<any> = Model<any>> = ModelClass<M> & {
  primaryKeyName: () => string | undefined
}

export interface SearchableOptions<M> {
  /** 索引名，默认表名 */
  index?: string
  /** 使用的引擎（config/search.ts 的 engines 键），默认 default */
  engine?: string
  /**
   * 写入索引的文档，默认 `model.toJSON()`（遵循 hidden / append）；可返回 Promise（加载关联）。
   * 主键字段会自动加入。
   */
  toSearchable?: (model: M) => Record<string, unknown> | Promise<Record<string, unknown>>
  /** 返回 false 的模型不进入索引（已在索引中的会被删除），如只索引已发布的文章 */
  shouldBeSearchable?: (model: M) => boolean | Promise<boolean>
  /** 索引设置：searchable / filterable / sortable 与各引擎的专有设置 */
  settings?: IndexSettings
  /** 通过队列同步（覆盖 config/search.ts 的 queue）；database 引擎始终同步执行 */
  queue?: boolean | SearchQueueConfig
  /** `search:import` 时调整查询（如预加载 toSearchable 用到的关联） */
  importQuery?: (query: ModelQuery<M & { readonly '~table': any }>) => unknown
  /** database 引擎的选项（搜索列、模式、PostgreSQL 语言、SQLite FTS5 表等） */
  database?: DatabaseSearchOptions
}

interface Registration {
  model: SearchableModel
  options: SearchableOptions<any>
  unobserve: () => void
}

const registrations = new Map<SearchableModel, Registration>()
/** 按类名 / 索引名查找（命令行使用）；热更新后同名的新类覆盖旧类 */
const byName = new Map<string, Registration>()

/** 关闭模型事件触发的索引同步（withoutSyncing 内） */
const paused = new AsyncLocalStorage<boolean>()

/**
 * 在回调内修改模型时不同步索引（批量导入、修复数据后统一 `search:import`）：
 *
 * ```ts
 * await withoutSyncing(() => Post.update({ status: 'draft' }, { userId: 1 }))
 * ```
 */
export function withoutSyncing<R>(fn: () => R): R {
  return paused.run(true, fn)
}

/** 模型的注册信息（未注册时抛错） */
export function registrationOf(model: SearchableModel): Registration {
  const registration = registrations.get(model)
  if (!registration)
    throw new Error(`${model.name} is not searchable: call searchable(${model.name}, {...}) first`)
  return registration
}

/** 已注册的可搜索模型 */
export function searchableModels(): SearchableModel[] {
  return [
    ...new Set([
      ...byName.values(),
    ].map(registration => registration.model)),
  ]
}

/** 按类名或索引名查找可搜索的模型 */
export function findSearchable(name: string): SearchableModel | undefined {
  return byName.get(name)?.model
}

/** 租户隔离的列（belongsToTenant） */
function tenantColumnOf(model: SearchableModel): string | undefined {
  const value = (model as { belongsToTenant?: boolean | string }).belongsToTenant
  return value
    ? value === true
      ? 'tenantId'
      : value
    : undefined
}

/**
 * 每租户独立数据库时，不同租户的主键会重复：索引名加上租户前缀。
 * 单库 + tenant_id 列的模型共用索引，查询时按租户过滤。
 */
function tenantIndexPrefix(model: SearchableModel): string {
  const scope = currentTenancy()
  if (!scope)
    return ''
  try {
    const databases = useDatabaseManager()
    const name = model.connection ?? databases.defaultConnection
    return databases.resolveName(name) === name
      ? ''
      : `${scope.key}_`
  }
  catch {
    return ''
  }
}

/** 模型当前上下文中的索引 */
export function indexFor(model: SearchableModel, manager: SearchManager = useSearchManager(), name?: string): SearchIndex {
  const { options } = registrationOf(model)
  const settings = { ...options.settings }
  const tenantColumn = tenantColumnOf(model)
  // 外部引擎需要按租户列过滤：自动加入 filterable
  if (tenantColumn && settings.filterable && !settings.filterable.includes(tenantColumn))
    settings.filterable = [...settings.filterable, tenantColumn]
  return {
    name: `${manager.config.prefix ?? ''}${tenantIndexPrefix(model)}${name ?? options.index ?? getTableName(model.table)}`,
    key: keyOf(model),
    settings,
    model,
    database: options.database,
  }
}

function keyOf(model: SearchableModel): string {
  const key = model.primaryKeyName()
  if (!key)
    throw new Error(`${model.name}: searchable models need a single-column primary key`)
  return key
}

/** 模型使用的引擎名 */
export function engineNameOf(model: SearchableModel, manager: SearchManager = useSearchManager()): string {
  return registrationOf(model).options.engine ?? manager.defaultEngine
}

/** 引擎返回的主键还原为列的类型（Typesense / Elasticsearch 的 id 为字符串） */
export function normalizeKey(model: SearchableModel, key: DocumentKey): DocumentKey {
  const column = getTableColumns(model.table)[keyOf(model)]
  if (column?.dataType === 'number' && typeof key === 'string' && key.trim() !== '' && !Number.isNaN(Number(key)))
    return Number(key)
  return key
}

/** 生成模型的索引文档 */
export async function documentOf(model: SearchableModel, record: Model<any>): Promise<SearchDocument> {
  const { options } = registrationOf(model)
  const data = options.toSearchable
    ? {
        ...await options.toSearchable(record),
      }
    : record.toJSON()
  const tenantColumn = tenantColumnOf(model)
  if (tenantColumn && !(tenantColumn in data))
    data[tenantColumn] = record.getRaw(tenantColumn)
  const key = record.getKey() as DocumentKey
  data[keyOf(model)] = key
  return { key, data }
}

/** 是否应该在索引中：未删除且 shouldBeSearchable 不为 false */
export async function shouldIndex(model: SearchableModel, record: Model<any>): Promise<boolean> {
  if (record.trashed())
    return false
  const { shouldBeSearchable } = registrationOf(model).options
  return shouldBeSearchable
    ? await shouldBeSearchable(record) !== false
    : true
}

/** 队列中传递的同步任务（索引描述与文档已在投递时计算好，worker 无需加载模型） */
interface SyncPayload {
  engine: string
  index: Omit<SearchIndex, 'model' | 'database'>
  documents?: SearchDocument[]
  keys?: DocumentKey[]
}

/** 内置任务 `search:sync`：searchProvider() 注册 */
export const searchSyncJob = defineJob<SyncPayload>({
  name: 'search:sync',
  tries: 3,
  backoff: [5, 30],
  async handle(payload) {
    const engine = useSearchManager().engine(payload.engine)
    if (payload.documents)
      await engine.update(payload.index, payload.documents)
    if (payload.keys)
      await engine.delete(payload.index, payload.keys)
  },
})

/** 写入 / 删除索引：配置了队列时投递任务，否则直接调用引擎 */
async function sync(model: SearchableModel, documents: SearchDocument[], keys: DocumentKey[]): Promise<void> {
  const manager = useSearchManager()
  const engineName = engineNameOf(model, manager)
  const engine = manager.engine(engineName)
  const index = indexFor(model, manager)
  const queue = registrationOf(model).options.queue ?? manager.config.queue
  if (queue && !manager.faked && engine.driver !== 'database') {
    const options = typeof queue === 'object'
      ? queue
      : {}
    const queues = Queue.manager()
    if (!queues.jobs().has('search:sync'))
      queues.register(searchSyncJob)
    await Queue.dispatch(searchSyncJob, {
      engine: engineName,
      index: { name: index.name, key: index.key, settings: index.settings },
      ...(documents.length && { documents }),
      ...(keys.length && { keys }),
    }, options)
    return
  }
  if (documents.length)
    await engine.update(index, documents)
  if (keys.length)
    await engine.delete(index, keys)
}

/** 把模型写入索引（不满足 shouldBeSearchable 或已软删除的从索引删除） */
export async function makeSearchable(model: SearchableModel, records: Array<Model<any>>): Promise<void> {
  const documents: SearchDocument[] = []
  const keys: DocumentKey[] = []
  for (const record of records) {
    if (await shouldIndex(model, record))
      documents.push(await documentOf(model, record))
    else
      keys.push(record.getKey() as DocumentKey)
  }
  await sync(model, documents, keys)
}

/** 从索引删除 */
export async function unsearchable(model: SearchableModel, records: Array<Model<any>>): Promise<void> {
  await sync(model, [], records.map(record => record.getKey() as DocumentKey))
}

export type SearchableClass<C extends SearchableModel> = C & {
  /** 全文搜索：`Post.search('haze').where('status', 'published').paginate(1, 20)` */
  search: (query?: string) => SearchBuilder<InstanceType<C>>
}

/**
 * 让模型可搜索：模型新增 / 修改 / 删除 / 恢复后自动同步索引，并获得 `Model.search()`：
 *
 * ```ts
 * export class Post extends Model.define(posts) {}
 *
 * searchable(Post, {
 *   index: 'posts',
 *   toSearchable: post => ({ id: post.id, title: post.title, body: post.body, status: post.status }),
 *   settings: { searchable: ['title', 'body'], filterable: ['status'] },
 * })
 *
 * await search(Post, 'haze').where('status', 'published').paginate(1, 20)
 * ```
 *
 * 返回值是同一个类（带 `search` 的类型），也可以写成 `export const Post = searchable(class Post extends ..., {...})`。
 */
export function searchable<C extends SearchableModel>(model: C, options: SearchableOptions<InstanceType<C>> = {}): SearchableClass<C> {
  registrations.get(model)?.unobserve()
  const unobserve = observeModel(model as unknown as abstract new () => Model<any>, async (record, event) => {
    if (paused.getStore())
      return
    switch (event) {
      case 'onAfterWrite':
      case 'onAfterRestore':
        await makeSearchable(model, [record])
        break
      case 'onAfterDelete':
        await unsearchable(model, [record])
        break
    }
  })
  const registration: Registration = { model, options, unobserve }
  registrations.set(model, registration)
  byName.set(model.name, registration)
  byName.set(options.index ?? getTableName(model.table), registration)
  Object.defineProperty(model, 'search', {
    value: (query = '') => new SearchBuilder(model, query),
    configurable: true,
    writable: true,
  })
  return model as SearchableClass<C>
}

/** 全文搜索：`search(Post, 'haze').where('status', 'published').get()` */
export function search<C extends SearchableModel>(model: C, query = ''): SearchBuilder<InstanceType<C>> {
  registrationOf(model)
  return new SearchBuilder(model, query)
}

/** 引擎是否能由数据源自己重建索引（database 引擎） */
export function canRebuild(engine: SearchEngine): engine is SearchEngine & { rebuild: (index: SearchIndex) => Promise<boolean> } {
  return typeof (engine as { rebuild?: unknown }).rebuild === 'function'
}
