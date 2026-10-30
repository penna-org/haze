import type { Import, Unimport } from 'unimport'
import type { Rollup } from 'vite'
import type { FileExports } from './scan'
import type { AutoImportConflict, AutoImportEntry, AutoImportOptions, ImportSource } from './types'
import { createUnimport } from 'unimport'
import { normalizePath } from 'vite'
import { generateDts, writeDts } from './dts'
import { detectPresets, loadPreset } from './presets'
import { createMatcher, scanFileExports, scanFiles } from './scan'
import { stripAutoImports } from './strip'

/** 默认扫描的目录（相对 srcDir）：项目与本地模块中由代码直接引用的类与定义 */
export const DEFAULT_DIRS: string[] = [
  'controller',
  'service',
  'repository',
  'model',
  'middleware',
  'interceptor',
  'validate',
  'event',
  'job',
  'mail',
  'notification',
  'resource',
].flatMap(kind => [`app/${kind}/**`, `modules/*/app/${kind}/**`])

export interface TransformResult {
  code: string
  map: Rollup.SourceMapInput
}

export interface AutoImportContext {
  /** 全量扫描，返回自动导入的名单是否变化 */
  scan: () => Promise<boolean>
  /** 文件新增 / 修改 / 删除后更新，返回名单是否变化（变化后需要重新转换引用了这些名字的模块并重新生成声明） */
  update: (file: string, event: 'create' | 'update' | 'delete') => Promise<boolean>
  /** 当前生效的自动导入（按名字排序） */
  entries: () => AutoImportEntry[]
  /** 重名的导出 */
  conflicts: () => AutoImportConflict[]
  /** 文件是否属于扫描目录 */
  matches: (file: string) => boolean
  /**
   * 为代码中用到但没有声明的名字插入导入。输入应为去掉类型后的 JS（在 TS 转换之后执行）：
   * 只在类型位置出现的名字不会产生运行时导入
   */
  transform: (code: string, id: string) => Promise<TransformResult | undefined>
  /** 去掉与自动导入完全相同的手写导入（`~/` 别名指向 srcDir），用于生成代码与迁移已有代码 */
  stripImports: (code: string, file: string) => string
  /** 全局类型声明的内容 */
  generateDts: (file: string) => string
  /** 写入全局类型声明，内容变化时返回 true */
  writeDts: (file: string) => Promise<boolean>
}

const SCRIPT_RE = /\.[cm]?[jt]sx?$/

export function createAutoImport(options: AutoImportOptions): AutoImportContext {
  const srcDir = normalizePath(options.srcDir)
  const dirs = options.dirs ?? DEFAULT_DIRS
  const ignore = new Set(options.ignore)
  const matches = createMatcher(srcDir, dirs)
  const sources = (options.imports ?? []).flatMap(normalizeSource)
  const root = normalizePath(options.root ?? options.srcDir)
  /** 预设在首次扫描时加载 */
  let presets: AutoImportEntry[] | undefined

  /** 文件 → 导出（文件变化时失效） */
  const cache = new Map<string, FileExports>()
  let files: string[] = []
  let entries: AutoImportEntry[] = []
  let conflicts: AutoImportConflict[] = []
  let signature = ''
  let unimport: Unimport | undefined

  function exportsOf(file: string): FileExports {
    let result = cache.get(file)
    if (!result) {
      result = scanFileExports(file)
      cache.set(file, result)
    }
    return result
  }

  async function loadPresets(): Promise<AutoImportEntry[]> {
    const names = options.presets ?? detectPresets(root)
    const loaded = await Promise.all(names.map(name => loadPreset(root, name)))
    return loaded.flat().flatMap(normalizeSource)
  }

  /** 按文件、imports、预设的顺序合并，重名时保留第一个 */
  function rebuild(): boolean {
    const used = new Map<string, AutoImportEntry>()
    /** 名字 → 来源（同一导出经 index.ts 等再导出时不算重名） */
    const origins = new Map<string, string>()
    const ignored = new Map<string, AutoImportEntry[]>()
    const add = (entry: AutoImportEntry, origin: string): void => {
      if (ignore.has(entry.as))
        return
      if (!used.has(entry.as)) {
        used.set(entry.as, entry)
        origins.set(entry.as, origin)
      }
      else if (origins.get(entry.as) !== origin) {
        ignored.set(entry.as, [
          ...(ignored.get(entry.as) ?? []),
          entry,
        ])
      }
    }
    for (const file of files) {
      for (const item of exportsOf(file).exports) {
        add({
          name: item.name,
          as: item.as,
          from: file,
          ...(item.type && { type: true }),
        }, item.origin)
      }
    }
    for (const entry of [
      ...sources,
      ...presets ?? [],
    ])
      add(entry, `${entry.from}#${entry.name}`)

    entries = [
      ...used.values(),
    ].sort((a, b) => a.as.localeCompare(b.as))
    conflicts = [...ignored].map(([name, list]) => ({
      name,
      used: used.get(name)!,
      ignored: list,
    }))
    const next = JSON.stringify(entries)
    if (next === signature)
      return false
    signature = next
    unimport = undefined
    return true
  }

  function getUnimport(): Unimport {
    unimport ??= createUnimport({
      // 只有类型的导出没有运行时的值，不注入
      imports: entries.filter(entry => !entry.type).map(({ name, as, from }): Import => ({ name, as, from })),
      addons: [
        {
          name: 'hazejs:skip-self',
          // 文件中用到自己导出的名字时不导入自己
          injectImportsResolved: (imports, _code, id) => id
            ? imports.filter(item => item.from !== cleanId(id))
            : imports,
        },
      ],
    })
    return unimport
  }

  return {
    async scan() {
      presets ??= await loadPresets()
      cache.clear()
      files = scanFiles(srcDir, dirs)
      return rebuild()
    },

    async update(file, event) {
      const path = normalizePath(file)
      const dependents = [...cache].filter(([, value]) => value.deps.includes(path)).map(([key]) => key)
      if (!matches(path) && !dependents.length)
        return false
      cache.delete(path)
      dependents.forEach(key => cache.delete(key))
      if (event !== 'update')
        files = scanFiles(srcDir, dirs)
      return rebuild()
    },

    entries: () => entries,
    conflicts: () => conflicts,
    matches,

    async transform(code, id) {
      const file = cleanId(id)
      if (id.startsWith('\0') || !SCRIPT_RE.test(file) || /\.d\.[cm]?ts$/.test(file) || file.includes('/node_modules/'))
        return
      const { s } = await getUnimport().injectImports(code, file)
      if (!s.hasChanged())
        return
      return {
        code: s.toString(),
        map: s.generateMap({ source: file, includeContent: true, hires: true }),
      }
    },

    stripImports: (code, file) => stripAutoImports(code, normalizePath(file), entries, { srcDir }),
    generateDts: file => generateDts(entries, file),
    writeDts: file => writeDts(entries, file),
  }
}

function normalizeSource(source: ImportSource): AutoImportEntry[] {
  return source.imports.map((item) => {
    if (typeof item === 'string')
      return { name: item, as: item, from: source.from }
    if (Array.isArray(item))
      return { name: item[0], as: item[1], from: source.from }
    return {
      name: item.name,
      as: item.as ?? item.name,
      from: source.from,
      ...(item.type && { type: true }),
    }
  })
}

/** 去掉查询参数（`?v=xxx` 等） */
function cleanId(id: string): string {
  return normalizePath(id.split('?')[0])
}
