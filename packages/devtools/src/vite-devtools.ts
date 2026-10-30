import type { InitHubOptions } from '@devframes/hub/initiate'
import type { DevtoolsSource } from './hub'
import { createHazeFrame } from './frame'
import { FRAME_DOCK, registerPanels } from './panels'

type HubContext = Parameters<NonNullable<InitHubOptions['configure']>>[0]

/**
 * 接入 Vite DevTools（Vite 配置中 `devtools: true`）：hazejs 的面板注册进 Vite DevTools 的 hub，
 * 与 Vite、Vue 等的面板共用一个界面、一次授权与一个 MCP 端点，不再单独启动 /__devtools/。
 * 由 `haze()` 插件的 `devtools.setup(ctx)` 调用。
 */
export async function setupViteDevtools(ctx: HubContext, options: { source: DevtoolsSource }): Promise<void> {
  await ctx.install(createHazeFrame({ source: options.source }), { dock: FRAME_DOCK })
  registerPanels(ctx, { source: options.source, live: true })
}
