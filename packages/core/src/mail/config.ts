import type { MailgunMailerConfig, PostmarkMailerConfig, ResendMailerConfig } from './transports/http'
import type { SesMailerConfig } from './transports/ses'
import type { SmtpMailerConfig } from './transports/smtp'
import type { AddressInput, MailTransport } from './types'

export interface LogMailerConfig {
  driver: 'log'
}

export interface ArrayMailerConfig {
  driver: 'array'
}

export interface CustomMailerConfig {
  driver: 'custom'
  transport: MailTransport
}

export type MailerConfig = SmtpMailerConfig | ResendMailerConfig | PostmarkMailerConfig | MailgunMailerConfig | SesMailerConfig | LogMailerConfig | ArrayMailerConfig | CustomMailerConfig

export interface MailConfig {
  /** 默认驱动，默认 log */
  default: string
  /** 默认发件人 */
  from?: AddressInput
  /** 默认回复地址 */
  replyTo?: AddressInput
  mailers: Record<string, MailerConfig>
  /** 排队发送（Mail.queue / later）使用的队列 */
  queue?: {
    connection?: string
    queue?: string
    /** 最多尝试次数，默认 3 */
    tries?: number
    /** 重试等待，默认 [10, 60] 秒 */
    backoff?: number | string | Array<number | string> | 'exponential'
  }
  /** 开发 / 预发环境：所有邮件改投到这些地址（原收件人写入 X-Original-To） */
  alwaysTo?: AddressInput
}

export const defaultMailConfig: MailConfig = {
  default: 'log',
  from: 'haze <noreply@example.com>',
  mailers: {
    log: { driver: 'log' },
    array: { driver: 'array' },
  },
}

/** `config/mail.ts` 的默认导出 */
export function defineMailConfig(config: MailConfig | (() => MailConfig)): MailConfig | (() => MailConfig) {
  return config
}
