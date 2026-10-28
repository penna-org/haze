import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { normalizePath } from 'vite'
import { findInstalled } from './presets'

/** 声明为 hazejs 模块的依赖包（package.json 的 `"hazejs": { "module": true }`） */
export interface ModulePackage {
  name: string
  /** 包的真实目录（跟随 pnpm / link: 的符号链接） */
  dir: string
  /** 链接进来的包（workspace / link:，真实路径不在 node_modules 中）：开发时由 Vite 处理，修改后热替换 */
  linked: boolean
}

interface PackageJson {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
  hazejs?: { module?: boolean }
}

/** 项目依赖中的 hazejs 模块包 */
export function findModulePackages(root: string): ModulePackage[] {
  const file = join(root, 'package.json')
  if (!existsSync(file))
    return []
  const pkg = JSON.parse(readFileSync(file, 'utf8')) as PackageJson
  const names = Object.keys({
    ...pkg.dependencies,
    ...pkg.devDependencies,
    ...pkg.optionalDependencies,
  })
  const found: ModulePackage[] = []
  for (const name of names) {
    const installed = findInstalled(name, root)
    if (!installed)
      continue
    let manifest: PackageJson
    try {
      manifest = JSON.parse(readFileSync(join(installed.dir, 'package.json'), 'utf8')) as PackageJson
    }
    catch {
      continue
    }
    if (!manifest.hazejs?.module)
      continue
    found.push({
      name,
      dir: normalizePath(installed.dir),
      linked: !installed.dir.split(sep).includes('node_modules'),
    })
  }
  return found.sort((a, b) => a.name.localeCompare(b.name))
}

/** 模块包中迁移文件在产物里的键：`node_modules/<包名>/<包内路径>` */
export function packagedMigrationKey(pkg: ModulePackage, path: string): string {
  return normalizePath(join('node_modules', pkg.name, relative(pkg.dir, path)))
}

const MIGRATION_URL_RE = /new\s+URL\(\s*(["'`])([^"'`$]+)\1\s*,\s*import\.meta\.url\s*\)/g

/**
 * 生产构建中模块包被打包进产物，`import.meta.url` 不再指向包目录。
 * 把指向迁移目录（含 meta/_journal.json）的 `new URL('../database/migrations', import.meta.url)`
 * 改写为内嵌迁移文件的键（与 virtual:haze/migrations 一致），其它 import.meta.url 保持不变
 */
export function rewriteMigrationUrls(code: string, file: string, pkg: ModulePackage): string | undefined {
  let changed = false
  const result = code.replace(MIGRATION_URL_RE, (match, _quote: string, path: string) => {
    const target = resolve(dirname(file), path)
    if (!existsSync(join(target, 'meta', '_journal.json')))
      return match
    changed = true
    return JSON.stringify(packagedMigrationKey(pkg, target))
  })
  return changed
    ? result
    : undefined
}

/** 模块包内的迁移文件（drizzle-kit 输出：*.sql 与 meta/_journal.json），键见 packagedMigrationKey */
export function packagedMigrationFiles(packages: readonly ModulePackage[]): Record<string, string> {
  const files: Record<string, string> = {}
  for (const pkg of packages) {
    for (const folder of migrationFolders(pkg.dir)) {
      for (const name of readdirSync(folder).filter(name => name.endsWith('.sql')).sort())
        files[packagedMigrationKey(pkg, join(folder, name))] = readFileSync(join(folder, name), 'utf8')
      const journal = join(folder, 'meta', '_journal.json')
      files[packagedMigrationKey(pkg, journal)] = readFileSync(journal, 'utf8')
    }
  }
  return files
}

/** 包内含 meta/_journal.json 的目录（跳过 node_modules） */
function migrationFolders(dir: string, depth = 0): string[] {
  if (depth > 4 || !existsSync(dir))
    return []
  const found = existsSync(join(dir, 'meta', '_journal.json'))
    ? [dir]
    : []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() && !['node_modules', 'meta', '.git'].includes(entry.name))
      found.push(...migrationFolders(join(dir, entry.name), depth + 1))
  }
  return found
}
