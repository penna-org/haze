import type { ChildProcess } from 'node:child_process'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Logger } from 'vite'
import type { BuildInfo } from './plugin'
import type { PresetName } from './presets'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { toNodeHandler } from 'srvx/node'

/** 构建结果记录（`.think/build.json`），供 `vite preview` / `think-h3 preview` 使用 */
export interface BuildManifest extends Pick<BuildInfo, 'preset' | 'layout' | 'entry'> {
  fullstack: boolean
  prefixes: string[]
}

type NodeHandler = (req: IncomingMessage, res: ServerResponse) => unknown
type FetchHandler = (request: Request) => Promise<Response> | Response

export interface PreviewServer {
  /** 是否交给产物处理；其余请求由 Vite 托管前端静态文件 */
  matches: (url: string) => boolean
  handle: NodeHandler
  close: () => Promise<void>
}

export function manifestFile(root: string): string {
  return join(root, '.think', 'build.json')
}

export function writeBuildManifest(root: string, manifest: BuildManifest): void {
  const file = manifestFile(root)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
}

export function readBuildManifest(root: string): BuildManifest {
  const file = manifestFile(root)
  if (!existsSync(file))
    throw new Error('No build found. Run `vite build` (or `think-h3 build`) before previewing.')
  return JSON.parse(readFileSync(file, 'utf8')) as BuildManifest
}

/** 前端静态文件由 Vite 托管的预设（产物中由平台 CDN 提供），其余预设的产物自己托管全部请求 */
export function staticDirOf(manifest: BuildManifest): string | undefined {
  return manifest.fullstack && !manifest.layout.staticFromServer
    ? manifest.layout.clientDir
    : undefined
}

/**
 * 按部署预设运行**构建产物**（而不是源码）：
 * - node / bun / deno / docker：在随机端口启动产物进程，请求全部转发给它
 * - aws-lambda / vercel / netlify：进程内加载函数 handler
 * - cloudflare：用 Miniflare（workerd）运行 Worker，绑定来自 wrangler.json
 */
export async function startPreview(root: string, manifest: BuildManifest, logger: Logger): Promise<PreviewServer> {
  const prefixes = manifest.prefixes
  // 静态文件由 Vite 托管时，只把后端前缀交给产物
  const matches = staticDirOf(manifest)
    ? (url: string) => prefixes.some(prefix => url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`))
    : () => true

  switch (manifest.preset) {
    case 'node':
    case 'bun':
    case 'deno':
    case 'docker':
      return {
        matches,
        ...await startProcess(root, manifest),
      }
    case 'aws-lambda': {
      const { lambdaResultToResponse, requestToLambdaEvent } = await import('@think-h3/core')
      const { handler } = await importEntry(manifest.entry)
      return fetchPreview(matches, async request => lambdaResultToResponse(await handler(await requestToLambdaEvent(request))))
    }
    case 'vercel': {
      const { default: handler } = await importEntry(manifest.entry)
      return {
        matches,
        handle: handler,
        close: async () => {},
      }
    }
    case 'netlify': {
      const { default: handler } = await importEntry(join(root, '.netlify', 'v1', 'functions', 'think-h3-server.mjs'))
      return fetchPreview(matches, request => handler(request, {}))
    }
    case 'cloudflare':
      return {
        ...await startWorker(root, manifest, logger),
        matches,
      }
  }
}

function fetchPreview(matches: PreviewServer['matches'], fetch: FetchHandler, close = async () => {}): PreviewServer {
  // Vite 的 connect 服务器是 HTTP/1；srvx 的类型同时覆盖 HTTP/2，这里按 HTTP/1 使用
  return {
    matches,
    handle: toNodeHandler(fetch) as unknown as NodeHandler,
    close,
  }
}

async function importEntry(file: string): Promise<Record<string, any>> {
  // 每次预览都重新加载产物（同一进程内多次构建时避免模块缓存）
  return import(`${pathToFileURL(file).href}?t=${Date.now()}`)
}

/** 产物按预设的运行时构建（bun / deno 的导出条件），必须用对应运行时执行 */
function runtimeCommand(root: string, preset: PresetName, entry: string): string[] {
  if (preset === 'bun') {
    const bun = which('bun')
    if (!bun)
      throw new Error('Previewing the bun build needs Bun (https://bun.sh)')
    return [bun, entry]
  }
  if (preset === 'deno') {
    const deno = which('deno')
    if (deno)
      return [deno, 'run', '-A', entry]
    // npm 的 deno 包（pnpm add -D deno）
    try {
      return [
        process.execPath,
        createRequire(join(root, 'package.json')).resolve('deno/bin.cjs'),
        'run',
        '-A',
        entry,
      ]
    }
    catch {
      throw new Error('Previewing the deno build needs Deno (https://deno.com) or the deno npm package')
    }
  }
  return [process.execPath, entry]
}

async function startProcess(root: string, manifest: BuildManifest): Promise<Omit<PreviewServer, 'matches'>> {
  const port = await freePort()
  const [command, ...args] = runtimeCommand(root, manifest.preset, manifest.entry)
  const child = spawn(command, args, {
    // 与 think-h3 start 一致：.env 从项目根目录加载
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      PORT: String(port),
      HOST: '127.0.0.1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  // 产物的日志原样输出
  child.stdout?.pipe(process.stdout)
  child.stderr?.pipe(process.stderr)
  const origin = `http://127.0.0.1:${port}`
  await waitUntilReady(origin, child)
  return {
    handle: toNodeHandler(request => forward(request, origin)) as unknown as NodeHandler,
    close: () => stopProcess(child),
  }
}

/** 转发到产物进程（去掉逐跳头；fetch 已解压响应体，去掉对应的编码头） */
async function forward(request: Request, origin: string): Promise<Response> {
  const url = new URL(request.url)
  const headers = new Headers(request.headers)
  for (const name of [
    'host',
    'connection',
    'keep-alive',
    'transfer-encoding',
    'upgrade',
  ])
    headers.delete(name)
  headers.set('x-forwarded-host', url.host)
  headers.set('x-forwarded-proto', url.protocol.slice(0, -1))
  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'
  const response = await fetch(new URL(url.pathname + url.search, origin), {
    method: request.method,
    headers,
    body: hasBody
      ? request.body
      : undefined,
    redirect: 'manual',
    // Node 的 fetch 发送流式请求体需要 duplex
    duplex: 'half',
  })
  const out = new Headers(response.headers)
  out.delete('content-encoding')
  out.delete('content-length')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers: out })
}

async function startWorker(root: string, manifest: BuildManifest, logger: Logger): Promise<PreviewServer> {
  const dir = manifest.layout.serverDir
  const wrangler = JSON.parse(readFileSync(join(dir, 'wrangler.json'), 'utf8')) as {
    compatibility_date?: string
    compatibility_flags?: string[]
    vars?: Record<string, string>
    d1_databases?: { binding: string, database_id?: string, database_name?: string, migrations_dir?: string }[]
    kv_namespaces?: { binding: string, id?: string }[]
  }
  let Miniflare: typeof import('miniflare').Miniflare
  try {
    const require = createRequire(join(root, 'package.json'))
    ;({ Miniflare } = await import(pathToFileURL(require.resolve('miniflare')).href))
  }
  catch {
    throw new Error(`Previewing the cloudflare build needs miniflare (pnpm add -D miniflare), or run: npx wrangler dev -c ${join(dir, 'wrangler.json')}`)
  }
  // 本地数据持久化在 .think/preview，多次预览之间保留
  const persist = join(root, '.think', 'preview')
  const d1 = wrangler.d1_databases ?? []
  const mf = new Miniflare({
    modules: true,
    scriptPath: manifest.entry,
    compatibilityDate: wrangler.compatibility_date,
    compatibilityFlags: wrangler.compatibility_flags,
    bindings: wrangler.vars ?? {},
    d1Databases: Object.fromEntries(d1.map(database => [database.binding, database.database_id ?? database.binding])),
    d1Persist: join(persist, 'd1'),
    kvNamespaces: Object.fromEntries((wrangler.kv_namespaces ?? []).map(namespace => [namespace.binding, namespace.id ?? namespace.binding])),
    kvPersist: join(persist, 'kv'),
  })
  // 与 wrangler d1 migrations apply --local 相同：按文件名执行尚未执行的迁移（记录在 d1_migrations 表）
  for (const database of d1) {
    const applied = await applyD1Migrations(await mf.getD1Database(database.binding), join(dir, database.migrations_dir ?? 'migrations'))
    if (applied.length)
      logger.info(`[think-h3] D1 ${database.database_name ?? database.binding}: applied ${applied.join(', ')}`)
  }
  return fetchPreview(() => true, request => mf.dispatchFetch(request.url, {
    method: request.method,
    headers: request.headers as never,
    body: request.body as never,
    redirect: 'manual',
    duplex: 'half',
  }) as unknown as Promise<Response>, () => mf.dispose())
}

interface D1Like {
  exec: (query: string) => Promise<unknown>
  prepare: (query: string) => { bind: (...values: unknown[]) => { run: () => Promise<unknown> }, all: () => Promise<{ results: Record<string, unknown>[] }> }
  batch: (statements: unknown[]) => Promise<unknown>
}

async function applyD1Migrations(db: D1Like, dir: string): Promise<string[]> {
  if (!existsSync(dir))
    return []
  await db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)')
  const done = new Set((await db.prepare('SELECT name FROM d1_migrations').all()).results.map(row => row.name))
  const applied: string[] = []
  for (const file of readdirSync(dir).filter(file => file.endsWith('.sql')).sort()) {
    if (done.has(file))
      continue
    const statements = readFileSync(join(dir, file), 'utf8').split('--> statement-breakpoint').filter(statement => statement.trim())
    await db.batch([
      ...statements.map(statement => db.prepare(statement)),
      db.prepare('INSERT INTO d1_migrations (name) VALUES (?)').bind(file),
    ])
    applied.push(file)
  }
  return applied
}

async function waitUntilReady(origin: string, child: ChildProcess): Promise<void> {
  const exited = (): boolean => child.exitCode !== null || child.signalCode !== null
  for (let attempt = 0; attempt < 150 && !exited(); attempt++) {
    try {
      await fetch(origin, { redirect: 'manual' })
      return
    }
    catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  child.kill()
  throw new Error(exited()
    ? 'The built server exited before it started listening'
    : `The built server did not respond on ${origin}`)
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null)
    return Promise.resolve()
  return new Promise((resolve) => {
    child.once('exit', () => resolve())
    child.kill('SIGTERM')
  })
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer().listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    }).on('error', reject)
  })
}

function which(command: string): string | undefined {
  try {
    return execFileSync(process.platform === 'win32'
      ? 'where'
      : 'which', [command], { encoding: 'utf8' }).split('\n')[0].trim() || undefined
  }
  catch {
    return undefined
  }
}
