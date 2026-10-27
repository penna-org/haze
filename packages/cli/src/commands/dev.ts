import process from 'node:process'
import { createDevServer } from '@think-h3/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { colors } from 'consola/utils'
import { displayUrl, parsePort, resolveRoot, rootArg, serverArgs } from '../args'

export default defineCommand({
  meta: { name: 'dev', description: '启动开发服务器（修改代码即时生效，无需重启）' },
  args: {
    ...rootArg,
    ...serverArgs,
  },
  async run({ args }) {
    const start = performance.now()
    const server = await createDevServer({
      root: resolveRoot(args.root),
      port: parsePort(args.port),
      host: args.host,
    })

    const routes = server.app?.router.list().length ?? 0
    consola.log('')
    consola.log(`  ${colors.bold(colors.cyan('think-h3'))} ${colors.dim('dev server ready in')} ${Math.round(performance.now() - start)}ms`)
    consola.log('')
    consola.log(`  ${colors.green('➜')}  Local:  ${colors.cyan(displayUrl(server.url!))}`)
    consola.log(`  ${colors.green('➜')}  Routes: ${routes}`)
    consola.log(`  ${colors.dim('watching for changes...')}`)
    consola.log('')

    const shutdown = async (): Promise<void> => {
      await server.close()
      process.exit(0)
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  },
})
