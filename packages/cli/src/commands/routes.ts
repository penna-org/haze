import process from 'node:process'
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
    // --json：stdout 只输出 JSON（启动日志、热更新提示改写到 stderr），可以直接重定向到文件或交给 jq
    const restore = args.json
      ? stdoutToStderr()
      : undefined
    let server: Awaited<ReturnType<typeof createDevServer>> | undefined
    try {
      server = await createDevServer({
        root: resolveRoot(args.root),
        listen: false,
      })
      if (!server.app)
        throw new Error('Application failed to start')
      const routes = server.app.router.list()
      if (args.json) {
        restore?.()
        process.stdout.write(`${JSON.stringify(routes, null, 2)}\n`)
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
      restore?.()
      await server?.close()
    }
  },
})

/** 把写到 stdout 的内容改写到 stderr，返回恢复函数 */
function stdoutToStderr(): () => void {
  const write = process.stdout.write
  process.stdout.write = ((...args: Parameters<typeof write>) => process.stderr.write(...(args as Parameters<typeof process.stderr.write>))) as typeof write
  return () => {
    process.stdout.write = write
  }
}
