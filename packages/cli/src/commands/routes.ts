import { createDevServer } from '@hazejs/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { colors } from 'consola/utils'
import { resolveRoot, rootArg } from '../args'

export default defineCommand({
  meta: { name: 'route:list', description: '列出所有路由' },
  args: {
    ...rootArg,
    json: { type: 'boolean', description: '以 JSON 输出', default: false },
  },
  async run({ args }) {
    const server = await createDevServer({
      root: resolveRoot(args.root),
      listen: false,
    })
    try {
      if (!server.app)
        throw new Error('Application failed to start')
      const routes = server.app.router.list()
      if (args.json) {
        consola.log(JSON.stringify(routes, null, 2))
        return
      }
      // 多应用时额外显示所属应用与域名，有模块时显示来源模块
      const multiApp = routes.some(route => route.app)
      const modules = routes.some(route => route.module)
      const rows = [
        [
          ...(multiApp
            ? ['APP', 'DOMAIN']
            : []),
          ...(modules
            ? ['MODULE']
            : []),
          'METHOD',
          'PATH',
          'NAME',
          'HANDLER',
          'MIDDLEWARE',
        ],
        ...routes.map(route => [
          ...(multiApp
            ? [route.app ?? '-', route.domain ?? '']
            : []),
          ...(modules
            ? [route.module ?? '-']
            : []),
          route.method,
          route.path,
          route.name ?? '',
          route.handler,
          route.middleware.join(', '),
        ]),
      ]
      const widths = rows[0].map((_, i) => Math.max(...rows.map(row => row[i].length)))
      rows.forEach((row, index) => {
        const line = row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()
        consola.log(index === 0
          ? colors.dim(line)
          : line)
      })
      consola.log(colors.dim(`\n${routes.length} route(s)`))
    }
    finally {
      await server.close()
    }
  },
})
