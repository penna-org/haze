import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/**
 * 从项目目录向上查找已安装包的 package.json。
 * 不使用 require.resolve('<pkg>/package.json')：部分包（如 drizzle-kit）未在 exports 中暴露它。
 */
export function findPackage(root: string, pkg: string): { dir: string, json: Record<string, any> } | undefined {
  for (let dir = root; ; dir = dirname(dir)) {
    const file = join(dir, 'node_modules', pkg, 'package.json')
    if (existsSync(file)) {
      return {
        dir: dirname(file),
        json: JSON.parse(readFileSync(file, 'utf8')),
      }
    }
    if (dirname(dir) === dir)
      return undefined
  }
}

/** 包的可执行文件路径 */
export function binOf(root: string, pkg: string, bin = pkg.split('/').pop()!): string {
  const found = findPackage(root, pkg)
  if (!found)
    throw new Error(`${pkg} is not installed. Run: pnpm add -D ${pkg}`)
  const bins = found.json.bin as string | Record<string, string> | undefined
  const path = typeof bins === 'string'
    ? bins
    : bins?.[bin]
  if (!path)
    throw new Error(`${pkg} has no "${bin}" executable`)
  return join(found.dir, path)
}
