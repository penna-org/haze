import type { BinaryTarget, FinalizeContext, PresetContext } from './types'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { gunzipSync } from 'node:zlib'
import { NodeNativePackages } from 'nf3/db'
import { which } from '../preview'
import { findInstalled, scanExternals } from './deps'
import { BINARY_TARGETS } from './types'

/** 当前机器对应的目标平台 */
export function hostTarget(): BinaryTarget {
  const platform = process.platform === 'win32'
    ? 'windows'
    : process.platform
  const target = `${platform}-${process.arch}`
  if (!(BINARY_TARGETS as readonly string[]).includes(target))
    throw new Error(`Compiling a binary is not supported on ${process.platform}-${process.arch}. Pass --target (${BINARY_TARGETS.join(', ')})`)
  return target as BinaryTarget
}

/** 解析 `--target` / haze.config.ts 的 binary.targets（逗号分隔或数组），默认当前平台 */
export function resolveBinaryTargets(targets: string | readonly string[] | undefined): BinaryTarget[] {
  const names = (typeof targets === 'string'
    ? targets.split(',')
    : targets ?? [])
    .map(name => name.trim())
    .filter(Boolean)
  for (const name of names) {
    if (!(BINARY_TARGETS as readonly string[]).includes(name))
      throw new Error(`Unknown binary target "${name}". Available: ${BINARY_TARGETS.join(', ')}`)
  }
  return names.length
    ? [
        ...new Set(names),
      ] as BinaryTarget[]
    : [
        hostTarget(),
      ]
}

/** 可执行文件名：`<name>-<target>`，Windows 加 `.exe` */
export function binaryFileName(name: string, target: BinaryTarget): string {
  return `${name}-${target}${target.startsWith('windows-')
    ? '.exe'
    : ''}`
}

/** libsql 按平台发布的原生包（`@libsql/<target>`），没有对应包的平台不能使用 sqlite 驱动 */
const LIBSQL_TARGETS: Partial<Record<BinaryTarget, string>> = {
  'linux-x64': 'linux-x64-gnu',
  'linux-arm64': 'linux-arm64-gnu',
  'linux-x64-musl': 'linux-x64-musl',
  'linux-arm64-musl': 'linux-arm64-musl',
  'darwin-x64': 'darwin-x64',
  'darwin-arm64': 'darwin-arm64',
  'windows-x64': 'win32-x64-msvc',
}

/**
 * 已知能在二进制中运行的原生依赖：libsql 的 .node 按目标平台嵌入；
 * msgpackr-extract（bullmq）、mongodb 的压缩 / 加密扩展是可选的，加载失败时回退纯 JS
 */
const HANDLED_NATIVE = new Set([
  'libsql',
  'msgpackr-extract',
  '@mongodb-js/zstd',
  'mongodb-client-encryption',
])

/**
 * 由 Bun 执行的编译脚本（Bun.build 的 compile 模式），插件处理两类打包后无法运行的依赖：
 * - libsql 在运行时按平台 `require(\`@libsql/${target}\`)`：改为静态 require 目标平台的 .node，Bun 才会把它嵌入二进制
 * - `new URL('./x.wasm', import.meta.url)` 读取包内的资源文件（pglite 的 wasm / 数据包）：以文件形式嵌入，改为嵌入后的路径
 */
const BUN_COMPILE_SCRIPT = `// 由 haze build --compile 生成
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

const { entry, external, jobs } = JSON.parse(readFileSync(process.argv[2], 'utf8'))
const ASSET_RE = /new URL\\(\\s*(["'])\\.\\/([^"'\\\\]+)\\1\\s*,\\s*import\\.meta\\.url\\s*\\)/g
const LIBSQL_RE = /require\\(\`@libsql\\/\\$\\{target\\}\`\\)/

for (const job of jobs) {
  const plugin = {
    name: 'hazejs-compile',
    setup(build) {
      if (job.libsql) {
        build.onLoad({ filter: /[\\\\/]libsql[\\\\/]index\\.js$/ }, ({ path }) => {
          const code = readFileSync(path, 'utf8')
          if (!LIBSQL_RE.test(code))
            throw new Error('Unsupported libsql version: the native loader was not found in ' + path)
          return { contents: code.replace(LIBSQL_RE, 'require(' + JSON.stringify(job.libsql) + ')'), loader: 'js' }
        })
      }
      build.onLoad({ filter: /[\\\\/]node_modules[\\\\/].*\\.m?js$/ }, ({ path }) => {
        const code = readFileSync(path, 'utf8')
        if (!code.includes('import.meta.url'))
          return { contents: code, loader: 'js' }
        const imports = new Map()
        const contents = code.replace(ASSET_RE, (match, quote, file) => {
          const asset = join(dirname(path), file)
          // 脚本（worker 等）与不存在的文件保持原样
          if (/\\.[cm]?[jt]s$/.test(file) || !existsSync(asset))
            return match
          if (!imports.has(asset))
            imports.set(asset, '__haze_asset_' + imports.size)
          // 嵌入后的路径（POSIX 为 /$bunfs/root/…，Windows 为盘符路径）转为 file URL
          return '__haze_file_url(' + imports.get(asset) + ')'
        })
        const header = [
          ...(imports.size ? ['import { pathToFileURL as __haze_file_url } from "node:url";'] : []),
          ...[...imports].map(([asset, id]) => 'import ' + id + ' from ' + JSON.stringify(asset) + ' with { type: "file" };'),
        ].join('\\n')
        return { contents: header ? header + '\\n' + contents : contents, loader: 'js' }
      })
    },
  }
  const result = await Bun.build({
    entrypoints: [entry],
    compile: {
      target: job.target,
      outfile: job.outfile,
      // .env 由应用按 haze 的规则加载（模式文件、变量优先级）
      autoloadDotenv: false,
      autoloadBunfig: false,
    },
    external,
    minify: true,
    sourcemap: 'inline',
    plugins: [plugin],
  })
  if (!result.success) {
    for (const log of result.logs)
      console.error(log)
    process.exit(1)
  }
  // source map 已嵌入可执行文件（错误堆栈指向源码），旁边的 .map 不需要
  for (const output of result.outputs) {
    if (output.path.endsWith('.map'))
      rmSync(output.path, { force: true })
  }
}
`

interface CompileJob {
  /** Bun 的编译目标，如 `bun-linux-x64` */
  target: string
  outfile: string
  /** 嵌入的 libsql 原生模块（.node 的绝对路径） */
  libsql?: string
}

/**
 * 用 Bun 把 binary 预设的产物编译为各平台的独立可执行文件（`bun build --compile`）：
 * 依赖从项目的 node_modules 重新打包进二进制，未安装的可选驱动保持 external（只在使用时报错）
 */
export async function compileBinaries(context: FinalizeContext, log: (message: string) => void): Promise<string[]> {
  const bun = which('bun')
  if (!bun)
    throw new Error('Compiling a binary needs Bun (https://bun.sh) on the build machine')
  const name = binaryName(context)
  const targets = resolveBinaryTargets(context.binary?.targets)
  const entry = join(context.layout.serverDir, 'index.mjs')

  // 产物中的裸导入：未安装的（ORM 以字面量导入全部驱动）保持 external
  const imported = scanExternals(context.layout.serverDir)
  const external = imported.filter(pkg => !findInstalled(pkg, context.root))
  const native = imported.filter(pkg => NodeNativePackages.includes(pkg) && !HANDLED_NATIVE.has(pkg))
  if (native.length)
    log(`These native packages load platform binaries at runtime and may not work inside the executable: ${native.join(', ')}. Prefer a pure JS / WASM alternative, or test the binary on each target`)

  const libsql = findLibsql(context.root)
  const jobs: CompileJob[] = []
  for (const target of targets) {
    const job: CompileJob = {
      target: `bun-${target}`,
      outfile: join(context.outDir, binaryFileName(name, target)),
    }
    if (libsql) {
      const pkg = LIBSQL_TARGETS[target]
      if (!pkg)
        throw new Error(`The sqlite driver (libsql) has no native binary for ${target}`)
      job.libsql = await nativeAddon(`@libsql/${pkg}`, libsql.version, libsql.dir, context.root)
    }
    jobs.push(job)
  }

  const workDir = join(context.root, '.haze', 'binary')
  await mkdir(workDir, { recursive: true })
  const script = join(workDir, 'compile.mjs')
  await writeFile(script, BUN_COMPILE_SCRIPT)
  await writeFile(join(workDir, 'compile.json'), JSON.stringify({ entry, external, jobs }))
  for (const job of jobs)
    await rm(job.outfile, { force: true })
  await run(bun, [
    script,
    join(workDir, 'compile.json'),
  ], context.root)
  return jobs.map(job => job.outfile)
}

function findLibsql(root: string): { version: string, dir: string } | undefined {
  const client = findInstalled('@libsql/client', root)
  return client && findInstalled('libsql', client.dir)
}

/**
 * 目标平台的原生包：与 libsql 同版本，优先使用已安装的（当前平台），
 * 否则从 npm registry 下载到 `node_modules/.cache/hazejs/native`
 */
async function nativeAddon(pkg: string, version: string, from: string, root: string): Promise<string> {
  const installed = findInstalled(pkg, from)
  if (installed?.version === version)
    return join(installed.dir, 'index.node')
  const dir = join(root, 'node_modules', '.cache', 'hazejs', 'native', `${pkg}@${version}`)
  const file = join(dir, 'index.node')
  if (existsSync(file))
    return file
  const registry = (process.env.npm_config_registry || 'https://registry.npmjs.org/').replace(/\/?$/, '/')
  // 先取该版本的元数据：下载的压缩包必须与 registry 记录的 dist.integrity 一致，才会解包并嵌入二进制
  const metaUrl = `${registry}${pkg.replace('/', '%2f')}/${version}`
  const meta = await fetch(metaUrl, {
    headers: { accept: 'application/json' },
  })
  if (!meta.ok)
    throw new Error(`Failed to fetch the metadata of ${pkg}@${version} (${meta.status} ${metaUrl})`)
  const { dist } = await meta.json() as { dist?: { integrity?: string } }
  const url = `${registry}${pkg}/-/${pkg.split('/').pop()}-${version}.tgz`
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`Failed to download ${pkg}@${version} (${response.status} ${url})`)
  const tarball = new Uint8Array(await response.arrayBuffer())
  verifyIntegrity(tarball, dist?.integrity, `${pkg}@${version}`)
  for (const [path, content] of untar(gunzipSync(tarball))) {
    // npm 包的文件都在 package/ 下
    const target = join(dir, path.replace(/^package\//, ''))
    if (!target.startsWith(dir))
      continue
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  if (!existsSync(file))
    throw new Error(`${pkg}@${version} does not contain index.node`)
  return file
}

/**
 * 校验下载内容与 npm 的 SRI（`dist.integrity`，如 `sha512-<base64>`）一致：
 * 只接受 sha512，缺失或不一致时抛错（构建失败），不嵌入未经校验的原生模块
 */
export function verifyIntegrity(data: Uint8Array, integrity: string | undefined, label: string): void {
  const expected = integrity?.split(/\s+/).find(item => item.startsWith('sha512-'))
  if (!expected)
    throw new Error(`Cannot verify ${label}: the registry metadata has no sha512 integrity`)
  const actual = `sha512-${createHash('sha512').update(data).digest('base64')}`
  // SRI 可带 `?选项` 后缀
  if (expected.split('?')[0] !== actual)
    throw new Error(`Integrity check failed for ${label}: expected ${expected}, got ${actual}`)
}

/** 读取 tar（ustar）中的普通文件 */
function untar(data: Uint8Array): [path: string, content: Uint8Array][] {
  const files: [string, Uint8Array][] = []
  const text = (start: number, length: number): string => {
    const bytes = data.subarray(start, start + length)
    const end = bytes.indexOf(0)
    return new TextDecoder().decode(end === -1
      ? bytes
      : bytes.subarray(0, end))
  }
  for (let offset = 0; offset + 512 <= data.length;) {
    const name = text(offset, 100)
    if (!name)
      break
    const size = Number.parseInt(text(offset + 124, 12).trim() || '0', 8)
    const type = text(offset + 156, 1)
    const prefix = text(offset + 345, 155)
    if (type === '' || type === '0') {
      files.push([
        prefix
          ? `${prefix}/${name}`
          : name,
        data.subarray(offset + 512, offset + 512 + size),
      ])
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return files
}

function run(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.once('error', reject)
    child.once('exit', code => code === 0
      ? resolve()
      : reject(new Error(`bun build --compile exited with code ${code}`)))
  })
}

/** 可执行文件名（不含平台后缀） */
export function binaryName(context: PresetContext): string {
  return context.binary?.name ?? projectName(context.root)
}

/** package.json 的 name（去掉 scope），用作镜像名、Worker 名与可执行文件名 */
export function projectName(root: string): string {
  const file = join(root, 'package.json')
  const name = existsSync(file)
    ? (JSON.parse(readFileSync(file, 'utf8')) as { name?: string }).name
    : undefined
  return (name ?? 'hazejs-app').replace(/^@[^/]+\//, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase()
}
