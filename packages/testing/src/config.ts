import type { HazePluginOptions } from '@hazejs/vite'
import type { ViteUserConfig } from 'vitest/config'
import { haze } from '@hazejs/vite'
import { mergeConfig } from 'vitest/config'

export interface HazeTestConfig extends ViteUserConfig {
  /** 传给 haze() 插件的选项，例如全栈项目的 `{ srcDir: 'server' }`（默认读取 haze.config.ts） */
  haze?: Omit<HazePluginOptions, 'standalone'>
}

/**
 * 后端测试的 Vitest 配置：注册 haze 插件（提供 `virtual:haze/app` 与 `~` 别名），
 * 并让 Vite 处理 `@hazejs/testing`，使其能导入虚拟模块。
 */
export function defineHazeTestConfig(config: HazeTestConfig = {}): ViteUserConfig {
  const { haze: pluginOptions, ...rest } = config
  return mergeConfig({
    plugins: [
      haze({ ...pluginOptions, standalone: true }),
    ],
    test: {
      environment: 'node',
      server: {
        deps: {
          inline: ['@hazejs/testing'],
        },
      },
    },
  } satisfies ViteUserConfig, rest)
}
