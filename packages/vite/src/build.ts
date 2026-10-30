import type { InlineConfig } from 'vite'
import type { BuildInfo } from './plugin'
import type { PresetName } from './presets'
import { rm } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import process from 'node:process'
import { createBuilder, mergeConfig } from 'vite'
import { loadHazeConfig } from './config'
import { haze } from './plugin'

export interface BuildServerOptions {
  root?: string
  /** 覆盖 haze.config.ts 中的 outDir */
  outDir?: string
  /** 部署预设，默认读取 haze.config.ts，否则为 node */
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
  const config = await loadHazeConfig(root, 'production')
  const outDir = options.outDir
    ? resolve(root, options.outDir)
    : config.outDir
  // 清空整个输出目录：预设把服务端放在子目录（docker 的 server/、aws-lambda 的 lambda/）时，
  // Vite 只清空子目录，旧产物会留在输出目录中（docker 镜像的 COPY . . 会把它们带进去）。
  // 与 Vite 的 emptyOutDir 相同，只清理项目根目录之内的输出目录
  const inside = relative(root, outDir)
  if (inside && !inside.startsWith('..') && !isAbsolute(inside))
    await rm(outDir, { recursive: true, force: true })
  const plugins = haze({
    srcDir: config.srcDir,
    outDir,
    port: config.port,
    host: config.host,
    preset: options.preset ?? config.preset,
    cloudflare: config.cloudflare,
    vercel: config.vercel,
    externals: config.externals,
    autoImport: config.autoImport,
    standalone: true,
  })

  const builder = await createBuilder(mergeConfig(config.vite, {
    root,
    configFile: false,
    mode: 'production',
    envDir: false,
    logLevel: 'warn',
    plugins,
    build: {
      minify: options.minify ?? false,
      sourcemap: options.sourcemap ?? true,
    },
  } satisfies InlineConfig))
  await builder.buildApp()

  const info = plugins[0].api!.lastBuild()
  if (!info)
    throw new Error('Build did not produce a server bundle')
  return { ...info, outDir }
}
