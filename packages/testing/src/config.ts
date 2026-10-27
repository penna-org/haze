import type { ThinkPluginOptions } from '@think-h3/vite'
import type { ViteUserConfig } from 'vitest/config'
import { thinkH3 } from '@think-h3/vite'
import { mergeConfig } from 'vitest/config'

export interface ThinkTestConfig extends ViteUserConfig {
  /** 传给 thinkH3() 插件的选项，例如全栈项目的 `{ srcDir: 'server' }`（默认读取 think.config.ts） */
  think?: Omit<ThinkPluginOptions, 'standalone'>
}

/**
 * 后端测试的 Vitest 配置：注册 thinkH3 插件（提供 `virtual:think/app` 与 `~` 别名），
 * 并让 Vite 处理 `@think-h3/testing`，使其能导入虚拟模块。
 */
export function defineThinkTestConfig(config: ThinkTestConfig = {}): ViteUserConfig {
  const { think, ...rest } = config
  return mergeConfig({
    plugins: [
      thinkH3({ ...think, standalone: true }),
    ],
    test: {
      environment: 'node',
      server: {
        deps: {
          inline: ['@think-h3/testing'],
        },
      },
    },
  } satisfies ViteUserConfig, rest)
}
