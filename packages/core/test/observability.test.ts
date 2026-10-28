import type { Context, ContextManager } from '@opentelemetry/api'
import type { Server } from 'node:http'
import type { Application } from '../src'
import type { LogEntry } from '../src/logger-transports'
import type { ObservabilityConfig } from '../src/observability'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createServer } from 'node:http'
import { context, metrics, ROOT_CONTEXT, SpanKind, SpanStatusCode, trace } from '@opentelemetry/api'
import { InMemorySpanExporter, SimpleSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Cache, createApplication, defineJob, defineRoutes, Mail, QueueManager } from '../src'
import { activeTraceIds, injectTraceContext, openTelemetryEnabled, recordTelemetry, tracedFetch, withTraceContext } from '../src/observability'
import { setOpenTelemetryLoader } from '../src/observability/otel'

/** 最小的 AsyncLocalStorage 上下文管理器（NodeSDK 中由 @opentelemetry/context-async-hooks 提供） */
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

/** 记录指标调用的 MeterProvider 替身 */
const measurements: Array<{ name: string, value: number, attributes: Record<string, unknown> }> = []
function instrument(name: string) {
  return {
    record: (value: number, attributes: Record<string, unknown> = {}) => void measurements.push({ name, value, attributes }),
    add: (value: number, attributes: Record<string, unknown> = {}) => void measurements.push({ name, value, attributes }),
  }
}
const meterProvider = {
  getMeter: () => ({
    createHistogram: instrument,
    createCounter: instrument,
    createUpDownCounter: instrument,
  }),
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
  metrics.setGlobalMeterProvider(meterProvider as never)
})
afterAll(async () => {
  await provider.shutdown()
  trace.disable()
  context.disable()
  metrics.disable()
})

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const PARENT_ID = '00f067aa0ba902b7'

let app: Application | undefined
let downstream: Server | undefined
const jobLog: Array<{ trace?: { trace_id: string, span_id: string }, context?: Record<string, string> }> = []
const entries: LogEntry[] = []

const Traced = defineJob({
  async handle(_payload: null) {
    jobLog.push({
      trace: activeTraceIds(),
    })
  },
})
const Broken = defineJob({
  tries: 1,
  handle() {
    throw new Error('job broke')
  },
})

beforeEach(() => {
  exporter.reset()
  measurements.length = 0
  jobLog.length = 0
  entries.length = 0
})
afterEach(async () => {
  await app?.dispose()
  app = undefined
  setOpenTelemetryLoader(undefined)
  if (downstream)
    await new Promise(resolve => downstream!.close(resolve))
  downstream = undefined
})

async function boot(observability: ObservabilityConfig, routes = defineRoutes(() => {})) {
  app = await createApplication({
    mode: 'test',
    env: false,
    config: {
      observability,
      logger: {
        level: 'info',
        channel: 'memory',
        channels: {
          memory: {
            driver: 'custom',
            transport: (entry: LogEntry) => entries.push(entry),
          },
        },
      },
      queue: {
        default: 'memory',
        connections: {
          memory: { driver: 'memory' },
        },
      },
      mail: { default: 'array', from: 'app@example.com' },
    },
    jobs: {
      '/app/job/Traced.ts': { default: Traced },
      '/app/job/Broken.ts': { default: Broken },
    },
    routes: [routes],
  })
  return app
}

const spans = () => exporter.getFinishedSpans()
const spanNamed = (name: string) => spans().find(span => span.name === name)

describe('openTelemetry', () => {
  it('creates an HTTP server span with semantic attributes and continues the incoming trace', async () => {
    await boot({
      otel: { enabled: true },
    }, defineRoutes((r) => {
      r.get('/users/:id', (ctx) => {
        ctx.logger.info('loading user')
        return {
          id: ctx.param('id'),
        }
      })
    }))
    expect(openTelemetryEnabled()).toBe(true)
    const response = await app!.request('/users/42?expand=1', {
      headers: { 'traceparent': `00-${TRACE_ID}-${PARENT_ID}-01`, 'user-agent': 'vitest' },
    })
    expect(response.status).toBe(200)

    const span = spanNamed('GET /users/:id')!
    expect(span).toBeDefined()
    expect(span.kind).toBe(SpanKind.SERVER)
    expect(span.spanContext().traceId).toBe(TRACE_ID)
    expect(span.parentSpanContext?.spanId).toBe(PARENT_ID)
    expect(span.attributes).toMatchObject({
      'http.request.method': 'GET',
      'url.path': '/users/42',
      'url.query': 'expand=1',
      'url.scheme': 'http',
      'http.route': '/users/:id',
      'http.response.status_code': 200,
      'server.address': 'localhost',
      'user_agent.original': 'vitest',
    })
    // 日志带上 trace_id / span_id
    const log = entries.find(entry => entry.msg === 'loading user')!
    expect(log.trace_id).toBe(TRACE_ID)
    expect(log.span_id).toBe(span.spanContext().spanId)
  })

  it('marks 5xx responses as errors and records the exception', async () => {
    await boot({
      otel: { enabled: true },
    }, defineRoutes((r) => {
      r.get('/boom', () => {
        throw new Error('kaboom')
      })
      r.get('/missing', () => {
        throw Object.assign(new Error('nope'), { status: 404 })
      })
    }))
    expect((await app!.request('/boom')).status).toBe(500)
    const span = spanNamed('GET /boom')!
    expect(span.status.code).toBe(SpanStatusCode.ERROR)
    expect(span.attributes['error.type']).toBe('500')
    expect(span.events.find(event => event.name === 'exception')?.attributes?.['exception.message']).toBe('kaboom')

    await app!.request('/nowhere')
    const notFound = spans().find(item => item.attributes['url.path'] === '/nowhere')!
    expect(notFound.name).toBe('GET')
    expect(notFound.attributes['http.response.status_code']).toBe(404)
    expect(notFound.status.code).toBe(SpanStatusCode.UNSET)
  })

  it('records HTTP metrics (duration histogram and active requests)', async () => {
    await boot({
      otel: { enabled: true },
    }, defineRoutes(r => r.get('/items/:id', () => 'ok')))
    await app!.request('/items/1', { method: 'GET' })
    const duration = measurements.find(item => item.name === 'http.server.request.duration')!
    expect(duration.value).toBeGreaterThan(0)
    expect(duration.attributes).toMatchObject({ 'http.request.method': 'GET', 'http.route': '/items/:id', 'http.response.status_code': 200 })
    const active = measurements.filter(item => item.name === 'http.server.active_requests').map(item => item.value)
    expect(active).toEqual([1, -1])
  })

  it('injects traceparent into outgoing fetch calls', async () => {
    let received: string | undefined
    downstream = createServer((req, res) => {
      received = req.headers.traceparent as string | undefined
      res.end('ok')
    })
    await new Promise<void>(resolve => downstream!.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(downstream.address() as { port: number }).port}/hook`
    await boot({
      otel: { enabled: true },
    }, defineRoutes(r => r.get('/proxy', async () => (await tracedFetch(url)).text())))

    await app!.request('/proxy', {
      headers: { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` },
    })
    const client = spans().find(span => span.kind === SpanKind.CLIENT)!
    expect(client.name).toBe('GET')
    expect(client.attributes).toMatchObject({
      'http.request.method': 'GET',
      'url.full': url,
      'server.address': '127.0.0.1',
      'http.response.status_code': 200,
    })
    expect(received).toBe(`00-${TRACE_ID}-${client.spanContext().spanId}-01`)
    const server = spanNamed('GET /proxy')!
    expect(client.parentSpanContext?.spanId).toBe(server.spanContext().spanId)

    // 手动传播：injectTraceContext / withTraceContext
    const carrier = await context.with(trace.setSpan(ROOT_CONTEXT, server as never), async () => injectTraceContext())
    expect(carrier.traceparent).toContain(TRACE_ID)
    const ids = withTraceContext({ traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` }, () => trace.getSpanContext(context.active()))
    expect(ids).toMatchObject({ traceId: TRACE_ID, spanId: PARENT_ID, isRemote: true })
  })

  it('propagates the trace through queued jobs and records job metrics', async () => {
    await boot({
      otel: { enabled: true },
    }, defineRoutes(r => r.post('/work', async () => {
      await Traced.dispatch(null)
      await Broken.dispatch(null)
      return 'queued'
    })))
    await app!.request('/work', {
      method: 'POST',
      headers: { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` },
    })
    await app!.make(QueueManager).idle()

    const send = spans().filter(span => span.kind === SpanKind.PRODUCER)
    expect(send).toHaveLength(2)
    expect(send[0]!.name).toBe('send default')
    expect(send[0]!.attributes).toMatchObject({ 'messaging.operation.type': 'send', 'messaging.destination.name': 'default', 'haze.job.name': 'Traced' })

    const process = spans().filter(span => span.kind === SpanKind.CONSUMER)
    const traced = process.find(span => span.attributes['haze.job.name'] === 'Traced')!
    expect(traced.name).toBe('process default')
    expect(traced.spanContext().traceId).toBe(TRACE_ID)
    expect(traced.parentSpanContext?.spanId).toBe(send[0]!.spanContext().spanId)
    // 任务内的活动 span 为 CONSUMER span
    expect(jobLog[0]!.trace).toEqual({ trace_id: TRACE_ID, span_id: traced.spanContext().spanId })

    const broken = process.find(span => span.attributes['haze.job.name'] === 'Broken')!
    expect(broken.status.code).toBe(SpanStatusCode.ERROR)
    expect(broken.attributes['haze.job.status']).toBe('failed')

    const durations = measurements.filter(item => item.name === 'messaging.process.duration')
    expect(durations).toHaveLength(2)
    expect(durations.find(item => item.attributes['haze.job.name'] === 'Broken')!.attributes['error.type']).toBe('Error')
    expect(measurements.filter(item => item.name === 'haze.queue.job.failures').map(item => item.attributes['haze.job.name'])).toEqual(['Broken'])
  })

  it('creates spans for mail, cache (opt-in), queries and AI calls', async () => {
    await boot({
      otel: {
        enabled: true,
        traces: { cache: true },
      },
    }, defineRoutes(r => r.get('/side-effects', async () => {
      await Cache.set('k', 1)
      await Cache.get('k')
      await Mail.send({ to: 'ada@example.com', subject: 'Hi', text: 'Hello' })
      recordTelemetry('query', {
        sql: 'select * from users where id = ?',
        params: [1],
        connection: 'default',
        dialect: 'sqlite',
        startTime: Date.now() - 5,
        duration: 5,
      })
      recordTelemetry('ai', {
        operation: 'chat',
        provider: 'openai',
        model: 'gpt-5',
        inputTokens: 12,
        outputTokens: 34,
        totalTokens: 46,
        finishReason: 'stop',
        startTime: Date.now() - 20,
        duration: 20,
      })
      return 'ok'
    })))
    await app!.request('/side-effects')
    const server = spanNamed('GET /side-effects')!
    const children = spans().filter(span => span.parentSpanContext?.spanId === server.spanContext().spanId)
    expect(children.map(span => span.name).sort()).toEqual([
      'SELECT',
      'cache.get',
      'cache.set',
      'chat gpt-5',
      'mail.send',
    ])

    expect(spanNamed('cache.get')!.attributes).toMatchObject({ 'haze.cache.store': 'memory', 'haze.cache.hit': true })
    expect(spanNamed('mail.send')!.attributes).toMatchObject({ 'haze.mail.mailer': 'array', 'haze.mail.driver': 'array', 'haze.mail.recipients': 1 })
    const query = spanNamed('SELECT')!
    expect(query.attributes).toMatchObject({
      'db.system.name': 'sqlite',
      'db.query.text': 'select * from users where id = ?',
      'db.operation.name': 'SELECT',
      'db.namespace': 'default',
    })
    // 补建的 span 使用上报的开始时间与耗时
    const [seconds, nanos] = query.duration
    expect(seconds * 1000 + nanos / 1e6).toBeCloseTo(5, 0)
    expect(spanNamed('chat gpt-5')!.attributes).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.provider.name': 'openai',
      'gen_ai.request.model': 'gpt-5',
      'gen_ai.usage.input_tokens': 12,
      'gen_ai.usage.output_tokens': 34,
      'gen_ai.response.finish_reasons': ['stop'],
    })
  })

  it('skips ignored paths (health checks) and cache spans by default', async () => {
    await boot({
      otel: { enabled: true },
    }, defineRoutes(r => r.get('/c', async () => Cache.get('x'))))
    await app!.request('/health/live')
    await app!.request('/c')
    expect(spans().map(span => span.name)).toEqual(['GET /c'])
  })

  it('is a no-op when disabled or when @opentelemetry/api is missing', async () => {
    // 默认未开启：即使已注册 SDK 也不产生 span
    await boot({}, defineRoutes(r => r.post('/work', async () => {
      await Traced.dispatch(null)
      return 'ok'
    })))
    expect(openTelemetryEnabled()).toBe(false)
    await app!.request('/work', {
      method: 'POST',
      headers: { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` },
    })
    await app!.make(QueueManager).idle()
    expect(spans()).toHaveLength(0)
    expect(measurements).toHaveLength(0)
    expect(jobLog[0]!.trace).toBeUndefined()
    await app!.dispose()

    // 开启但未安装 api：给出警告，保持空操作
    setOpenTelemetryLoader(() => Promise.reject(new Error('Cannot find package \'@opentelemetry/api\'')))
    await boot({
      otel: { enabled: true },
    }, defineRoutes(r => r.get('/fetch', () => ({
      carrier: injectTraceContext(),
    }))))
    expect(openTelemetryEnabled()).toBe(false)
    expect(entries.find(entry => entry.level === 'warn')?.msg).toContain('@opentelemetry/api is not installed')
    const body = await (await app!.request('/fetch', {
      headers: { traceparent: `00-${TRACE_ID}-${PARENT_ID}-01` },
    })).json() as any
    expect(body.data.carrier).toEqual({})
    expect(spans()).toHaveLength(0)
    expect(withTraceContext({ traceparent: 'x' }, () => 42)).toBe(42)

    // 打包器把缺失的可选依赖替换为空模块时同样视为未安装
    await app!.dispose()
    setOpenTelemetryLoader(async () => ({}))
    await boot({
      otel: { enabled: true },
    })
    expect(openTelemetryEnabled()).toBe(false)
  })
})
