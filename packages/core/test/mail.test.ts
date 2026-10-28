import type { IncomingMessage } from 'node:http'
import type { Application, ResolvedMessage } from '../src'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:http'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { button, createApplication, defineMail, defineRoutes, html, htmlToText, Mail, MailFake, mailLayout, MailManager, QueueManager, rawHtml, StorageManager } from '../src'

const WelcomeMail = defineMail((payload: { name: string, url: string }) => ({
  subject: `欢迎，${payload.name}`,
  html: mailLayout({
    brand: 'Demo',
    preheader: '感谢注册',
    body: html`<h1>你好，${payload.name}</h1><p>点击下方按钮开始使用。</p>${button('开始使用', payload.url)}`,
    footer: '© Demo',
  }),
}), { name: 'WelcomeMail' })

const ReportMail = defineMail(() => ({
  subject: 'Monthly report',
  text: 'See attachments.',
  attachments: [
    { filename: 'inline.txt', content: 'inline content' },
    { filename: 'report.csv', disk: 'local', path: 'reports/2026-10.csv' },
  ],
}), { name: 'ReportMail' })

function boot(mail: Record<string, unknown> = {}) {
  return createApplication({
    mode: 'test',
    env: false,
    config: {
      logger: { level: 'silent' },
      queue: { default: 'sync' },
      filesystem: {
        default: 'local',
        disks: {
          local: { driver: 'memory' },
        },
      },
      mail: {
        default: 'array',
        from: 'Demo <noreply@demo.test>',
        ...mail,
      },
    },
    routes: [
      defineRoutes((r) => {
        r.post('/register', async (ctx) => {
          const { email, name } = await ctx.body<{ email: string, name: string }>()
          await Mail.to({ address: email, name }).queue(WelcomeMail, { name, url: 'https://demo.test/start' })
          return { ok: true }
        })
      }),
    ],
  })
}

const closers: Array<() => Promise<unknown>> = []
afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

async function start(mail: Record<string, unknown> = {}): Promise<Application> {
  const app = await boot(mail)
  closers.push(() => app.dispose())
  return app
}

const messages = (app: Application) => (app.make(MailManager).transport('array') as unknown as { messages: ResolvedMessage[] }).messages

describe('mail', () => {
  it('renders mails with the layout helpers and sends them through the array driver', async () => {
    const app = await start()
    const sent = await app.make(MailManager).to('Ada Lovelace <ada@example.com>').cc('cc@example.com').send(WelcomeMail, { name: '<Ada>', url: 'https://demo.test/start?a=1&b=2' })
    expect(sent.mailer).toBe('array')
    expect(sent.messageId).toBeTruthy()

    const [message] = messages(app)
    expect(message.from).toEqual({ address: 'noreply@demo.test', name: 'Demo' })
    expect(message.to).toEqual([
      { address: 'ada@example.com', name: 'Ada Lovelace' },
    ])
    expect(message.cc).toEqual([
      { address: 'cc@example.com' },
    ])
    expect(message.subject).toBe('欢迎，<Ada>')
    // 插值被转义
    expect(message.html).toContain('<h1>你好，&lt;Ada&gt;</h1>')
    expect(message.html).toContain('href="https://demo.test/start?a=1&amp;b=2"')
    // 纯文本由 html 生成
    expect(message.text).toBe('Demo\n\n你好，<Ada>\n点击下方按钮开始使用。\n开始使用 (https://demo.test/start?a=1&b=2)\n\n© Demo')
  })

  it('resolves attachments from content and storage disks', async () => {
    const app = await start()
    await app.make(StorageManager).disk('local').put('reports/2026-10.csv', 'a,b\n1,2\n')
    await app.make(MailManager).to('ops@example.com').send(ReportMail)
    const [message] = messages(app)
    expect(message.attachments.map(item => [
      item.filename,
      item.contentType,
      new TextDecoder().decode(item.content),
    ])).toEqual([
      ['inline.txt', 'text/plain; charset=utf-8', 'inline content'],
      ['report.csv', 'text/csv; charset=utf-8', 'a,b\n1,2\n'],
    ])
    await app.make(StorageManager).disk('local').delete('reports/2026-10.csv')
    await expect(app.make(MailManager).to('ops@example.com').send(ReportMail)).rejects.toThrow('Mail attachment not found')
  })

  it('queues mails as mail:send jobs (attachments survive serialization)', async () => {
    const app = await start({ default: 'array' })
    await app.make(StorageManager).disk('local').put('reports/2026-10.csv', 'from disk')
    const queue = app.make(QueueManager).fake()
    await app.make(MailManager).to('ops@example.com').queue(ReportMail)
    queue.assertDispatched('mail:send')
    expect(messages(app)).toHaveLength(0)
    // JSON 往返后由任务发送
    queue.dispatched[0].payload = JSON.parse(JSON.stringify(queue.dispatched[0].payload))
    await queue.drain()
    const [message] = messages(app)
    expect(message.attachments.map(item => new TextDecoder().decode(item.content))).toEqual(['inline content', 'from disk'])

    // sync 队列：排队即发送；later 带延迟
    app.make(QueueManager).restore()
    const res = await app.request('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'bob@example.com', name: 'Bob' }),
    })
    expect(res.status).toBe(200)
    expect(messages(app).at(-1)!.to).toEqual([
      { address: 'bob@example.com', name: 'Bob' },
    ])
    const later = app.make(QueueManager).fake()
    await app.make(MailManager).to('x@example.com').later('10m', WelcomeMail, { name: 'X', url: '/' })
    expect(later.dispatched[0]).toMatchObject({ job: 'mail:send', delay: 600 })
  })

  it('fakes mail in tests', async () => {
    const app = await start()
    const fake = app.make(MailManager).fake()
    fake.assertNothingSent()
    await app.request('/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'ada@example.com', name: 'Ada' }),
    })
    fake.assertQueued(WelcomeMail, mail => MailFake.hasRecipient(mail, 'ADA@example.com') && (mail.payload as { name: string }).name === 'Ada')
    fake.assertNotQueued(ReportMail)
    fake.assertNothingSent()
    expect(() => fake.assertSent(WelcomeMail)).toThrow('Expected mail "WelcomeMail" to be sent')
    await app.make(MailManager).send({ to: 'raw@example.com', subject: 'Raw', text: 'hi' })
    fake.assertSent(mail => mail.message.subject === 'Raw')
    expect(messages(app)).toHaveLength(0)
  })

  it('redirects every mail with alwaysTo and requires recipients', async () => {
    const app = await start({ alwaysTo: 'dev@demo.test' })
    await app.make(MailManager).to('real@example.com').bcc('boss@example.com').send(WelcomeMail, { name: 'A', url: '/' })
    const [message] = messages(app)
    expect(message.to).toEqual([
      { address: 'dev@demo.test' },
    ])
    expect(message.bcc).toEqual([])
    expect(message.headers['X-Original-To']).toBe('real@example.com, boss@example.com')
    await expect(app.make(MailManager).send({ to: [], subject: 'Nobody' })).rejects.toThrow('has no recipients')
  })

  it('escapes html`` interpolations unless rawHtml()', () => {
    const items = ['<a>', 'b']
    expect(html`<ul>${items.map(item => html`<li>${item}</li>`)}</ul>${rawHtml('<hr>')}${false}`.toString()).toBe('<ul><li>&lt;a&gt;</li><li>b</li></ul><hr>')
    expect(htmlToText('<p>a&nbsp;&amp;&#20320;</p><ul><li>x</li><li>y</li></ul>')).toBe('a &你\n- x\n- y')
  })
})

/** 本地捕获服务器：模拟 Resend / Postmark / Mailgun / SES 接口 */
describe('mail: HTTP API drivers', () => {
  const requests: Array<{ method: string, url: string, headers: IncomingMessage['headers'], body: Buffer }> = []
  let endpoint = ''
  let fail = false
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      requests.push({
        method: req.method!,
        url: req.url!,
        headers: req.headers,
        body: Buffer.concat(chunks),
      })
      res.setHeader('content-type', 'application/json')
      if (fail) {
        res.statusCode = 422
        return res.end(JSON.stringify({ message: 'invalid from' }))
      }
      const body = req.url === '/emails'
        ? { id: 'resend-1' }
        : req.url === '/email'
          ? { ErrorCode: 0, MessageID: 'postmark-1' }
          : req.url!.startsWith('/v3/')
            ? { id: '<mailgun-1>', message: 'Queued' }
            : { MessageId: 'ses-1' }
      res.end(JSON.stringify(body))
    })
  })
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  })
  afterEach(() => {
    requests.splice(0)
    fail = false
  })
  afterAll(() => new Promise(resolve => server.close(resolve)))

  async function sendWith(mailer: Record<string, unknown>) {
    const app = await start({
      default: 'api',
      mailers: {
        api: { ...mailer, endpoint },
      },
    })
    return app.make(MailManager)
      .to(['Ada <ada@example.com>', 'bob@example.com'])
      .cc('cc@example.com')
      .replyTo('support@demo.test')
      .send({
        subject: 'Hello',
        html: '<p>Hi</p>',
        attachments: [
          { filename: 'a.txt', content: 'attached' },
        ],
        tags: { category: 'welcome' },
      })
  }

  it('resend', async () => {
    expect((await sendWith({ driver: 'resend', key: 're_test' })).messageId).toBe('resend-1')
    const [request] = requests
    expect(request.headers.authorization).toBe('Bearer re_test')
    expect(JSON.parse(request.body.toString())).toEqual({
      from: 'Demo <noreply@demo.test>',
      to: ['Ada <ada@example.com>', 'bob@example.com'],
      cc: ['cc@example.com'],
      reply_to: ['support@demo.test'],
      subject: 'Hello',
      html: '<p>Hi</p>',
      text: 'Hi',
      attachments: [
        {
          filename: 'a.txt',
          content: Buffer.from('attached').toString('base64'),
          content_type: 'text/plain; charset=utf-8',
        },
      ],
      tags: [
        { name: 'category', value: 'welcome' },
      ],
    })
  })

  it('postmark', async () => {
    expect((await sendWith({ driver: 'postmark', token: 'pm-token' })).messageId).toBe('postmark-1')
    const [request] = requests
    expect(request.headers['x-postmark-server-token']).toBe('pm-token')
    expect(JSON.parse(request.body.toString())).toMatchObject({
      From: 'Demo <noreply@demo.test>',
      To: 'Ada <ada@example.com>, bob@example.com',
      Cc: 'cc@example.com',
      ReplyTo: 'support@demo.test',
      HtmlBody: '<p>Hi</p>',
      MessageStream: 'outbound',
      Tag: 'welcome',
      Attachments: [
        {
          Name: 'a.txt',
          Content: Buffer.from('attached').toString('base64'),
        },
      ],
    })
  })

  it('mailgun', async () => {
    expect((await sendWith({ driver: 'mailgun', key: 'key-1', domain: 'mg.demo.test' })).messageId).toBe('<mailgun-1>')
    const [request] = requests
    expect(request.url).toBe('/v3/mg.demo.test/messages')
    expect(request.headers.authorization).toBe(`Basic ${Buffer.from('api:key-1').toString('base64')}`)
    const form = await new Response(request.body, {
      headers: { 'content-type': request.headers['content-type']! },
    }).formData()
    expect(form.getAll('to')).toEqual(['Ada <ada@example.com>', 'bob@example.com'])
    expect(form.get('h:Reply-To')).toBe('support@demo.test')
    expect(form.get('o:tag')).toBe('welcome')
    expect(await (form.get('attachment') as File).text()).toBe('attached')
  })

  it('ses (AWS SDK v3, signed request)', async () => {
    expect((await sendWith({
      driver: 'ses',
      region: 'eu-west-1',
      accessKeyId: 'AKIDTEST',
      secretAccessKey: 'secret',
    })).messageId).toBe('ses-1')
    const [request] = requests
    expect(request.url).toBe('/v2/email/outbound-emails')
    expect(request.headers.authorization).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDTEST\/\d+\/eu-west-1\/ses\/aws4_request/)
    const body = JSON.parse(request.body.toString())
    expect(body).toMatchObject({
      FromEmailAddress: 'Demo <noreply@demo.test>',
      Destination: {
        ToAddresses: ['Ada <ada@example.com>', 'bob@example.com'],
        CcAddresses: ['cc@example.com'],
      },
      ReplyToAddresses: ['support@demo.test'],
      EmailTags: [
        { Name: 'category', Value: 'welcome' },
      ],
      Content: {
        Simple: {
          Subject: { Data: 'Hello' },
          Body: {
            Html: { Data: '<p>Hi</p>' },
            Text: { Data: 'Hi' },
          },
        },
      },
    })
    expect(body.Content.Simple.Attachments[0]).toMatchObject({
      FileName: 'a.txt',
      RawContent: Buffer.from('attached').toString('base64'),
    })
  })

  it('surfaces API errors', async () => {
    fail = true
    await expect(sendWith({ driver: 'resend', key: 're_test' })).rejects.toThrow('Resend rejected the message (422): invalid from')
  })
})

// 真实 SMTP：本地 Mailpit（THINK_TEST_SMTP_URL=smtp://127.0.0.1:11025 THINK_TEST_MAILPIT_API=http://127.0.0.1:18025）
describe.runIf(process.env.THINK_TEST_SMTP_URL && process.env.THINK_TEST_MAILPIT_API)('mail: SMTP (Mailpit)', () => {
  const api = process.env.THINK_TEST_MAILPIT_API!

  it('delivers html, text, cc and attachments over SMTP', async () => {
    const app = await start({
      default: 'smtp',
      mailers: {
        smtp: { driver: 'smtp', url: process.env.THINK_TEST_SMTP_URL },
      },
    })
    const subject = `欢迎 ${crypto.randomUUID()}`
    const sent = await app.make(MailManager)
      .to('Ada <ada@example.com>')
      .cc('cc@example.com')
      .send({
        subject,
        html: mailLayout({ body: html`<p>你好 Ada</p>` }),
        attachments: [
          { filename: '报告.txt', content: 'attached' },
        ],
      })
    expect(sent.messageId).toMatch(/^<.+>$/)

    const search = await (await fetch(`${api}/api/v1/search?query=${encodeURIComponent(`subject:"${subject}"`)}`)).json() as any
    expect(search.messages).toHaveLength(1)
    const message = await (await fetch(`${api}/api/v1/message/${search.messages[0].ID}`)).json() as any
    expect(message.Subject).toBe(subject)
    expect(message.From).toEqual({ Name: 'Demo', Address: 'noreply@demo.test' })
    expect(message.To).toEqual([
      { Name: 'Ada', Address: 'ada@example.com' },
    ])
    expect(message.Cc).toEqual([
      { Name: '', Address: 'cc@example.com' },
    ])
    expect(message.HTML).toContain('<p>你好 Ada</p>')
    expect(message.Text).toBe('你好 Ada')
    expect(message.Attachments.map((item: any) => [item.FileName, item.Size])).toEqual([
      ['报告.txt', 8],
    ])
  })
})
