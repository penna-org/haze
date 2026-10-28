import process from 'node:process'
import { createDevServer, findViteConfig } from '@hazejs/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { colors } from 'consola/utils'
import { createServer } from 'vite'
import { displayUrl, parsePort, resolveRoot, rootArg, serverArgs } from '../args'

export default defineCommand({
  meta: { name: 'dev', description: '启动开发服务器（修改代码即时生效，无需重启）' },
  args: {
    ...rootArg,
    ...serverArgs,
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    const port = parsePort(args.port)
    const start = performance.now()

    // 全栈项目：交给用户的 vite.config.ts（haze() 插件负责挂载 /api 与热替换）
    if (findViteConfig(root)) {
      const server = await createServer({
        root,
        server: { port, host: args.host },
      })
      await server.listen()
      server.printUrls()
      onExit(() => server.close())
      return
    }

    const server = await createDevServer({ root, port, host: args.host })
    const routes = server.app?.router.list().length ?? 0
    consola.log('')
    consola.log(`  ${colors.bold(colors.cyan('hazejs'))} ${colors.dim('dev server ready in')} ${Math.round(performance.now() - start)}ms`)
    consola.log('')
    consola.log(`  ${colors.green('➜')}  Local:  ${colors.cyan(displayUrl(server.url!))}`)
    consola.log(`  ${colors.green('➜')}  Routes: ${routes}`)
    consola.log(`  ${colors.dim('watching for changes...')}`)
    consola.log('')
    onExit(() => server.close())
  },
})

function onExit(close: () => Promise<void>): void {
  const shutdown = async (): Promise<void> => {
    await close()
    process.exit(0)
  }
  process.once('SIGINT', shutdown)
  process.once('SIGTERM', shutdown)
}
