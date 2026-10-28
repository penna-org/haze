import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import process from 'node:process'
import { useDatabaseManager } from './context'
import { migrate, migrationsTableOf, modulesOf } from './migrate'

export interface RefreshDatabaseOptions {
  /**
   * 项目的迁移目录（相对 cwd），默认为应用 srcDir 下的 database/migrations（全栈项目即 server/database/migrations）。
   * 已执行模块迁移且该目录不存在时跳过（例如模块包测试中的宿主应用）
   */
  migrations?: string
  connection?: string
  /** 同时执行已启用模块的迁移（在项目的迁移之前），默认 true */
  modules?: boolean
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
  // 模块的迁移按启用顺序先执行（相对目录以应用的 srcDir 为基准），没有迁移的模块跳过
  const srcDir = manager.srcDir ?? process.cwd()
  let ranModules = false
  for (const module of modulesOf(name, manager, options.modules === false
    ? false
    : undefined)) {
    const folder = isAbsolute(module.folder)
      ? module.folder
      : resolve(srcDir, module.folder)
    if (!existsSync(join(folder, 'meta', '_journal.json')))
      continue
    await migrate({
      manager,
      connection: name,
      folder,
      table: migrationsTableOf(module.module),
    })
    ranModules = true
  }
  const folder = options.migrations
    ? resolve(process.cwd(), options.migrations)
    : resolve(srcDir, 'database/migrations')
  if (ranModules && !existsSync(join(folder, 'meta', '_journal.json')))
    return
  await migrate({
    manager,
    connection: options.connection,
    folder,
  })
}
