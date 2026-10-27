import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { buildServer } from '../src'
import { copyFixture } from './utils'

let fixture: ReturnType<typeof copyFixture> | undefined

afterEach(() => {
  fixture?.cleanup()
  fixture = undefined
})

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer().listen(0, () => {
      const { port } = server.address() as { port: number }
      server.close(() => resolve(port))
    })
  })
}

describe('buildServer', () => {
  it('produces a runnable production entry', async () => {
    fixture = copyFixture('basic')
    const { entry } = await buildServer({ root: fixture.root })
    expect(existsSync(entry)).toBe(true)

    const port = await freePort()
    const child = spawn(process.execPath, [entry], {
      cwd: fixture.root,
      env: {
        ...process.env,
        PORT: String(port),
        NODE_ENV: 'production',
      },
      stdio: 'pipe',
    })
    try {
      const body = await poll(`http://localhost:${port}/name`)
      // .env 在运行时从工作目录加载
      expect(body).toEqual({
        code: 0,
        message: 'ok',
        data: { name: 'basic' },
      })

      const res = await fetch(`http://localhost:${port}/missing`)
      expect(res.status).toBe(404)
      expect(res.headers.get('x-handler')).toBe('custom')
    }
    finally {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
  })
})

async function poll(url: string, attempts = 50): Promise<unknown> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await (await fetch(url)).json()
    }
    catch {
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }
  throw new Error(`Server at ${url} did not start`)
}
