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
} as const
