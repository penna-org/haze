import type { InlineConfig } from 'vite'
import type { BuildInfo } from './plugin'
import type { PresetName } from './presets'
import { resolve } from 'node:path'
import process from 'node:process'
import { createBuilder, mergeConfig } from 'vite'
import { loadThinkConfig } from './config'
import { thinkH3 } from './plugin'

export interface BuildServerOptions {
  root?: string
  /** 覆盖 think.config.ts 中的 outDir */
  outDir?: string
  /** 部署预设，默认读取 think.config.ts，否则为 node */
  preset?: PresetName
  minify?: boolean
  sourcemap?: boolean
}

export interface BuildServerResult extends BuildInfo {
  outDir: string
}

/**
 * 构建纯后端项目的生产产物。产物布局、打包策略与入口由部署预设决定；
 * node 预设下依赖保持 external（运行时需要 node_modules），`.env` 从运行时工作目录加载。
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<BuildServerResult> {
  const root = resolve(options.root ?? process.cwd())
  const config = await loadThinkConfig(root, 'production')
  const outDir = options.outDir
    ? resolve(root, options.outDir)
    : config.outDir
  const plugin = thinkH3({
    srcDir: config.srcDir,
    outDir,
    port: config.port,
    host: config.host,
    preset: options.preset ?? config.preset,
    standalone: true,
  })

  const builder = await createBuilder(mergeConfig(config.vite, {
    root,
    configFile: false,
    mode: 'production',
    envDir: false,
    logLevel: 'warn',
    plugins: [plugin],
    build: {
      minify: options.minify ?? false,
      sourcemap: options.sourcemap ?? true,
    },
  } satisfies InlineConfig))
  await builder.buildApp()

  const info = plugin.api!.lastBuild()
  if (!info)
    throw new Error('Build did not produce a server bundle')
  return { ...info, outDir }
}
