# Mail

hazejs sends email through SMTP or HTTP providers (Resend, Postmark, Mailgun, Amazon SES) behind a single API. Mails are plain functions that return a subject and HTML, sending can be immediate or queued, and `Mail.fake()` makes them easy to test.

```ts
await Mail.to(user.email).send(WelcomeMail, { name: user.name, url })
```

## Configuration

Mail is configured in `config/mail.ts` (in full-stack projects, `server/config/mail.ts`):

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

| Option | Description |
|--------|-------------|
| `default` | Mailer used when none is specified. Defaults to `log`. |
| `from` | Default sender. |
| `replyTo` | Default reply-to address. |
| `mailers` | Named mailers. The built-in `log` and `array` mailers are always available. |
| `queue` | Queue used by `queue()` / `later()`: `{ connection?, queue?, tries?, backoff? }`. `tries` defaults to 3, `backoff` to `[10, 60]` seconds. |
| `alwaysTo` | Redirect every mail to these addresses (useful for development and staging). Original recipients are written to the `X-Original-To` header. |

Without a `config/mail.ts`, mail uses the `log` driver, which only writes to the log.

## Drivers

| Driver | Install | Runs on Workers | Options |
|--------|---------|-----------------|---------|
| `smtp` | `pnpm add nodemailer` | No | `url`, `host`, `port`, `secure`, `username`, `password`, `pool`, `options` |
| `resend` | — | Yes | `key`, `endpoint` |
| `postmark` | — | Yes | `token`, `messageStream`, `endpoint` |
| `mailgun` | — | Yes | `key`, `domain`, `region` (`'us'` \| `'eu'`), `endpoint` |
| `ses` | `pnpm add @aws-sdk/client-sesv2` | Yes (untested) | `region`, `accessKeyId`, `secretAccessKey`, `endpoint`, `configurationSet` |
| `log` | — | Yes | Writes a summary to the log. |
| `array` | — | Yes | Keeps messages in memory: `Mail.transport('array').messages`. |
| `custom` | — | — | `transport`: your own `MailTransport` (`send(message)`, optional `close()`). |

Notes:

- **smtp** — `url` (e.g. `smtps://user:pass@smtp.example.com:465`) takes precedence over `host` / `port`. `port` defaults to 587, or 465 when `secure`; `secure` defaults to `true` on port 465 (587 uses STARTTLS). Connections are pooled by default. `options` is passed through to nodemailer.
- **resend / postmark / mailgun** call the provider's HTTP API with `fetch`; `endpoint` overrides the API base URL.
- **ses** uses the AWS SDK's default credential chain when no keys are given.
- On Cloudflare Workers, `nodemailer` is replaced at build time by a module that throws when used — pick an HTTP driver there.

## Defining mails

Mails live in `app/mail/*.ts`. `defineMail()` takes a function from your payload to the mail content:

```ts
// app/mail/WelcomeMail.ts
import { button, defineMail, html, mailLayout } from '@hazejs/core'

export default defineMail((payload: { name: string, url: string }) => ({
  subject: `Welcome, ${payload.name}`,
  html: mailLayout({
    brand: 'My App',
    preheader: 'Thanks for signing up',
    body: html`
      <h1 style="margin:0 0 16px;font-size:22px">Hi ${payload.name}</h1>
      <p>Thanks for signing up! Click the button below to get started.</p>
      ${button('Get started', payload.url)}
    `,
    footer: 'This is an automated message, please do not reply.',
  }),
}), { name: 'WelcomeMail' })
```

The function may be async and returns:

| Field | Description |
|-------|-------------|
| `subject` | Required. |
| `html` | HTML body. |
| `text` | Plain-text body. Generated from `html` when omitted. |
| `from`, `replyTo`, `cc`, `bcc` | Override the defaults for this mail. |
| `attachments` | See [Attachments](#attachments). |
| `headers` | Extra headers. |
| `tags` | Provider tags (Resend, Postmark, Mailgun, SES). |

The second argument of `defineMail()` is `{ name?, mailer?, locale? }`: `name` is used in logs and fake assertions, `mailer` pins the mail to a specific mailer, and `locale` renders the mail in that language (see [Localization](./localization#mail)).

## Sending

```ts
import { Mail } from '@hazejs/core'
import WelcomeMail from '~/app/mail/WelcomeMail'

await Mail.to(user.email).send(WelcomeMail, { name: user.name, url })

await Mail.to({ address: user.email, name: user.name })
  .cc('team@example.com')
  .bcc(['audit@example.com'])
  .replyTo('support@example.com')
  .from('Billing <billing@example.com>')
  .mailer('resend')
  .send(WelcomeMail, { name: user.name, url })
```

`send()` resolves to `{ mailer, messageId? }`. Values set on the chain win over those returned by the mail, which win over the defaults in `config/mail.ts`. A mail with no recipients throws.

`.locale('zh-CN')` renders the mail in that locale, so `t()` inside the render function translates into it. It takes precedence over the `locale` option of `defineMail()`, which takes precedence over the current (request) locale; queued mail keeps it. See [Localization](./localization#mail).

You can also send a raw message without defining a mail:

```ts
await Mail.send({ to: 'ops@example.com', subject: 'Nightly report', text: 'All good.' })
await Mail.to('ops@example.com').send({ subject: 'Nightly report', html: '<p>All good.</p>' })
```

### Addresses

Anywhere an address is accepted you can pass:

- a string: `'ada@example.com'` or `'Ada Lovelace <ada@example.com>'`
- an object: `{ address: 'ada@example.com', name: 'Ada Lovelace' }`
- an array of either

## Attachments

Attach content directly, or point at a file on a [storage disk](./storage) — disk files are read at send time:

```ts
// app/mail/InvoiceMail.ts
import { defineMail } from '@hazejs/core'

export default defineMail((payload: { id: number, pdf: Uint8Array }) => ({
  subject: `Invoice #${payload.id}`,
  html: '<p>Your invoice is attached.</p><img src="cid:logo">',
  attachments: [
    { filename: `invoice-${payload.id}.pdf`, content: payload.pdf },
    { filename: 'terms.pdf', disk: 's3', path: 'legal/terms.pdf' },
    { filename: 'logo.png', disk: 'public', path: 'brand/logo.png', cid: 'logo' },
  ],
}), { name: 'InvoiceMail' })
```

`contentType` is inferred from the file name unless you set it. `cid` embeds an inline image referenced as `<img src="cid:…">`.

## Layout helpers

| Helper | Description |
|--------|-------------|
| `` html`...` `` | Tagged template: interpolated values are HTML-escaped, arrays are joined, nested `` html`` `` and `rawHtml()` are inserted as-is. |
| `rawHtml(value)` | Marks trusted HTML so it is not escaped. |
| `escapeHtml(value)` | Escapes a value manually. |
| `button(text, url, { color? })` | A table-based button that renders in all major clients. |
| `mailLayout({ body, brand?, preheader?, footer?, color? })` | A simple responsive layout with inline styles. Returns a full HTML document. |
| `htmlToText(html)` | The function used to generate `text`; links become `label (url)`. |

```ts
html`<ul>${items.map(item => html`<li>${item.name}</li>`)}</ul>`
html`<p>${user.bio}</p>` // "<script>" becomes "&lt;script&gt;"
html`<div>${rawHtml(trustedMarkdownHtml)}</div>`
```

::: tip TSX mail bodies
Mail bodies can also be [TSX views](./views): name the mail file `.tsx` and return `html: await renderToString(<Welcome name={payload.name} />)` from an `async` render function. The same escaping rules apply, and `mailLayout({ body: rawHtml(await renderToString(...)) })` combines both.
:::

## Queued sending

`queue()` and `later()` dispatch the built-in `mail:send` job instead of sending inline. Failed sends are retried according to `mail.queue.tries` and `backoff`.

```ts
await Mail.to(user.email).queue(WelcomeMail, { name: user.name, url })
await Mail.to(user.email).later('10m', WelcomeMail, { name: user.name, url })
await Mail.queue({ to: 'ops@example.com', subject: 'Report', text: '...' })
```

The mail is rendered when it is queued, so workers don't need to load your mail definitions. Inline attachment content is stored base64-encoded in the job payload, while disk attachments only store their path — prefer disk attachments for large files. Which queue runs the job, and how to run a worker, is covered in [Queues](./queues).

## Previewing mail locally

The default `log` driver only logs a summary. To see real messages, run [Mailpit](https://mailpit.axllent.org) and point the `smtp` mailer at it:

```bash
docker run -p 1025:1025 -p 8025:8025 axllent/mailpit
pnpm add nodemailer
```

```ini
# .env
MAIL_MAILER=smtp
MAIL_PORT=1025
```

Then open http://localhost:8025. On staging, `alwaysTo` is a good safety net so real users never receive test mail.

## Testing

`Mail.fake()` records mails instead of delivering them:

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

  // Run the queued SendWelcomeEmail job, which sends the mail
  await queue.drain()
  mail.assertSent(WelcomeMail, sent => MailFake.hasRecipient(sent, 'ada@example.com') && sent.message.subject === 'Welcome, Ada')
})
```

| Assertion | Description |
|-----------|-------------|
| `assertSent(matcher, predicate?)` | A matching mail was sent. |
| `assertNotSent(matcher, predicate?)` | No matching mail was sent. |
| `assertSentTimes(matcher, n)` | A matching mail was sent exactly `n` times. |
| `assertQueued(matcher, predicate?)` | A matching mail was queued. |
| `assertNotQueued(matcher, predicate?)` | No matching mail was queued. |
| `assertNothingSent()` / `assertNothingQueued()` | Nothing was sent / queued. |

`matcher` is a mail definition or a function receiving the recorded mail (`{ mail?, payload, mailer, message, delay? }`). `MailFake.hasRecipient(mail, address)` checks `to`, `cc` and `bcc`, case-insensitively. The `sent` and `queued` arrays are available for custom checks; `Mail.restore()` removes the fake. See [Testing](./testing) for combining it with `Queue.fake()`.
