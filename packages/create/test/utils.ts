import type { ScaffoldResult, TemplateName } from '../src/scaffold'
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { scaffold } from '../src/scaffold'

const testDir = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
let counter = 0

/** 生成到 test/.tmp 下，依赖沿目录向上解析到 packages/create/node_modules */
export function createProject(template: TemplateName, options: { autoImport?: boolean } = {}): ScaffoldResult & {
  edit: (file: string, from: string, to: string) => void
  write: (file: string, content: string) => void
  read: (file: string) => string
  cleanup: () => void
} {
  const dir = join(testDir, '.tmp', `${template}-${process.pid}-${++counter}`)
  const result = scaffold({
    dir,
    template,
    name: `demo-${template}`,
    force: true,
    ...options,
  })
  return {
    ...result,
    read: file => readFileSync(join(result.root, file), 'utf8'),
    write(file, content) {
      mkdirSync(dirname(join(result.root, file)), { recursive: true })
      writeFileSync(join(result.root, file), content)
    },
    edit(file, from, to) {
      const path = join(result.root, file)
      const source = readFileSync(path, 'utf8')
      if (!source.includes(from))
        throw new Error(`"${from}" not found in ${file}`)
      writeFileSync(path, source.replace(from, to))
    },
    cleanup: () => rmSync(result.root, { recursive: true, force: true }),
  }
}

/** 解析某个包的可执行文件（从 create 包的依赖中查找） */
export function binOf(pkg: string, bin = pkg.split('/').pop()!): string {
  const pkgJson = require.resolve(`${pkg}/package.json`)
  const { bin: bins } = JSON.parse(readFileSync(pkgJson, 'utf8')) as { bin: string | Record<string, string> }
  return join(dirname(pkgJson), typeof bins === 'string'
    ? bins
    : bins[bin])
}

/**
 * 子进程环境：去掉本进程中由 .env 写入的变量（框架记录在全局集合里），
 * 否则前一个模板的 APP_NAME 会作为“真实环境变量”覆盖下一个模板的 .env
 */
function childEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
  const loaded = (globalThis as Record<string, unknown>).__HAZEJS__envKeys as Set<string> | undefined
  const env = {
    ...process.env,
    ...extra,
  }
  loaded?.forEach(key => delete env[key])
  // 未显式指定时去掉 Vitest 注入的测试标记（consola 在测试环境下会隐藏 info 输出）
  if (!('NODE_ENV' in extra)) {
    for (const key of Object.keys(env)) {
      if (key === 'NODE_ENV' || key === 'TEST' || key.startsWith('VITEST'))
        delete env[key]
    }
  }
  return env
}

export function run(script: string, args: string[], cwd: string, env: Record<string, string> = { NODE_ENV: 'test' }): Promise<{ code: number, output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: childEnv({ CI: '1', ...env }),
    })
    let output = ''
    child.stdout.on('data', chunk => (output += chunk))
    child.stderr.on('data', chunk => (output += chunk))
    child.on('close', code => resolve({ code: code ?? 1, output }))
  })
}

export function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

/**
 * 全栈模板启用了 csrf：先请求 /api/csrf-cookie，返回带会话 Cookie 与 X-XSRF-TOKEN 的请求头（与 src/api.ts 相同）
 */
export async function csrfHeaders(fetcher: (path: string) => Promise<Response>): Promise<Record<string, string>> {
  const res = await fetcher('/api/csrf-cookie')
  const cookies = res.headers.getSetCookie().map(cookie => cookie.split(';')[0])
  const xsrf = cookies.find(cookie => cookie.startsWith('XSRF-TOKEN='))
  if (!xsrf)
    throw new Error(`No XSRF-TOKEN cookie (status ${res.status})`)
  return {
    'cookie': cookies.join('; '),
    'x-xsrf-token': decodeURIComponent(xsrf.slice('XSRF-TOKEN='.length)),
  }
}

/** 启动生产产物并等待就绪 */
export async function startProduction(entry: string, cwd: string, env: Record<string, string> = {}): Promise<{ url: string, stop: () => Promise<void> }> {
  const port = await freePort()
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: childEnv({
      ...env,
      PORT: String(port),
      NODE_ENV: 'production',
    }),
    stdio: 'pipe',
  })
  const url = `http://localhost:${port}`
  await waitFor(async () => (await fetch(url)).status > 0)
  return {
    url,
    stop: async () => {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    },
  }
}

export async function waitFor(check: () => Promise<boolean>, timeout = 10_000): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeout) {
    try {
      if (await check())
        return
    }
    catch {}
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error('Timed out')
}

/** 直接读取 SQLite 文件（验证 db:migrate / db:seed 的结果） */
export async function sqliteRows(file: string, query: string): Promise<Array<Record<string, unknown>>> {
  const { createClient } = await import('@libsql/client')
  const client = createClient({ url: `file:${file}` })
  try {
    return (await client.execute(query)).rows.map(row => ({ ...row }))
  }
  finally {
    client.close()
  }
}

/** 连接、发送一条消息并收集前 count 条回复 */
export async function wsExchange(url: string, send: string, count: number): Promise<string[]> {
  const socket = new WebSocket(url)
  const messages: string[] = []
  socket.addEventListener('message', event => messages.push(String(event.data)))
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve())
    socket.addEventListener('error', () => reject(new Error(`WebSocket ${url} failed`)))
  })
  socket.send(send)
  for (let attempt = 0; attempt < 100 && messages.length < count; attempt++)
    await new Promise(resolve => setTimeout(resolve, 30))
  socket.close()
  return messages
}

/** socket.io-client 连接命名空间，返回收到的第一个 event 的数据 */
export async function socketIoFirst(url: string, event: string, options: Record<string, unknown> = {}): Promise<unknown> {
  const { io } = await import('socket.io-client')
  const socket = io(url, { reconnection: false, ...options })
  try {
    return await new Promise((resolve, reject) => {
      socket.once(event, resolve)
      socket.once('connect_error', reject)
      setTimeout(() => reject(new Error(`no ${event} from ${url}`)), 10_000)
    })
  }
  finally {
    socket.close()
  }
}
