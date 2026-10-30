# 邮件

hazejs 用同一套 API 通过 SMTP 或 HTTP 服务商（Resend、Postmark、Mailgun、Amazon SES）发送邮件。邮件就是一个返回主题与 HTML 的函数，可以立即发送，也可以排队发送；测试时用 `Mail.fake()` 断言即可。

```ts
await Mail.to(user.email).send(WelcomeMail, { name: user.name, url })
```

## 配置

邮件配置在 `config/mail.ts`（全栈项目为 `server/config/mail.ts`）：

```ts
// config/mail.ts
import { defineMailConfig, env } from '@hazejs/core'

export default defineMailConfig(() => ({
  default: env('MAIL_MAILER', 'log'),
  from: {
    address: env('MAIL_FROM_ADDRESS', 'hello@example.com'),
    name: env('MAIL_FROM_NAME', 'My App'),
  },
  mailers: {
    smtp: {
      driver: 'smtp',
      host: env('MAIL_HOST', '127.0.0.1'),
      port: env('MAIL_PORT', 1025),
      username: env('MAIL_USERNAME', ''),
      password: env('MAIL_PASSWORD', ''),
    },
    resend: {
      driver: 'resend',
      key: env('RESEND_API_KEY', ''),
    },
  },
}))
```

| 选项 | 说明 |
|------|------|
| `default` | 未指定时使用的邮件驱动，默认 `log` |
| `from` | 默认发件人 |
| `replyTo` | 默认回复地址 |
| `mailers` | 具名的邮件驱动；内置的 `log` 与 `array` 始终可用 |
| `queue` | `queue()` / `later()` 使用的队列：`{ connection?, queue?, tries?, backoff? }`，`tries` 默认 3，`backoff` 默认 `[10, 60]` 秒 |
| `alwaysTo` | 所有邮件改投到这些地址（适合开发与预发环境），原收件人写入 `X-Original-To` 头 |

没有 `config/mail.ts` 时使用 `log` 驱动，只写日志、不真正发送。

## 驱动

| 驱动 | 需要安装 | 可在 Workers 运行 | 选项 |
|------|----------|-------------------|------|
| `smtp` | `pnpm add nodemailer` | 否 | `url`、`host`、`port`、`secure`、`username`、`password`、`pool`、`options` |
| `resend` | — | 是 | `key`、`endpoint` |
| `postmark` | — | 是 | `token`、`messageStream`、`endpoint` |
| `mailgun` | — | 是 | `key`、`domain`、`region`（`'us'` \| `'eu'`）、`endpoint` |
| `ses` | `pnpm add @aws-sdk/client-sesv2` | 是（尚未测试） | `region`、`accessKeyId`、`secretAccessKey`、`endpoint`、`configurationSet` |
| `log` | — | 是 | 把邮件摘要写入日志 |
| `array` | — | 是 | 保存在内存中：`Mail.transport('array').messages` |
| `custom` | — | — | `transport`：自己实现的 `MailTransport`（`send(message)`，可选 `close()`） |

补充说明：

- **smtp**：`url`（如 `smtps://user:pass@smtp.example.com:465`）优先于 `host` / `port`。`port` 默认 587，`secure` 时为 465；端口为 465 时 `secure` 默认开启（587 使用 STARTTLS）。默认复用连接池，`options` 原样透传给 nodemailer。
- **resend / postmark / mailgun**：直接用 `fetch` 调用服务商的 HTTP 接口，`endpoint` 可覆盖接口地址。
- **ses**：不提供密钥时使用 AWS SDK 的默认凭证链（环境变量、IAM 角色等）。
- Cloudflare Workers 不支持 SMTP：构建时 `nodemailer` 会被替换为调用即报错的空模块，请使用 HTTP 接口的驱动。

## 定义邮件

邮件放在 `app/mail/*.ts`，`defineMail()` 接收一个函数，把数据转换为邮件内容：

```ts
// app/mail/WelcomeMail.ts
import { button, defineMail, html, mailLayout } from '@hazejs/core'

export default defineMail((payload: { name: string, url: string }) => ({
  subject: `欢迎加入，${payload.name}`,
  html: mailLayout({
    brand: 'My App',
    preheader: '感谢注册，开始使用吧',
    body: html`
      <h1 style="margin:0 0 16px;font-size:22px">你好，${payload.name}</h1>
      <p>感谢注册！点击下方按钮开始使用。</p>
      ${button('开始使用', payload.url)}
    `,
    footer: '此邮件由系统自动发送，请勿直接回复',
  }),
}), { name: 'WelcomeMail' })
```

函数可以是异步的，返回值包括：

| 字段 | 说明 |
|------|------|
| `subject` | 主题（必填） |
| `html` | HTML 正文 |
| `text` | 纯文本正文；省略时由 `html` 自动生成 |
| `from`、`replyTo`、`cc`、`bcc` | 覆盖这封邮件的默认值 |
| `attachments` | 见[附件](#附件) |
| `headers` | 额外的邮件头 |
| `tags` | 服务商标签（Resend、Postmark、Mailgun、SES） |

`defineMail()` 的第二个参数为 `{ name?, mailer?, locale? }`：`name` 用于日志与 fake 断言的提示信息，`mailer` 让这封邮件固定使用某个驱动，`locale` 指定渲染邮件时使用的语言（见[多语言](./localization#邮件)）。

## 发送

```ts
import { Mail } from '@hazejs/core'
import WelcomeMail from '~/app/mail/WelcomeMail'

await Mail.to(user.email).send(WelcomeMail, { name: user.name, url })

await Mail.to({ address: user.email, name: user.name })
  .cc('team@example.com')
  .bcc(['audit@example.com'])
  .replyTo('support@example.com')
  .from('账单 <billing@example.com>')
  .mailer('resend')
  .send(WelcomeMail, { name: user.name, url })
```

`send()` 返回 `{ mailer, messageId? }`。优先级为：链式调用设置的值 > 邮件定义返回的值 > `config/mail.ts` 中的默认值。没有任何收件人时会抛出异常。

`.locale('zh-CN')` 让邮件按指定语言渲染，渲染函数中的 `t()` 会翻译成该语言。它优先于 `defineMail()` 的 `locale` 选项，后者又优先于当前（请求的）语言；排队发送的邮件同样保留该语言。见[多语言](./localization#邮件)。

不想单独定义邮件时，也可以直接发送原始消息：

```ts
await Mail.send({ to: 'ops@example.com', subject: '每日报表', text: '一切正常。' })
await Mail.to('ops@example.com').send({ subject: '每日报表', html: '<p>一切正常。</p>' })
```

### 地址格式

所有接收地址的地方都可以传入：

- 字符串：`'ada@example.com'` 或 `'Ada Lovelace <ada@example.com>'`；
- 对象：`{ address: 'ada@example.com', name: 'Ada Lovelace' }`；
- 以上两种组成的数组。

## 附件

附件可以直接给出内容，也可以指向[存储磁盘](./storage)上的文件（发送时才读取）：

```ts
// app/mail/InvoiceMail.ts
import { defineMail } from '@hazejs/core'

export default defineMail((payload: { id: number, pdf: Uint8Array }) => ({
  subject: `账单 #${payload.id}`,
  html: '<p>账单见附件。</p><img src="cid:logo">',
  attachments: [
    { filename: `invoice-${payload.id}.pdf`, content: payload.pdf },
    { filename: '服务条款.pdf', disk: 's3', path: 'legal/terms.pdf' },
    { filename: 'logo.png', disk: 'public', path: 'brand/logo.png', cid: 'logo' },
  ],
}), { name: 'InvoiceMail' })
```

未设置 `contentType` 时按文件名推断。`cid` 用于内嵌图片，在 HTML 中以 `<img src="cid:…">` 引用。

## 布局辅助

| 函数 | 说明 |
|------|------|
| `` html`...` `` | 模板标签：插值自动做 HTML 转义，数组自动拼接，嵌套的 `` html`` `` 与 `rawHtml()` 原样插入 |
| `rawHtml(value)` | 标记为可信的 HTML，不再转义 |
| `escapeHtml(value)` | 手动转义 |
| `button(text, url, { color? })` | 表格布局的按钮，兼容主流邮件客户端 |
| `mailLayout({ body, brand?, preheader?, footer?, color? })` | 简单的响应式布局（内联样式），返回完整的 HTML 文档 |
| `htmlToText(html)` | 生成纯文本版本所用的函数，链接转为 `文字 (地址)` |

```ts
html`<ul>${items.map(item => html`<li>${item.name}</li>`)}</ul>`
html`<p>${user.bio}</p>` // "<script>" 会变成 "&lt;script&gt;"
html`<div>${rawHtml(trustedMarkdownHtml)}</div>`
```

::: tip 用 TSX 编写邮件正文
邮件正文也可以使用 [TSX 视图](./views)：把邮件文件命名为 `.tsx`，在 `async` 渲染函数中返回 `html: await renderToString(<Welcome name={payload.name} />)`。转义规则相同，也可以组合使用：`mailLayout({ body: rawHtml(await renderToString(...)) })`。
:::

## 排队发送

`queue()` 与 `later()` 不会立即发送，而是投递内置任务 `mail:send`，失败时按 `mail.queue.tries` 与 `backoff` 重试：

```ts
await Mail.to(user.email).queue(WelcomeMail, { name: user.name, url })
await Mail.to(user.email).later('10m', WelcomeMail, { name: user.name, url })
await Mail.queue({ to: 'ops@example.com', subject: '报表', text: '...' })
```

邮件在投递时就已渲染，worker 端无需加载邮件定义。直接给出内容的附件以 base64 写入任务载荷，磁盘附件只记录路径，因此大文件请使用磁盘附件。任务进入哪个队列、如何运行 worker，见[队列](./queues)。

## 本地查看邮件

默认的 `log` 驱动只记录摘要。想看到真实的邮件，可以运行 [Mailpit](https://mailpit.axllent.org)，并让 `smtp` 驱动连接它：

```bash
docker run -p 1025:1025 -p 8025:8025 axllent/mailpit
pnpm add nodemailer
```

```ini
# .env
MAIL_MAILER=smtp
MAIL_PORT=1025
```

然后打开 http://localhost:8025。预发环境建议配置 `alwaysTo`，避免测试邮件发到真实用户。

## 测试

`Mail.fake()` 只记录邮件而不投递：

```ts
// tests/welcome.test.ts
import { Mail, MailFake, Queue } from '@hazejs/core'
import { useTestApp } from '@hazejs/testing'
import { it } from 'vitest'
import WelcomeMail from '~/app/mail/WelcomeMail'

const t = useTestApp()

it('sends a welcome mail after registration', async () => {
  const queue = Queue.fake()
  const mail = Mail.fake()
  await t.post('/api/auth/register', { name: 'Ada', email: 'ada@example.com', password: 'correct horse' })

  // 执行已投递的 SendWelcomeEmail 任务，由它发送邮件
  await queue.drain()
  mail.assertSent(WelcomeMail, sent => MailFake.hasRecipient(sent, 'ada@example.com') && sent.message.subject === '欢迎加入，Ada')
})
```

| 断言 | 说明 |
|------|------|
| `assertSent(matcher, predicate?)` | 发送过匹配的邮件 |
| `assertNotSent(matcher, predicate?)` | 没有发送匹配的邮件 |
| `assertSentTimes(matcher, n)` | 匹配的邮件恰好发送了 `n` 次 |
| `assertQueued(matcher, predicate?)` | 排队了匹配的邮件 |
| `assertNotQueued(matcher, predicate?)` | 没有排队匹配的邮件 |
| `assertNothingSent()` / `assertNothingQueued()` | 没有发送 / 没有排队任何邮件 |

`matcher` 可以是邮件定义，也可以是接收记录（`{ mail?, payload, mailer, message, delay? }`）的函数。`MailFake.hasRecipient(mail, address)` 检查 `to`、`cc` 与 `bcc`，不区分大小写。需要自定义检查时可以直接读取 `sent` 与 `queued` 数组；`Mail.restore()` 撤销 fake。与 `Queue.fake()` 配合使用的方式见[测试](./testing)。
