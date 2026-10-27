import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TEMPLATES = {
  api: '纯后端 API 服务',
  vue: 'Vue 3 全栈（同仓库、同端口、一次构建）',
  react: 'React 19 全栈（同仓库、同端口、一次构建）',
} as const

export type TemplateName = keyof typeof TEMPLATES

export interface ScaffoldOptions {
  /** 目标目录 */
  dir: string
  template: TemplateName
  /** 项目名（package.json name），默认取目录名 */
  name?: string
  /** 框架包的版本范围，默认使用 create-think-h3 自身的版本 */
  version?: string
  /** 目标目录非空时清空 */
  force?: boolean
}

export interface ScaffoldResult {
  root: string
  name: string
  files: string[]
}

const templatesDir = fileURLToPath(new URL('../templates', import.meta.url))

/** npm 发布时会丢弃 .gitignore，模板中以 _gitignore 存放 */
const RENAMES: Record<string, string> = { _gitignore: '.gitignore' }

export function scaffold(options: ScaffoldOptions): ScaffoldResult {
  const root = resolve(options.dir)
  const source = join(templatesDir, options.template)
  if (!existsSync(source))
    throw new Error(`Unknown template "${options.template}". Available: ${Object.keys(TEMPLATES).join(', ')}`)

  if (existsSync(root) && readdirSync(root).length) {
    if (!options.force)
      throw new Error(`Target directory ${root} is not empty. Use --force to overwrite.`)
    rmSync(root, { recursive: true, force: true })
  }

  const name = toPackageName(options.name ?? basename(root))
  const variables: Record<string, string> = {
    name,
    version: options.version ?? `^${ownVersion()}`,
  }

  cpSync(source, root, { recursive: true })
  const files = walk(root)
  for (const file of files) {
    const content = readFileSync(file, 'utf8')
    const replaced = content.replace(/\{\{(\w+)\}\}/g, (match, key: string) => variables[key] ?? match)
    if (replaced !== content)
      writeFileSync(file, replaced)
  }
  for (const file of files) {
    const target = RENAMES[basename(file)]
    if (target)
      renameSync(file, join(file, '..', target))
  }

  return {
    root,
    name,
    files: walk(root).map(file => relative(root, file)).sort(),
  }
}

export function toPackageName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^[._]+/, '')
    .replace(/[^a-z0-9\-~]+/g, '-') || 'think-h3-app'
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    return statSync(path).isDirectory()
      ? walk(path)
      : [path]
  })
}

function ownVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }
  return pkg.version
}
