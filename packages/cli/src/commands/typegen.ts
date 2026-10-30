import { relative } from 'node:path'
import process from 'node:process'
import { createDevServer, loadHazeConfig, writeTypes } from '@hazejs/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { resolveRoot, rootArg } from '../args'

export default defineCommand({
  meta: { name: 'typegen', description: '生成配置键与路由名类型（.haze/types/haze.d.ts）' },
  args: rootArg,
  async run({ args }) {
    const root = resolveRoot(args.root)
    const { srcDir } = await loadHazeConfig(root)
    // 开启了自动导入时，插件在启动时写入 .haze/types/auto-imports.d.ts
    const server = await createDevServer({ root, listen: false, typegen: true })
    try {
      if (!server.app)
        throw new Error('Application failed to start')
      const result = await writeTypes({
        root,
        srcDir,
        routes: server.app.router.records(),
        import: id => server.import(id),
      })
      consola.success(`Types written to ${relative(process.cwd(), result.file)} (${result.configs.length} config file(s), ${result.routes.length} named route(s))`)
    }
    finally {
      await server.close()
    }
  },
})
