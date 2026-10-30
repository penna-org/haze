/**
 * `@hazejs/auto-import` 的预设（`@hazejs/orm/auto-imports`）：模型、查询与数据库配置中常用的 API。
 * `Session`（事务会话类型）与 `@hazejs/core` 的会话同名，不收录
 */
export default {
  from: '@hazejs/orm',
  imports: [
    'Model',
    'Db',
    'defineDatabaseConfig',
    'defineFactory',
    'databaseProvider',
    'modelUserProvider',
    'databaseTokenStore',
    'databasePasswordResetStore',
    'databaseTwoFactorStore',
    'databasePasskeyStore',
    'databaseNotificationStore',
    'databaseQueue',
    'transaction',
    'observeModel',
    'refreshDatabase',
    'snowflakeId',
    'Snowflake',
    'ModelNotFoundException',
    'UniqueConstraintException',
    'OptimisticLockException',
    'ModelQuery',
    { name: 'Paginated', type: true },
    { name: 'CursorPaginated', type: true },
    { name: 'ModelObserver', type: true },
  ],
} satisfies { from: string, imports: Array<string | { name: string, type: true }> }
