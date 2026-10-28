import type { Dialect } from '@hazejs/orm'
import type { DatabaseEngineConfig } from './engines/database'
import type { SearchableModel } from './searchable'
import { dialectOf, useDatabaseManager } from '@hazejs/orm'
import { DatabaseEngine, databaseIndexStatements, dropDatabaseIndexStatements } from './engines/database'
import { useSearchManager } from './manager'
import { indexFor } from './searchable'

function defaults(): DatabaseEngineConfig {
  const config = useSearchManager().config.engines.database
  return (config && (config.driver ?? 'database') === 'database'
    ? config
    : {}) as DatabaseEngineConfig
}

function dialectFor(model: SearchableModel): Dialect {
  const databases = useDatabaseManager()
  return dialectOf(databases.connectionConfig(databases.resolveName(model.connection)).driver)
}

/**
 * 模型的全文索引 DDL（database 引擎），可复制到自定义迁移（`drizzle-kit generate --custom`）中：
 *
 * ```ts
 * console.log(searchIndexSql(Post).join(';\n'))
 * ```
 *
 * dialect 缺省时按模型连接的驱动推断。
 */
export function searchIndexSql(model: SearchableModel, dialect: Dialect = dialectFor(model)): string[] {
  return databaseIndexStatements(indexFor(model), dialect, defaults())
}

/** 删除全文索引的 DDL（迁移的 down） */
export function dropSearchIndexSql(model: SearchableModel, dialect: Dialect = dialectFor(model)): string[] {
  return dropDatabaseIndexStatements(indexFor(model), dialect, defaults())
}

/** 在模型的连接上创建全文索引（已存在时跳过），与 database 引擎的 `search:sync-settings` 相同 */
export async function createSearchIndex(model: SearchableModel): Promise<void> {
  await new DatabaseEngine(defaults()).syncSettings(indexFor(model))
}
