import type { InlineConfig } from 'vite'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { build, mergeConfig } from 'vite'
import { loadThinkConfig } from './config'
import { VIRTUAL_MODULES } from './constants'
import { thinkH3 } from './plugin'

export interface BuildServerOptions {
  root?: string
  /** 覆盖 think.config.ts 中的 outDir */
  outDir?: string
  minify?: boolean
  sourcemap?: boolean
}

export interface BuildServerResult {
  outDir: string
  /** 生产入口：`node <entry>` 即可启动 */
  entry: string
}

/**
 * 构建生产服务端产物。依赖保持 external（运行时需要 node_modules），
 * `.env` 在运行时从当前工作目录加载。
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<BuildServerResult> {
  const root = resolve(options.root ?? process.cwd())
  const config = await loadThinkConfig(root, 'production')
  const outDir = options.outDir
    ? resolve(root, options.outDir)
    : config.outDir

  await build(mergeConfig(config.vite, {
    root,
    configFile: false,
    mode: 'production',
    envDir: false,
    logLevel: 'warn',
    plugins: [
      thinkH3({
        srcDir: config.srcDir,
        port: config.port,
        host: config.host,
        standalone: true,
      }),
    ],
    build: {
      ssr: true,
      outDir,
      emptyOutDir: true,
      target: 'node22',
      minify: options.minify ?? false,
      sourcemap: options.sourcemap ?? true,
      rolldownOptions: {
        input: { index: VIRTUAL_MODULES.serverEntry },
        output: {
          entryFileNames: '[name].mjs',
          chunkFileNames: 'chunks/[name]-[hash].mjs',
        },
      },
    },
  } satisfies InlineConfig))

  return {
    outDir,
    entry: join(outDir, 'index.mjs'),
  }
}
