import type { ConfigInput, ServiceProvider } from '@hazejs/core'
import type { DatabaseConfig } from './config'
import { Logger } from '@hazejs/core'
import { DatabaseManager } from './connection'
import { setDatabaseManager } from './context'

export interface DatabaseProviderOptions {
  /** 默认读取 config/database.ts */
  config?: ConfigInput<DatabaseConfig>
}

/**
 * 数据库服务提供者（放在 app/provider/DatabaseProvider.ts）：
 *
 * ```ts
 * export default databaseProvider()
 * ```
 *
 * 注册 DatabaseManager（可 inject），并让 Db / Model 使用该配置。连接在首次查询时建立，
 * 开发时跨热更新复用，应用关闭时释放。
 */
export function databaseProvider(options: DatabaseProviderOptions = {}): ServiceProvider {
  return {
    register(container, app) {
      const input = options.config ?? app.config.get<ConfigInput<DatabaseConfig> | undefined>('database', undefined)
      if (!input)
        throw new Error('databaseProvider(): config/database.ts is missing')
      const config = typeof input === 'function'
        ? input()
        : input
      const manager = new DatabaseManager(config, {
        logger: container.make(Logger),
        rootDir: app.rootDir,
      })
      container.instance(DatabaseManager, manager)
      setDatabaseManager(manager)
    },
  }
}
