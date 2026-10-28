import type { IncomingMessage } from 'node:http'
import type { Application } from '../src'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createApplication, defineRoutes, html, Mail, MailFake, QueueManager } from '../src'
import { setBroadcastManager } from '../src/broadcast/broadcast'
import { defineChannels } from '../src/broadcast/channels'
import { BroadcastManager } from '../src/broadcast/manager'
import { NotificationDeliveryError, registerNotificationChannel } from '../src/notification/channel'
import { dingtalkPayload, feishuPayload, wecomPayload } from '../src/notification/channels/robots'
import { verifyWebhookSignature } from '../src/notification/channels/webhook'
import { markAsRead, Notification, NotificationManager, notify, setNotificationManager, unreadNotifications } from '../src/notification/manager'
import { AnonymousNotifiable, defineNotification, notifiableKey } from '../src/notification/notification'
import { memoryNotificationStore } from '../src/notification/store'

interface Captured {
  path: string
  query: URLSearchParams
  headers: IncomingMessage['headers']
  raw: string
  body: any
}

// 本地捕获服务器：模拟 Slack / 企业微信 / 钉钉 / 飞书 / 通用 Webhook
const requests: Captured[] = []
let base = ''
const server = createServer((req, res) => {
  let raw = ''
  req.on('data', chunk => (raw += chunk))
  req.on('end', () => {
    const url = new URL(req.url!, 'http://localhost')
    requests.push({
      path: url.pathname,
      query: url.searchParams,
      headers: req.headers,
      raw,
      body: raw
        ? JSON.parse(raw)
        : undefined,
    })
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, {
        'content-type': typeof body === 'string'
          ? 'text/plain'
          : 'application/json',
      })
      res.end(typeof body === 'string'
        ? body
        : JSON.stringify(body))
    }
    switch (url.pathname) {
      case '/slack':
        return reply(200, 'ok')
      case '/wecom':
      case '/dingtalk':
        return reply(200, { errcode: 0, errmsg: 'ok' })
      case '/dingtalk-bad-sign':
        return reply(200, { errcode: 310000, errmsg: 'sign not match' })
      case '/feishu':
        return reply(200, { code: 0, msg: 'success', data: {} })
      case '/webhook':
        return reply(204, '')
      default:
        return reply(500, 'boom')
    }
  })
})

beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})
const closers: Array<() => unknown> = []
afterEach(async () => {
  requests.length = 0
  for (const close of closers.splice(0).reverse())
    await close()
})
afterAll(() => new Promise(resolve => server.close(resolve)))

class User {
  constructor(readonly id: number, readonly name: string, readonly email: string, readonly hooks: Record<string, unknown> = {}) {}

  routeNotificationFor(channel: string): unknown {
    return this.hooks[channel]
  }
}

const InvoicePaid = defineNotification<{ amount: number }, User>({
  via: () => ['mail', 'database', 'broadcast'],
  toMail: (user, { amount }) => ({
    subject: `Invoice paid: ${amount}`,
    html: html`<p>Hi ${user.name}, we received ${amount}.</p>`.toString(),
    attachments: [
      {
        filename: 'receipt.txt',
        content: new TextEncoder().encode(`paid ${amount}`),
      },
    ],
  }),
  toArray: (_, { amount }) => ({ amount }),
})

const Alert = defineNotification<{ text: string }>({
  name: 'ServerAlert',
  via: () => [
    'slack',
    'webhook',
    'wecom',
    'dingtalk',
    'feishu',
  ],
  toSlack: (_, { text }) => ({
    text,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `*${text}*` },
      },
    ],
  }),
  toWebhook: (_, { text }) => ({ level: 'error', text }),
  toWecom: (_, { text }) => ({
    text,
    atAll: true,
    atMobiles: ['13800000000'],
  }),
  toDingtalk: (_, { text }) => ({
    markdown: `### 告警\n${text}`,
    atMobiles: ['13800000000'],
  }),
  toFeishu: (_, { text }) => ({
    markdown: `**${text}**`,
    title: '告警',
    atUserIds: ['ou_1'],
  }),
})

const Queued = defineNotification<{ step: number }>({
  via: () => ['mail', 'database'],
  toMail: (_, { step }) => ({ subject: `Step ${step}`, text: `step ${step}` }),
  toDatabase: (_, { step }) => ({ step }),
  queue: { delay: '1m', queue: 'notifications' },
})

/** 与 application.ts 中的接线相同（application.ts 已接线时跳过） */
function wire(app: Application): void {
  if (app.container.has(BroadcastManager))
    return
  const broadcast = new BroadcastManager(app)
  app.container.instance(BroadcastManager, broadcast)
  setBroadcastManager(broadcast, BroadcastManager)
  app.router.load(broadcast.routes())
  const notifications = new NotificationManager(app)
  app.container.instance(NotificationManager, notifications)
  setNotificationManager(notifications, NotificationManager)
}

async function boot(notification: Record<string, unknown> = {}) {
  const store = memoryNotificationStore()
  const app = await createApplication({
    mode: 'test',
    env: false,
    config: {
      logger: { level: 'silent' },
      app: {
        key: 'k'.repeat(32),
      },
      queue: { default: 'sync' },
      mail: { default: 'array', from: 'Billing <billing@demo.test>' },
      notification: {
        channels: {
          database: { store },
          ...notification,
        },
      },
    },
    discovered: {
      notifications: {
        '/app/notification/InvoicePaid.ts': { default: InvoicePaid },
      },
      channels: {
        '/app/channel/app.ts': {
          default: defineChannels(c => c.private('User.{id}', (user: { id: number }, { id }) => user.id === Number(id))),
        },
      },
    },
    routes: [
      defineRoutes((r) => {
        r.post('/pay', async () => {
          await notify(new User(1, 'Ada', 'ada@demo.test'), InvoicePaid({ amount: 10 }))
          return 'ok'
        })
      }),
    ],
    setup: wire,
  })
  closers.push(() => app.dispose())
  return {
    app,
    store,
    manager: app.make(NotificationManager),
  }
}

describe('notifications', () => {
  it('sends mail, database and broadcast notifications', async () => {
    const { app, store } = await boot()
    const mail = Mail.fake()
    const broadcasts = app.make(BroadcastManager).fake()
    const ada = new User(1, 'Ada', 'ada@demo.test')
    expect(await (await app.request('/pay', { method: 'POST' })).text()).toContain('ok')

    // mail：收件人默认取 email 与 name，字节附件经 base64 往返
    mail.assertSent(item => item.message.subject === 'Invoice paid: 10' && MailFake.hasRecipient(item, 'ada@demo.test'))
    const sent = mail.sent[0].message
    expect(sent.to).toEqual({ address: 'ada@demo.test', name: 'Ada' })
    expect(new TextDecoder().decode(sent.attachments![0].content as Uint8Array)).toBe('paid 10')

    // database：类型名取 app/notification 下的文件名
    const [record] = await unreadNotifications(ada)
    expect(record).toMatchObject({
      type: 'InvoicePaid',
      notifiableType: 'User',
      notifiableId: '1',
      data: { amount: 10 },
      readAt: null,
    })
    expect(store.records).toHaveLength(1)

    // broadcast：发到 private-User.1，事件名 notification，带 id 与 type
    broadcasts.assertBroadcastOn('private-User.1', 'notification', item => (item.data as any).id === record.id && (item.data as any).type === 'InvoicePaid' && (item.data as any).amount === 10)
  })

  it('reads and marks database notifications', async () => {
    const { manager } = await boot()
    const ada = new User(1, 'Ada', 'ada@demo.test')
    const bob = { id: 2, notifiableType: 'User', email: 'bob@demo.test' }
    Mail.fake()
    await Notification.sendNow([ada, bob], InvoicePaid({ amount: 1 }), ['database'])
    await Notification.sendNow(ada, InvoicePaid({ amount: 2 }), ['database'])
    expect(await Notification.unreadCount(ada)).toBe(2)
    const [latest, first] = await Notification.notifications(ada)
    expect([latest.data.amount, first.data.amount]).toEqual([2, 1])

    expect(await markAsRead(latest)).toBe(1)
    expect(await markAsRead([latest.id])).toBe(0)
    expect((await Notification.unread(ada)).map(item => item.data.amount)).toEqual([1])
    expect(await manager.markAsUnread(latest.id)).toBe(1)
    expect(await Notification.markAllAsRead(ada)).toBe(2)
    expect(await Notification.unreadCount(ada)).toBe(0)
    expect(await Notification.unreadCount(bob)).toBe(1)
    expect((await manager.notifications(ada, { unread: false, limit: 1 })).length).toBe(1)
  })

  it('posts Slack, webhook, WeCom, DingTalk and Feishu messages with signatures', async () => {
    await boot({
      webhook: { url: `${base}/webhook`, secret: 'whsec' },
      dingtalk: { url: `${base}/dingtalk?access_token=t1`, secret: 'SECdemo' },
      feishu: { url: `${base}/feishu`, secret: 'fs-secret' },
    })
    const ops = new User(9, 'Ops', 'ops@demo.test', { slack: `${base}/slack`, wecom: `${base}/wecom` })
    const before = Date.now()
    await notify(ops, Alert({ text: 'disk full' }))
    const by = (path: string) => requests.find(item => item.path === path)!

    expect(by('/slack').body).toEqual({
      text: 'disk full',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text: '*disk full*' },
        },
      ],
    })

    // 通用 webhook：请求体原样、HMAC-SHA256(secret, "<timestamp>.<body>")
    const webhook = by('/webhook')
    expect(webhook.body).toEqual({ level: 'error', text: 'disk full' })
    expect(webhook.headers['x-haze-notification']).toBe('ServerAlert')
    expect(webhook.headers['x-haze-notification-id']).toEqual(expect.any(String))
    const timestamp = webhook.headers['x-haze-timestamp'] as string
    expect(webhook.headers['x-haze-signature']).toBe(`sha256=${createHmac('sha256', 'whsec').update(`${timestamp}.${webhook.raw}`).digest('hex')}`)
    expect(await verifyWebhookSignature({
      body: webhook.raw,
      signature: webhook.headers['x-haze-signature'] as string,
      timestamp,
      secret: 'whsec',
    })).toBe(true)
    expect(await verifyWebhookSignature({
      body: `${webhook.raw} `,
      signature: webhook.headers['x-haze-signature'] as string,
      timestamp,
      secret: 'whsec',
    })).toBe(false)
    expect(await verifyWebhookSignature({
      body: webhook.raw,
      signature: webhook.headers['x-haze-signature'] as string,
      timestamp: '1000',
      secret: 'whsec',
    })).toBe(false)

    expect(by('/wecom').body).toEqual({
      msgtype: 'text',
      text: {
        content: 'disk full',
        mentioned_list: ['@all'],
        mentioned_mobile_list: ['13800000000'],
      },
    })

    // 钉钉加签：timestamp（毫秒）与 urlencode(base64(HMAC-SHA256(secret, "timestamp\nsecret")))
    const dingtalk = by('/dingtalk')
    expect(dingtalk.body).toEqual({
      msgtype: 'markdown',
      markdown: { title: '告警', text: '### 告警\ndisk full' },
      at: {
        atMobiles: ['13800000000'],
      },
    })
    expect(dingtalk.query.get('access_token')).toBe('t1')
    const ts = dingtalk.query.get('timestamp')!
    expect(Number(ts)).toBeGreaterThanOrEqual(before)
    expect(dingtalk.query.get('sign')).toBe(createHmac('sha256', 'SECdemo').update(`${ts}\nSECdemo`).digest('base64'))

    // 飞书签名：以 "timestamp\nsecret" 为密钥对空串做 HMAC-SHA256，timestamp 为秒
    const feishu = by('/feishu')
    expect(feishu.body).toMatchObject({
      msg_type: 'interactive',
      card: {
        header: {
          title: { tag: 'plain_text', content: '告警' },
        },
        elements: [
          { tag: 'markdown', content: '<at id=ou_1></at>\n**disk full**' },
        ],
      },
    })
    expect(feishu.body.sign).toBe(createHmac('sha256', `${feishu.body.timestamp}\nfs-secret`).update('').digest('base64'))
    expect(Math.abs(Number(feishu.body.timestamp) - before / 1000)).toBeLessThan(5)
  })

  it('builds vendor payloads for text, markdown and raw messages', () => {
    expect(wecomPayload('hi')).toEqual({
      msgtype: 'text',
      text: { content: 'hi' },
    })
    expect(wecomPayload({ markdown: '**hi**' })).toEqual({
      msgtype: 'markdown',
      markdown: { content: '**hi**' },
    })
    expect(dingtalkPayload({
      text: 'hi',
      atAll: true,
      atUserIds: ['u1'],
    })).toEqual({
      msgtype: 'text',
      text: { content: 'hi' },
      at: {
        atUserIds: ['u1'],
        isAtAll: true,
      },
    })
    expect(dingtalkPayload({
      raw: {
        msgtype: 'link',
        link: { title: 't' },
      },
    })).toEqual({
      msgtype: 'link',
      link: { title: 't' },
    })
    expect(feishuPayload({ text: 'hi', atAll: true })).toEqual({
      msg_type: 'text',
      content: { text: '<at user_id="all">所有人</at> hi' },
    })
    expect(feishuPayload({ markdown: 'x' })).toEqual({
      msg_type: 'interactive',
      card: {
        elements: [
          { tag: 'markdown', content: 'x' },
        ],
      },
    })
  })

  it('surfaces vendor errors and HTTP failures', async () => {
    await boot({
      dingtalk: { url: `${base}/dingtalk-bad-sign` },
      slack: { url: `${base}/nope` },
    })
    const ops = { id: 1 }
    const Ding = defineNotification({
      via: () => ['dingtalk'],
      toDingtalk: () => 'hi',
    })
    const Slack = defineNotification({
      via: () => ['slack'],
      toSlack: () => 'hi',
    })
    await expect(notify(ops, Ding())).rejects.toThrow('sign not match')
    await expect(notify(ops, Slack())).rejects.toBeInstanceOf(NotificationDeliveryError)
    const Missing = defineNotification({
      name: 'Missing',
      via: () => ['slack'],
    })
    await expect(notify(ops, Missing())).rejects.toThrow('Notification "Missing" is sent via "slack" but defines none of toSlack()')
  })

  it('sends on demand, skipping channels without a route', async () => {
    await boot()
    const mail = Mail.fake()
    const OnDemand = defineNotification({
      via: () => [
        'mail',
        'slack',
        'database',
        'broadcast',
      ],
      toMail: () => ({ subject: 'Deploy finished', text: 'done' }),
      toSlack: () => 'deploy finished',
      toArray: () => ({ done: true }),
    })
    await Notification.route('mail', 'ops@demo.test').route('slack', `${base}/slack`).notify(OnDemand())
    mail.assertSent(item => MailFake.hasRecipient(item, 'ops@demo.test'))
    expect(requests.map(item => item.path)).toEqual(['/slack'])
  })

  it('queues one job per channel and delivers them from the worker', async () => {
    const { app, store } = await boot()
    const queue = app.make(QueueManager).fake()
    const mail = Mail.fake()
    await notify(new User(1, 'Ada', 'ada@demo.test'), Queued({ step: 1 }))
    queue.assertCount(2)
    queue.assertDispatched('notification:send', (delivery: any) => delivery.channel === 'mail' && delivery.route.address === 'ada@demo.test')
    expect(queue.dispatched.every(item => item.delay === 60 && item.queue === 'notifications')).toBe(true)
    mail.assertNothingSent()
    // 载荷可 JSON 往返，worker 中无需通知定义
    for (const item of queue.dispatched)
      item.payload = JSON.parse(JSON.stringify(item.payload))
    expect((await queue.drain()).map(result => result.status)).toEqual(['ok', 'ok'])
    mail.assertSent(item => item.message.subject === 'Step 1')
    expect(store.records[0]).toMatchObject({
      type: 'Notification',
      data: { step: 1 },
    })

    // notifyNow 忽略 queue
    app.make(QueueManager).restore()
    await Notification.sendNow(new User(1, 'Ada', 'ada@demo.test'), Queued({ step: 2 }))
    expect(store.records).toHaveLength(2)
  })

  it('retries failed queued deliveries with the configured tries', async () => {
    const { app } = await boot({
      slack: { url: `${base}/nope` },
    })
    const Flaky = defineNotification({
      via: () => ['slack'],
      toSlack: () => 'x',
      queue: true,
    })
    const queue = app.make(QueueManager).fake()
    await notify({ id: 1 }, Flaky())
    const [job] = queue.dispatched
    const message = {
      id: 'm1',
      job: job.job,
      payload: job.payload,
      queue: job.queue,
      attempts: 0,
      dispatchedAt: Date.now(),
    }
    expect((await app.make(QueueManager).process(message, 1)).status).toBe('retry')
    expect((await app.make(QueueManager).process(message, 3)).status).toBe('failed')
  })

  it('fakes notifications with assertions', async () => {
    const { app } = await boot()
    const fake = Notification.fake()
    const ada = new User(1, 'Ada', 'ada@demo.test')
    await notify(ada, InvoicePaid({ amount: 5 }))
    await notify({ id: 2, notifiableType: 'User' }, Queued({ step: 1 }))
    await Notification.route('slack', 'https://hooks.example/x').notify(Alert({ text: 'down' }))

    fake.assertSentTo(ada, InvoicePaid, sent => sent.payload.amount === 5 && sent.channels.includes('database'))
    // 相同类型与 ID 的对象视为同一个通知对象
    fake.assertSentTo(new User(1, 'Other', 'x@demo.test'), InvoicePaid)
    fake.assertNotSentTo(ada, Queued)
    fake.assertSentTo({ id: 2, notifiableType: 'User' }, Queued, sent => sent.queued)
    fake.assertSentOnDemand(Alert, sent => sent.notifiable.routes.get('slack') === 'https://hooks.example/x')
    fake.assertSentTimes(InvoicePaid, 1)
    fake.assertCount(3)
    fake.assertNothingSentTo({ id: 3 })
    expect(() => fake.assertNothingSent()).toThrow()
    expect(() => fake.assertSentTo(ada, Alert)).toThrow('Expected notification "ServerAlert" to be sent to User#1')
    // 渲染某个渠道的内容
    const [sent] = fake.sentTo(ada, InvoicePaid)
    expect(await sent.message('mail')).toMatchObject({ subject: 'Invoice paid: 5' })
    expect(app.make(BroadcastManager)).toBeDefined()
  })

  it('supports custom channels and identifies notifiables', async () => {
    const { manager } = await boot({
      sms: { from: 'HAZE' },
    })
    const sent: unknown[] = []
    registerNotificationChannel('sms', {
      send: ({ route, message }, { config }) => sent.push({ to: route, text: message, from: config.from }),
    })
    const Code = defineNotification<{ code: string }>({
      via: () => ['sms', 'pager-duty'],
      toSms: (_, { code }) => `code ${code}`,
      toPagerDuty: () => ({ severity: 'info' }),
    })
    manager.extend('pager-duty', {
      send: ({ message }) => sent.push(message),
    })
    await notify({
      id: 1,
      routeNotificationFor: (channel: string) => channel === 'sms'
        ? '+8613800000000'
        : undefined,
    }, Code({ code: '1234' }))
    expect(sent).toEqual([
      { to: '+8613800000000', text: 'code 1234', from: 'HAZE' },
      { severity: 'info' },
    ])
    await expect(notify({ id: 1 }, defineNotification({
      via: () => ['nope'],
    })())).rejects.toThrow('Notification channel "nope" is not registered')

    class Admin {
      static notifiableType = 'Staff'
      getKey() {
        return 5
      }
    }
    expect(notifiableKey(new Admin())).toEqual({ type: 'Staff', id: '5' })
    expect(notifiableKey({ id: 1 })).toEqual({ type: 'User', id: '1' })
    expect(notifiableKey(new AnonymousNotifiable())).toBeUndefined()
    await expect(notify({ id: 1 }, {} as never)).rejects.toThrow('expects a notification')
  })

  it('requires a store for the database channel', async () => {
    const app = await createApplication({
      mode: 'test',
      env: false,
      config: {
        logger: { level: 'silent' },
      },
      setup: wire,
    })
    closers.push(() => app.dispose())
    await expect(notify({ id: 1 }, defineNotification({
      via: () => ['database'],
      toDatabase: () => ({}),
    })())).rejects.toThrow('needs a store')
  })
})
