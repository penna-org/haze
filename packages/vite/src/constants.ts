/** 产品更名时与 `@hazejs/core` 的 constants.ts 一起修改 */
export const PLUGIN_NAME = 'hazejs'

export const CONFIG_BASENAME = 'haze.config'

export const VIRTUAL_MODULES = {
  /** 编译期发现的配置 / 路由 / 提供者 / 异常处理器 */
  manifest: 'virtual:haze/manifest',
  /** `createApp(options)`：用 manifest 创建应用 */
  app: 'virtual:haze/app',
  /** 生产环境入口：创建应用并监听端口 */
  serverEntry: 'virtual:haze/server-entry',
  /** 打包进产物的迁移文件（database/ 下的 drizzle-kit 输出） */
  migrations: 'virtual:haze/migrations',
  /** 生产迁移脚本入口（migrate.mjs） */
  migrateEntry: 'virtual:haze/migrate-entry',
  /** 队列 worker 与定时任务入口（worker.mjs） */
  workerEntry: 'virtual:haze/worker-entry',
} as const
