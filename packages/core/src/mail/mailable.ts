import type { MaybePromise } from '../utils'
import type { MailContent } from './types'

const kMail = Symbol.for('think-h3.mail')

export interface MailOptions {
  /** 名称（日志与 Mail.fake() 断言信息），默认 anonymous */
  name?: string
  /** 使用的邮件驱动（config/mail.ts 的 mailers），默认 default */
  mailer?: string
}

export interface MailDefinition<P = void> extends MailOptions {
  readonly [kMail]: true
  render: (payload: P) => MaybePromise<MailContent>
}

/**
 * 定义邮件（app/mail/*.ts）：函数接收数据，返回主题与 html / text。
 *
 * ```ts
 * export default defineMail((payload: { name: string }) => ({
 *   subject: `欢迎，${payload.name}`,
 *   html: mailLayout({ body: html`<p>你好，${payload.name}</p>` }),
 * }))
 * await Mail.to(user.email).send(WelcomeMail, { name: user.name })
 * ```
 */
export function defineMail<P = void>(render: (payload: P) => MaybePromise<MailContent>, options: MailOptions = {}): MailDefinition<P> {
  return {
    [kMail]: true,
    ...options,
    name: options.name || render.name || undefined,
    render,
  }
}

export function isMail(value: unknown): value is MailDefinition<any> {
  return typeof value === 'object' && value !== null && kMail in value
}
