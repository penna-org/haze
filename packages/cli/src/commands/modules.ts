import { createDevServer } from '@hazejs/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { colors } from 'consola/utils'
import { resolveRoot, rootArg } from '../args'

export default defineCommand({
  meta: { name: 'module:list', description: '列出已启用的模块（启用顺序、前缀、路由数与迁移目录）' },
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
      const modules = server.app.modules().map(module => ({
        name: module.name,
        source: module.source,
        prefix: module.prefix || '/',
        as: module.as,
        app: module.app,
        routes: routes.filter(route => route.module === module.name).length,
        migrations: module.migrations,
        connection: module.connection,
      }))
      if (args.json) {
        consola.log(JSON.stringify(modules, null, 2))
        return
      }
      if (!modules.length) {
        consola.info('No modules (config/modules.ts or modules/<name>/)')
        return
      }
      const multiApp = modules.some(module => module.app)
      const rows = [
        [
          'NAME',
          'SOURCE',
          ...(multiApp
            ? ['APP']
            : []),
          'PREFIX',
          'ROUTE NAMES',
          'ROUTES',
          'MIGRATIONS',
        ],
        ...modules.map(module => [
          module.name,
          module.source,
          ...(multiApp
            ? [module.app ?? '-']
            : []),
          module.prefix,
          module.as
            ? `${module.as}*`
            : '-',
          String(module.routes),
          module.migrations
            ? `${module.migrations}${module.connection
              ? ` (${module.connection})`
              : ''}`
            : '-',
        ]),
      ]
      const widths = rows[0].map((_, i) => Math.max(...rows.map(row => row[i].length)))
      rows.forEach((row, index) => {
        const line = row.map((cell, i) => cell.padEnd(widths[i])).join('  ').trimEnd()
        consola.log(index === 0
          ? colors.dim(line)
          : line)
      })
      consola.log(colors.dim(`\n${modules.length} module(s), in enable order`))
    }
    finally {
      await server.close()
    }
  },
})
