import type { Application, ApplicationOptions } from '../src'
import type { DashboardEntry, ObservabilityConfig } from '../src/observability'
import { afterEach, describe, expect, it } from 'vitest'
import { Cache, createApplication, defineEvent, defineJob, defineRoutes, Events, Mail, QueueManager } from '../src'
import { queueDashboard, recordTelemetry, telemetryActive } from '../src/observability'

const UserViewed = defineEvent<{ id: number }>()

const SendReceipt = defineJob({
  async handle(payload: { to: string }) {
    await Mail.send({ to: payload.to, subject: 'Your receipt', html: '<h1>Thanks!</h1><script>alert(1)</script>' })
  },
})
const Broken = defineJob({
  handle() {
    throw new Error('job broke')
  },
})

let app: Application | undefined
afterEach(async () => {
  await app?.dispose()
  app = undefined
})

async function boot(options: ApplicationOptions & { observability?: ObservabilityConfig } = {}) {
  const { observability, ...rest } = options
  app = await createApplication({
    mode: 'development',
    env: false,
    config: {
      observability: observability ?? {},
      // 记录日志但不输出到控制台
      logger: {
        level: 'info',
        requests: false,
        channel: 'none',
        channels: {
          none: {
            driver: 'custom',
            transport: () => {},
          },
        },
      },
      queue: {
        default: 'memory',
        connections: {
          sync: { driver: 'sync' },
          memory: { driver: 'memory' },
        },
      },
      mail: { default: 'array', from: 'shop@example.com' },
    },
    jobs: {
      '/app/job/SendReceipt.ts': { default: SendReceipt },
      '/app/job/Broken.ts': { default: Broken },
    },
    events: {
      '/app/event/UserViewed.ts': { default: UserViewed },
    },
    routes: [
      defineRoutes((r) => {
        r.get('/users/:id', async (ctx) => {
        // 模拟 @hazejs/orm 经遥测总线上报的查询
          recordTelemetry('query', {
            sql: 'select * from users where id = ?',
            params: [
              Number(ctx.param('id')),
            ],
            connection: 'default',
            dialect: 'sqlite',
            startTime: Date.now(),
            duration: 1.5,
          })
          await Cache.get('user:1')
          await Cache.set('user:1', { id: 1 })
          await Events.emit(UserViewed, { id: 1 })
          ctx.logger.info('user viewed')
          await SendReceipt.dispatch({ to: 'ada@example.com' })
          ctx.setCookie('session', 'abcdef123456')
          return {
            id: ctx.param('id'),
          }
        })
        r.get('/boom', () => {
          throw new Error('kaboom')
        })
        r.post('/fail', async () => {
          await Broken.dispatch(null)
          return 'queued'
        })
      }),
    ],
    ...rest,
  })
  return app
}

const getJson = async (path: string, init?: RequestInit): Promise<any> => (await app!.request(path, init)).json()

describe('dev dashboard', () => {
  it('records requests with their queries, jobs, mail, events, cache and logs', async () => {
    await boot()
    expect(telemetryActive()).toBe(true)
    const response = await app!.request('/users/7', {
      headers: { 'x-request-id': 'req-1' },
    })
    expect(response.status).toBe(200)
    await app!.make(QueueManager).idle()

    const { request, entries } = await getJson('/__haze/api/requests/req-1') as { request: DashboardEntry, entries: DashboardEntry[] }
    expect(request.content).toMatchObject({
      method: 'GET',
      path: '/users/7',
      route: '/users/:id',
      status: 200,
    })
    expect(request.content.duration).toBeGreaterThan(0)
    const byType = (type: string) => entries.filter(entry => entry.type === type)

    expect(byType('query')[0]!.content).toMatchObject({
      sql: 'select * from users where id = ?',
      params: [7],
      duration: 1.5,
    })
    expect(byType('cache').map(entry => [entry.content.operation, entry.content.hit])).toEqual([
      ['get', false],
      ['set', undefined],
    ])
    expect(byType('event')[0]!.content).toMatchObject({
      event: 'UserViewed',
      payload: { id: 1 },
    })
    expect(byType('log').map(entry => entry.content.msg)).toContain('user viewed')

    // 投递与执行都关联到请求；任务中发送的邮件同样关联（带 jobId）
    const jobs = byType('job')
    expect(jobs.map(entry => entry.content.status)).toEqual(['dispatched', 'ok'])
    expect(jobs[1]!.content).toMatchObject({ job: 'SendReceipt', attempt: 1 })
    const mail = byType('mail')[0]!
    expect(mail.content).toMatchObject({
      subject: 'Your receipt',
      to: ['ada@example.com'],
      mailer: 'array',
      driver: 'array',
    })
    expect(mail.jobId).toBe(jobs[0]!.jobId)

    // 列表、单条记录与统计
    const { entries: queries } = await getJson('/__haze/api/entries?type=query')
    expect(queries).toHaveLength(1)
    expect((await getJson(`/__haze/api/entries/${mail.id}`)).entry.id).toBe(mail.id)
    expect((await getJson('/__haze/api/stats')).counts).toMatchObject({ request: 1, query: 1, mail: 1 })
    expect((await app!.request('/__haze/api/entries?type=nope')).status).toBe(422)

    // 邮件预览：沙箱 CSP
    const preview = await app!.request(`/__haze/api/mail/${mail.id}/preview`)
    expect(preview.headers.get('content-security-policy')).toContain('sandbox')
    expect(await preview.text()).toContain('<h1>Thanks!</h1>')

    // 面板自身的请求不被记录
    expect((await getJson('/__haze/api/entries?type=request')).entries).toHaveLength(1)
  })

  it('redacts sensitive request and response headers', async () => {
    await boot({
      observability: {
        dashboard: {
          redactHeaders: ['X-Secret'],
        },
      },
    })
    await app!.request('/users/1', {
      headers: {
        'authorization': 'Bearer super-secret-token',
        'cookie': 'session=topsecret',
        'x-secret': 'hunter2',
        'x-request-id': 'req-2',
        'x-visible': 'yes',
      },
    })
    const { request } = await getJson('/__haze/api/requests/req-2')
    const headers = request.content.requestHeaders
    expect(headers.authorization).toBe('Bearer…（已隐藏）')
    expect(headers.cookie).not.toContain('topsecret')
    expect(headers['x-secret']).not.toContain('hunter2')
    expect(headers['x-visible']).toBe('yes')
    expect(request.content.responseHeaders['set-cookie']).not.toContain('abcdef123456')
    expect(JSON.stringify(request)).not.toContain('super-secret-token')
  })

  it('streams new entries over SSE', async () => {
    await boot()
    const stream = await app!.request('/__haze/api/stream')
    expect(stream.headers.get('content-type')).toContain('text/event-stream')
    const reader = stream.body!.getReader()
    const decoder = new TextDecoder()
    expect(decoder.decode((await reader.read()).value)).toContain(': connected')

    await app!.request('/users/3', {
      headers: { 'x-request-id': 'req-3' },
    })
    let text = ''
    while (!text.includes('"type":"request"'))
      text += decoder.decode((await reader.read()).value)
    const events = text.split('\n\n').filter(chunk => chunk.startsWith('event: entry'))
    const entries = events.map(chunk => JSON.parse(chunk.split('\n').find(line => line.startsWith('data: '))!.slice(6)) as DashboardEntry)
    expect(entries.map(entry => entry.type)).toContain('query')
    expect(entries.find(entry => entry.type === 'request')).toMatchObject({
      requestId: 'req-3',
      content: { path: '/users/3' },
    })
    await reader.cancel()
  })

  it('serves a self-contained page and links the dev error page to the request', async () => {
    await boot()
    const page = await app!.request('/__haze')
    expect(page.headers.get('content-type')).toContain('text/html')
    const html = await page.text()
    expect(html).toContain('<title>hazejs dashboard</title>')
    // 不依赖 CDN
    expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href="http/)
    expect(await (await app!.request('/__haze/requests/abc')).text()).toContain('"initial":"#/requests/abc"')
    expect(await (await app!.request('/__haze/queues')).text()).toContain('"initial":"#/queues"')
    expect((await app!.request('/__haze/unknown')).status).toBe(404)

    const error = await app!.request('/boom', {
      headers: { 'accept': 'text/html', 'x-request-id': 'req-err' },
    })
    expect(error.status).toBe(500)
    expect(await error.text()).toContain('href="/__haze/requests/req-err"')
    const { entries } = await getJson('/__haze/api/requests/req-err')
    expect(entries.find((entry: DashboardEntry) => entry.type === 'exception')?.content).toMatchObject({ message: 'kaboom', status: 500 })
  })

  it('is never enabled outside development', async () => {
    for (const mode of ['production', 'test'] as const) {
      await boot({
        mode,
        observability: {
          dashboard: { enabled: true },
        },
      })
      expect((await app!.request('/__haze')).status).toBe(404)
      expect((await app!.request('/__haze/api/entries')).status).toBe(404)
      await app!.dispose()
    }
    app = undefined
    // development 下可显式关闭，也可换路径
    await boot({
      observability: {
        dashboard: { enabled: false },
      },
    })
    expect((await app!.request('/__haze')).status).toBe(404)
    expect(telemetryActive()).toBe(false)
    await app!.dispose()
    await boot({
      observability: {
        dashboard: { path: '/_debug' },
      },
    })
    expect((await app!.request('/_debug')).status).toBe(200)
  })

  it('lists failed jobs and retries / forgets / flushes them', async () => {
    await boot()
    const queues = app!.make(QueueManager)
    await app!.request('/fail', { method: 'POST' })
    await app!.request('/fail', { method: 'POST' })
    await queues.idle()

    const { connections } = await getJson('/__haze/api/queues')
    expect(connections.map((item: { name: string }) => item.name)).toEqual(['memory'])
    const memory = connections[0]
    expect(memory).toMatchObject({
      driver: 'memory',
      default: true,
      counts: { waiting: 0, failed: 2 },
    })
    expect(memory.failed[0]).toMatchObject({ job: 'Broken', attempts: 1 })
    expect(memory.failed[0].error).toContain('job broke')

    // 写操作需要自定义请求头（防跨站请求）
    expect((await app!.request('/__haze/api/queues/memory/retry', { method: 'POST' })).status).toBe(403)
    const headers = { 'x-haze-dashboard': '1', 'content-type': 'application/json' }
    expect((await app!.request('/__haze/api/queues/memory/retry', {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    })).status).toBe(200)
    expect((await app!.request('/__haze/api/queues/memory/retry', {
      method: 'POST',
      headers: { ...headers, origin: 'https://evil.example' },
      body: '{}',
    })).status).toBe(403)

    const failedId = memory.failed[0].id
    expect(await getJson('/__haze/api/queues/memory/retry', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: failedId }),
    })).toEqual({ retried: 1 })
    await queues.idle()
    // 重试后再次失败
    expect((await queues.failed('memory')).map(job => job.id)).toContain(failedId)
    expect(await getJson('/__haze/api/queues/memory/forget', {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: failedId }),
    })).toEqual({ forgotten: true })
    expect(await getJson('/__haze/api/queues/memory/flush', { method: 'POST', headers })).toEqual({ flushed: 1 })
    expect(await queues.failed('memory')).toHaveLength(0)
    expect((await app!.request('/__haze/api/queues/nope/flush', { method: 'POST', headers })).status).toBe(404)
  })

  it('mounts the queue dashboard behind middleware in production', async () => {
    await boot({
      mode: 'production',
      routes: [
        defineRoutes((r) => {
          r.post('/fail', async () => {
            await Broken.dispatch(null)
            return 'queued'
          })
          const guard = (ctx: { header: (name: string) => string | undefined }, next: () => Promise<unknown>) =>
            ctx.header('authorization') === 'Bearer admin'
              ? next()
              : new Response('Unauthorized', { status: 401 })
          r.group({
            middleware: [guard as never],
          }, r => queueDashboard(r, { path: '/admin/queues' }))
        }),
      ],
    })
    await app!.request('/fail', { method: 'POST' })
    await app!.make(QueueManager).idle()

    expect((await app!.request('/admin/queues')).status).toBe(401)
    expect((await app!.request('/admin/queues/api')).status).toBe(401)
    const auth = { authorization: 'Bearer admin' }
    const page = await app!.request('/admin/queues', { headers: auth })
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('"mode":"queues"')
    const { connections } = await getJson('/admin/queues/api', { headers: auth })
    expect(connections[0].failed).toHaveLength(1)
    const retried = await app!.request('/admin/queues/api/memory/retry', {
      method: 'POST',
      headers: { ...auth, 'x-haze-dashboard': '1' },
    })
    expect(await retried.json()).toEqual({ retried: 1 })
    // 生产环境没有开发面板
    expect((await app!.request('/__haze')).status).toBe(404)
  })
})
