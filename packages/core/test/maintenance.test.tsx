import type { Application, ApplicationOptions, MaintenanceState, ViewChild } from '../src'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, defineJob, defineListener, defineRoutes, defineSchedule, Maintenance, MaintenanceManager, MaintenanceModeDisabled, MaintenanceModeEnabled, memoryStore, Queue, runMaintenanceCommand, Scheduler } from '../src'

const apps: Application[] = []
const dirs: string[] = []
afterEach(async () => {
  for (const app of apps.splice(0)) {
    await app.make(MaintenanceManager).up()
    await app.dispose()
  }
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

const KEY = 'k'.repeat(32)
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))
const HTML = { accept: 'text/html,application/xhtml+xml' }

let storeCounter = 0
const log: string[] = []

const Work = defineJob({
  handle: (payload: { id: number }) => void log.push(`job:${payload.id}`),
})

async function boot(options: ApplicationOptions & { config?: Record<string, unknown> } = {}) {
  const app = await createApplication({
    mode: 'test',
    env: false,
    ...options,
    config: {
      app: { key: KEY },
      logger: { level: 'silent' },
      // 每个用例独立的缓存存储；进程内缓存时间设为 0（每次读取存储）
      cache: {
        default: 'shared',
        stores: {
          shared: {
            driver: 'custom',
            store: memoryStore(`maintenance-${++storeCounter}`),
          },
        },
      },
      maintenance: { interval: 0, workerSleep: 20 },
      ...options.config,
    },
    routes: options.routes ?? [
      defineRoutes((r) => {
        r.get('/', () => ({ home: true }))
        r.get('/api/users', () => ({ users: [] }))
        r.post('/api/webhooks/stripe', () => ({ received: true }))
        r.get('/maintenance', () => ({ page: true }))
      }),
    ],
  })
  apps.push(app)
  return app
}

describe('maintenance mode', () => {
  it('returns 503 with Retry-After, JSON for API requests and an HTML page for browsers', async () => {
    const app = await boot()
    expect((await app.request('/')).status).toBe(200)

    const { state } = await Maintenance.down({ refresh: 15 })
    expect(state).toMatchObject({ status: 503, retry: 60, refresh: 15 })

    const json = await app.request('/api/users', {
      headers: { accept: 'application/json' },
    })
    expect(json.status).toBe(503)
    expect(json.headers.get('retry-after')).toBe('60')
    expect(json.headers.get('refresh')).toBe('15')
    expect(await json.json()).toEqual({
      code: 503,
      message: 'The application is down for maintenance. Please check back soon.',
      data: null,
    })
    // /api 下的路由即使接受 HTML 也返回 JSON
    expect((await app.request('/api/users', { headers: HTML })).headers.get('content-type')).toContain('application/json')

    const page = await app.request('/', { headers: HTML })
    expect(page.status).toBe(503)
    expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8')
    expect(page.headers.get('cache-control')).toBe('no-store')
    const body = await page.text()
    expect(body).toMatch(/^<!DOCTYPE html><html lang="en">/)
    expect(body).toContain('<h1>Down for maintenance</h1>')

    expect(await Maintenance.up()).toBe(true)
    expect((await app.request('/')).status).toBe(200)
    expect(await Maintenance.up()).toBe(false)
  })

  it('stores the state in the cache store with a hashed secret', async () => {
    const app = await boot()
    const { secret, driver } = await app.make(MaintenanceManager).down({ secret: 'let-me-in', status: 502, message: 'Upgrading' })
    expect(secret).toBe('let-me-in')
    expect(driver.name).toBe('cache')
    const stored = await app.make(MaintenanceManager).driver().get() as MaintenanceState
    expect(stored.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(stored)).not.toContain('let-me-in')
    const res = await app.request('/api/users')
    expect([res.status, (await res.json() as any).message]).toEqual([502, 'Upgrading'])
    expect(app.make(MaintenanceManager).warning()).toBeUndefined()
  })

  it('uses a local file with the file driver', async () => {
    const root = mkdtempSync(join(tmpdir(), 'haze-down-'))
    dirs.push(root)
    const app = await boot({
      rootDir: root,
      config: {
        maintenance: { driver: 'file', interval: 0 },
      },
    })
    await Maintenance.down({ retry: 30 })
    const file = join(root, 'storage/framework/down')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({ status: 503, retry: 30 })
    expect((await app.request('/')).status).toBe(503)

    // 另一个应用（模拟另一个进程）读取同一个文件
    const other = await boot({
      rootDir: root,
      config: {
        maintenance: { driver: 'file', interval: 0 },
      },
    })
    expect(await other.make(MaintenanceManager).isDown()).toBe(true)
    await other.make(MaintenanceManager).up()
    expect(existsSync(file)).toBe(false)
    expect((await app.request('/')).status).toBe(200)
  })

  it('falls back to the file driver for an in-process memory store outside tests and warns', async () => {
    const root = mkdtempSync(join(tmpdir(), 'haze-down-'))
    dirs.push(root)
    const app = await boot({
      mode: 'development',
      rootDir: root,
      config: {
        cache: {
          default: 'memory',
          stores: {
            memory: { driver: 'memory' },
          },
        },
        logger: { level: 'silent' },
      },
    })
    const manager = app.make(MaintenanceManager)
    expect(manager.driver().name).toBe('file')
    expect(manager.warning()).toMatch(/in-process memory store/)
    // 测试模式下保持内存存储（进程内隔离），同样给出提示
    const test = await boot({
      config: {
        cache: {
          default: 'memory',
          stores: {
            memory: { driver: 'memory' },
          },
        },
      },
    })
    expect(test.make(MaintenanceManager).driver().name).toBe('cache')
    expect(test.make(MaintenanceManager).warning()).toMatch(/only affects the current process/)
  })

  it('lets except paths, health checks and the bypass cookie through', async () => {
    const app = await boot({
      config: {
        maintenance: {
          interval: 0,
          except: ['/maintenance'],
        },
      },
    })
    await Maintenance.down({
      secret: 'open-sesame',
      except: ['/api/webhooks/*'],
    })

    expect((await app.request('/api/webhooks/stripe', { method: 'POST' })).status).toBe(200)
    expect((await app.request('/maintenance')).status).toBe(200)
    expect((await app.request('/health')).status).toBe(200)
    expect((await app.request('/health/live')).status).toBe(200)
    expect((await app.request('/api/users')).status).toBe(503)

    // 错误的密钥不会设置 Cookie
    const wrong = await app.request('/wrong-secret', { headers: HTML })
    expect([
      wrong.status,
      wrong.headers.getSetCookie(),
    ]).toEqual([503, []])

    const bypass = await app.request('/open-sesame')
    expect(bypass.status).toBe(302)
    expect(bypass.headers.get('location')).toBe('/')
    const cookie = bypass.headers.getSetCookie().find(item => item.startsWith('haze_maintenance='))!
    expect(cookie).toMatch(/HttpOnly/i)
    const header = { cookie: cookie.split(';')[0] }
    expect((await app.request('/api/users', { headers: header })).status).toBe(200)

    // 篡改的 Cookie 无效
    expect((await app.request('/api/users', {
      headers: { cookie: `${header.cookie}x` },
    })).status).toBe(503)
    // 新的一次维护（不同密钥）使旧 Cookie 失效
    await Maintenance.down({ secret: 'another' })
    expect((await app.request('/api/users', { headers: header })).status).toBe(503)
  })

  it('redirects HTML requests and renders a custom view', async () => {
    function Maintenance503(props: { message: string, status: number, retry?: number }): ViewChild {
      return (
        <html>
          <body>
            <h1>We'll be back</h1>
            <p>{props.message}</p>
            <p>
              {props.status}
              /
              {props.retry}
            </p>
          </body>
        </html>
      )
    }
    const app = await boot({
      views: {
        '/app/view/Maintenance.tsx': { default: Maintenance503 },
      },
    })
    await Maintenance.down({ redirect: '/maintenance' })
    const redirected = await app.request('/', { headers: HTML })
    expect([
      redirected.status,
      redirected.headers.get('location'),
    ]).toEqual([302, '/maintenance'])
    // 重定向的目标本身显示维护页；JSON 请求不重定向
    expect((await app.request('/maintenance', { headers: HTML })).status).toBe(503)
    expect((await app.request('/api/users')).status).toBe(503)

    await Maintenance.down({ render: 'Maintenance', retry: 120 })
    const page = await app.request('/', { headers: HTML })
    expect(page.status).toBe(503)
    expect(await page.text()).toBe(`<!DOCTYPE html><html><body><h1>We&#39;ll be back</h1><p>The application is down for maintenance. Please check back soon.</p><p>503/120</p></body></html>`)

    // 视图不存在时退回内置页面
    await Maintenance.down({ render: 'Missing' })
    expect(await (await app.request('/', { headers: HTML })).text()).toContain('Down for maintenance')
  })

  it('translates the message with config/i18n.ts', async () => {
    const app = await boot({
      config: {
        i18n: {
          defaultLocale: 'zh-CN',
          locales: ['zh-CN', 'en'],
        },
      },
    })
    await Maintenance.down()
    expect((await (await app.request('/api/users')).json() as any).message).toBe('系统正在维护，请稍后再访问。')
    expect((await (await app.request('/api/users', {
      headers: { 'accept-language': 'en' },
    })).json() as any).message).toBe('The application is down for maintenance. Please check back soon.')
    const page = await (await app.request('/', { headers: HTML })).text()
    expect(page).toContain('<html lang="zh-CN">')
    expect(page).toContain('<h1>系统维护中</h1>')
  })

  it('caches the state in process for the configured interval', async () => {
    const app = await boot({
      config: {
        maintenance: { interval: 200 },
      },
    })
    const manager = app.make(MaintenanceManager)
    expect((await app.request('/')).status).toBe(200)
    // 另一个进程写入状态（直接写存储，绕过本进程的缓存）
    await manager.driver().put({
      time: Date.now(),
      status: 503,
      retry: 60,
    })
    expect((await app.request('/')).status).toBe(200)
    await sleep(250)
    expect((await app.request('/')).status).toBe(503)
    await manager.driver().forget()
    expect((await app.request('/')).status).toBe(503)
    await sleep(250)
    expect((await app.request('/')).status).toBe(200)
  })

  it('pauses queue workers between jobs and skips scheduled tasks', async () => {
    log.length = 0
    const app = await boot({
      jobs: {
        '/app/job/Work.ts': { default: Work },
      },
      schedules: [
        defineSchedule(s => s.call('tick', () => void log.push('tick')).everyMinute()),
      ],
    })
    await Maintenance.down()
    await Queue.dispatch(Work, { id: 1 })
    await sleep(100)
    expect(log).toEqual([])
    expect((await app.make(Scheduler).runDue()).map(run => [run.status, run.reason])).toEqual([
      ['skipped', 'maintenance'],
    ])

    await Maintenance.up()
    await Queue.idle()
    expect(log).toEqual(['job:1'])
    expect((await app.make(Scheduler).runDue()).map(run => run.status)).toEqual(['ok'])

    // pauseWorkers: false 时继续执行
    log.length = 0
    const other = await boot({
      jobs: {
        '/app/job/Work.ts': { default: Work },
      },
      config: {
        maintenance: { interval: 0, pauseWorkers: false },
      },
    })
    await other.make(MaintenanceManager).down()
    await other.make(Scheduler).runDue()
    expect(log).toEqual([])
  })

  it('emits events and runs the production maintenance commands', async () => {
    const seen: string[] = []
    const app = await boot({
      listeners: [
        defineListener(MaintenanceModeEnabled, ({ state }) => void seen.push(`down:${state.status}`)),
        defineListener(MaintenanceModeDisabled, () => void seen.push('up')),
      ],
    })
    const output: string[] = []
    const write = process.stdout.write
    process.stdout.write = ((chunk: string) => {
      output.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      expect(await runMaintenanceCommand(app, [
        'down',
        '--secret=abc',
        '--retry',
        '30',
        '--except',
        '/a,/b/*',
      ])).toBe(0)
      expect(await runMaintenanceCommand(app, ['maintenance:status'])).toBe(0)
      expect(await runMaintenanceCommand(app, ['up'])).toBe(0)
      expect(await runMaintenanceCommand(app, ['nope'])).toBe(1)
      await expect(runMaintenanceCommand(app, ['down', '--status', '200'])).rejects.toThrow(/4xx or 5xx/)
      await expect(runMaintenanceCommand(app, ['down', '--secret', 'a/b'])).rejects.toThrow(/may only contain/)
    }
    finally {
      process.stdout.write = write
    }
    const text = output.join('')
    expect(text).toContain('Application is now in maintenance mode')
    expect(text).toContain('Bypass: visit /abc')
    expect(text).toContain('Retry-After 30')
    expect(text).toContain('except /a, /b/*')
    expect(text).toContain('Application is now live')
    expect(seen).toEqual(['down:503', 'up'])
  })
})
