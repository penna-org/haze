import type { AppIntrospection, DashboardEntry, DashboardQuery } from '@hazejs/core'
import type { EntrySource } from '../src/data'
import { describe, expect, it } from 'vitest'
import { aiSummary, buildGraph, listRequests, repeatedQueries, requestDetail } from '../src/data'

let id = 0
function entry(type: DashboardEntry['type'], content: Record<string, unknown>, meta: Partial<DashboardEntry> = {}): DashboardEntry {
  return {
    id: ++id,
    type,
    time: 1000 + id,
    content,
    ...meta,
  }
}

/** 与 DashboardStore 相同的查询语义：最新的在前 */
function source(entries: DashboardEntry[]): EntrySource {
  const list = (query: DashboardQuery = {}): DashboardEntry[] => entries
    .filter(item => (!query.type || item.type === query.type) && (!query.requestId || item.requestId === query.requestId))
    .sort((a, b) => b.id - a.id)
    .slice(0, query.limit ?? 100)
  return {
    list,
    request: (requestId) => {
      const all = list({ requestId, limit: Number.POSITIVE_INFINITY })
      return {
        request: all.find(item => item.type === 'request'),
        entries: all.filter(item => item.type !== 'request').reverse(),
      }
    },
  }
}

function introspection(overrides: Partial<AppIntrospection> = {}): AppIntrospection {
  return {
    app: {
      name: 'demo',
      mode: 'development',
      debug: true,
      rootDir: '/app',
      srcDir: '/app',
      node: 'v22',
    },
    modules: [],
    apps: [],
    routes: [],
    middleware: { global: [], aliases: [], groups: [] },
    providers: [],
    bindings: [],
    events: [],
    jobs: [],
    schedules: [],
    ...overrides,
  }
}

function module(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    source: 'local' as const,
    prefix: `/${name}`,
    as: `${name}.`,
    routes: 0,
    providers: [],
    jobs: [],
    schedules: [],
    events: [],
    listeners: [],
    middleware: { aliases: [], groups: [], global: [] },
    ...extra,
  }
}

describe('buildGraph', () => {
  it('links modules through events, listeners, jobs, schedules, middleware and sub-apps', () => {
    const graph = buildGraph(introspection({
      modules: [
        module('shop', { app: 'admin' }),
        module('audit'),
      ],
      apps: [
        { name: 'admin', prefix: '/admin', routes: 0 },
      ],
      routes: [
        {
          method: 'GET',
          path: '/shop/orders',
          module: 'shop',
          handler: 'closure',
          middleware: ['audit.log:orders', 'auth'],
        },
      ],
      middleware: {
        global: [],
        aliases: [
          { name: 'audit.log', module: 'audit' },
          { name: 'auth' },
        ],
        groups: [],
      },
      events: [
        {
          name: 'OrderPlaced',
          module: 'shop',
          listeners: [
            { name: 'Record', module: 'audit', queued: true },
            { name: 'Notify', queued: false },
          ],
        },
      ],
      jobs: [
        { name: 'SendReceipt', module: 'shop' },
        { name: 'listener:Record' },
        { name: 'mail:send' },
      ],
      schedules: [
        {
          name: 'job:SendReceipt',
          module: 'audit',
          kind: 'job',
          expression: '0 0 * * *',
          withoutOverlapping: false,
          onOneServer: false,
        },
      ],
    }))

    expect(graph.nodes.map(node => node.id).sort()).toEqual([
      'app',
      'event:OrderPlaced',
      'job:SendReceipt',
      'module:audit',
      'module:shop',
      'subapp:admin',
    ])
    const edges = graph.edges.map(edge => `${edge.from} -${edge.kind}-> ${edge.to}${edge.labels.length
      ? ` [${edge.labels.join(', ')}]`
      : ''}`)
    expect(edges).toEqual(expect.arrayContaining([
      'module:shop -mounted-> subapp:admin',
      'module:shop -owns-> event:OrderPlaced',
      'event:OrderPlaced -listens-> module:audit [Record (queued)]',
      'event:OrderPlaced -listens-> app [Notify]',
      'module:shop -owns-> job:SendReceipt',
      'module:audit -schedules-> job:SendReceipt [0 0 * * *]',
      'module:shop -middleware-> module:audit [audit.log]',
    ]))
    expect(edges.some(edge => edge.includes('auth'))).toBe(false)
  })

  it('adds runtime links for events and jobs seen in requests and jobs', () => {
    const entries = [
      entry('request', { path: '/shop/orders', module: 'shop' }, { requestId: 'r1' }),
      entry('event', { event: 'OrderPlaced' }, { requestId: 'r1' }),
      entry('event', { event: 'OrderPlaced' }, { requestId: 'r1' }),
      entry('job', { job: 'SendReceipt', status: 'dispatched' }, { requestId: 'r1', jobId: 'j1' }),
      entry('job', { job: 'SendReceipt', status: 'ok' }, { requestId: 'r1', jobId: 'j1' }),
      // 任务执行期间触发的事件归到任务上
      entry('event', { event: 'ReceiptSent' }, { requestId: 'r1', jobId: 'j1' }),
      entry('request', { path: '/hello' }, { requestId: 'r2' }),
      entry('event', { event: 'Greeted' }, { requestId: 'r2' }),
    ]
    const graph = buildGraph(introspection({
      modules: [
        module('shop'),
      ],
    }), entries)
    const runtime = graph.edges.filter(edge => edge.runtime).map(edge => `${edge.from} -${edge.kind}-> ${edge.to} x${edge.count}`)
    expect(runtime.sort()).toEqual([
      'app -emits-> event:Greeted x1',
      'job:SendReceipt -emits-> event:ReceiptSent x1',
      'module:shop -dispatches-> job:SendReceipt x1',
      'module:shop -emits-> event:OrderPlaced x2',
    ])
  })
})

describe('requests', () => {
  const entries = [
    entry('request', {
      method: 'GET',
      path: '/a',
      status: 200,
      duration: 10,
    }, { requestId: 'a', time: 2000 }),
    entry('request', {
      method: 'POST',
      path: '/orders',
      status: 201,
      duration: 50,
      module: 'shop',
      name: 'orders.store',
    }, { requestId: 'b', time: 3050 }),
    entry('query', { sql: 'select * from users where id = ?', startTime: 3005, duration: 2 }, { requestId: 'b' }),
    entry('query', { sql: 'select * from users where id = ?', startTime: 3010, duration: 3 }, { requestId: 'b' }),
    entry('query', { sql: 'insert into orders', startTime: 3020, duration: 4 }, { requestId: 'b' }),
    entry('event', { event: 'OrderPlaced' }, { requestId: 'b', time: 3030 }),
    entry('log', { level: 'info', msg: 'in job' }, { requestId: 'b', jobId: 'j1', time: 3040 }),
  ]

  it('lists requests newest first with counts and repeated queries', () => {
    const list = listRequests(source(entries))
    expect(list.map(row => row.path)).toEqual(['/orders', '/a'])
    expect(list[0]).toMatchObject({
      module: 'shop',
      name: 'orders.store',
      status: 201,
      counts: { query: 3, event: 1, log: 1 },
      repeatedQueries: 2,
    })
    expect(list[1]!.counts).toEqual({})
  })

  it('places spans on the request timeline and flags repeated queries', () => {
    const detail = requestDetail(source(entries), 'b')!
    expect(detail.spans.map(span => [
      span.type,
      Math.round(span.start),
      span.duration,
    ])).toEqual([
      ['query', 5, 2],
      ['query', 10, 3],
      ['query', 20, 4],
      ['event', 30, 0],
      ['log', 40, 0],
    ])
    expect(detail.spans.at(-1)!.jobId).toBe('j1')
    expect(detail.repeatedQueries).toEqual([
      { sql: 'select * from users where id = ?', count: 2, total: 5 },
    ])
    expect(requestDetail(source(entries), 'missing')).toBeUndefined()
  })

  it('groups queries by SQL', () => {
    expect(repeatedQueries(entries)).toHaveLength(1)
    expect(repeatedQueries(entries, 1)).toHaveLength(2)
  })
})

describe('aiSummary', () => {
  it('totals tokens and errors per model', () => {
    const summary = aiSummary(source([
      entry('ai', {
        provider: 'openai',
        model: 'gpt',
        inputTokens: 10,
        outputTokens: 5,
        duration: 100,
      }),
      entry('ai', {
        provider: 'openai',
        model: 'gpt',
        inputTokens: 20,
        outputTokens: 5,
        duration: 300,
        error: 'rate limited',
      }),
      entry('ai', {
        provider: 'echo',
        model: 'parrot',
        inputTokens: 1,
        outputTokens: 1,
        duration: 1,
      }),
    ]))
    expect(summary).toMatchObject({
      calls: 3,
      errors: 1,
      inputTokens: 31,
      outputTokens: 11,
    })
    expect(summary.models[0]).toEqual({
      model: 'gpt',
      provider: 'openai',
      calls: 2,
      errors: 1,
      inputTokens: 30,
      outputTokens: 10,
      totalDuration: 400,
    })
  })
})
