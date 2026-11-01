import type { BuildInfo, HazePluginApi, PresetName } from '@hazejs/vite'
import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import process from 'node:process'
import { BINARY_TARGETS, buildServer, findViteConfig, PRESET_NAMES, resolveBinaryTargets } from '@hazejs/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { colors } from 'consola/utils'
import { createBuilder } from 'vite'
import { resolveRoot, rootArg } from '../args'

export default defineCommand({
  meta: { name: 'build', description: '构建生产环境产物' },
  args: {
    ...rootArg,
    preset: { type: 'string', alias: 'p', description: `部署预设：${PRESET_NAMES.join(' | ')}（默认读取 haze.config.ts，否则为 node）` },
    outDir: { type: 'string', description: '输出目录（默认 dist，仅纯后端项目）' },
    minify: { type: 'boolean', description: '压缩产物', default: false },
    compile: { type: 'boolean', description: '编译为独立可执行文件（需要 Bun；等同 --preset binary）', default: false },
    target: { type: 'string', description: `可执行文件的目标平台，逗号分隔：${BINARY_TARGETS.join(' | ')}（默认当前平台）` },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    if (args.compile && args.preset && args.preset !== 'binary')
      throw new Error(`--compile builds the binary preset and cannot be combined with --preset ${args.preset}`)
    const preset = (args.compile ? 'binary' : args.preset) as PresetName | undefined
    if (preset && !PRESET_NAMES.includes(preset))
      throw new Error(`Unknown preset "${preset}". Available: ${PRESET_NAMES.join(', ')}`)
    // 提前校验目标平台（构建前报错）
    const targets = args.target
      ? resolveBinaryTargets(args.target)
      : undefined
    const start = performance.now()
    process.env.NODE_ENV ??= 'production'

    let info: BuildInfo | undefined
    if (findViteConfig(root)) {
      // 全栈项目：由 vite.config.ts 中的 haze() 构建 client + server，预设通过环境变量传入
      if (preset)
        process.env.HAZE_PRESET = preset
      if (targets)
        process.env.HAZE_BINARY_TARGETS = targets.join(',')
      const builder = await createBuilder({ root, mode: 'production' })
      await builder.buildApp()
      const plugin = builder.config.plugins.find(item => item.name === 'hazejs') as { api?: HazePluginApi } | undefined
      info = plugin?.api?.lastBuild()
      if (!info)
        throw new Error('Server entry was not generated. Is haze() added to the plugins in vite.config?')
    }
    else {
      info = await buildServer({
        root,
        outDir: args.outDir,
        minify: args.minify,
        preset,
        targets,
      })
    }

    const size = existsSync(info.entry)
      ? `${((await stat(info.entry)).size / 1024).toFixed(1)} kB`
      : ''
    consola.success(`Built ${colors.cyan(info.preset)} in ${Math.round(performance.now() - start)}ms → ${relative(process.cwd(), info.entry)} ${colors.dim(size)}`)
    // binary：依赖已打包进可执行文件
    if (info.externals.length && info.preset !== 'binary')
      consola.info(`Runtime dependencies (node_modules): ${info.externals.join(', ')}`)
    consola.info(info.hint)
  },
})
