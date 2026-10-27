import type { DatabaseManager } from './connection'
import { existsSync } from 'node:fs'
import { useDatabaseManager } from './context'

export interface MigrateOptions {
  /** 连接名，默认 default 连接 */
  connection?: string
  /** 迁移目录（drizzle-kit generate 的输出目录） */
  folder: string
  manager?: DatabaseManager
}

/** 执行 drizzle-kit 生成的迁移（已执行过的会跳过） */
export async function migrate(options: MigrateOptions): Promise<void> {
  if (!existsSync(options.folder))
    throw new Error(`Migrations folder not found: ${options.folder}. Run think-h3 db:generate first.`)
  const manager = options.manager ?? useDatabaseManager()
  const connection = await manager.connection(options.connection)
  const config = { migrationsFolder: options.folder }
  switch (connection.driver) {
    case 'sqlite':
      return (await import('drizzle-orm/libsql/migrator')).migrate(connection.db, config)
    case 'postgres':
      return (await import('drizzle-orm/postgres-js/migrator')).migrate(connection.db, config)
    case 'pglite':
      return (await import('drizzle-orm/pglite/migrator')).migrate(connection.db, config)
    case 'mysql':
      return (await import('drizzle-orm/mysql2/migrator')).migrate(connection.db, config)
  }
}
