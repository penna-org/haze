import type { Rollup } from 'vite'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createFilter, normalizePath } from 'vite'

export const AUTO_IMPORT_PACKAGE = '@hazejs/auto-import'

/** `haze.config.ts` / `haze()` 的 autoImport 选项 */
export interface AutoImportConfig {
  /**
   * 扫描导出的目录（相对 srcDir 的 glob）：`app/service` 只扫描第一层，`app/service/**` 包含子目录。
   * 默认为 `app/<kind>/**` 与 `modules/*\/app/<kind>/**`（controller、service、repository、model、middleware 等）
   */
  dirs?: string[]
  /** 依赖包的自动导入，如 `{ from: 'valibot', imports: [['*', 'v']] }` */
  imports?: Array<{ from: string, imports: Array<string | [name: string, as: string] | { name: string, as?: string, type?: boolean }> }>
  /** 不自动导入的名字 */
  ignore?: string[]
  /**
   * 框架 API 的预设（包名，读取 `<包名>/auto-imports`）：默认使用项目依赖中所有提供了预设的 `@hazejs/*` 包
   * （如 `@hazejs/core` 的 defineRoutes、inject、HttpContext 等），`[]` 关闭。重名时项目中的导出优先
   */
  presets?: string[]
  /**
   * 不注入导入的文件（相对 srcDir 的 glob）。
   * 默认排除 drizzle-kit 自己加载的 `database/schema/**`（不经过 Vite，自动导入在其中不可用）
   */
  exclude?: string[]
}

/** `@hazejs/auto-import` 的上下文中被用到的部分（这里只声明用到的部分，避免依赖该包） */
interface AutoImportContext {
  scan: () => Promise<boolean>
  update: (file: string, event: 'create' | 'update' | 'delete') => Promise<boolean>
  conflicts: () => Array<{ name: string, used: { from: string }, ignored: Array<{ from: string }> }>
  transform: (code: string, id: string) => Promise<{ code: string, map: Rollup.SourceMapInput } | undefined>
  writeDts: (file: string) => Promise<boolean>
  stripImports: (code: string, file: string) => string
}

interface AutoImportModule {
  createAutoImport: (options: { srcDir: string, root: string, dirs?: string[], imports?: AutoImportConfig['imports'], presets?: string[], ignore?: string[] }) => AutoImportContext
}

export interface AutoImportHostOptions {
  root: string
  srcDir: string
  config: AutoImportConfig
  /** 写入 `.haze/types/auto-imports.d.ts` */
  typegen: boolean
  warn: (message: string) => void
}

export interface AutoImportHost {
  /** 为后端代码注入导入（在 TS 转换之后执行） */
  transform: (code: string, id: string) => Promise<{ code: string, map: Rollup.SourceMapInput } | undefined>
  /** 文件新增 / 修改 / 删除后更新，自动导入的名单变化时返回 true（引用了这些名字的模块需要重新转换） */
  update: (file: string, event: 'create' | 'update' | 'delete') => Promise<boolean>
}

const DEFAULT_EXCLUDE = ['database/schema/**', 'modules/*/database/schema/**']

/** 自动导入的全局类型声明（tsconfig 的 include 中已有 `.haze/types/**\/*.d.ts`） */
export function autoImportsFile(root: string): string {
  return join(root, '.haze', 'types', 'auto-imports.d.ts')
}

/** `true` 使用默认配置，`false` / 未设置时关闭 */
export function resolveAutoImportConfig(value: boolean | AutoImportConfig | undefined): AutoImportConfig | false {
  if (!value)
    return false
  return value === true
    ? {}
    : value
}

/** 从项目根解析并加载 `@hazejs/auto-import`；开启了自动导入却未安装时报错 */
export async function importAutoImport(root: string): Promise<AutoImportModule> {
  let entry: string
  try {
    entry = createRequire(join(root, 'package.json')).resolve(AUTO_IMPORT_PACKAGE)
  }
  catch {
    throw new Error(`autoImport is enabled but ${AUTO_IMPORT_PACKAGE} is not installed. Run \`pnpm add -D ${AUTO_IMPORT_PACKAGE}\` (or turn autoImport off in haze.config.ts)`)
  }
  return await import(pathToFileURL(entry).href) as AutoImportModule
}

/** 按 autoImport 配置创建并扫描 `@hazejs/auto-import` 的上下文 */
async function createContext(root: string, srcDir: string, config: AutoImportConfig): Promise<AutoImportContext> {
  const { createAutoImport } = await importAutoImport(root)
  const context = createAutoImport({
    srcDir,
    root,
    dirs: config.dirs,
    imports: config.imports,
    presets: config.presets,
    ignore: config.ignore,
  })
  await context.scan()
  return context
}

/**
 * 生成代码（`haze make:*`）时去掉会被自动导入的手写导入；未开启自动导入时返回 undefined。
 * 排除的文件（默认 `database/schema/**`）保持原样
 */
export async function createImportStripper(options: { root: string, srcDir: string, autoImport: boolean | AutoImportConfig | undefined }): Promise<((code: string, file: string) => string) | undefined> {
  const config = resolveAutoImportConfig(options.autoImport)
  if (!config)
    return undefined
  const context = await createContext(options.root, options.srcDir, config)
  const excluded = createFilter(config.exclude ?? DEFAULT_EXCLUDE, null, { resolve: options.srcDir })
  return (code, file) => excluded(normalizePath(file))
    ? code
    : context.stripImports(code, file)
}

export function createAutoImportHost({ root, srcDir, config, typegen, warn }: AutoImportHostOptions): AutoImportHost {
  const base = normalizePath(root)
  const excluded = createFilter(config.exclude ?? DEFAULT_EXCLUDE, null, { resolve: srcDir })
  let conflicts = ''

  /** 名单变化后：写入类型声明，重名有变化时提示 */
  async function sync(context: AutoImportContext): Promise<void> {
    const list = context.conflicts()
    const next = JSON.stringify(list)
    if (next !== conflicts && list.length) {
      warn(`[hazejs] auto-import name conflicts (the first one is used, rename or add the name to autoImport.ignore):\n${list
        .map(item => `  ${item.name}: ${[item.used, ...item.ignored].map(entry => relativePath(entry.from)).join(', ')}`)
        .join('\n')}`)
    }
    conflicts = next
    if (typegen)
      await context.writeDts(autoImportsFile(root))
  }

  function relativePath(from: string): string {
    return from.startsWith(`${base}/`)
      ? from.slice(base.length + 1)
      : from
  }

  const ready = (async () => {
    const context = await createContext(root, srcDir, config)
    await sync(context)
    return context
  })()
  // 失败（如未安装）时由 transform / update 抛出，这里避免未处理的 rejection
  ready.catch(() => {})

  return {
    async transform(code, id) {
      const file = normalizePath(id.split('?')[0])
      // 只处理项目中的代码（含 srcDir 之外的 tests/），生成的文件与排除的目录除外
      if (!file.startsWith(`${base}/`) || file.startsWith(`${base}/.haze/`) || excluded(file))
        return
      return (await ready).transform(code, id)
    },

    async update(file, event) {
      const context = await ready
      const changed = await context.update(file, event)
      if (changed)
        await sync(context)
      return changed
    },
  }
}
