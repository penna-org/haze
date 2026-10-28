import type { Model, ModelQuery } from '@hazejs/orm'
import type { SearchableModel } from './searchable'
import { ModelQuery as Query } from '@hazejs/orm'
import { useSearchManager } from './manager'
import { canRebuild, engineNameOf, findSearchable, indexFor, makeSearchable, registrationOf, searchableModels } from './searchable'

type ModelInput = SearchableModel | string

function resolveModel(input: ModelInput): SearchableModel {
  if (typeof input !== 'string')
    return input
  const model = findSearchable(input)
  if (!model) {
    const known = searchableModels().map(model => model.name).join(', ')
    throw new Error(`No searchable model named "${input}"${known
      ? ` (known: ${known})`
      : ' (no model has called searchable() yet)'}`)
  }
  return model
}

export interface ImportOptions {
  /** 每批读取的数量，默认 config/search.ts 的 chunk（500） */
  chunk?: number
  /** 每批写入后回调（命令行显示进度） */
  onProgress?: (imported: number) => void
}

/**
 * `haze search:import Post`：把模型的全部记录写入索引（已软删除、shouldBeSearchable 为 false 的跳过）。
 * database 引擎由数据库自己重建（MySQL / PostgreSQL 无需操作，SQLite 触发器模式执行 rebuild）。
 * 返回写入的记录数。
 */
export async function importSearchable(input: ModelInput, options: ImportOptions = {}): Promise<number> {
  const model = resolveModel(input)
  const manager = useSearchManager()
  const engine = manager.engine(engineNameOf(model, manager))
  if (canRebuild(engine) && await engine.rebuild(indexFor(model, manager)))
    return new Query(model).count()

  const { importQuery } = registrationOf(model).options
  const query = new Query(model) as ModelQuery<any>
  importQuery?.(query)
  let imported = 0
  await query.chunk(options.chunk ?? manager.config.chunk ?? 500, async (records) => {
    await makeSearchable(model, records as Array<Model<any>>)
    imported += records.length
    options.onProgress?.(imported)
  })
  await engine.settle?.()
  return imported
}

/** `haze search:flush Post`：清空模型的索引 */
export async function flushSearchable(input: ModelInput): Promise<void> {
  const model = resolveModel(input)
  const manager = useSearchManager()
  const engine = manager.engine(engineNameOf(model, manager))
  await engine.flush(indexFor(model, manager))
  await engine.settle?.()
}

export interface SyncedSettings {
  model: string
  index: string
  engine: string
}

/**
 * `haze search:sync-settings [Post]`：创建索引并同步设置（searchable / filterable / sortable）；
 * database 引擎创建全文索引（FULLTEXT / GIN / FTS5 虚拟表与触发器）。不传模型时同步全部已注册的模型。
 */
export async function syncSearchSettings(input?: ModelInput | ModelInput[]): Promise<SyncedSettings[]> {
  const models = input === undefined
    ? searchableModels()
    : ([] as ModelInput[]).concat(input).map(resolveModel)
  const manager = useSearchManager()
  const synced: SyncedSettings[] = []
  for (const model of models) {
    const engineName = engineNameOf(model, manager)
    const index = indexFor(model, manager)
    await manager.engine(engineName).syncSettings?.(index)
    synced.push({ model: model.name, index: index.name, engine: engineName })
  }
  return synced
}
