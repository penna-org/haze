import type { Context, ContextManager } from '@opentelemetry/api'
import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { Application, HttpClientRequest, TelemetryEvents } from '../src'
import { AsyncLocalStorage } from 'node:async_hooks'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import { context, ROOT_CONTEXT, SpanKind, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  ConnectionException,
  createApplication,
  defineHttpConfig,
  defineRoutes,
  Http,
  HttpManager,
  HttpRequestException,
  onTelemetry,
  StrayRequestException,
  TimeoutException,
  useHttpManager,
} from '../src'
import { redactUrl } from '../src/http-client/redact'
import { disableOpenTelemetry } from '../src/observability/otel'

// ---- 本地测试服务器 -----------------------------------------------------------

let server: Server
let base: string
/** 按 tag 参数计数的请求次数（重试测试） */
const hits = new Map<string, number>()
let inFlight = 0
let maxInFlight = 0

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of req)
    chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

function json(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', ...headers })
  res.end(JSON.stringify(value))
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url!, base)
  const body = await readBody(req)
  const key = url.searchParams.get('tag') ?? url.pathname
  hits.set(key, (hits.get(key) ?? 0) + 1)
  switch (url.pathname.split('/')[1]) {
    case 'echo':
    case 'api': {
      let form: Record<string, unknown> | undefined
      const type = req.headers['content-type'] ?? ''
      if (type.startsWith('multipart/form-data')) {
        // 用标准 Request 解析 multipart
        const data = await new Request(url, {
          method: 'POST',
          headers: { 'content-type': type },
          body,
        }).formData()
        form = {}
        for (const [name, value] of data) {
          form[name] = typeof value === 'string'
            ? value
            : { filename: value.name, type: value.type, text: await value.text() }
        }
      }
      return json(res, 200, {
        method: req.method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body: body.toString(),
        form,
      })
    }
    case 'status': {
      const status = Number(url.pathname.split('/')[2])
      res.writeHead(status, { 'content-type': 'text/plain' })
      return void res.end(`error body ${status}`)
    }
    case 'slow': {
      await sleep(Number(url.searchParams.get('ms') ?? 200))
      return json(res, 200, { slow: true })
    }
    case 'slow-body': {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.write('start')
      await sleep(Number(url.searchParams.get('ms') ?? 200))
      return void res.end('end')
    }
    case 'flaky': {
      // 前 fail 次返回 status（默认 503），之后返回 200
      const fail = Number(url.searchParams.get('fail') ?? 1)
      const status = Number(url.searchParams.get('status') ?? 503)
      if (hits.get(key)! <= fail) {
        const headers: Record<string, string> = {}
        if (url.searchParams.has('retryAfter'))
          headers['retry-after'] = url.searchParams.get('retryAfter')!
        return json(res, status, {
          attempt: hits.get(key),
        }, headers)
      }
      return json(res, 200, {
        attempt: hits.get(key),
      })
    }
    case 'concurrent': {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await sleep(30)
      inFlight--
      return json(res, 200, {
        id: url.searchParams.get('id'),
      })
    }
    case 'stream': {
      res.writeHead(200, { 'content-type': 'text/plain' })
      for (const part of ['a', 'b', 'c']) {
        res.write(part)
        await sleep(10)
      }
      return void res.end()
    }
    case 'sse': {
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('event: greeting\ndata: hello\n\n')
      await sleep(5)
      res.write(': comment\r\ndata: line 1\r\ndata: line 2\r\nid: 7\r\n\r\n')
      return void res.end('data: {"done":true}\n\n')
    }
    case 'redirect': {
      res.writeHead(302, { location: '/echo/redirected' })
      return void res.end()
    }
    default:
      res.writeHead(404)
      res.end('not found')
  }
}

beforeAll(async () => {
  server = createServer((req, res) => {
    handle(req, res).catch((error) => {
      res.writeHead(500)
      res.end(String(error))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

let app: Application | undefined

beforeEach(() => {
  hits.clear()
  inFlight = 0
  maxInFlight = 0
})

afterEach(async () => {
  useHttpManager().restore()
  await app?.dispose()
  app = undefined
})

afterAll(async () => {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
})

async function boot(config: Record<string, unknown> = {}, routes = defineRoutes(() => {})): Promise<Application> {
  app = await createApplication({
    mode: 'test',
    env: false,
    config: {
      logger: { level: 'silent' },
      ...config,
    },
    routes: [routes],
  })
  return app
}

// ---- 请求 --------------------------------------------------------------------

describe('http client: requests', () => {
  it('sends every verb with query parameters and reads the response', async () => {
    const res = await Http.get(`${base}/echo/users?fixed=1`, {
      query: {
        page: 2,
        tags: ['a', 'b'],
        skip: undefined,
        none: null,
      },
    })
    expect(res.status).toBe(200)
    expect(res.ok).toBe(true)
    expect(res.successful()).toBe(true)
    expect(res.header('content-type')).toBe('application/json')
    const body = await res.json()
    expect(body.method).toBe('GET')
    expect(body.query).toEqual({ fixed: '1', page: '2', tags: 'b' })
    expect(new URL(res.request.url).search).toBe('?fixed=1&page=2&tags=a&tags=b')
    // 缓冲后可以重复读取
    expect(JSON.parse(await res.text()).method).toBe('GET')
    expect((await res.blob()).type).toBe('application/json')

    for (const method of ['post', 'put', 'patch'] as const) {
      const sent = await (await Http[method](`${base}/echo`, { n: 1 })).json()
      expect(sent.method).toBe(method.toUpperCase())
      expect(sent.body).toBe('{"n":1}')
      expect(sent.headers['content-type']).toBe('application/json')
    }
    const deleted = await (await Http.delete(`${base}/echo`, {
      body: { id: 3 },
    })).json()
    expect(deleted).toMatchObject({ method: 'DELETE', body: '{"id":3}' })
    const head = await Http.head(`${base}/echo`)
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')
    const custom = await (await Http.send('options', `${base}/echo`)).json()
    expect(custom.method).toBe('OPTIONS')
    await expect(Http.get(`${base}/echo`, { body: 'x' })).rejects.toThrow(TypeError)
  })

  it('encodes JSON, form, multipart and raw bodies', async () => {
    const nested = await (await Http.post(`${base}/echo`, {
      user: { name: 'Ada' },
      big: 12345678901234567890n,
    })).json()
    expect(nested.body).toBe('{"user":{"name":"Ada"},"big":"12345678901234567890"}')

    const form = await (await Http.asForm().post(`${base}/echo`, {
      a: 1,
      list: [1, 2],
      user: { name: 'Ada' },
    })).json()
    expect(form.headers['content-type']).toBe('application/x-www-form-urlencoded;charset=UTF-8')
    expect(form.body).toBe('a=1&list=1&list=2&user%5Bname%5D=Ada')

    const multipart = await (await Http.attach('file', new Blob(['PNG'], { type: 'image/png' }), 'a.png').post(`${base}/echo`, { field: 'v' })).json()
    expect(multipart.headers['content-type']).toMatch(/^multipart\/form-data; boundary=/)
    expect(multipart.form).toEqual({
      field: 'v',
      file: { filename: 'a.png', type: 'image/png', text: 'PNG' },
    })

    const asMultipart = await (await Http.asMultipart().post(`${base}/echo`, {
      a: '1',
      doc: new File(['hi'], 'doc.txt', { type: 'text/plain' }),
    })).json()
    expect(asMultipart.form).toEqual({
      a: '1',
      doc: { filename: 'doc.txt', type: 'text/plain', text: 'hi' },
    })

    const raw = await (await Http.withBody('<xml/>', 'application/xml').post(`${base}/echo`)).json()
    expect(raw).toMatchObject({
      body: '<xml/>',
      headers: { 'content-type': 'application/xml' },
    })
    const text = await (await Http.post(`${base}/echo`, 'plain')).json()
    expect(text.body).toBe('plain')
  })

  it('sets headers, bearer tokens and basic auth, and joins baseURL', async () => {
    const client = Http.baseURL(`${base}/api/v1/`)
      .withHeaders({ 'x-one': '1' })
      .withHeader('x-two', '2')
      .acceptJson()
      .withUserAgent('haze-test')
      .withToken('secret-token')
    const res = await (await client.get('/users/{id}', {
      urlParameters: { id: 'a b' },
    })).json()
    expect(res.path).toBe('/api/v1/users/a%20b')
    expect(res.headers).toMatchObject({
      'x-one': '1',
      'x-two': '2',
      'accept': 'application/json',
      'user-agent': 'haze-test',
      'authorization': 'Bearer secret-token',
    })
    const basic = await (await client.withBasicAuth('ada', 'pässword').get('users')).json()
    expect(basic.path).toBe('/api/v1/users')
    expect(basic.headers.authorization).toBe(`Basic ${Buffer.from('ada:pässword').toString('base64')}`)
    // 绝对地址忽略 baseURL；构造器不可变
    expect((await (await client.get(`${base}/echo/abs`)).json()).path).toBe('/echo/abs')
    expect((await (await Http.withQuery({ q: 'x' }).withQuery('r=1').get(`${base}/echo`)).json()).query).toEqual({ q: 'x', r: '1' })
    await expect(Http.get('/relative')).rejects.toThrow(/absolute URL or set baseURL/)
  })

  it('follows redirects unless disabled', async () => {
    const followed = await Http.get(`${base}/redirect`)
    expect(followed.redirected).toBe(true)
    expect((await followed.json()).path).toBe('/echo/redirected')
    const manual = await Http.withoutRedirecting().get(`${base}/redirect`)
    expect(manual.status).toBe(302)
    expect(manual.redirect()).toBe(true)
  })
})

// ---- 错误、超时与重试 ----------------------------------------------------------

describe('http client: errors, timeouts and retries', () => {
  it('throws HttpRequestException from throw() with the status and a body preview', async () => {
    const res = await Http.get(`${base}/status/404?token=abc&page=1`)
    expect(res.failed()).toBe(true)
    expect(res.clientError()).toBe(true)
    expect(res.serverError()).toBe(false)
    let error: HttpRequestException | undefined
    try {
      res.throw()
    }
    catch (caught) {
      error = caught as HttpRequestException
    }
    expect(error).toBeInstanceOf(HttpRequestException)
    expect(error!.status).toBe(404)
    expect(error!.body).toBe('error body 404')
    expect(error!.response).toBe(res)
    expect(error!.message).toContain(`GET ${base}/status/404?token=[REDACTED]&page=1`)
    expect(error!.message).not.toContain('abc')
    expect((await Http.get(`${base}/status/500`)).serverError()).toBe(true)
    // 成功时返回自身，可以链式调用
    expect(await (await Http.get(`${base}/echo`)).throw().json()).toMatchObject({ method: 'GET' })
    // 客户端的 throw()：自动抛出
    await expect(Http.throw().get(`${base}/status/503`)).rejects.toBeInstanceOf(HttpRequestException)
  })

  it('wraps network errors in ConnectionException and redacts secrets in messages', async () => {
    const closed = createServer()
    await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve))
    const port = (closed.address() as { port: number }).port
    await new Promise(resolve => closed.close(resolve))
    const error = await Http.get(`http://127.0.0.1:${port}/x?api_key=k&page=2`).catch(e => e)
    expect(error).toBeInstanceOf(ConnectionException)
    expect(error).not.toBeInstanceOf(TimeoutException)
    expect(error.cause).toBeInstanceOf(Error)
    expect(error.message).toContain(`GET http://127.0.0.1:${port}/x?api_key=[REDACTED]&page=2`)
    expect(error.message).toContain('ECONNREFUSED')
    expect(error.request.url).toContain('api_key=k')
    expect(redactUrl('https://user:pw@example.com/a?token=t&sig=s&q=1')).toBe('https://REDACTED:REDACTED@example.com/a?token=[REDACTED]&sig=[REDACTED]&q=1')
    expect(redactUrl('https://example.com/a?q=1')).toBe('https://example.com/a?q=1')
  })

  it('turns credentials in the URL into basic auth', async () => {
    const body = await (await Http.get(`${base.replace('http://', 'http://ada:p%40ss@')}/echo`)).json()
    expect(body.headers.authorization).toBe(`Basic ${Buffer.from('ada:p@ss').toString('base64')}`)
  })

  it('times out each attempt with TimeoutException, including while reading the body', async () => {
    const error = await Http.timeout('50ms').get(`${base}/slow?ms=300`).catch(e => e)
    expect(error).toBeInstanceOf(TimeoutException)
    expect(error).toBeInstanceOf(ConnectionException)
    expect(error.timeout).toBe(50)
    expect(error.message).toContain('timed out after 50ms')
    expect((await (await Http.timeout(1000).get(`${base}/slow?ms=10`)).json()).slow).toBe(true)
    const slowBody = await Http.timeout(80).get(`${base}/slow-body?ms=300`)
    await expect(slowBody.text()).rejects.toBeInstanceOf(TimeoutException)
    // 调用方的 signal 中止时原样抛出 AbortError
    const controller = new AbortController()
    const pending = Http.get(`${base}/slow?ms=300`, { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('retries connection errors and retryable statuses with backoff', async () => {
    const res = await Http.retry(3, { delay: 5 }).get(`${base}/flaky?tag=a&fail=2`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ attempt: 3 })
    expect(hits.get('a')).toBe(3)

    // 用完次数后返回最后一个响应
    const exhausted = await Http.retry(2, { delay: 1 }).get(`${base}/flaky?tag=b&fail=5`)
    expect(exhausted.status).toBe(503)
    expect(hits.get('b')).toBe(2)

    // 默认不重试 404
    expect((await Http.retry(3, { delay: 1 }).get(`${base}/flaky?tag=c&fail=5&status=404`)).status).toBe(404)
    expect(hits.get('c')).toBe(1)

    // 超时同样重试
    const timedOut = await Http.timeout(30).retry(2, { delay: 1 }).get(`${base}/slow?ms=200&tag=d`).catch(e => e)
    expect(timedOut).toBeInstanceOf(TimeoutException)
    expect(hits.get('d')).toBe(2)

    // 指数退避
    const delays: number[] = []
    const started = performance.now()
    await Http.retry(3, { delay: 20, backoff: 'exponential' })
      .withMiddleware(async (request, next) => {
        delays.push(performance.now() - started)
        return next(request)
      })
      .get(`${base}/flaky?tag=e&fail=2`)
    expect(delays[2]! - delays[0]!).toBeGreaterThanOrEqual(55)
  })

  it('honours retry-after on 429 / 503 and gives up when it is too long', async () => {
    const started = performance.now()
    const res = await Http.retry(2, { delay: 0 }).get(`${base}/flaky?tag=f&fail=1&status=429&retryAfter=1`)
    expect(res.status).toBe(200)
    expect(performance.now() - started).toBeGreaterThanOrEqual(950)

    const tooLong = await Http.retry(3, { delay: 0, maxRetryAfter: '1s' }).get(`${base}/flaky?tag=g&fail=1&status=503&retryAfter=120`)
    expect(tooLong.status).toBe(503)
    expect(hits.get('g')).toBe(1)
  })

  it('uses the when predicate to decide what to retry', async () => {
    const seen: Array<[number | undefined, boolean, number]> = []
    const res = await Http.retry(3, {
      delay: 1,
      when: (response, error, request) => {
        seen.push([response?.status, error !== undefined, request.attempt])
        return response?.status === 404
      },
    }).get(`${base}/flaky?tag=h&fail=1&status=404`)
    expect(res.status).toBe(200)
    expect(seen).toEqual([
      [404, false, 1],
    ])
    // 返回 false 时不重试 503
    expect((await Http.retry(3, {
      delay: 1,
      when: () => false,
    }).get(`${base}/flaky?tag=i&fail=1`)).status).toBe(503)
    expect(hits.get('i')).toBe(1)
  })
})

// ---- 并发、中间件与流式 --------------------------------------------------------

describe('http client: pool, middleware and streaming', () => {
  it('runs a pool with a concurrency limit and returns results in order or by key', async () => {
    const results = await Http.pool(p => Array.from({ length: 6 }, (_, i) => p.get(`${base}/concurrent?id=${i}`)), { concurrency: 2 })
    expect(maxInFlight).toBe(2)
    expect(await Promise.all(results.map(res => res.json()))).toEqual(Array.from({ length: 6 }, (_, i) => ({
      id: String(i),
    })))

    maxInFlight = 0
    const unlimited = await Http.pool(p => [
      p.get(`${base}/concurrent?id=a`),
      p.get(`${base}/concurrent?id=b`),
      p.get(`${base}/concurrent?id=c`),
    ])
    expect(maxInFlight).toBe(3)
    expect(unlimited).toHaveLength(3)

    // 继承构造器的设置，按键返回
    const { first, second } = await Http.baseURL(base).withHeader('x-pool', 'yes').pool(p => ({
      first: p.get('/echo/1'),
      second: p.post('/echo/2', { a: 1 }),
    }))
    expect((await first.json()).headers['x-pool']).toBe('yes')
    expect((await second.json()).method).toBe('POST')
    await expect(Http.pool(p => [
      p.get(`${base}/echo`),
    ], { concurrency: 0 })).rejects.toThrow(RangeError)
  })

  it('runs middleware in registration order around the request', async () => {
    const order: string[] = []
    const res = await Http
      .withMiddleware(async (request, next) => {
        order.push('outer:before')
        request.headers.set('x-outer', '1')
        const response = await next(request)
        order.push(`outer:after:${response.status}`)
        return response
      })
      .withMiddleware(async (request, next) => {
        order.push(`inner:before:${request.header('x-outer')}`)
        request.url = `${request.url}?rewritten=1`
        const response = await next(request)
        order.push('inner:after')
        return response
      })
      .get(`${base}/echo`)
    expect(order).toEqual([
      'outer:before',
      'inner:before:1',
      'inner:after',
      'outer:after:200',
    ])
    const body = await res.json()
    expect(body.headers['x-outer']).toBe('1')
    expect(body.query).toEqual({ rewritten: '1' })
  })

  it('streams the response body and parses server-sent events', async () => {
    const chunks: string[] = []
    for await (const chunk of (await Http.get(`${base}/stream`)).stream())
      chunks.push(new TextDecoder().decode(chunk))
    expect(chunks.join('')).toBe('abc')

    const events = []
    for await (const event of (await Http.get(`${base}/sse`)).sse())
      events.push(event)
    expect(events).toEqual([
      { event: 'greeting', data: 'hello' },
      { data: 'line 1\nline 2', id: '7' },
      // 按规范，id 在之后的消息中保留
      { data: '{"done":true}', id: '7' },
    ])
    // 流式读取不受超时限制
    const slow = await Http.timeout(50).get(`${base}/slow-body?ms=120`)
    let text = ''
    for await (const chunk of slow.stream())
      text += new TextDecoder().decode(chunk)
    expect(text).toBe('startend')
  })
})

// ---- 配置、遥测与追踪 ----------------------------------------------------------

describe('http client: named clients, telemetry and tracing', () => {
  it('reads defaults and named clients from config/http.ts', async () => {
    await boot({
      http: defineHttpConfig({
        defaults: {
          headers: { 'x-default': 'yes' },
        },
        clients: {
          echo: {
            baseURL: `${base}/api`,
            headers: { 'x-client': 'echo' },
            token: 'client-token',
            timeout: '2s',
          },
          flaky: {
            baseURL: base,
            retry: { times: 3, delay: 1 },
          },
        },
      }),
    })
    const res = await (await Http.client('echo').get('/me')).json()
    expect(res.path).toBe('/api/me')
    expect(res.headers).toMatchObject({ 'x-default': 'yes', 'x-client': 'echo', 'authorization': 'Bearer client-token' })
    // 构造器的设置覆盖命名客户端
    expect((await (await Http.client('echo').withHeader('x-client', 'override').get('/me')).json()).headers['x-client']).toBe('override')
    expect((await Http.client('flaky').get('/flaky?tag=j&fail=2')).status).toBe(200)
    expect(hits.get('j')).toBe(3)
    // Http.create() 不使用 defaults
    expect((await (await Http.create({ baseURL: base }).get('/echo')).json()).headers['x-default']).toBeUndefined()
    await expect(Http.client('missing').get('/x')).rejects.toThrow('HTTP client "missing" is not defined in config/http.ts')
  })

  it('records an http telemetry event per attempt with redacted headers and URLs', async () => {
    await boot({
      http: {
        redactHeaders: ['X-Private'],
      },
    })
    const events: Array<TelemetryEvents['http']> = []
    const off = onTelemetry((kind, data) => {
      if (kind === 'http')
        events.push(data as TelemetryEvents['http'])
    })
    try {
      await Http.withToken('t0ps3cret')
        .withHeaders({
          'cookie': 'sid=1',
          'x-api-key': 'k',
          'x-private': 'p',
          'x-public': 'ok',
        })
        .retry(2, { delay: 1 })
        .post(`${base}/flaky?tag=k&fail=1&access_token=zzz`, { hello: 'world' })
      await Http.timeout(20).get(`${base}/slow?ms=200`).catch(() => {})
    }
    finally {
      off()
    }
    expect(events).toHaveLength(3)
    const [first, second, failed] = events
    expect(first).toMatchObject({
      method: 'POST',
      url: `${base}/flaky?tag=k&fail=1&access_token=[REDACTED]`,
      status: 503,
      attempt: 1,
      requestSize: 17,
      requestHeaders: {
        'authorization': '[REDACTED]',
        'cookie': '[REDACTED]',
        'x-api-key': '[REDACTED]',
        'x-private': '[REDACTED]',
        'x-public': 'ok',
        'content-type': 'application/json',
      },
    })
    expect(first!.responseSize).toBeGreaterThan(0)
    expect(first!.duration).toBeGreaterThan(0)
    expect(first!.startTime).toBeGreaterThan(Date.now() - 10_000)
    expect(JSON.stringify(events)).not.toContain('t0ps3cret')
    expect(second).toMatchObject({ status: 200, attempt: 2 })
    expect(failed!.status).toBeUndefined()
    expect(failed!.error).toContain('timed out')
  })

  it('shows outgoing requests in the dashboard store', async () => {
    const { DashboardStore } = await import('../src/observability')
    const live = new DashboardStore().listen()
    try {
      await Http.get(`${base}/echo?dash=1`)
      const [entry] = live.list({ type: 'http' })
      expect(entry).toMatchObject({
        type: 'http',
        content: { method: 'GET', status: 200 },
      })
    }
    finally {
      live.close()
    }
  })

  describe('opentelemetry', () => {
    /** 最小的 AsyncLocalStorage 上下文管理器（与 observability.test.ts 相同） */
    class AlsContextManager implements ContextManager {
      readonly #storage = new AsyncLocalStorage<Context>()
      active(): Context {
        return this.#storage.getStore() ?? ROOT_CONTEXT
      }

      with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(ctx: Context, fn: F, thisArg?: ThisParameterType<F>, ...args: A): ReturnType<F> {
        return this.#storage.run(ctx, () => fn.call(thisArg, ...args))
      }

      bind<T>(_ctx: Context, target: T): T {
        return target
      }

      enable(): this {
        return this
      }

      disable(): this {
        this.#storage.disable()
        return this
      }
    }

    const exporter = new InMemorySpanExporter()
    const provider = new TracerProvider({
      spanProcessors: [
        new SimpleSpanProcessor({ exporter }),
      ],
    })
    beforeAll(() => {
      context.setGlobalContextManager(new AlsContextManager())
      trace.setGlobalTracerProvider(provider)
    })
    afterAll(async () => {
      disableOpenTelemetry()
      await provider.shutdown()
      trace.disable()
      context.disable()
    })

    it('propagates traceparent and creates a CLIENT span per attempt', async () => {
      const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
      await boot({
        observability: {
          otel: { enabled: true },
        },
      }, defineRoutes((r) => {
        r.get('/proxy', async () => (await Http.retry(2, { delay: 1 }).get(`${base}/flaky?tag=otel&fail=1`)).json())
      }))
      const response = await app!.request('/proxy', {
        headers: { traceparent: `00-${TRACE_ID}-00f067aa0ba902b7-01` },
      })
      expect(await response.json()).toMatchObject({
        data: { attempt: 2 },
      })
      const clients = exporter.getFinishedSpans().filter(span => span.kind === SpanKind.CLIENT)
      expect(clients).toHaveLength(2)
      expect(clients.map(span => span.attributes['http.response.status_code'])).toEqual([503, 200])
      for (const span of clients)
        expect(span.spanContext().traceId).toBe(TRACE_ID)
      const serverSpan = exporter.getFinishedSpans().find(span => span.kind === SpanKind.SERVER)!
      expect(clients[0]!.parentSpanContext?.spanId).toBe(serverSpan.spanContext().spanId)
    })

    it('sends the traceparent header downstream', async () => {
      await boot({
        observability: {
          otel: { enabled: true },
        },
      })
      const tracer = trace.getTracer('test')
      const span = tracer.startSpan('parent')
      const body = await context.with(trace.setSpan(ROOT_CONTEXT, span), async () => (await Http.get(`${base}/echo`)).json())
      span.end()
      expect(body.headers.traceparent).toMatch(new RegExp(`^00-${span.spanContext().traceId}-[\\da-f]{16}-01$`))
    })
  })
})

// ---- Http.fake() ---------------------------------------------------------------

describe('http fake', () => {
  beforeEach(async () => {
    await boot({
      http: {
        clients: {
          github: { baseURL: 'https://api.github.com', token: 'gh-token' },
        },
      },
    })
  })

  it('fakes every request with an empty 200 and records them', async () => {
    const fake = Http.fake()
    const res = await Http.post('https://example.com/anything', { a: 1 })
    expect(res.status).toBe(200)
    expect(res.faked).toBe(true)
    expect(await res.text()).toBe('')
    expect(await res.json()).toBeNull()
    expect(fake.recorded()).toHaveLength(1)
    Http.assertSentCount(1)
  })

  it('matches URL patterns, methods and callbacks', async () => {
    Http.fake({
      'api.github.com/*': Http.response({ login: 'ada' }, 200, { 'x-ratelimit-remaining': '42' }),
      'POST example.com/users': Http.response({ created: true }, 201),
      'example.com/users/*': (request: HttpClientRequest) => Http.response({
        id: request.url.split('/').pop(),
      }),
      'example.com/text': 'plain text',
      'example.com/json': { direct: true },
      'example.com/native': new Response('native', { status: 202 }),
      'example.com/skip': () => undefined,
      '*': Http.response('', 500),
    })
    const github = await Http.get('https://api.github.com/user')
    expect(await github.json()).toEqual({ login: 'ada' })
    expect(github.header('x-ratelimit-remaining')).toBe('42')
    expect(github.header('content-type')).toBe('application/json')
    expect((await Http.post('https://example.com/users', {})).status).toBe(201)
    expect(await (await Http.get('https://example.com/users/7?expand=1')).json()).toEqual({ id: '7?expand=1' })
    expect(await (await Http.get('https://example.com/text')).text()).toBe('plain text')
    expect(await (await Http.get('https://example.com/json')).json()).toEqual({ direct: true })
    const native = await Http.get('https://example.com/native')
    expect([native.status, await native.text()]).toEqual([202, 'native'])
    expect(await (await Http.get('https://example.com/native')).text()).toBe('native')
    // 回调返回 undefined 时继续匹配，落到 '*'
    expect((await Http.get('https://example.com/skip')).status).toBe(500)
    expect((await Http.get('https://other.test/')).status).toBe(500)

    // 后添加的规则优先；回调形式
    Http.fake(request => request.method === 'DELETE'
      ? Http.response('', 204)
      : undefined)
    expect((await Http.delete('https://api.github.com/repo')).status).toBe(204)
    expect((await Http.get('https://api.github.com/user')).status).toBe(200)
  })

  it('returns sequences in order and handles the empty case', async () => {
    const sequence = Http.sequence()
      .push({ n: 1 })
      .push('', 500)
      .pushStatus(201)
      .whenEmpty(Http.response('', 404))
    Http.fake({
      'example.com/seq': sequence,
      'example.com/strict': Http.sequence([
        { only: 1 },
      ]),
    })
    const statuses = []
    for (let i = 0; i < 5; i++)
      statuses.push((await Http.get('https://example.com/seq')).status)
    expect(statuses).toEqual([200, 500, 201, 404, 404])
    expect(sequence.isEmpty).toBe(true)
    expect(() => Http.assertSequencesAreEmpty()).toThrow('Not all response sequences are empty')
    expect(await (await Http.get('https://example.com/strict')).json()).toEqual({ only: 1 })
    Http.assertSequencesAreEmpty()
    await expect(Http.get('https://example.com/strict')).rejects.toThrow('The response sequence for GET https://example.com/strict is empty')
  })

  it('retries through faked sequences and simulates failed connections', async () => {
    Http.fake({
      'example.com/retry': Http.sequence().push('', 503).pushFailedConnection().push({ ok: true }),
      'example.com/down': Http.failedConnection(),
    })
    const res = await Http.retry(3, { delay: 1 }).get('https://example.com/retry')
    expect(await res.json()).toEqual({ ok: true })
    Http.assertSentCount(3)
    expect(Http.recorded().map(([request, response]) => [request.attempt, response?.status])).toEqual([
      [1, 503],
      [2, undefined],
      [3, 200],
    ])
    await expect(Http.get('https://example.com/down')).rejects.toBeInstanceOf(ConnectionException)
    // 失败的假响应同样可以 throw()
    Http.fake({
      'example.com/error': Http.response({ message: 'nope' }, 422),
    })
    const error = await Http.throw().post('https://example.com/error').catch(e => e)
    expect(error).toBeInstanceOf(HttpRequestException)
    expect(error.body).toBe('{"message":"nope"}')
  })

  it('prevents stray requests unless they are allowed', async () => {
    Http.preventStrayRequests()
    Http.fake({
      'example.com/*': Http.response('ok'),
    })
    expect(await (await Http.get('https://example.com/a')).text()).toBe('ok')
    const error = await Http.get('https://stripe.com/v1/charges?secret=s').catch(e => e)
    expect(error).toBeInstanceOf(StrayRequestException)
    expect(error.message).toContain('GET https://stripe.com/v1/charges?secret=[REDACTED]')
    Http.allowStrayRequests([`${base}/*`])
    expect((await Http.get(`${base}/echo`)).faked).toBe(false)
    // 没有 preventStrayRequests 时，未匹配的请求照常发出并被记录
    Http.preventStrayRequests(false)
    expect((await (await Http.get(`${base}/echo/real`)).json()).path).toBe('/echo/real')
    Http.assertSent(request => request.url === `${base}/echo/real`)
  })

  it('provides assertions over the recorded requests', async () => {
    Http.fake()
    Http.assertNothingSent()
    await Http.withHeaders({ 'x-trace': 'abc' }).post('https://example.com/users', {
      name: 'Ada',
      tags: ['a'],
    })
    await Http.asForm().put('https://example.com/users/1', {
      name: 'Grace',
      roles: ['admin', 'dev'],
    })
    await Http.attach('avatar', new Blob(['img']), 'me.png').post('https://example.com/upload', { caption: 'hi' })

    Http.assertSent(request => request.method === 'POST'
      && request.url === 'https://example.com/users'
      && request.hasHeader('x-trace')
      && request.hasHeader('x-trace', 'abc')
      && request.hasHeader('content-type', /json/)
      && request.isJson()
      && request.json().name === 'Ada'
      && (request.data as { tags: string[] }).tags[0] === 'a')
    Http.assertSent(request => request.isForm() && request.form().name === 'Grace' && request.form().roles.join() === 'admin,dev')
    Http.assertSent((request) => {
      const form = request.form()
      return request.isMultipart() && form.caption === 'hi' && form.avatar instanceof Blob && (form.avatar as File).name === 'me.png'
    })
    Http.assertSent((_request, response) => response?.status === 200)
    Http.assertNotSent(request => request.url.includes('delete'))
    Http.assertSentCount(3)
    Http.assertSentInOrder([
      request => request.method === 'POST',
      request => request.method === 'PUT',
      request => request.url.endsWith('/upload'),
    ])
    expect(Http.recorded(request => request.method === 'PUT')).toHaveLength(1)
    expect(Http.recorded()[0]![0].body).toBe('{"name":"Ada","tags":["a"]}')

    expect(() => Http.assertSent(request => request.method === 'PATCH')).toThrow(/An expected request was not recorded[\s\S]*PUT https:\/\/example.com\/users\/1 → 200/)
    expect(() => Http.assertNotSent(request => request.method === 'PUT')).toThrow('An unexpected request was recorded')
    expect(() => Http.assertSentCount(1)).toThrow('Expected 1 request(s) to be sent, got 3')
    expect(() => Http.assertNothingSent()).toThrow('Expected no requests to be sent, got 3')
    expect(() => Http.assertSentInOrder([
      () => true,
    ])).toThrow('Expected 1 request(s) in order, got 3')
  })

  it('applies to named clients, Http.create() and middleware', async () => {
    Http.fake({
      'api.github.com/*': Http.response({ login: 'ada' }),
    })
    const user = await (await Http.client('github').get('/user')).json()
    expect(user).toEqual({ login: 'ada' })
    await Http.create({ baseURL: 'https://api.github.com' })
      .withMiddleware(async (request, next) => {
        request.headers.set('x-signed', 'yes')
        return next(request)
      })
      .get('/repos')
    Http.assertSent(request => request.client === 'github' && request.url === 'https://api.github.com/user' && request.header('authorization') === 'Bearer gh-token')
    Http.assertSent(request => request.url === 'https://api.github.com/repos' && request.hasHeader('x-signed', 'yes'))
  })

  it('exposes a fetch-compatible function for third-party SDKs', async () => {
    Http.fake({
      'api.vendor.test/*': Http.response({ id: 'ch_1' }, 201),
    })
    const sdkFetch = Http.withHeader('x-from', 'sdk').toFetch()
    const response = await sdkFetch('https://api.vendor.test/v1/charges', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ amount: 100 }),
    })
    expect(response).toBeInstanceOf(Response)
    expect(response.status).toBe(201)
    expect(await response.json()).toEqual({ id: 'ch_1' })
    Http.assertSent(request => request.method === 'POST'
      && request.hasHeader('x-from', 'sdk')
      && request.hasHeader('content-type', 'application/json')
      && new TextDecoder().decode(request.body as Uint8Array) === '{"amount":100}')
    // 真实请求
    const real = await Http.toFetch()(new Request(`${base}/echo/sdk`, { method: 'PUT', body: 'x' }))
    expect(await real.json()).toMatchObject({ method: 'PUT', path: '/echo/sdk', body: 'x' })
  })

  it('records telemetry for faked requests', async () => {
    Http.fake({
      '*': Http.response({ ok: true }),
    })
    const events: Array<TelemetryEvents['http']> = []
    const off = onTelemetry((kind, data) => {
      if (kind === 'http')
        events.push(data as TelemetryEvents['http'])
    })
    await Http.client('github').get('/user')
    off()
    expect(events).toEqual([
      expect.objectContaining({
        method: 'GET',
        url: 'https://api.github.com/user',
        status: 200,
        faked: true,
        client: 'github',
      }),
    ])
  })

  it('is scoped to the application: requests inside a route use the same fake', async () => {
    await app!.dispose()
    await boot({}, defineRoutes((r) => {
      r.get('/profile', async () => (await Http.get('https://api.github.com/user')).json())
    }))
    Http.fake({
      'api.github.com/*': Http.response({ login: 'from-fake' }),
    })
    expect(Http.manager()).toBe(app!.make(HttpManager))
    const response = await app!.request('/profile')
    expect(((await response.json()) as { data: unknown }).data).toEqual({ login: 'from-fake' })
    Http.assertSentCount(1)

    // 新的应用没有假响应
    const previous = app!
    app = undefined
    await previous.dispose()
    await boot()
    expect(Http.manager().faking).toBeUndefined()
    expect(() => Http.assertNothingSent()).toThrow('Http.fake() has not been called')
    Http.fake()
    Http.restore()
    expect(Http.manager().faking).toBeUndefined()
  })
})
