import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join, relative } from 'node:path'
import process from 'node:process'
import { buildServer, findViteConfig, loadThinkConfig } from '@think-h3/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { createBuilder } from 'vite'
import { resolveRoot, rootArg } from '../args'

export default defineCommand({
  meta: { name: 'build', description: '构建生产环境产物' },
  args: {
    ...rootArg,
    outDir: { type: 'string', description: '输出目录（默认 dist，仅纯后端项目）' },
    minify: { type: 'boolean', description: '压缩产物', default: false },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    const start = performance.now()
    process.env.NODE_ENV ??= 'production'

    let entry: string
    if (findViteConfig(root)) {
      // 全栈项目：thinkH3() 插件配置了 builder，依次构建 client 与 server
      const builder = await createBuilder({ root, mode: 'production' })
      await builder.buildApp()
      entry = join((await loadThinkConfig(root, 'production')).outDir, 'server', 'index.mjs')
      if (!existsSync(entry))
        throw new Error(`Server entry was not generated. Is thinkH3() added to the plugins in vite.config?`)
    }
    else {
      entry = (await buildServer({ root, outDir: args.outDir, minify: args.minify })).entry
    }

    const { size } = await stat(entry)
    consola.success(`Built in ${Math.round(performance.now() - start)}ms → ${relative(process.cwd(), entry)} (${(size / 1024).toFixed(1)} kB)`)
    consola.info(`Run with: think-h3 start  (or node ${relative(process.cwd(), entry)})`)
  },
})
