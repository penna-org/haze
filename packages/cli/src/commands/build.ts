import type { BuildInfo, PresetName, ThinkPluginApi } from '@think-h3/vite'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import process from 'node:process'
import { buildServer, findViteConfig, PRESET_NAMES } from '@think-h3/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { colors } from 'consola/utils'
import { createBuilder } from 'vite'
import { resolveRoot, rootArg } from '../args'

export default defineCommand({
  meta: { name: 'build', description: '构建生产环境产物' },
  args: {
    ...rootArg,
    preset: { type: 'string', alias: 'p', description: `部署预设：${PRESET_NAMES.join(' | ')}（默认读取 think.config.ts，否则为 node）` },
    outDir: { type: 'string', description: '输出目录（默认 dist，仅纯后端项目）' },
    minify: { type: 'boolean', description: '压缩产物', default: false },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    const preset = args.preset as PresetName | undefined
    if (preset && !PRESET_NAMES.includes(preset))
      throw new Error(`Unknown preset "${preset}". Available: ${PRESET_NAMES.join(', ')}`)
    const start = performance.now()
    process.env.NODE_ENV ??= 'production'

    let info: BuildInfo | undefined
    if (findViteConfig(root)) {
      // 全栈项目：由 vite.config.ts 中的 thinkH3() 构建 client + server，预设通过环境变量传入
      if (preset)
        process.env.THINK_PRESET = preset
      const builder = await createBuilder({ root, mode: 'production' })
      await builder.buildApp()
      const plugin = builder.config.plugins.find(item => item.name === 'think-h3') as { api?: ThinkPluginApi } | undefined
      info = plugin?.api?.lastBuild()
      if (!info)
        throw new Error('Server entry was not generated. Is thinkH3() added to the plugins in vite.config?')
    }
    else {
      info = await buildServer({
        root,
        outDir: args.outDir,
        minify: args.minify,
        preset,
      })
    }

    const size = existsSync(info.entry)
      ? `${((await stat(info.entry)).size / 1024).toFixed(1)} kB`
      : ''
    consola.success(`Built ${colors.cyan(info.preset)} in ${Math.round(performance.now() - start)}ms → ${relative(process.cwd(), info.entry)} ${colors.dim(size)}`)
    if (info.externals.length)
      consola.info(`Runtime dependencies (node_modules): ${info.externals.join(', ')}`)
    consola.info(info.hint)
  },
})
