import type { ConfigInput, ServiceProvider } from '@hazejs/core'
import type { DatabaseConfig } from './config'
import { createToken, Logger, registerQueueDriver } from '@hazejs/core'
import { DatabaseManager } from './connection'
import { bindDatabaseManager, currentDatabaseManager, setDatabaseManager } from './context'
import { databaseQueue } from './queue'
import { configureSnowflake } from './snowflake'

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
 * 注册 DatabaseManager（可 inject），并让 Db / Model 使用该配置；同时注册数据库队列驱动（`driver: 'database'`）。连接在首次查询时建立，
 * 开发时跨热更新复用，应用关闭时释放。
 */
/** 应用关闭时恢复之前的 DatabaseManager（由根容器在最后释放，晚于队列与邮件的关闭） */
const kRestoreManager = createToken<AsyncDisposable>('orm:restore-manager')

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
        srcDir: app.srcDir,
        // 模块的迁移在项目的迁移之前执行（db:migrate、refreshDatabase、生产迁移入口）
        modules: app.modules().filter(module => module.migrations).map(module => ({
          module: module.name,
          folder: module.migrations!,
          connection: module.connection,
        })),
      })
      container.instance(DatabaseManager, manager)
      // 同一进程中先后启动多个应用（测试）：这个应用关闭后，请求之外的 Db / Model 回到之前的应用
      const previous = currentDatabaseManager()
      setDatabaseManager(manager)
      bindDatabaseManager(app, manager)
      container.singleton(kRestoreManager, () => ({
        [Symbol.asyncDispose]: async () => {
          // 没有之前的应用时保留（单应用的脚本与测试在关闭后仍可调用 useDatabaseManager().close()）
          if (previous && currentDatabaseManager() === manager)
            setDatabaseManager(previous)
        },
      }))
      container.make(kRestoreManager)
      // config/queue.ts 中 driver: 'database' 的队列连接
      registerQueueDriver('database', (name, queueConfig) => databaseQueue(name, queueConfig, {
        logger: container.make(Logger),
      }))
      if (config.snowflake)
        configureSnowflake(config.snowflake)
    },
  }
}
