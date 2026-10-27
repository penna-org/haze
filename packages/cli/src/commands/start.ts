import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { loadThinkConfig } from '@think-h3/vite'
import { defineCommand } from 'citty'
import { resolveRoot, rootArg, serverArgs } from '../args'

export default defineCommand({
  meta: { name: 'start', description: '运行生产环境产物（需先 build）' },
  args: {
    ...rootArg,
    ...serverArgs,
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    const { outDir } = await loadThinkConfig(root, 'production')
    const entry = join(outDir, 'index.mjs')
    if (!existsSync(entry))
      throw new Error(`${relative(process.cwd(), entry)} not found. Run \`think-h3 build\` first.`)

    process.env.NODE_ENV = 'production'
    if (args.port)
      process.env.PORT = args.port
    if (args.host)
      process.env.HOST = args.host
    // .env 从项目根目录加载
    process.chdir(root)
    // 入口内部会调用 app.serve()，监听地址由 srvx 输出
    await import(pathToFileURL(entry).href)
  },
})
