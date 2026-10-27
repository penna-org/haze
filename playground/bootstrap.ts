import type { ApplicationOptions } from '@think-h3/core'
import { createApplication } from '@think-h3/core'
import Handler from '~/app/exception/Handler'

/**
 * 应用入口。M2 阶段这些 glob 会由 Vite 插件生成的虚拟模块 `virtual:think/manifest` 取代。
 */
export function createApp(options: ApplicationOptions = {}) {
  return createApplication({
    rootDir: import.meta.dirname,
    config: import.meta.glob('./config/*.ts', { eager: true }),
    routes: import.meta.glob('./route/*.ts', { eager: true }),
    providers: import.meta.glob('./app/provider/*.ts', { eager: true }),
    exceptionHandler: Handler,
    ...options,
  })
}
