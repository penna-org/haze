import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { traceNodeModules } from 'nf3'
import { NodeNativePackages, NonBundleablePackages } from 'nf3/db'

/** 数据库驱动：含原生二进制 / WASM / 可选原生依赖，不打包，运行时从 node_modules 加载（或追踪进产物） */
export const DRIVER_PACKAGES = [
  // 文件存储（S3）与邮件（SES / SMTP）：可选安装，未安装时替换为空模块
  '@aws-sdk/client-s3',
  '@aws-sdk/client-sesv2',
  '@aws-sdk/lib-storage',
  '@aws-sdk/s3-request-presigner',
  '@libsql/client',
  // 通行密钥（WebAuthn）：core 的可选依赖，未安装时替换为空模块
  '@simplewebauthn/server',
  '@socket.io/bun-engine',
  '@socket.io/redis-adapter',
  '@upstash/redis',
  'bullmq',
  'ioredis',
  'libsql',
  '@electric-sql/pglite',
  'mongodb',
  'mysql2',
  'nodemailer',
  'postgres',
  // Socket.IO 服务端（engine.io / ws）：保持 external 并追踪进产物
  'socket.io',
]

/** Edge（Workers）上无法运行的驱动：构建时替换为调用即报错的空模块 */
export const EDGE_UNSUPPORTED_DRIVERS = [
  '@electric-sql/pglite',
  // TCP 长连接；Workers 上请用 upstash（HTTP）或 KV，队列用 Cloudflare Queues，实时通信用 r.ws()
  '@socket.io/bun-engine',
  '@socket.io/redis-adapter',
  'bullmq',
  'socket.io',
  'ioredis',
  'mysql2',
  'mongodb',
  'libsql',
  // SMTP（TCP）：Workers 上请用 resend / postmark / mailgun / ses 等 HTTP 接口的邮件驱动
  'nodemailer',
]

/** 匹配“除给定包外的全部依赖”，用作 ssr.noExternal */
export function bundleAllExcept(names: string[]): RegExp {
  return new RegExp(`^(?!(?:${names.map(name => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})(?:/|$))`)
}

/**
 * 匹配给定包（含子路径）的正则，用作 Rolldown 的 external：
 * 不经 Vite 解析直接保留导入，项目未安装的可选驱动（如 drizzle-orm 的 mysql2 / pglite）
 * 不会被替换为没有导出的空模块而导致构建失败
 */
export function externalPattern(names: string[]): RegExp {
  return new RegExp(`^(?:${names.map(name => name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|')})(?:/|$)`)
}

/** 依赖处理选项（haze.config.ts 的 externals） */
export interface ExternalsOptions {
  /**
   * 构建后把仍为 external 的依赖按实际引用的文件追踪复制到产物的 node_modules（node / bun / deno），默认 true。
   * false 时 node / bun 不打包依赖，运行时从项目的 node_modules 加载。aws-lambda / vercel 始终追踪。
   */
  trace?: boolean
  /**
   * 保持 external 并追踪进产物的包（默认已包含数据库驱动与已知的原生 / 无法打包的包）。
   * `pkg*` 表示整包复制（运行时动态读取文件、静态分析不到时）。
   */
  traceDeps?: string[]
  /** 强制打包进产物的包（覆盖默认的 external 列表） */
  inline?: string[]
}

/** 不打包、运行时从 node_modules 加载的包：数据库驱动、原生模块、已知无法打包的包与 traceDeps */
export function externalPackages(options: ExternalsOptions = {}): string[] {
  const inline = new Set(options.inline)
  return [
    ...new Set([
      ...DRIVER_PACKAGES,
      ...NodeNativePackages,
      ...NonBundleablePackages,
      ...(options.traceDeps ?? []).map(name => name.replace(/\*$/, '')),
    ]),
  ].filter(name => !inline.has(name))
}

/** 按平台发布的原生二进制包，如 @libsql/darwin-arm64、@rollup/rollup-linux-x64-gnu */
const PLATFORM_PACKAGE_RE = /(?:^|[-/])(?:darwin|win32|linux|freebsd)-(?:x64|arm64|ia32|arm)/

export interface TraceResult {
  /** 复制进产物的包（含传递依赖） */
  packages: string[]
  /** 构建机与目标平台不一致的原生包 */
  foreignNative: string[]
}

/**
 * 用 nf3（@vercel/nft）从产物入口追踪运行时实际加载的文件，复制为 `<serverDir>/node_modules`。
 * 同名多版本放在 `node_modules/.nf3/<name>@<version>` 并链接到依赖方。
 */
export async function traceDependencies(serverDir: string, root: string, options: {
  conditions?: string[]
  traceDeps?: string[]
  /** 目标运行平台（Lambda / Vercel 为 linux），用于检查原生包 */
  platform?: NodeJS.Platform
}): Promise<TraceResult> {
  const inputs = walk(serverDir).filter(file => /\.m?js$/.test(file) && !file.startsWith(join(serverDir, 'client')))
  const names = options.traceDeps ?? []
  const layout = await traceNodeModules(inputs, {
    rootDir: root,
    outDir: serverDir,
    ...(options.conditions && {
      conditions: [...options.conditions, 'import', 'default'],
    }),
    traceInclude: names.filter(name => !name.endsWith('*')),
    fullTraceInclude: names.filter(name => name.endsWith('*')).map(name => name.slice(0, -1)),
    chmod: true,
  })
  const packages = Object.keys(layout.packages).sort()
  const platform = options.platform ?? process.platform
  const foreign = platform === process.platform
    ? []
    : packages.filter(name => PLATFORM_PACKAGE_RE.test(name) || NodeNativePackages.includes(name))
  return { packages, foreignNative: foreign }
}

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
