import { execFile } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { stripVTControlCharacters } from 'node:util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// haze schedule:* / queue:* 在应用的依赖被外部化（Node 原生加载 @hazejs/core）时取到与应用相同的 core 实例

const testDir = dirname(fileURLToPath(import.meta.url))
const bin = join(testDir, '../bin/haze.mjs')
const root = join(testDir, '.tmp', `worker-${process.pid}`)

function write(file: string, content: string): void {
  mkdirSync(dirname(join(root, file)), { recursive: true })
  writeFileSync(join(root, file), content)
}

function haze(...args: string[]): Promise<{ code: number, output: string }> {
  return new Promise((resolve) => {
    // 去掉 Vitest 注入的测试标记，否则 consola 会隐藏命令的输出
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'NODE_ENV' && key !== 'TEST' && !key.startsWith('VITEST')))
    execFile(process.execPath, [bin, ...args, '--root', root], { cwd: root, env, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({
        code: error
          ? Number((error as { code?: number }).code ?? 1)
          : 0,
        output: stripVTControlCharacters(`${stdout}${stderr}`),
      })
    })
  })
}

beforeAll(() => {
  rmSync(root, { recursive: true, force: true })
  cpSync(join(testDir, '../../vite/test/fixtures/basic'), root, { recursive: true })
  // 与安装在 node_modules 中的依赖相同：应用代码中的 @hazejs/core 由 Node 原生加载（不经过 Vite 的模块图）
  write('haze.config.ts', `import { defineHazeConfig } from '@hazejs/vite'

export default defineHazeConfig({ vite: { ssr: { external: ['@hazejs/core'] } } })
`)
  write('app/job/Ping.ts', `import { defineJob } from '@hazejs/core'

export default defineJob({
  handle: () => console.log('ping ran'),
})
`)
  write('schedule/tasks.ts', `import { defineSchedule, useApp } from '@hazejs/core'
import Ping from '../app/job/Ping'

export default defineSchedule((s, app) => {
  s.call('hello', () => console.log(\`hello from \${useApp() === app ? 'the owning app' : 'another app'}\`)).everyMinute()
  s.job(Ping).hourly().onOneServer()
})
`)
})

afterAll(() => rmSync(root, { recursive: true, force: true }))

describe('worker commands with an externalized @hazejs/core', () => {
  it('schedule:list lists the tasks', async () => {
    const { code, output } = await haze('schedule:list')
    expect(code, output).toBe(0)
    expect(output).toMatch(/hello\s+\* \* \* \* \*\s+UTC\s+next /)
    expect(output).toMatch(/job:Ping\s+0 \* \* \* \*\s+UTC\s+next .*\(onOneServer\)/)
  })

  it('schedule:run runs due tasks in the application context', async () => {
    const { code, output } = await haze('schedule:run')
    expect(code, output).toBe(0)
    expect(output).toContain('hello from the owning app')
    expect(output).toContain('hello: ok')
  })

  it('queue:failed reads the application queue', async () => {
    const { code, output } = await haze('queue:failed')
    expect(code, output).toBe(0)
    expect(output).toContain('No failed jobs')
  })
}, 120_000)
