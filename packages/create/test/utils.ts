import type { ScaffoldResult, TemplateName } from '../src/scaffold'
import { spawn } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
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
export function createProject(template: TemplateName): ScaffoldResult & {
  edit: (file: string, from: string, to: string) => void
  read: (file: string) => string
  cleanup: () => void
} {
  const dir = join(testDir, '.tmp', `${template}-${process.pid}-${++counter}`)
  const result = scaffold({
    dir,
    template,
    name: `demo-${template}`,
    force: true,
  })
  return {
    ...result,
    read: file => readFileSync(join(result.root, file), 'utf8'),
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
  const loaded = (globalThis as Record<string, unknown>).__THINK_H3__envKeys as Set<string> | undefined
  const env = {
    ...process.env,
    ...extra,
  }
  loaded?.forEach(key => delete env[key])
  return env
}

export function run(script: string, args: string[], cwd: string): Promise<{ code: number, output: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd,
      env: childEnv({ CI: '1', NODE_ENV: 'test' }),
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

/** 启动生产产物并等待就绪 */
export async function startProduction(entry: string, cwd: string): Promise<{ url: string, stop: () => Promise<void> }> {
  const port = await freePort()
  const child = spawn(process.execPath, [entry], {
    cwd,
    env: childEnv({
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
