import { existsSync, readFileSync, statSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, resolve } from 'node:path'
import picomatch from 'picomatch'
import { globSync } from 'tinyglobby'
import { normalizePath, parseSync } from 'vite'

/** 文件中的一个导出 */
export interface ScannedExport {
  /** 导出名，默认导出为 `default` */
  name: string
  /** 自动导入使用的名字：默认导出取声明的名字，匿名时取文件名 */
  as: string
  /** 只有类型 */
  type: boolean
  /** 最初声明的位置（`文件#导出名`）：同一个导出经再导出出现多次时据此去重 */
  origin: string
}

export interface FileExports {
  exports: ScannedExport[]
  /** 通过再导出（`export * from` 等）读取过的其它文件，这些文件变化时需要重新扫描 */
  deps: string[]
}

/** AST 节点（oxc 的 ESTree 输出，这里只读取用到的字段） */
interface Node {
  type: string
  [key: string]: any
}

/** 本地绑定：声明在文件内，或从其它模块导入 */
type Binding
  = | { kind: 'local', type: boolean }
    | { kind: 'import', from: string, imported: string, type: boolean }

const EXTENSIONS = ['ts', 'mts', 'tsx', 'js', 'mjs', 'jsx']
const SOURCE_GLOB = `*.{${EXTENSIONS.join(',')}}`
const IGNORE = ['**/node_modules/**', '**/*.d.{ts,mts}', '**/*.{test,spec}.*']

/** 目录 glob 转为文件 glob：`app/service` → `app/service/*.{ts,...}`，`app/service/**` → `app/service/**\/*.{ts,...}` */
export function filePattern(dir: string): string {
  const pattern = dir.replace(/^\.\//, '').replace(/\/+$/, '')
  const last = pattern.split('/').pop() ?? ''
  return last.includes('.')
    ? pattern
    : `${pattern}/${SOURCE_GLOB}`
}

/** 按目录顺序列出要扫描的文件（同一目录内按路径排序） */
export function scanFiles(srcDir: string, dirs: string[]): string[] {
  const files = new Set<string>()
  for (const dir of dirs) {
    const matched = globSync(filePattern(dir), { cwd: srcDir, absolute: true, ignore: IGNORE })
    for (const file of matched.map(normalizePath).sort())
      files.add(file)
  }
  return [...files]
}

/** 文件是否属于扫描目录 */
export function createMatcher(srcDir: string, dirs: string[]): (file: string) => boolean {
  const root = normalizePath(srcDir)
  const match = picomatch(dirs.map(filePattern), { ignore: IGNORE })
  return (file) => {
    const path = normalizePath(file)
    return path.startsWith(`${root}/`) && match(path.slice(root.length + 1))
  }
}

/** 默认导出的名字：`UserRegistered.ts` → `UserRegistered`，`send-receipt.ts` → `sendReceipt`，`user/index.ts` → `user` */
export function defaultExportName(file: string): string {
  let name = basename(file, extname(file))
  if (name === 'index')
    name = basename(dirname(file))
  const words = name.split(/[^\w$]+/).filter(Boolean)
  const identifier = words
    .map((word, index) => index === 0
      ? word
      : word[0].toUpperCase() + word.slice(1))
    .join('')
  return /^\d/.test(identifier)
    ? `_${identifier}`
    : identifier
}

/** 读取文件的导出（跟随相对路径的再导出，用于区分值与类型） */
export function scanFileExports(file: string): FileExports {
  const deps = new Set<string>()
  const exports = collect(normalizePath(file), deps, new Set())
  deps.delete(normalizePath(file))
  return {
    exports,
    deps: [...deps],
  }
}

function collect(file: string, deps: Set<string>, visiting: Set<string>): ScannedExport[] {
  if (visiting.has(file))
    return []
  visiting.add(file)
  deps.add(file)

  const { program } = parseSync(file, readFileSync(file, 'utf8'))
  const bindings = collectBindings(program.body as Node[])
  const result = new Map<string, ScannedExport>()
  const add = (name: string, type: boolean, origin = `${file}#${name}`, as = name): void => {
    if (!result.has(name))
      result.set(name, { name, as, type, origin })
  }
  /** 再导出：相对路径的模块读取它的导出判断是否只有类型，依赖包按值处理 */
  const reexport = (from: string, imported: string, exported: string, type: boolean): void => {
    const target = resolveRelative(file, from)
    const found = target
      ? collect(target, deps, visiting).find(item => item.name === imported)
      : undefined
    add(exported, type || Boolean(found?.type), found?.origin ?? `${target ?? from}#${imported}`)
  }

  for (const node of program.body as Node[]) {
    if (node.type === 'ExportNamedDeclaration') {
      const declaration = node.declaration as Node | null
      if (declaration) {
        const type = node.exportKind === 'type' || isTypeDeclaration(declaration)
        for (const name of declaredNames(declaration))
          add(name, type)
        continue
      }
      for (const specifier of node.specifiers as Node[]) {
        const local = nameOf(specifier.local)
        const exported = nameOf(specifier.exported)
        const type = node.exportKind === 'type' || specifier.exportKind === 'type'
        if (node.source) {
          reexport(node.source.value, local, exported, type)
          continue
        }
        const binding = bindings.get(local)
        if (binding?.kind === 'import')
          reexport(binding.from, binding.imported, exported, type || binding.type)
        else
          add(exported, type || Boolean(binding?.type))
      }
    }
    else if (node.type === 'ExportAllDeclaration') {
      const from = node.source.value as string
      if (node.exported) {
        add(nameOf(node.exported), node.exportKind === 'type', `${resolveRelative(file, from) ?? from}#*`)
        continue
      }
      // export * 不包含默认导出；依赖包的 export * 无法列出名字，跳过
      const target = resolveRelative(file, from)
      if (!target)
        continue
      for (const item of collect(target, deps, visiting)) {
        if (item.name !== 'default')
          add(item.name, node.exportKind === 'type' || item.type, item.origin)
      }
    }
    else if (node.type === 'ExportDefaultDeclaration') {
      const declaration = node.declaration as Node
      const id = declaration.id
        ? nameOf(declaration.id)
        : undefined
      const type = declaration.type === 'TSInterfaceDeclaration'
        || (declaration.type === 'Identifier' && Boolean(bindings.get(declaration.name)?.type))
      add('default', type, undefined, id ?? defaultExportName(file))
    }
  }

  visiting.delete(file)
  return [
    ...result.values(),
  ]
}

/** 文件顶层的绑定：声明是否只有类型、导入来自哪里 */
function collectBindings(body: Node[]): Map<string, Binding> {
  const bindings = new Map<string, Binding>()
  for (const node of body) {
    if (node.type === 'ImportDeclaration') {
      for (const specifier of node.specifiers as Node[]) {
        const local = nameOf(specifier.local)
        const type = node.importKind === 'type' || specifier.importKind === 'type'
        if (specifier.type === 'ImportSpecifier') {
          bindings.set(local, {
            kind: 'import',
            from: node.source.value,
            imported: nameOf(specifier.imported),
            type,
          })
        }
        else if (specifier.type === 'ImportDefaultSpecifier') {
          bindings.set(local, {
            kind: 'import',
            from: node.source.value,
            imported: 'default',
            type,
          })
        }
        else {
          bindings.set(local, { kind: 'local', type })
        }
      }
      continue
    }
    const declaration = node.type === 'ExportNamedDeclaration' || node.type === 'ExportDefaultDeclaration'
      ? node.declaration as Node | null
      : node
    if (!declaration)
      continue
    const type = isTypeDeclaration(declaration)
    for (const name of declaredNames(declaration)) {
      // 同名的值与类型（如 const X + type X）按值处理
      const previous = bindings.get(name)
      bindings.set(name, {
        kind: 'local',
        type: previous?.kind === 'local'
          ? previous.type && type
          : type,
      })
    }
  }
  return bindings
}

/** 声明是否只存在于类型层面（运行时没有对应的值） */
function isTypeDeclaration(node: Node): boolean {
  return node.type === 'TSInterfaceDeclaration'
    || node.type === 'TSTypeAliasDeclaration'
    || Boolean(node.declare)
}

function declaredNames(node: Node): string[] {
  switch (node.type) {
    case 'VariableDeclaration':
      return (node.declarations as Node[]).flatMap(item => patternNames(item.id))
    case 'FunctionDeclaration':
    case 'ClassDeclaration':
    case 'TSInterfaceDeclaration':
    case 'TSTypeAliasDeclaration':
    case 'TSEnumDeclaration':
    case 'TSModuleDeclaration':
      return node.id?.type === 'Identifier'
        ? [node.id.name]
        : []
    default:
      return []
  }
}

/** 解构声明中的变量名 */
function patternNames(node: Node | null): string[] {
  if (!node)
    return []
  switch (node.type) {
    case 'Identifier':
      return [node.name]
    case 'ObjectPattern':
      return (node.properties as Node[]).flatMap(item => patternNames(item.type === 'RestElement'
        ? item.argument
        : item.value))
    case 'ArrayPattern':
      return (node.elements as Array<Node | null>).flatMap(patternNames)
    case 'RestElement':
      return patternNames(node.argument)
    case 'AssignmentPattern':
      return patternNames(node.left)
    default:
      return []
  }
}

/** Identifier 或字符串字面量（`export { x as 'y' }`）的名字 */
function nameOf(node: Node): string {
  return node.type === 'Identifier'
    ? node.name
    : String(node.value)
}

/** 解析相对路径的模块（含 TS 的 `.js` → `.ts` 写法与目录 index）；依赖包返回 undefined */
function resolveRelative(importer: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.') && !isAbsolute(specifier))
    return undefined
  const base = resolve(dirname(importer), specifier)
  const stripped = base.replace(/\.[cm]?js$/, '')
  const candidates = [
    base,
    ...EXTENSIONS.map(ext => `${stripped}.${ext}`),
    ...EXTENSIONS.map(ext => `${base}/index.${ext}`),
  ]
  const found = candidates.find(path => existsSync(path) && statSync(path).isFile())
  return found && normalizePath(found)
}
