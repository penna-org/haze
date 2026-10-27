import type { LoggerConfig } from '../src'
import { describe, expect, it } from 'vitest'
import { createApplication, defineRoutes, Logger, NotFoundException } from '../src'

function capture(config: LoggerConfig = {}) {
  const lines: Array<Record<string, any>> = []
  const logger = new Logger({
    format: 'json',
    ...config,
    write: line => lines.push(JSON.parse(line)),
  })
  return { logger, lines }
}

describe('logger', () => {
  it('writes structured json lines with context, fields and errors', () => {
    const { logger, lines } = capture()
    const child = logger.child({ requestId: 'r1' }).child({ userId: 7 })
    child.info('user logged in', { ip: '127.0.0.1' })
    child.error(new Error('boom'))

    expect(lines[0]).toMatchObject({
      level: 'info',
      tag: 'think-h3',
      msg: 'user logged in',
      requestId: 'r1',
      userId: 7,
      ip: '127.0.0.1',
    })
    expect(lines[0].time).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(lines[1]).toMatchObject({
      level: 'error',
      msg: 'boom',
      err: { name: 'Error', message: 'boom' },
    })
    expect(lines[1].err.stack).toContain('boom')
  })

  it('respects the configured level', () => {
    const { logger, lines } = capture({ level: 'warn' })
    logger.info('hidden')
    logger.debug('hidden')
    logger.warn('shown')
    expect(lines.map(line => line.msg)).toEqual(['shown'])
  })

  it('keeps subclasses when creating children', () => {
    class Custom extends Logger {}
    expect(new Custom({ level: 'silent' }).child({ a: 1 })).toBeInstanceOf(Custom)
  })
})

describe('request logging', () => {
  async function boot(config: Record<string, any> = {}) {
    const lines: Array<Record<string, any>> = []
    const app = await createApplication({
      mode: 'production',
      env: false,
      config: {
        logger: {
          requests: true,
          write: (line: string) => lines.push(JSON.parse(line)),
        },
        ...config,
      },
      routes: [
        defineRoutes((r) => {
          r.get('/ok', ctx => ({ id: ctx.requestId }))
          r.get('/log', (ctx) => {
            ctx.logger.info('inside handler')
            return 'ok'
          })
          r.get('/missing', () => {
            throw new NotFoundException()
          })
          r.get('/boom', () => {
            throw new Error('kaboom')
          })
        }),
      ],
    })
    return { app, lines }
  }

  it('generates a request id, returns it and logs access lines', async () => {
    const { app, lines } = await boot()
    const res = await app.request('/ok')
    const id = res.headers.get('x-request-id')!
    expect(id).toMatch(/^[\da-f-]{36}$/)
    expect((await res.json() as any).data.id).toBe(id)
    expect(lines).toEqual([
      expect.objectContaining({
        level: 'info',
        msg: 'GET /ok 200',
        method: 'GET',
        path: '/ok',
        status: 200,
        requestId: id,
      }),
    ])
    expect(typeof lines[0].duration).toBe('number')
  })

  it('reuses safe incoming request ids and rejects unsafe ones', async () => {
    const { app } = await boot()
    const reused = await app.request('/ok', {
      headers: { 'x-request-id': 'upstream-123' },
    })
    expect(reused.headers.get('x-request-id')).toBe('upstream-123')

    // 空格 / 引号可伪造日志字段，过长值浪费日志空间（换行已被 Headers 规范拒绝）
    const injected = await app.request('/ok', {
      headers: { 'x-request-id': 'evil" level="error' },
    })
    expect(injected.headers.get('x-request-id')).not.toContain('evil')
    const long = await app.request('/ok', {
      headers: {
        'x-request-id': 'a'.repeat(200),
      },
    })
    expect(long.headers.get('x-request-id')).toHaveLength(36)
  })

  it('tags handler and error logs with the request id and records final status', async () => {
    const { app, lines } = await boot()
    await app.request('/log', {
      headers: { 'x-request-id': 'req-a' },
    })
    await app.request('/missing', {
      headers: { 'x-request-id': 'req-b' },
    })
    await app.request('/boom', {
      headers: { 'x-request-id': 'req-c' },
    })

    expect(lines.find(line => line.msg === 'inside handler')).toMatchObject({ requestId: 'req-a' })
    expect(lines.find(line => line.path === '/missing')).toMatchObject({ status: 404, requestId: 'req-b' })
    // 5xx 由 ExceptionHandler 上报，带请求 ID 与错误详情
    expect(lines.find(line => line.level === 'error')).toMatchObject({
      requestId: 'req-c',
      err: { message: 'kaboom' },
    })
    expect(lines.find(line => line.path === '/boom')).toMatchObject({ status: 500 })
  })

  it('can disable the request id header and access logs', async () => {
    const { app, lines } = await boot({
      app: { requestIdHeader: false },
      logger: {
        requests: false,
        write: () => {},
      },
    })
    const res = await app.request('/ok')
    expect(res.headers.get('x-request-id')).toBeNull()
    expect(lines).toEqual([])
  })

  it('defaults to json in production, pretty in development and quiet in tests', async () => {
    const prod = await createApplication({ mode: 'production', env: false })
    const dev = await createApplication({ mode: 'development', env: false })
    const test = await createApplication({ mode: 'test', env: false })
    expect(prod.config.get('logger')).toMatchObject({ format: 'json', level: 'info', requests: true })
    expect(dev.config.get('logger')).toMatchObject({ format: 'pretty', level: 'info', requests: true })
    expect(test.config.get('logger')).toMatchObject({ level: 'warn', requests: false })
  })
})
