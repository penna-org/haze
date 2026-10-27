import type { InlineConfig, PreviewServer } from 'vite'
import { resolve } from 'node:path'
import process from 'node:process'
import { mergeConfig, preview } from 'vite'
import { findViteConfig, loadThinkConfig } from './config'
import { thinkH3 } from './plugin'

export interface PreviewServerOptions {
  /** 项目根目录，默认 `process.cwd()` */
  root?: string
  /** 默认 4173（与 vite preview 一致） */
  port?: number
  host?: string | boolean
  open?: boolean
}

/**
 * 本地预览构建产物（`think-h3 preview`）：按构建时的部署预设运行产物本身。
 * 全栈项目使用项目的 vite.config.ts（等同 `vite preview`），纯后端项目使用内置配置。
 */
export async function previewServer(options: PreviewServerOptions = {}): Promise<PreviewServer> {
  const root = resolve(options.root ?? process.cwd())
  const server = {
    preview: {
      ...(options.port !== undefined && { port: options.port }),
      ...(options.host !== undefined && { host: options.host }),
      ...(options.open !== undefined && { open: options.open }),
    },
  } satisfies InlineConfig
  const viteConfig = findViteConfig(root)
  if (viteConfig)
    return preview({ root, configFile: viteConfig, ...server })

  const config = await loadThinkConfig(root, 'production')
  return preview(mergeConfig(config.vite, {
    root,
    configFile: false,
    appType: 'custom',
    envDir: false,
    plugins: [
      thinkH3({ srcDir: config.srcDir, outDir: config.outDir, standalone: true }),
    ],
    ...server,
  } satisfies InlineConfig))
}
