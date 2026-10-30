import type { AutoImportEntry } from './types'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, relative } from 'node:path'
import { normalizePath } from 'vite'

/** 声明文件引用自身导出的命名空间名 */
const SELF = '__autoImports'

/**
 * 生成全局声明。
 *
 * 先把每个自动导入以 `as` 的名字从本文件再导出，再在 `declare global` 中用 `export import X = self.X` 起别名：
 * 别名同时带有值、类型与命名空间的含义，类可以直接用作类型，泛型参数（含约束、默认值）原样保留；
 * 默认导出也能以具名形式引用（`self.default` 中 default 是保留字，不能直接写）。
 * 只用 `typeof import()` 的 const 声明会让类不能用作类型，而同名的 const 与 `export type {}` 又会冲突（TS1362）。
 *
 * 只有类型的导出不能这样起别名（源模块以 `export type {}` 导出时报 TS1380），改为在 `declare global` 中
 * `export type { X } from`：TS 报“module augmentation 中不允许 export”（以 @ts-ignore 忽略），但仍会建立全局类型名，
 * 泛型参数原样保留
 */
export function generateDts(entries: readonly AutoImportEntry[], file: string): string {
  const dir = dirname(file)
  const groups = new Map<string, AutoImportEntry[]>()
  for (const entry of entries) {
    const from = modulePath(dir, entry.from)
    groups.set(from, [
      ...(groups.get(from) ?? []),
      entry,
    ])
  }

  const imports = [`import * as ${SELF} from ${JSON.stringify(`./${selfName(file)}`)}`]
  const exports: string[] = []
  const types: string[] = []
  /** 名字 → 别名指向 */
  const targets = new Map<string, string>()
  const specifier = (item: AutoImportEntry): string => item.name === item.as
    ? item.as
    : `${item.name} as ${item.as}`
  for (const [from, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
    const typeOnly = list.filter(item => item.type)
    if (typeOnly.length)
      types.push(`  // @ts-ignore\n  export type { ${typeOnly.map(specifier).join(', ')} } from ${JSON.stringify(from)}`)
    const items = list.filter(item => !item.type)
    const named = items.filter(item => item.name !== '*')
    if (named.length) {
      exports.push(`export { ${named.map(specifier).join(', ')} } from ${JSON.stringify(from)}`)
    }
    named.forEach(item => targets.set(item.as, `${SELF}.${item.as}`))
    // 命名空间直接导入（`export * as` 不能用于 `export =` 形式的模块，如 @types/node）
    for (const item of items.filter(item => item.name === '*')) {
      imports.push(`import * as ${SELF}_${item.as} from ${JSON.stringify(from)}`)
      targets.set(item.as, `${SELF}_${item.as}`)
    }
  }
  const aliases = [...targets]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, target]) => `  export import ${name} = ${target}`)

  return `// 由 @hazejs/auto-import 自动生成，请勿手动修改
${imports.join('\n')}

${exports.join('\n')}${exports.length
  ? '\n\n'
  : ''}declare global {
${[
  ...aliases,
  ...types,
].join('\n')}
}
`
}

/** 内容变化时才写入 */
export async function writeDts(entries: readonly AutoImportEntry[], file: string): Promise<boolean> {
  const content = generateDts(entries, file)
  const previous = await readFile(file, 'utf8').catch(() => undefined)
  if (previous === content)
    return false
  await mkdir(dirname(file), { recursive: true })
  await writeFile(file, content)
  return true
}

/** 声明文件中的模块路径：文件为相对路径（保留扩展名，nodenext 下不带扩展名的相对路径解析不到），依赖包原样 */
function modulePath(dir: string, from: string): string {
  if (!isAbsolute(from))
    return from
  const path = normalizePath(relative(dir, from))
  return path.startsWith('.')
    ? path
    : `./${path}`
}

/** 引用自身：`auto-imports.d.ts` → `auto-imports.js`（bundler 与 nodenext 都会解析回 .d.ts） */
function selfName(file: string): string {
  const name = basename(file)
  if (name.endsWith('.d.ts'))
    return `${name.slice(0, -'.d.ts'.length)}.js`
  if (name.endsWith('.d.mts'))
    return `${name.slice(0, -'.d.mts'.length)}.mjs`
  throw new Error(`[@hazejs/auto-import] The declaration file must end with .d.ts or .d.mts: ${file}`)
}
