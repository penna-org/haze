import type { createProject as CreateProject } from './utils'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildServer, createDevServer } from '@think-h3/vite'
import { createBuilder, createServer } from 'vite'
import { afterEach, describe, expect, it } from 'vitest'
import { scaffold, toPackageName } from '../src/scaffold'
import { binOf, createProject, run, startProduction, waitFor } from './utils'

let project: ReturnType<typeof CreateProject> | undefined
afterEach(() => {
  project?.cleanup()
  project = undefined
})

async function json(url: string, init?: RequestInit): Promise<any> {
  return (await fetch(url, init)).json()
}

describe('scaffold', () => {
  it('copies the template, renames dotfiles and fills placeholders', () => {
    project = createProject('api')
    expect(project.files).toContain('.gitignore')
    expect(project.files).not.toContain('_gitignore')
    expect(JSON.parse(project.read('package.json'))).toMatchObject({
      name: 'demo-api',
      dependencies: { '@think-h3/core': '^0.0.0' },
    })
    for (const file of project.files)
      expect(project.read(file), file).not.toMatch(/\{\{\w+\}\}/)
  })

  it('refuses to overwrite a non-empty directory without force', () => {
    project = createProject('api')
    expect(() => scaffold({ dir: project!.root, template: 'api' })).toThrow(/not empty/)
    expect(() => scaffold({ dir: project!.root, template: 'nope' as 'api' })).toThrow(/Unknown template/)
  })

  it('normalizes package names', () => {
    expect(toPackageName('My App')).toBe('my-app')
    expect(toPackageName('.hidden')).toBe('hidden')
  })
})

describe('api template', () => {
  it('typechecks and passes its own tests', async () => {
    project = createProject('api')
    const tsc = await run(binOf('typescript', 'tsc'), ['--noEmit', '-p', 'tsconfig.json'], project.root)
    expect(tsc.output).toBe('')
    expect(tsc.code).toBe(0)

    const tests = await run(binOf('vitest'), ['run'], project.root)
    expect(tests.output).toContain('3 passed')
    expect(tests.code).toBe(0)
  })

  it('runs in dev with hot reload and builds for production', async () => {
    project = createProject('api')
    const dev = await createDevServer({ root: project.root, port: 0, debounce: 10 })
    try {
      expect((await json(new URL('/api/hello', dev.url).href)).data.message).toBe('Hello, think-h3!')
      await new Promise(resolve => setTimeout(resolve, 150))
      // eslint-disable-next-line no-template-curly-in-string -- 模板源码中的字面量
      project.edit('app/service/GreetingService.ts', '`Hello, ${name}!`', '`你好，${name}！`')
      await waitFor(async () => (await json(new URL('/api/hello', dev.url).href)).data.message === '你好，think-h3！')
    }
    finally {
      await dev.close()
    }

    const { entry } = await buildServer({ root: project.root })
    const server = await startProduction(entry, project.root)
    try {
      expect(await json(`${server.url}/api/hello`)).toEqual({
        code: 0,
        message: 'ok',
        data: { app: 'demo-api', message: '你好，think-h3！' },
      })
    }
    finally {
      await server.stop()
    }
  })
})

describe('vue template', () => {
  it('typechecks and passes its own tests', async () => {
    project = createProject('vue')
    const typecheck = await run(binOf('vue-tsc'), ['--build'], project.root)
    expect(typecheck.output).toBe('')
    expect(typecheck.code).toBe(0)

    const tests = await run(binOf('vitest'), ['run'], project.root)
    expect(tests.output).toContain('3 passed')
    expect(tests.code).toBe(0)
  })

  it('serves the Vue app and the API from one Vite dev server', async () => {
    project = createProject('vue')
    const vite = await createServer({
      root: project.root,
      logLevel: 'silent',
      server: { port: 0 },
    })
    await vite.listen()
    const base = vite.resolvedUrls!.local[0].replace(/\/$/, '')
    try {
      const html = await (await fetch(`${base}/`)).text()
      expect(html).toContain('<div id="app"></div>')
      expect(html).toContain('/@vite/client')
      expect((await fetch(`${base}/src/App.vue`)).status).toBe(200)
      // 前端路由由 Vite 回退到 index.html，/api 交给后端
      expect(await (await fetch(`${base}/about`, {
        headers: { accept: 'text/html' },
      })).text()).toContain('<div id="app"></div>')

      expect((await json(`${base}/api/hello`)).data).toEqual({ app: 'demo-vue', message: 'Hello, think-h3!' })
      const posted = await json(`${base}/api/hello`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Vue' }),
      })
      expect(posted.data).toEqual({ message: 'Hello, Vue!' })
      expect((await fetch(`${base}/api/nope`)).status).toBe(404)

      await new Promise(resolve => setTimeout(resolve, 150))
      // eslint-disable-next-line no-template-curly-in-string -- 模板源码中的字面量
      project.edit('server/app/service/GreetingService.ts', '`Hello, ${name}!`', '`Hi, ${name}!`')
      await waitFor(async () => (await json(`${base}/api/hello`)).data.message === 'Hi, think-h3!')
    }
    finally {
      await vite.close()
    }
  })

  it('builds client and server together and serves both in production', async () => {
    project = createProject('vue')
    const builder = await createBuilder({ root: project.root, logLevel: 'silent' })
    await builder.buildApp()

    const clientIndex = join(project.root, 'dist/client/index.html')
    const entry = join(project.root, 'dist/server/index.mjs')
    expect(existsSync(clientIndex)).toBe(true)
    expect(existsSync(entry)).toBe(true)
    const asset = readFileSync(clientIndex, 'utf8').match(/src="(\/assets\/[^"]+\.js)"/)![1]

    const server = await startProduction(entry, project.root)
    try {
      const page = await fetch(`${server.url}/`)
      expect(await page.text()).toContain('<div id="app"></div>')

      const js = await fetch(`${server.url}${asset}`)
      expect(js.status).toBe(200)
      expect(js.headers.get('cache-control')).toContain('immutable')

      const fallback = await fetch(`${server.url}/users/1`, {
        headers: { accept: 'text/html' },
      })
      expect(await fallback.text()).toContain('<div id="app"></div>')

      expect((await json(`${server.url}/api/hello`)).data.app).toBe('demo-vue')
      const missing = await fetch(`${server.url}/api/nope`, {
        headers: { accept: 'text/html' },
      })
      expect(missing.status).toBe(404)
      expect((await missing.json() as { code: number }).code).toBe(404)
    }
    finally {
      await server.stop()
    }
  })
})
