import { stat } from 'node:fs/promises'
import { relative } from 'node:path'
import process from 'node:process'
import { buildServer } from '@think-h3/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { resolveRoot, rootArg } from '../args'

export default defineCommand({
  meta: { name: 'build', description: '构建生产环境产物' },
  args: {
    ...rootArg,
    outDir: { type: 'string', description: '输出目录（默认 dist）' },
    minify: { type: 'boolean', description: '压缩产物', default: false },
  },
  async run({ args }) {
    const start = performance.now()
    process.env.NODE_ENV ??= 'production'
    const { entry } = await buildServer({
      root: resolveRoot(args.root),
      outDir: args.outDir,
      minify: args.minify,
    })
    const { size } = await stat(entry)
    consola.success(`Built in ${Math.round(performance.now() - start)}ms → ${relative(process.cwd(), entry)} (${(size / 1024).toFixed(1)} kB)`)
    consola.info(`Run with: think-h3 start  (or node ${relative(process.cwd(), entry)})`)
  },
})
