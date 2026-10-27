import { resolve } from 'node:path'
import process from 'node:process'
import { useDatabaseManager } from './context'
import { migrate } from './migrate'

export interface RefreshDatabaseOptions {
  /** 迁移目录，默认 `<cwd>/database/migrations`（全栈项目为 `server/database/migrations`） */
  migrations?: string
  connection?: string
}

/**
 * 测试用：重建连接并执行迁移。配合 `.env.test` 中的 `DATABASE_URL=:memory:`，每个用例得到全新的数据库。
 *
 * ```ts
 * const t = useTestApp()
 * beforeEach(() => refreshDatabase())
 * ```
 */
export async function refreshDatabase(options: RefreshDatabaseOptions = {}): Promise<void> {
  const manager = useDatabaseManager()
  const name = options.connection ?? manager.defaultConnection
  if (manager.connectionConfig(name).driver === 'mongodb') {
    // MongoDB 无迁移：清空数据库
    await (await manager.connection(name)).db.dropDatabase()
    return
  }
  await manager.close(name)
  await migrate({
    manager,
    connection: options.connection,
    folder: resolve(process.cwd(), options.migrations ?? 'database/migrations'),
  })
}
