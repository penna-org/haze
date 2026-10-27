import process from 'node:process'
import { previewServer } from '@think-h3/vite'
import { defineCommand } from 'citty'
import { parsePort, resolveRoot, rootArg, serverArgs } from '../args'

export default defineCommand({
  meta: { name: 'preview', description: '按构建时的部署预设本地预览产物（需先 build）' },
  args: {
    ...rootArg,
    ...serverArgs,
    open: { type: 'boolean', description: '启动后打开浏览器', default: false },
  },
  async run({ args }) {
    const server = await previewServer({
      root: resolveRoot(args.root),
      port: parsePort(args.port),
      host: args.host,
      open: args.open,
    })
    server.printUrls()
    // Ctrl+C 时关闭预览服务器（同时停止产物进程 / Miniflare）
    const close = async (): Promise<void> => {
      await server.close()
      process.exit(0)
    }
    process.once('SIGINT', close)
    process.once('SIGTERM', close)
  },
})
