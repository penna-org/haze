import { execFile } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// haze route:list --json：stdout 只有 JSON（应用启动时的日志改写到 stderr）
const testDir = dirname(fileURLToPath(import.meta.url))
const bin = join(testDir, '../bin/haze.mjs')
const root = join(testDir, '.tmp', `routes-${process.pid}`)

function write(file: string, content: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), content)
}

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  cpSync(join(testDir, '../../vite/test/fixtures/basic'), root, { recursive: true })
  // 启动时写日志的提供者（模拟应用启动时输出到 stdout 的信息）
  write('app/provider/NoisyProvider.ts', `import { defineProvider } from '@hazejs/core'
export default defineProvider({ boot: () => { console.log('booting…') } })
`)
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('route:list --json', () => {
  it('prints only JSON on stdout', async () => {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_ENV' && key !== 'TEST' && !key.startsWith('VITEST')))
    const { stdout, stderr } = await new Promise<{ stdout: string, stderr: string }>((resolve, reject) => {
      execFile(process.execPath, [
        bin,
        'route:list',
        '--json',
        '--root',
        root,
      ], { cwd: root, env, timeout: 60_000 }, (error, stdout, stderr) => {
        if (error)
          reject(Object.assign(error, { stderr }))
        else
          resolve({ stdout, stderr })
      })
    })
    const routes = JSON.parse(stdout) as Array<{ method: string, path: string }>
    expect(routes.length).toBeGreaterThan(0)
    expect(stderr).toContain('booting…')
  }, 60_000)
})
