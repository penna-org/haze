/** 产品更名时与 `@think-h3/core` 的 constants.ts 一起修改 */
export const PLUGIN_NAME = 'think-h3'

export const CONFIG_BASENAME = 'think.config'

export const VIRTUAL_MODULES = {
  /** 编译期发现的配置 / 路由 / 提供者 / 异常处理器 */
  manifest: 'virtual:think/manifest',
  /** `createApp(options)`：用 manifest 创建应用 */
  app: 'virtual:think/app',
  /** 生产环境入口：创建应用并监听端口 */
  serverEntry: 'virtual:think/server-entry',
  /** 打包进产物的迁移文件（database/ 下的 drizzle-kit 输出） */
  migrations: 'virtual:think/migrations',
  /** 生产迁移脚本入口（migrate.mjs） */
  migrateEntry: 'virtual:think/migrate-entry',
} as const
