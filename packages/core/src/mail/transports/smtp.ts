import type { MailTransport } from '../types'
import { Buffer } from 'node:buffer'
import { formatAddress } from '../address'

export interface SmtpMailerConfig {
  driver: 'smtp'
  /** 连接串，如 `smtps://user:pass@smtp.example.com:465`（优先于 host / port） */
  url?: string
  host?: string
  /** 默认 587（secure 时 465） */
  port?: number
  /** 直接 TLS（465），默认 port 为 465 时开启；587 使用 STARTTLS */
  secure?: boolean
  username?: string
  password?: string
  /** 复用连接，默认 true */
  pool?: boolean
  /** 透传给 nodemailer 的其它选项 */
  options?: Record<string, unknown>
}

/** SMTP（nodemailer）：Node / Bun / Deno；Cloudflare Workers 请使用 HTTP 接口的驱动 */
export function smtpTransport(config: SmtpMailerConfig): MailTransport {
  let transporter: Promise<import('nodemailer').Transporter> | undefined
  const connect = (): NonNullable<typeof transporter> => {
    transporter ??= import('nodemailer').then((module) => {
      const nodemailer = (module as unknown as { default?: typeof module }).default ?? module
      const port = config.port ?? (config.secure ? 465 : 587)
      return nodemailer.createTransport(config.url ?? {
        host: config.host ?? '127.0.0.1',
        port,
        secure: config.secure ?? port === 465,
        pool: config.pool ?? true,
        ...(config.username && {
          auth: { user: config.username, pass: config.password ?? '' },
        }),
        ...config.options,
      } as never)
    }, (error) => {
      transporter = undefined
      throw new Error('Mail driver "smtp" requires nodemailer (pnpm add nodemailer). SMTP is not available on Cloudflare Workers: use resend / postmark / mailgun / ses', { cause: error })
    })
    return transporter
  }
  return {
    driver: 'smtp',
    async send(message) {
      const info = await (await connect()).sendMail({
        from: formatAddress(message.from),
        to: message.to.map(formatAddress),
        cc: message.cc.map(formatAddress),
        bcc: message.bcc.map(formatAddress),
        replyTo: message.replyTo.map(formatAddress),
        subject: message.subject,
        html: message.html,
        text: message.text,
        headers: message.headers,
        attachments: message.attachments.map(item => ({
          filename: item.filename,
          content: Buffer.from(item.content.buffer, item.content.byteOffset, item.content.byteLength),
          contentType: item.contentType,
          ...(item.cid && { cid: item.cid }),
        })),
      })
      return { messageId: info.messageId }
    },
    async close() {
      if (transporter)
        (await transporter.catch(() => undefined))?.close()
      transporter = undefined
    },
  }
}
