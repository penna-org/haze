import type { IncomingMessage, Server } from 'node:http'
import type { LogEntry } from '../src/logger-transports'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApplication, defineRoutes, Logger } from '../src'
import { fileTransport, httpTransport } from '../src/logger-transports'

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

describe('log channels', () => {
  it('keeps the console default and its custom write target', () => {
    const lines: string[] = []
    const logger = new Logger({
      format: 'json',
      write: line => lines.push(line),
    })
    logger.child({ requestId: 'r1' }).info('hello', { user: 1 })
    logger.debug('hidden')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({
      level: 'info',
      msg: 'hello',
      requestId: 'r1',
      user: 1,
      tag: 'hazejs',
    })
  })

  it('fans out to stacked channels with per-channel levels', () => {
    const all: LogEntry[] = []
    const errors: LogEntry[] = []
    const console: string[] = []
    const logger = new Logger({
      level: 'debug',
      format: 'json',
      write: line => console.push(line),
      channel: 'everything',
      channels: {
        everything: {
          driver: 'stack',
          channels: ['console', 'all', 'errors'],
        },
        all: {
          driver: 'custom',
          transport: entry => all.push(entry),
        },
        errors: {
          driver: 'custom',
          level: 'error',
          transport: {
            log: entry => errors.push(entry),
          },
        },
      },
    })
    logger.debug('details')
    logger.warn('careful')
    logger.error('broken', new Error('boom'))
    logger.access({
      method: 'GET',
      path: '/x',
      status: 200,
      duration: 1.234,
    })

    expect(all.map(entry => entry.msg)).toEqual([
      'details',
      'careful',
      'broken',
      'GET /x 200',
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatchObject({
      level: 'error',
      msg: 'broken',
      err: { name: 'Error', message: 'boom' },
    })
    expect(all[3]).toMatchObject({
      method: 'GET',
      path: '/x',
      status: 200,
      duration: 1.2,
    })
    expect(console).toHaveLength(4)

    // channel() 只写入指定通道，子日志器保留上下文
    all.length = 0
    console.length = 0
    logger.child({ userId: 7 }).channel('all').info('audit')
    expect(all).toEqual([
      expect.objectContaining({ msg: 'audit', userId: 7 }),
    ])
    expect(console).toHaveLength(0)
  })

  it('rejects unknown channels and recursive stacks', () => {
    expect(() => new Logger({ channel: 'nope' })).toThrow('Log channel "nope" is not defined')
    expect(() => new Logger({
      channel: 'a',
      channels: {
        a: {
          driver: 'stack',
          channels: ['b'],
        },
        b: {
          driver: 'stack',
          channels: ['a'],
        },
      },
    }))
      .toThrow('includes itself')
  })

  it('writes NDJSON to stdout with the json driver', () => {
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      new Logger({ channel: 'json' }).warn('to stdout')
      expect(spy).toHaveBeenCalledTimes(1)
      expect(JSON.parse(String(spy.mock.calls[0]![0]))).toMatchObject({ level: 'warn', msg: 'to stdout' })
    }
    finally {
      spy.mockRestore()
    }
  })

  it('configures channels through config/logger.ts (access logs included)', async () => {
    const entries: LogEntry[] = []
    const app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        logger: {
          level: 'info',
          requests: true,
          channel: 'memory',
          channels: {
            memory: {
              driver: 'custom',
              transport: (entry: LogEntry) => entries.push(entry),
            },
          },
        },
      },
      routes: [
        defineRoutes(r => r.get('/ping', (ctx) => {
          ctx.logger.info('pinged')
          return 'pong'
        })),
      ],
    })
    try {
      await app.request('/ping')
      expect(entries.map(entry => entry.msg)).toEqual(['pinged', 'GET /ping 200'])
      expect(entries[0]!.requestId).toBe(entries[1]!.requestId)
    }
    finally {
      await app.dispose()
    }
  })
})

describe('file transport', () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'haze-logs-'))
  })
  afterEach(async () => {
    vi.useRealTimers()
    await rm(dir, { recursive: true, force: true })
  })

  it('rotates daily and keeps maxFiles', async () => {
    vi.useFakeTimers({
      toFake: ['Date'],
    })
    // 已有的旧文件：超出保留数量时被删除
    await writeFile(join(dir, 'app-2026-10-01.log'), 'old\n')
    await writeFile(join(dir, 'unrelated.txt'), 'keep\n')
    const logger = new Logger({
      channel: 'file',
      channels: {
        file: {
          driver: 'file',
          path: join(dir, 'app.log'),
          maxFiles: 2,
        },
      },
    })

    for (const day of ['2026-10-26', '2026-10-27', '2026-10-28']) {
      vi.setSystemTime(new Date(`${day}T12:00:00`))
      logger.info(`hello ${day}`)
      logger.warn(`bye ${day}`)
      await logger.flush()
    }
    await vi.waitFor(async () => {
      expect((await readdir(dir)).sort()).toEqual(['app-2026-10-27.log', 'app-2026-10-28.log', 'unrelated.txt'])
    })
    const lines = (await readFile(join(dir, 'app-2026-10-28.log'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    expect(lines.map(line => line.msg)).toEqual(['hello 2026-10-28', 'bye 2026-10-28'])
    expect(lines[0]).toMatchObject({ level: 'info', tag: 'hazejs' })
    await logger.close()
  })

  it('appends to a single file when daily is off', async () => {
    const path = join(dir, 'nested', 'haze.log')
    const transport = fileTransport({ path, daily: false })
    transport.log({
      time: new Date().toISOString(),
      level: 'info',
      tag: 't',
      msg: 'one',
    })
    transport.log({
      time: new Date().toISOString(),
      level: 'info',
      tag: 't',
      msg: 'two',
    })
    await transport.close!()
    const second = fileTransport({ path, daily: false })
    second.log({
      time: new Date().toISOString(),
      level: 'error',
      tag: 't',
      msg: 'three',
    })
    await second.close!()
    const lines = (await readFile(path, 'utf8')).trim().split('\n').map(line => JSON.parse(line).msg)
    expect(lines).toEqual(['one', 'two', 'three'])
  })
})

describe('http transport', () => {
  let server: Server
  let url: string
  let requests: Array<{ headers: IncomingMessage['headers'], body: string }>
  let status = 200

  beforeEach(async () => {
    requests = []
    status = 200
    server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => {
        body += chunk
      })
      req.on('end', () => {
        requests.push({ headers: req.headers, body })
        res.statusCode = status
        res.end(status === 200
          ? 'ok'
          : 'nope')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    url = `http://127.0.0.1:${(server.address() as { port: number }).port}/ingest`
  })
  afterEach(async () => {
    await new Promise(resolve => server.close(resolve))
  })

  it('batches by size and interval, in order, with custom headers', async () => {
    const logger = new Logger({
      channel: 'remote',
      channels: {
        remote: {
          driver: 'http',
          url,
          batchSize: 3,
          interval: 400,
          headers: { 'DD-API-KEY': 'secret' },
        },
      },
    })
    for (let i = 1; i <= 7; i++)
      logger.info(`line ${i}`)
    // 两个满批立即发送，剩下一条等待 interval
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    await sleep(50)
    expect(requests).toHaveLength(2)
    await vi.waitFor(() => expect(requests).toHaveLength(3), { timeout: 2000 })

    expect(requests.map(request => JSON.parse(request.body).map((entry: LogEntry) => entry.msg))).toEqual([
      ['line 1', 'line 2', 'line 3'],
      ['line 4', 'line 5', 'line 6'],
      ['line 7'],
    ])
    expect(requests[0]!.headers['content-type']).toBe('application/json')
    expect(requests[0]!.headers['dd-api-key']).toBe('secret')
  })

  it('flushes on close, and encodes ndjson / loki / custom bodies', async () => {
    const ndjson = httpTransport({ url, format: 'ndjson', interval: 10_000 })
    ndjson.log({
      time: '2026-10-28T00:00:00.000Z',
      level: 'info',
      tag: 'app',
      msg: 'a',
    })
    ndjson.log({
      time: '2026-10-28T00:00:01.000Z',
      level: 'warn',
      tag: 'app',
      msg: 'b',
    })
    expect(requests).toHaveLength(0)
    await ndjson.close!()
    expect(requests).toHaveLength(1)
    expect(requests[0]!.headers['content-type']).toBe('application/x-ndjson')
    expect(requests[0]!.body.trim().split('\n').map(line => JSON.parse(line).msg)).toEqual(['a', 'b'])

    const loki = httpTransport({
      url,
      format: 'loki',
      labels: { env: 'test' },
    })
    loki.log({
      time: '2026-10-28T00:00:00.000Z',
      level: 'info',
      tag: 'app',
      msg: 'a',
    })
    loki.log({
      time: '2026-10-28T00:00:00.001Z',
      level: 'error',
      tag: 'app',
      msg: 'b',
    })
    loki.log({
      time: '2026-10-28T00:00:00.002Z',
      level: 'info',
      tag: 'app',
      msg: 'c',
    })
    await loki.flush!()
    const push = JSON.parse(requests[1]!.body)
    expect(push.streams).toHaveLength(2)
    expect(push.streams[0].stream).toEqual({ service: 'app', level: 'info', env: 'test' })
    expect(push.streams[0].values.map((value: [string, string]) => value[0])).toEqual([
      `${Date.parse('2026-10-28T00:00:00.000Z')}000000`,
      `${Date.parse('2026-10-28T00:00:00.002Z')}000000`,
    ])
    expect(JSON.parse(push.streams[0].values[1][1]).msg).toBe('c')
    expect(push.streams[1].stream.level).toBe('error')

    const custom = httpTransport({
      url,
      format: entries => entries.map(entry => entry.msg).join('|'),
      headers: { 'content-type': 'text/plain' },
    })
    custom.log({
      time: '2026-10-28T00:00:00.000Z',
      level: 'info',
      tag: 'app',
      msg: 'x',
    })
    custom.log({
      time: '2026-10-28T00:00:00.000Z',
      level: 'info',
      tag: 'app',
      msg: 'y',
    })
    await custom.flush!()
    expect(requests[2]).toMatchObject({
      body: 'x|y',
      headers: { 'content-type': 'text/plain' },
    })
  })

  it('reports delivery failures to stderr without throwing, and caps the buffer', async () => {
    status = 500
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      const transport = httpTransport({ url, batchSize: 100, maxBuffer: 2 })
      for (const msg of ['1', '2', '3']) {
        transport.log({
          time: new Date().toISOString(),
          level: 'info',
          tag: 't',
          msg,
        })
      }
      await transport.flush!()
      expect(JSON.parse(requests[0]!.body).map((entry: LogEntry) => entry.msg)).toEqual(['2', '3'])
      expect(String(spy.mock.calls[0]![0])).toContain('Failed to ship 2 log entries')
    }
    finally {
      spy.mockRestore()
    }
  })
})
