import type { Application, MiddlewareHandler } from '../src'
import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, defineEvent, defineJob, defineListener, defineModule, defineProvider, defineRoutes, defineSchedule, onTelemetry, Scheduler, Scope } from '../src'

let app: Application | undefined

afterEach(async () => {
  await app?.dispose()
  app = undefined
})

const pass: MiddlewareHandler = (_ctx, next) => next()

class Mailer {}
class Clock {
  static scope = Scope.Request
}

describe('app.introspect()', () => {
  it('describes modules, routes, middleware, providers, bindings, events, jobs and schedules', async () => {
    const OrderPlaced = defineEvent<{ id: number }>()
    const UserSignedUp = defineEvent<{ id: number }>({ name: 'UserSignedUp' })
    const Digest = defineJob({
      name: 'SendDigest',
      queue: 'mail',
      tries: 3,
      handle: () => {},
    })

    const shop = defineModule({
      name: 'shop',
      prefix: '/shop',
      routes: defineRoutes((r) => {
        r.get('/orders', () => []).name('orders').middleware('audit')
      }),
      middleware: {
        alias: { audit: pass },
        groups: {
          shopping: ['audit'],
        },
      },
      providers: [
        class ShopProvider {
          register() {}
        },
      ],
      jobs: [Digest],
      events: { OrderPlaced },
      listeners: [
        // 订阅另一个模块（项目）的事件：模块联动
        defineListener(UserSignedUp, () => {}, { name: 'WelcomeCoupon' }),
      ],
      schedules: [
        defineSchedule(s => void s.job(Digest, {}).daily()),
      ],
    })

    app = await createApplication({
      mode: 'test',
      env: false,
      modules: [shop],
      config: {
        app: { name: 'demo' },
        middleware: {
          global: ['cors'],
        },
      },
      routes: [
        defineRoutes(r => void r.get('/hello', () => 'hi').name('hello')),
      ],
      events: [UserSignedUp],
      listeners: [
        defineListener(OrderPlaced, () => {}, { name: 'NotifyWarehouse', queue: true }),
      ],
      providers: [
        defineProvider({
          register(container) {
            container.singleton(Mailer).bind(Clock)
          },
        }),
      ],
    })

    const info = app.introspect()
    expect(JSON.parse(JSON.stringify(info))).toEqual(info)
    expect(info.app).toMatchObject({ name: 'demo', mode: 'test' })

    const module = info.modules.find(item => item.name === 'shop')!
    expect(module).toMatchObject({
      prefix: '/shop',
      routes: 1,
      providers: ['ShopProvider'],
      jobs: ['SendDigest'],
      schedules: ['job:SendDigest'],
      events: ['OrderPlaced'],
      listeners: ['WelcomeCoupon'],
      middleware: {
        aliases: ['audit'],
        groups: ['shopping'],
        global: [],
      },
    })

    expect(info.routes).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: '/shop/orders',
        module: 'shop',
        middleware: ['audit'],
      }),
      expect.objectContaining({ path: '/hello', name: 'hello' }),
    ]))
    expect(info.middleware.global).toEqual(['cors'])
    expect(info.middleware.aliases).toContainEqual({ name: 'audit', module: 'shop' })
    expect(info.middleware.groups).toContainEqual({
      name: 'shopping',
      members: ['audit'],
      module: 'shop',
    })
    expect(info.providers).toEqual([
      { name: 'ShopProvider', module: 'shop' },
      { name: 'anonymous' },
    ])

    expect(info.bindings).toEqual(expect.arrayContaining([
      {
        key: 'Mailer',
        scope: 'singleton',
        kind: 'class',
        resolved: false,
      },
      {
        key: 'Clock',
        scope: 'request',
        kind: 'class',
        resolved: false,
      },
      expect.objectContaining({ key: 'Application', kind: 'instance', resolved: true }),
    ]))

    expect(info.events).toEqual(expect.arrayContaining([
      {
        name: 'OrderPlaced',
        module: 'shop',
        listeners: [
          { name: 'NotifyWarehouse', queued: true },
        ],
      },
      {
        name: 'UserSignedUp',
        listeners: [
          { name: 'WelcomeCoupon', module: 'shop', queued: false },
        ],
      },
    ]))
    expect(info.jobs).toEqual(expect.arrayContaining([
      {
        name: 'SendDigest',
        module: 'shop',
        queue: 'mail',
        tries: 3,
      },
      expect.objectContaining({ name: 'listener:NotifyWarehouse' }),
    ]))
    expect(info.schedules).toEqual([
      expect.objectContaining({
        name: 'job:SendDigest',
        module: 'shop',
        kind: 'job',
        expression: '0 0 * * *',
      }),
    ])
    expect(info.schedules[0]!.nextRun).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(info.dashboard).toBeUndefined()
  })

  it('records each scheduled task run as telemetry', async () => {
    app = await createApplication({
      mode: 'test',
      env: false,
      schedules: [
        defineSchedule((s) => {
          s.call('tick', () => {}).everyMinute()
          s.call('boom', () => {
            throw new Error('nope')
          }).everyMinute()
        }),
      ],
    })
    const runs: unknown[] = []
    const off = onTelemetry((kind, data) => {
      if (kind === 'schedule')
        runs.push(data)
    })
    try {
      await app.make(Scheduler).runDue()
    }
    finally {
      off()
    }
    expect(runs).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'tick', kind: 'call', status: 'ok' }),
      expect.objectContaining({ name: 'boom', status: 'failed', error: 'nope' }),
    ]))
  })
})
