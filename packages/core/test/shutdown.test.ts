import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// 使用构建产物（与生产入口相同的 serve()）：子进程中收到 SIGTERM 后优雅退出
const dist = fileURLToPath(new URL('../dist/index.mjs', import.meta.url))

const script = `
import { createApplication, defineRoutes } from ${JSON.stringify(dist)}
const app = await createApplication({
  mode: 'production',
  env: false,
  config: { logger: { level: 'silent' }, app: { key: 'k'.repeat(32), shutdownTimeout: '1s' } },
  routes: [defineRoutes(r => {
    // 永不结束的流（模拟 SSE / 长轮询这类长连接）
    r.get('/stream', () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: hi\\n\\n')) } }), { headers: { 'content-type': 'text/event-stream' } }))
  })],
})
const server = app.serve({ port: 0, hostname: '127.0.0.1', silent: true })
await server.ready()
console.log(new URL(server.url).port)
`

describe('graceful shutdown', () => {
  it('exits after shutdownTimeout even while a long-lived connection is open', async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const port = await new Promise<string>(resolve => child.stdout.once('data', chunk => resolve(String(chunk).trim())))
    const response = await fetch(`http://127.0.0.1:${port}/stream`)
    const reader = response.body!.getReader()
    await reader.read()

    const started = performance.now()
    const exited = new Promise<number | null>(resolve => child.once('exit', code => resolve(code)))
    child.kill('SIGTERM')
    const code = await exited
    const elapsed = performance.now() - started
    await reader.cancel().catch(() => {})
    expect(code).toBe(0)
    // 1 秒的超时后强制断开（不会一直等下去）
    expect(elapsed).toBeGreaterThan(900)
    expect(elapsed).toBeLessThan(5000)
  }, 15_000)
})
