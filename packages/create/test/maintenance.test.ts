import type { createProject as CreateProject } from './utils'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { createDevServer } from '@hazejs/vite'
import { afterEach, describe, expect, it } from 'vitest'
import { binOf, createProject, run, waitFor } from './utils'

let project: ReturnType<typeof CreateProject> | undefined
afterEach(() => {
  project?.cleanup()
  project = undefined
})

/** 不传 NODE_ENV=test，否则 consola 会隐藏命令的输出 */
function haze(...args: string[]) {
  return run(binOf('@hazejs/cli', 'haze'), [...args, '--root', project!.root], project!.root, {})
}

describe('maintenance mode', () => {
  it('haze down / up take effect on a running dev server without a restart', async () => {
    project = createProject('api')
    const view = await haze('make:view', 'Maintenance')
    expect(view.code, view.output).toBe(0)

    const dev = await createDevServer({ root: project.root, port: 0, debounce: 10 })
    try {
      const url = (path: string) => new URL(path, dev.url).href
      expect((await fetch(url('/api/hello'))).status).toBe(200)
      expect((await fetch(url('/'))).status).toBe(200)
      const app = dev.app

      const down = await haze('down', '--secret', 'open-sesame', '--render', 'Maintenance', '--except', '/api/hello', '--retry', '15')
      expect(down.code, down.output).toBe(0)
      // 模板的缓存默认是进程内的 memory 存储：改用文件并给出提示
      expect(down.output).toContain('in-process memory store')
      expect(down.output).toContain('Bypass: visit /open-sesame')
      expect(existsSync(join(project.root, 'storage/framework/down'))).toBe(true)

      // 开发服务器在进程内缓存的时间（2 秒）内生效
      await waitFor(async () => (await fetch(url('/api/users'))).status === 503)
      const blocked = await fetch(url('/api/users'))
      expect(blocked.headers.get('retry-after')).toBe('15')
      // 模板默认语言 zh-CN
      expect(await blocked.json()).toMatchObject({ code: 503, message: '系统正在维护，请稍后再访问。' })
      expect((await fetch(url('/api/hello'))).status).toBe(200)
      expect((await fetch(url('/health'))).status).toBe(200)
      const page = await fetch(url('/'), {
        headers: { accept: 'text/html' },
      })
      expect(page.status).toBe(503)
      // make:view 生成的视图收到翻译后的 title 等属性（不是内置页面）
      const html = await page.text()
      expect(html).toContain('<h1>系统维护中</h1>')
      expect(html).not.toContain('class="status"')

      const bypass = await fetch(url('/open-sesame'), { redirect: 'manual' })
      expect(bypass.status).toBe(302)
      const cookie = bypass.headers.getSetCookie()[0].split(';')[0]
      expect((await fetch(url('/'), {
        headers: { cookie },
      })).status).toBe(200)

      const status = await haze('maintenance:status')
      expect(status.output).toContain('Application is down since')
      expect(status.output).toContain('except /api/hello')

      const up = await haze('up')
      expect(up.output).toContain('Application is now live')
      await waitFor(async () => (await fetch(url('/'))).status === 200)
      // 没有重启或重载应用
      expect(dev.app).toBe(app)
    }
    finally {
      await dev.close()
    }
  })
})
