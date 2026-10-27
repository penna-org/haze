import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { cp, mkdir, writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, join } from 'node:path'

/** 数据库驱动：含原生二进制 / WASM / 可选原生依赖，不打包，运行时从 node_modules 加载 */
export const DRIVER_PACKAGES = [
  '@libsql/client',
  'libsql',
  '@electric-sql/pglite',
  'mongodb',
  'mysql2',
  'postgres',
]

/** Edge（Workers）上无法运行的驱动：构建时替换为调用即报错的空模块 */
export const EDGE_UNSUPPORTED_DRIVERS = [
  '@electric-sql/pglite',
  'mysql2',
  'mongodb',
  'libsql',
]

/** 匹配“除数据库驱动外的全部依赖”，用作 ssr.noExternal */
export const BUNDLE_ALL_EXCEPT_DRIVERS = new RegExp(`^(?!(?:${DRIVER_PACKAGES.map(name => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})(?:/|$))`)

const builtins = new Set(builtinModules)
/** 产物中的 import / export ... from / import() 语句（Rolldown 输出的规范格式） */
const IMPORT_RE = /(?:^|[;\n])\s*(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']|(?:^|[;\n])\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/g
const PACKAGE_RE = /^(?:@[\w.~-]+\/)?[\w.~-]+(?:\/.*)?$/

/** 扫描产物中的裸模块导入，得到运行时仍需要的包名 */
export function scanExternals(dir: string): string[] {
  const names = new Set<string>()
  for (const file of walk(dir)) {
    if (!/\.m?js$/.test(file))
      continue
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2] ?? match[3]
      // 跳过相对路径、运行时内置（node:、cloudflare: 等协议）与 Node 内置模块
      if (!specifier || !PACKAGE_RE.test(specifier) || specifier.startsWith('.') || builtins.has(specifier.split('/')[0]))
        continue
      names.add(packageName(specifier))
    }
  }
  return [...names].sort()
}

/** 项目依赖中的数据库驱动（ORM 通过动态 import 按需加载，扫描不到，需要显式带上） */
export function projectDrivers(root: string): string[] {
  const file = join(root, 'package.json')
  if (!existsSync(file))
    return []
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as { dependencies?: Record<string, string> }
  return DRIVER_PACKAGES.filter(name => name in (pkg.dependencies ?? {}))
}

export interface InstalledPackage {
  name: string
  version: string
  dir: string
}

/** 从 root 开始按 Node 解析规则查找已安装的包（跟随 pnpm 的符号链接） */
export function findInstalled(name: string, from: string): InstalledPackage | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', name, 'package.json')
    if (existsSync(candidate)) {
      const real = realpathSync(dirname(candidate))
      const { version } = JSON.parse(readFileSync(join(real, 'package.json'), 'utf8')) as { version: string }
      return { name, version, dir: real }
    }
    if (dirname(dir) === dir)
      return undefined
  }
}

/**
 * 把依赖（含传递依赖与已安装的可选依赖）复制为扁平的 node_modules，
 * 用于需要自带依赖的产物（AWS Lambda、Vercel 函数）。同名不同版本时嵌套到依赖方目录下。
 */
export async function copyDependencies(names: string[], from: string, target: string): Promise<InstalledPackage[]> {
  const copied = new Map<string, InstalledPackage>()

  async function copy(name: string, resolveFrom: string, into: string): Promise<void> {
    const found = findInstalled(name, resolveFrom)
    if (!found)
      return
    const existing = copied.get(name)
    if (existing && existing.version === found.version)
      return
    const destination = existing
      ? join(into, 'node_modules', name)
      : join(target, name)
    if (!existing)
      copied.set(name, found)
    await mkdir(dirname(destination), { recursive: true })
    await cp(found.dir, destination, {
      recursive: true,
      dereference: true,
      filter: source => !source.includes(`${found.dir}/node_modules`),
    })

    const pkg = JSON.parse(readFileSync(join(found.dir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
      optionalDependencies?: Record<string, string>
    }
    for (const dependency of Object.keys({
      ...pkg.dependencies,
      ...pkg.optionalDependencies,
    }))
      await copy(dependency, found.dir, destination)
  }

  for (const name of names)
    await copy(name, from, target)
  return [
    ...copied.values(),
  ]
}

/** 生成只包含运行时依赖的 package.json（Docker 中 npm install 使用） */
export async function writeRuntimePackageJson(file: string, root: string, names: string[]): Promise<void> {
  const manifest = join(root, 'package.json')
  const project = existsSync(manifest)
    ? JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }
    : {}
  const dependencies: Record<string, string> = {}
  for (const name of names) {
    const found = findInstalled(name, root)
    if (found)
      dependencies[name] = found.version
  }
  await writeFile(file, `${JSON.stringify({
    name: project.name ?? 'app',
    private: true,
    type: 'module',
    dependencies,
  }, null, 2)}\n`)
}

function packageName(specifier: string): string {
  const parts = specifier.split('/')
  return specifier.startsWith('@')
    ? parts.slice(0, 2).join('/')
    : parts[0]
}

function walk(dir: string): string[] {
  if (!existsSync(dir))
    return []
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules'
        ? []
        : walk(path)
    }
    return [path]
  })
}
