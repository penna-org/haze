import type { DevServer } from '@hazejs/vite'
import { existsSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'
import process from 'node:process'
import { createDevServer, loadHazeConfig } from '@hazejs/vite'
import { defineCommand } from 'citty'
import { consola } from 'consola'
import { importFromApp } from '../app-import'
import { resolveRoot, rootArg } from '../args'

/** 用到的 @hazejs/search 接口（避免 CLI 依赖该包的类型） */
interface SearchModule {
  importSearchable: (model: string, options?: { chunk?: number, onProgress?: (count: number) => void }) => Promise<number>
  flushSearchable: (model: string) => Promise<void>
  syncSearchSettings: (model?: string) => Promise<Array<{ model: string, index: string, engine: string }>>
}

const MODULE_RE = /\.[cm]?[jt]s$/

/** 模型文件：app/model/*.ts 与多应用的 app/<name>/model/*.ts；name 指定时只取同名文件 */
function modelFiles(srcDir: string, name?: string): string[] {
  const app = join(srcDir, 'app')
  const dirs = [
    join(app, 'model'),
  ]
  if (existsSync(app)) {
    for (const entry of readdirSync(app, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'model')
        dirs.push(join(app, entry.name, 'model'))
    }
  }
  return dirs.filter(dir => existsSync(dir)).flatMap(dir => readdirSync(dir)
    .filter(file => MODULE_RE.test(file) && (!name || file.replace(MODULE_RE, '') === name))
    .map(file => join(dir, file)))
}

/**
 * 在开发服务器的模块图中启动应用，加载模型文件（searchable() 在模型模块中注册），再执行命令。
 * 模型名不是文件名时，会加载全部模型文件后按类名 / 索引名查找。
 */
async function withSearch(rootArgValue: string, model: string | undefined, run: (search: SearchModule, server: DevServer) => Promise<void>): Promise<void> {
  const root = resolveRoot(rootArgValue)
  const { srcDir } = await loadHazeConfig(root)
  const server = await createDevServer({ root, listen: false })
  try {
    if (!server.app)
      throw new Error('Application failed to start')
    let search: SearchModule
    try {
      search = await importFromApp<SearchModule>(server, root, '@hazejs/search')
    }
    catch {
      consola.error('@hazejs/search is not installed. Run `pnpm add @hazejs/search` first.')
      process.exitCode = 1
      return
    }
    const base = srcDir
    const files = (model && modelFiles(base, model).length)
      ? modelFiles(base, model)
      : modelFiles(base)
    for (const file of files)
      await server.import(file)
    if (!files.length)
      consola.warn(`No model files found in ${relative(process.cwd(), join(base, 'app'))}`)
    await run(search, server)
  }
  catch (error) {
    consola.error((error as Error).message)
    process.exitCode = 1
  }
  finally {
    await server.close()
  }
}

/** `haze search:import Post`：把模型的全部记录写入搜索索引 */
export const searchImportCommand = defineCommand({
  meta: { name: 'search:import', description: '把模型的全部记录写入搜索索引' },
  args: {
    model: { type: 'positional', description: '模型类名或索引名，例如 Post', required: true },
    ...rootArg,
    chunk: { type: 'string', description: '每批读取的数量（默认 config/search.ts 的 chunk，500）' },
  },
  async run({ args }) {
    await withSearch(args.root, args.model, async (search) => {
      const count = await search.importSearchable(args.model, {
        chunk: args.chunk
          ? Number(args.chunk)
          : undefined,
        onProgress: imported => consola.info(`Imported ${imported} record(s)`),
      })
      consola.success(`Imported ${count} ${args.model} record(s) into the search index`)
    })
  },
})

/** `haze search:flush Post`：清空模型的搜索索引 */
export const searchFlushCommand = defineCommand({
  meta: { name: 'search:flush', description: '清空模型的搜索索引' },
  args: {
    model: { type: 'positional', description: '模型类名或索引名，例如 Post', required: true },
    ...rootArg,
  },
  async run({ args }) {
    await withSearch(args.root, args.model, async (search) => {
      await search.flushSearchable(args.model)
      consola.success(`Flushed the search index of ${args.model}`)
    })
  },
})

/** `haze search:sync-settings [Post]`：创建索引并同步 searchable / filterable / sortable 等设置 */
export const searchSyncSettingsCommand = defineCommand({
  meta: { name: 'search:sync-settings', description: '创建搜索索引并同步索引设置（database 引擎创建全文索引）' },
  args: {
    model: { type: 'positional', description: '模型类名或索引名（默认全部可搜索的模型）', required: false },
    ...rootArg,
  },
  async run({ args }) {
    await withSearch(args.root, args.model, async (search) => {
      const synced = await search.syncSearchSettings(args.model)
      if (!synced.length)
        consola.warn('No searchable models found (call searchable(Model, {...}) in the model file)')
      for (const item of synced)
        consola.success(`${item.model} → ${item.index} (${item.engine})`)
    })
  },
})
