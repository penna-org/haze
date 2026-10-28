import type { MailTransport, ResolvedAttachment, ResolvedMessage } from '../types'
import { toBase64 } from '../../storage/content'
import { formatAddress } from '../address'

export interface ResendMailerConfig {
  driver: 'resend'
  /** API Key（RESEND_API_KEY） */
  key: string
  /** 默认 https://api.resend.com */
  endpoint?: string
}

export interface PostmarkMailerConfig {
  driver: 'postmark'
  /** Server Token（POSTMARK_TOKEN） */
  token: string
  /** 消息流，默认 outbound */
  messageStream?: string
  /** 默认 https://api.postmarkapp.com */
  endpoint?: string
}

export interface MailgunMailerConfig {
  driver: 'mailgun'
  /** API Key（MAILGUN_SECRET） */
  key: string
  domain: string
  /** 欧盟区域使用 api.eu.mailgun.net，默认 us */
  region?: 'us' | 'eu'
  /** 覆盖接口地址（优先于 region） */
  endpoint?: string
}

async function request(service: string, url: string, init: RequestInit): Promise<any> {
  const response = await fetch(url, init)
  const text = await response.text()
  let body: any
  try {
    body = text
      ? JSON.parse(text)
      : {}
  }
  catch {
    body = { message: text }
  }
  if (!response.ok)
    throw new Error(`${service} rejected the message (${response.status}): ${body?.message ?? body?.Message ?? text}`)
  return body
}

const list = (addresses: ResolvedMessage['to']): string[] => addresses.map(formatAddress)

export function resendTransport(config: ResendMailerConfig): MailTransport {
  return {
    driver: 'resend',
    async send(message) {
      const body = await request('Resend', `${(config.endpoint ?? 'https://api.resend.com').replace(/\/$/, '')}/emails`, {
        method: 'POST',
        headers: { 'authorization': `Bearer ${config.key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          from: formatAddress(message.from),
          to: list(message.to),
          ...(message.cc.length && {
            cc: list(message.cc),
          }),
          ...(message.bcc.length && {
            bcc: list(message.bcc),
          }),
          ...(message.replyTo.length && {
            reply_to: list(message.replyTo),
          }),
          subject: message.subject,
          html: message.html,
          text: message.text,
          ...(Object.keys(message.headers).length && { headers: message.headers }),
          ...(message.attachments.length && {
            attachments: message.attachments.map(item => ({
              filename: item.filename,
              content: toBase64(item.content),
              content_type: item.contentType,
              ...(item.cid && { content_id: item.cid }),
            })),
          }),
          ...(Object.keys(message.tags).length && {
            tags: Object.entries(message.tags).map(([name, value]) => ({ name, value })),
          }),
        }),
      })
      return { messageId: body.id }
    },
  }
}

export function postmarkTransport(config: PostmarkMailerConfig): MailTransport {
  return {
    driver: 'postmark',
    async send(message) {
      const tag = Object.values(message.tags)[0]
      const body = await request('Postmark', `${(config.endpoint ?? 'https://api.postmarkapp.com').replace(/\/$/, '')}/email`, {
        method: 'POST',
        headers: { 'accept': 'application/json', 'content-type': 'application/json', 'x-postmark-server-token': config.token },
        body: JSON.stringify({
          From: formatAddress(message.from),
          To: list(message.to).join(', '),
          ...(message.cc.length && {
            Cc: list(message.cc).join(', '),
          }),
          ...(message.bcc.length && {
            Bcc: list(message.bcc).join(', '),
          }),
          ...(message.replyTo.length && {
            ReplyTo: list(message.replyTo).join(', '),
          }),
          Subject: message.subject,
          HtmlBody: message.html,
          TextBody: message.text,
          MessageStream: config.messageStream ?? 'outbound',
          ...(tag && { Tag: tag }),
          ...(Object.keys(message.tags).length && { Metadata: message.tags }),
          ...(Object.keys(message.headers).length && {
            Headers: Object.entries(message.headers).map(([Name, Value]) => ({ Name, Value })),
          }),
          ...(message.attachments.length && {
            Attachments: message.attachments.map(item => ({
              Name: item.filename,
              Content: toBase64(item.content),
              ContentType: item.contentType,
              ...(item.cid && { ContentID: `cid:${item.cid}` }),
            })),
          }),
        }),
      })
      if (body.ErrorCode)
        throw new Error(`Postmark rejected the message: ${body.Message}`)
      return { messageId: body.MessageID }
    },
  }
}

function blob(item: ResolvedAttachment): Blob {
  return new Blob([item.content as Uint8Array<ArrayBuffer>], { type: item.contentType })
}

export function mailgunTransport(config: MailgunMailerConfig): MailTransport {
  const endpoint = (config.endpoint ?? (config.region === 'eu'
    ? 'https://api.eu.mailgun.net'
    : 'https://api.mailgun.net')).replace(/\/$/, '')
  return {
    driver: 'mailgun',
    async send(message) {
      const form = new FormData()
      form.set('from', formatAddress(message.from))
      for (const to of list(message.to))
        form.append('to', to)
      for (const cc of list(message.cc))
        form.append('cc', cc)
      for (const bcc of list(message.bcc))
        form.append('bcc', bcc)
      form.set('subject', message.subject)
      if (message.html)
        form.set('html', message.html)
      if (message.text)
        form.set('text', message.text)
      if (message.replyTo.length)
        form.set('h:Reply-To', list(message.replyTo).join(', '))
      for (const [name, value] of Object.entries(message.headers))
        form.set(`h:${name}`, value)
      for (const [name, value] of Object.entries(message.tags)) {
        form.append('o:tag', value)
        form.set(`v:${name}`, value)
      }
      for (const item of message.attachments)
        form.append(item.cid ? 'inline' : 'attachment', blob(item), item.cid ?? item.filename)
      const body = await request('Mailgun', `${endpoint}/v3/${config.domain}/messages`, {
        method: 'POST',
        headers: { authorization: `Basic ${btoa(`api:${config.key}`)}` },
        body: form,
      })
      return { messageId: body.id }
    },
  }
}
