import { afterEach, describe, expect, it } from 'vitest'
import { createApplication, defineEvent, defineListener, EventManager, Events, Queue } from '../src'

const log: string[] = []

const UserRegistered = defineEvent<{ userId: number }>()
const OrderPlaced = defineEvent<{ orderId: number }>({ name: 'order.placed' })

const audit = defineListener(UserRegistered, ({ userId }, ctx) => void log.push(`audit:${userId}:${ctx.event}`))
const welcome = defineListener(UserRegistered, async ({ userId }, ctx) => {
  log.push(`welcome:${userId}:attempt${ctx.attempt}`)
}, {
  queue: { tries: 2 },
})
const stopper = defineListener(OrderPlaced, () => {
  log.push('stopper')
  return false
})
const never = defineListener(OrderPlaced, () => void log.push('never'))
const both = defineListener([UserRegistered, OrderPlaced], (_payload, ctx) => void log.push(`both:${ctx.event}`))

let app: Awaited<ReturnType<typeof createApplication>> | undefined
afterEach(async () => {
  await app?.dispose()
  app = undefined
  log.length = 0
})

async function boot() {
  app = await createApplication({
    mode: 'test',
    env: false,
    events: {
      '/app/event/UserRegistered.ts': { default: UserRegistered },
      '/app/event/OrderPlaced.ts': { default: OrderPlaced },
    },
    listeners: {
      '/app/listener/Audit.ts': { default: audit },
      '/app/listener/SendWelcome.ts': { default: welcome },
      // 监听器按文件名顺序执行
      '/app/listener/AStopper.ts': { default: stopper },
      '/app/listener/Never.ts': { default: never },
      '/app/listener/Both.ts': { default: both },
    },
    config: {
      logger: { level: 'silent' },
    },
  })
  return app
}

describe('events', () => {
  it('runs sync listeners in order and queues queued listeners as jobs', async () => {
    const instance = await boot()
    const manager = instance.make(EventManager)
    expect(manager.nameOf(UserRegistered)).toBe('UserRegistered')
    expect(manager.nameOf(OrderPlaced)).toBe('order.placed')
    expect(manager.listeners(UserRegistered)).toEqual(['Audit', 'Both', 'SendWelcome'])

    await UserRegistered.emit({ userId: 7 })
    // 同步监听器在 emit 返回前执行完，排队的在队列中执行
    expect(log.slice(0, 2)).toEqual(['audit:7:UserRegistered', 'both:UserRegistered'])
    await Queue.idle()
    expect(log).toEqual(['audit:7:UserRegistered', 'both:UserRegistered', 'welcome:7:attempt1'])

    // 排队监听器以队列任务 listener:<名字> 投递
    const queue = Queue.fake()
    await UserRegistered.emit({ userId: 8 })
    queue.assertDispatched('listener:SendWelcome', (payload: any) => payload.event === 'UserRegistered' && payload.payload.userId === 8)
  })

  it('stops later listeners when one returns false', async () => {
    await boot()
    await Events.emit(OrderPlaced, { orderId: 1 })
    expect(log).toEqual(['stopper'])
  })

  it('registers runtime listeners and propagates errors from sync listeners', async () => {
    await boot()
    const off = Events.on(UserRegistered, ({ userId }) => {
      if (userId === 0)
        throw new Error('invalid user')
      log.push(`runtime:${userId}`)
    })
    await UserRegistered.emit({ userId: 1 })
    expect(log).toContain('runtime:1')
    await expect(UserRegistered.emit({ userId: 0 })).rejects.toThrow('invalid user')
    off()
    log.length = 0
    await UserRegistered.emit({ userId: 2 })
    expect(log).not.toContain('runtime:2')
  })

  it('fake() records emits without running listeners, optionally for some events only', async () => {
    await boot()
    const fake = Events.fake()
    await UserRegistered.emit({ userId: 3 })
    fake.assertEmitted(UserRegistered)
    fake.assertEmitted(UserRegistered, payload => payload.userId === 3)
    fake.assertNotEmitted(OrderPlaced)
    fake.assertEmittedTimes(UserRegistered, 1)
    expect(() => fake.assertEmitted(UserRegistered, payload => payload.userId === 9)).toThrow('matching payload')
    expect(log).toEqual([])

    Events.restore()
    const partial = Events.fake([OrderPlaced])
    await OrderPlaced.emit({ orderId: 1 })
    await UserRegistered.emit({ userId: 4 })
    partial.assertEmitted(OrderPlaced)
    expect(log.slice(0, 2)).toEqual(['audit:4:UserRegistered', 'both:UserRegistered'])
    expect(log).not.toContain('stopper')
  })

  it('rejects modules that are not events or listeners', async () => {
    await expect(createApplication({
      mode: 'test',
      env: false,
      listeners: [{}],
      config: {
        logger: { level: 'silent' },
      },
    })).rejects.toThrow('defineListener')
  })
})
