import { createDevServer, importDevtools } from '@hazejs/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { colors } from 'consola/utils'
import { resolveRoot, rootArg } from '../args'

export default defineCommand({
  meta: { name: 'devtools:report', description: '生成应用结构的静态报告（概览、模块联动图、路由、容器与事件），需要 @hazejs/devtools' },
  args: {
    ...rootArg,
    out: {
      type: 'string',
      alias: 'o',
      description: '输出目录',
      default: '.haze/devtools-report',
    },
    base: { type: 'string', description: '部署时的路径前缀', default: '/' },
  },
  async run({ args }) {
    const root = resolveRoot(args.root)
    const devtools = await importDevtools(root)
    if (!devtools)
      throw new Error('@hazejs/devtools is not installed. Install it with: pnpm add -D @hazejs/devtools')
    const server = await createDevServer({ root, listen: false })
    try {
      if (!server.app)
        throw new Error('Application failed to start')
      const outDir = await devtools.buildReport({
        source: {
          get app() {
            return server.app
          },
          onReload: server.onReload,
          import: server.import,
        },
        outDir: args.out,
        base: args.base,
        root,
      })
      consola.success(`DevTools report written to ${colors.cyan(outDir)}`)
      consola.log(colors.dim(`  Serve it with any static file server, e.g. npx serve ${outDir}`))
    }
    finally {
      await server.close()
    }
  },
})
