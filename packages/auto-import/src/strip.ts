import type { AutoImportEntry } from './types'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { normalizePath, parseSync } from 'vite'

/** AST 节点（oxc 的 ESTree 输出，这里只读取用到的字段） */
interface Node {
  type: string
  start: number
  end: number
  [key: string]: any
}

export interface StripOptions {
  /** 后端源码目录：`~/` 别名指向这里 */
  srcDir: string
  /** 路径别名前缀，默认 `~` */
  alias?: string
}

const EXTENSIONS = ['ts', 'mts', 'tsx', 'js', 'mjs', 'jsx']

/**
 * 去掉与自动导入完全相同的手写导入（同一个模块的同一个导出、同名），其余导入保留。
 * 用于生成代码（`haze make:*`）与把已有代码迁移到自动导入
 */
export function stripAutoImports(code: string, file: string, entries: readonly AutoImportEntry[], options: StripOptions): string {
  const byName = new Map(entries.map(entry => [entry.as, entry]))
  const { program } = parseSync(file, code)
  const edits: Array<{ start: number, end: number, text: string }> = []

  for (const node of program.body as Node[]) {
    if (node.type !== 'ImportDeclaration' || !node.specifiers?.length)
      continue
    const target = resolveSource(node.source.value, file, options)
    const matches = (entry: AutoImportEntry | undefined, name: string): boolean =>
      Boolean(entry && entry.name === name && sameModule(entry.from, target))
    const kept = (node.specifiers as Node[]).filter((specifier) => {
      const local = specifier.local.name as string
      const entry = byName.get(local)
      if (specifier.type === 'ImportDefaultSpecifier')
        return !matches(entry, 'default')
      if (specifier.type === 'ImportNamespaceSpecifier')
        return !matches(entry, '*')
      const imported = specifier.imported.type === 'Identifier'
        ? specifier.imported.name
        : String(specifier.imported.value)
      return !matches(entry, imported)
    })
    if (kept.length === node.specifiers.length)
      continue
    edits.push({
      start: node.start,
      end: lineEnd(code, node.end),
      text: kept.length
        ? `${printImport(node, kept, code)}\n`
        : '',
    })
  }
  if (!edits.length)
    return code

  let result = code
  for (const edit of edits.reverse())
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end)
  // 去掉导入整体删除后留在文件开头的空行
  return result.replace(/^\s*\n/, '')
}

/** 只保留部分说明符时重新生成导入语句 */
function printImport(node: Node, specifiers: Node[], code: string): string {
  const typeOnly = node.importKind === 'type'
  const text = (item: Node): string => code.slice(item.start, item.end)
  const parts: string[] = []
  const named: string[] = []
  for (const specifier of specifiers) {
    if (specifier.type === 'ImportSpecifier')
      named.push(text(specifier))
    else
      parts.push(text(specifier))
  }
  if (named.length)
    parts.push(`{ ${named.join(', ')} }`)
  return `import ${typeOnly
    ? 'type '
    : ''}${parts.join(', ')} from ${code.slice(node.source.start, node.source.end)}`
}

/** 语句结束位置之后的换行一并删除 */
function lineEnd(code: string, end: number): number {
  const match = /^[ \t]*(?:;[ \t]*)?\r?\n/.exec(code.slice(end))
  return end + (match?.[0].length ?? 0)
}

/** 导入路径解析为文件（不带扩展名比较）；依赖包原样返回 */
function resolveSource(source: string, importer: string, options: StripOptions): string {
  const alias = `${options.alias ?? '~'}/`
  if (source.startsWith(alias))
    return normalizePath(resolve(options.srcDir, source.slice(alias.length)))
  if (source.startsWith('.') || isAbsolute(source))
    return normalizePath(resolve(dirname(importer), source))
  return source
}

function sameModule(from: string, target: string): boolean {
  if (from === target)
    return true
  if (!isAbsolute(from) || !isAbsolute(target))
    return false
  const base = target.replace(/\.[cm]?js$/, '')
  return [
    target,
    ...EXTENSIONS.map(ext => `${base}.${ext}`),
    ...EXTENSIONS.map(ext => `${target}/index.${ext}`),
  ]
    .some(path => path === from && existsSync(path))
}
