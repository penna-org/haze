import { Buffer } from 'node:buffer'
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TEMPLATES = {
  api: '纯后端 API 服务',
  vue: 'Vue 3 全栈（同仓库、同端口、一次构建）',
  react: 'React 19 全栈（同仓库、同端口、一次构建）',
  module: '可发布的模块包（路由、中间件、配置与迁移，供其它项目在 config/modules.ts 中启用）',
} as const

export type TemplateName = keyof typeof TEMPLATES

export interface ScaffoldOptions {
  /** 目标目录 */
  dir: string
  template: TemplateName
  /** 项目名（package.json name），默认取目录名 */
  name?: string
  /** 框架包的版本范围，默认使用 create-hazejs 自身的版本 */
  version?: string
  /** 目标目录非空时清空 */
  force?: boolean
  /**
   * 生成 pnpm-workspace.yaml（声明依赖安装脚本的处理，pnpm 11 未声明时安装会报错）。
   * 默认只在目标目录不位于已有 pnpm workspace 中时生成，避免嵌套 workspace
   */
  pnpmWorkspace?: boolean
}

export interface ScaffoldResult {
  root: string
  name: string
  files: string[]
}

const templatesDir = fileURLToPath(new URL('../templates', import.meta.url))

/** npm 发布时会丢弃 .gitignore，模板中以 _gitignore 存放 */
const RENAMES: Record<string, string> = { _gitignore: '.gitignore' }

/**
 * pnpm 11 要求显式声明是否运行依赖的安装脚本，未声明时 install / run 会报错。
 * esbuild（drizzle-kit、tsx 引入）的二进制来自平台可选依赖，不需要运行安装脚本
 */
const PNPM_WORKSPACE = `# pnpm 11：依赖的安装脚本需要显式允许或忽略（新增需要构建的依赖时在此声明）
allowBuilds:
  esbuild: false
`

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
    // 每个项目独立的 APP_KEY（签名 Cookie、加密 Session、JWT 默认密钥）
    appKey: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url'),
    // 模块模板：模块名（配置键、路由名前缀）与表名前缀
    moduleName: camelCase(name),
    moduleTable: name.replace(/\W+/g, '_').replace(/^_+|_+$/g, ''),
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
  if (options.pnpmWorkspace ?? !findPnpmWorkspace(dirname(root)))
    writeFileSync(join(root, 'pnpm-workspace.yaml'), PNPM_WORKSPACE)

  return {
    root,
    name,
    files: walk(root).map(file => relative(root, file)).sort(),
  }
}

/** 向上查找所在的 pnpm workspace 根目录 */
function findPnpmWorkspace(from: string): string | undefined {
  for (let dir = from; ; dir = dirname(dir)) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml')))
      return dir
    if (dirname(dir) === dir)
      return undefined
  }
}

export function toPackageName(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/^[._]+/, '')
    .replace(/[^a-z0-9\-~]+/g, '-') || 'hazejs-app'
}

function camelCase(value: string): string {
  const camel = value.replace(/[^a-z0-9]+(.)?/gi, (_, char: string | undefined) => (char ?? '').toUpperCase())
  return /^\d/.test(camel)
    ? `m${camel}`
    : camel.replace(/^./, char => char.toLowerCase())
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
