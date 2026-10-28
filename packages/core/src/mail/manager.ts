import type { Application } from '../application'
import type { DispatchOptions } from '../queue/job'
import type { MailConfig, MailerConfig } from './config'
import type { MailDefinition } from './mailable'
import type { AddressInput, Attachment, MailContent, MailMessage, MailTransport, ResolvedAttachment, ResolvedMessage, SentMessage } from './types'
import { useI18n } from '../i18n/manager'
import { recordTelemetry, telemetryActive } from '../observability/telemetry'
import { defineJob } from '../queue/job'
import { QueueManager } from '../queue/manager'
import { getRequestStore } from '../request'
import { fromBase64, toBase64 } from '../storage/content'
import { StorageManager } from '../storage/manager'
import { contentTypeOf } from '../storage/mime'
import { parseDuration } from '../utils'
import { formatAddress, normalizeAddresses } from './address'
import { defaultMailConfig } from './config'
import { htmlToText } from './layout'
import { isMail } from './mailable'
import { arrayTransport, logTransport } from './transports/basic'
import { mailgunTransport, postmarkTransport, resendTransport } from './transports/http'
import { sesTransport } from './transports/ses'
import { smtpTransport } from './transports/smtp'

const JOB = 'mail:send'

/** 信封：收件人与发送驱动（PendingMail 收集） */
export interface Envelope {
  to?: AddressInput
  cc?: AddressInput
  bcc?: AddressInput
  replyTo?: AddressInput
  from?: AddressInput
  mailer?: string
  /** 渲染邮件内容时使用的语言 */
  locale?: string
}

/** 可序列化的消息（排队时写入任务载荷） */
interface QueuedMail {
  mailer: string
  name?: string
  message: Omit<MailMessage, 'attachments'> & { attachments?: Array<Omit<Attachment, 'content'> & { base64?: string }> }
}

export interface RecordedMail {
  /** defineMail 定义；原始消息时为 undefined */
  mail?: MailDefinition<any>
  payload?: unknown
  mailer: string
  message: MailMessage
  /** 排队时的延迟（秒） */
  delay?: number
}

type Matcher = MailDefinition<any> | ((mail: RecordedMail) => boolean)

/** Mail.fake()：记录发送与排队而不投递 */
export class MailFake {
  readonly sent: RecordedMail[] = []
  readonly queued: RecordedMail[] = []

  #filter(list: RecordedMail[], matcher: Matcher, predicate?: (mail: RecordedMail) => boolean): RecordedMail[] {
    return list.filter(item => (isMail(matcher)
      ? item.mail === matcher
      : matcher(item)) && (!predicate || predicate(item)))
  }

  #describe(matcher: Matcher): string {
    return isMail(matcher)
      ? `mail "${matcher.name ?? 'anonymous'}"`
      : 'a matching mail'
  }

  assertSent(matcher: Matcher, predicate?: (mail: RecordedMail) => boolean): void {
    if (!this.#filter(this.sent, matcher, predicate).length)
      throw new Error(`Expected ${this.#describe(matcher)} to be sent${predicate ? ' with matching data' : ''}`)
  }

  assertNotSent(matcher: Matcher, predicate?: (mail: RecordedMail) => boolean): void {
    if (this.#filter(this.sent, matcher, predicate).length)
      throw new Error(`Unexpected ${this.#describe(matcher)} sent`)
  }

  assertSentTimes(matcher: Matcher, times: number): void {
    const count = this.#filter(this.sent, matcher).length
    if (count !== times)
      throw new Error(`Expected ${this.#describe(matcher)} to be sent ${times} time(s), got ${count}`)
  }

  assertQueued(matcher: Matcher, predicate?: (mail: RecordedMail) => boolean): void {
    if (!this.#filter(this.queued, matcher, predicate).length)
      throw new Error(`Expected ${this.#describe(matcher)} to be queued${predicate ? ' with matching data' : ''}`)
  }

  assertNotQueued(matcher: Matcher, predicate?: (mail: RecordedMail) => boolean): void {
    if (this.#filter(this.queued, matcher, predicate).length)
      throw new Error(`Unexpected ${this.#describe(matcher)} queued`)
  }

  assertNothingSent(): void {
    if (this.sent.length)
      throw new Error(`Expected no mail to be sent, got ${this.sent.length}`)
  }

  assertNothingQueued(): void {
    if (this.queued.length)
      throw new Error(`Expected no mail to be queued, got ${this.queued.length}`)
  }

  /** 是否发送给该地址 */
  static hasRecipient(mail: RecordedMail, address: string): boolean {
    return [
      ...normalizeAddresses(mail.message.to),
      ...normalizeAddresses(mail.message.cc),
      ...normalizeAddresses(mail.message.bcc),
    ]
      .some(item => item.address.toLowerCase() === address.toLowerCase())
  }
}

/** 邮件管理（应用单例，`inject(MailManager)`；config/mail.ts 缺省时为 log 驱动） */
export class MailManager {
  readonly #transports = new Map<string, MailTransport>()
  #fake: MailFake | undefined

  constructor(readonly app: Application) {
    // 排队发送：任务载荷为可序列化的消息
    const queue = this.config.queue ?? {}
    app.make(QueueManager).register(defineJob({
      name: JOB,
      tries: queue.tries ?? 3,
      backoff: queue.backoff ?? [10, 60],
      queue: queue.queue,
      connection: queue.connection,
      handle: async (job: QueuedMail) => {
        const message = {
          ...job.message,
          attachments: job.message.attachments?.map(({ base64, ...item }) => base64 === undefined
            ? item
            : {
                ...item,
                content: fromBase64(base64),
              }),
        }
        await this.#deliver(job.mailer, message)
      },
    }))
  }

  get config(): MailConfig {
    const config = this.app.config.get<Partial<MailConfig> | undefined>('mail', undefined)
    return {
      ...defaultMailConfig,
      ...config,
      mailers: {
        ...defaultMailConfig.mailers,
        ...config?.mailers,
      },
    }
  }

  /** 取传输驱动（array 驱动可读取 `.messages`） */
  transport(name: string = this.config.default): MailTransport {
    let transport = this.#transports.get(name)
    if (!transport) {
      const config = this.config.mailers[name]
      if (!config)
        throw new Error(`Mailer "${name}" is not defined in config/mail.ts`)
      transport = this.#create(name, config)
      this.#transports.set(name, transport)
    }
    return transport
  }

  #create(name: string, config: MailerConfig): MailTransport {
    switch (config.driver) {
      case 'log':
        return logTransport(this.app.logger.child({ mailer: name }))
      case 'array':
        return arrayTransport()
      case 'smtp':
        return smtpTransport(config)
      case 'resend':
        return resendTransport(config)
      case 'postmark':
        return postmarkTransport(config)
      case 'mailgun':
        return mailgunTransport(config)
      case 'ses':
        return sesTransport(config)
      case 'custom':
        return config.transport
      default:
        throw new Error(`Mailer "${name}": unknown driver "${(config as { driver: string }).driver}"`)
    }
  }

  /** 开始一封邮件：`mail.to(...).send(WelcomeMail, payload)` */
  to(address: AddressInput): PendingMail {
    return new PendingMail(this).to(address)
  }

  mailer(name: string): PendingMail {
    return new PendingMail(this).mailer(name)
  }

  /** 发送：defineMail 定义 + 数据，或原始消息 */
  async send<P>(mail: MailDefinition<P> | MailMessage, payload?: P, envelope: Envelope = {}): Promise<SentMessage> {
    const { message, mailer } = await this.#compose(mail, payload, envelope)
    if (this.#fake) {
      this.#fake.sent.push({
        mail: isMail(mail)
          ? mail
          : undefined,
        payload,
        mailer,
        message,
      })
      return { mailer }
    }
    return this.#deliver(mailer, message)
  }

  /** 排队发送：投递队列任务 `mail:send`，由 worker 发送（失败按 config.mail.queue 重试） */
  async queue<P>(mail: MailDefinition<P> | MailMessage, payload?: P, envelope: Envelope = {}, options: DispatchOptions = {}): Promise<string> {
    const { message, mailer } = await this.#compose(mail, payload, envelope)
    if (this.#fake) {
      const delay = options.delay === undefined
        ? undefined
        : parseDuration(options.delay)
      this.#fake.queued.push({
        mail: isMail(mail)
          ? mail
          : undefined,
        payload,
        mailer,
        message,
        delay,
      })
      return crypto.randomUUID()
    }
    const queued: QueuedMail = {
      mailer,
      name: isMail(mail)
        ? mail.name
        : undefined,
      message: {
        ...message,
        attachments: message.attachments?.map(({ content, ...item }) => content === undefined
          ? item
          : {
              ...item,
              base64: toBase64(typeof content === 'string'
                ? new TextEncoder().encode(content)
                : content),
            }),
      },
    }
    return this.app.make(QueueManager).dispatch(JOB, queued, options)
  }

  fake(): MailFake {
    this.#fake = new MailFake()
    return this.#fake
  }

  restore(): void {
    this.#fake = undefined
  }

  async close(): Promise<void> {
    for (const transport of this.#transports.values())
      await transport.close?.()
    this.#transports.clear()
  }

  /** 渲染 defineMail，合并信封与默认发件人 */
  async #compose<P>(mail: MailDefinition<P> | MailMessage, payload: P | undefined, envelope: Envelope): Promise<{ message: MailMessage, mailer: string }> {
    // 指定了语言时在该语言下渲染（内容中的 t() 按此翻译），否则沿用当前请求的语言
    const locale = envelope.locale ?? (isMail(mail)
      ? mail.locale
      : undefined)
    const render = async (): Promise<MailContent & { to?: AddressInput }> => isMail(mail)
      ? await mail.render(payload as P)
      : mail as MailMessage
    const content = locale
      ? await useI18n().withLocale(locale, render)
      : await render()
    const message: MailMessage = {
      ...content,
      to: envelope.to ?? content.to ?? [],
      cc: envelope.cc ?? content.cc,
      bcc: envelope.bcc ?? content.bcc,
      replyTo: envelope.replyTo ?? content.replyTo ?? this.config.replyTo,
      from: envelope.from ?? content.from ?? this.config.from,
    }
    if (!normalizeAddresses(message.to).length)
      throw new Error(`Mail "${message.subject}" has no recipients`)
    const mailer = envelope.mailer ?? (isMail(mail)
      ? mail.mailer
      : undefined) ?? this.config.default
    return { message, mailer }
  }

  async #deliver(mailer: string, message: MailMessage): Promise<SentMessage> {
    const resolved = await this.#resolve(message)
    const transport = this.transport(mailer)
    if (!telemetryActive()) {
      const result = await transport.send(resolved)
      return { mailer, messageId: result.messageId }
    }
    // 可观测性：开发面板（含渲染后的预览）与 OpenTelemetry 的 mail.send span
    const startTime = Date.now()
    const started = performance.now()
    const report = (messageId?: string, error?: unknown): void => recordTelemetry('mail', {
      mailer,
      driver: transport.driver,
      subject: resolved.subject,
      from: formatAddress(resolved.from),
      to: resolved.to.map(formatAddress),
      cc: resolved.cc.map(formatAddress),
      bcc: resolved.bcc.map(formatAddress),
      html: resolved.html,
      text: resolved.text,
      messageId,
      startTime,
      duration: performance.now() - started,
      ...(error !== undefined && {
        error: error instanceof Error
          ? error.message
          : String(error),
      }),
    })
    try {
      const result = await transport.send(resolved)
      report(result.messageId)
      return { mailer, messageId: result.messageId }
    }
    catch (error) {
      report(undefined, error)
      throw error
    }
  }

  async #resolve(message: MailMessage): Promise<ResolvedMessage> {
    const [from] = normalizeAddresses(message.from)
    if (!from)
      throw new Error('Mail has no sender: set "from" in config/mail.ts')
    let to = normalizeAddresses(message.to)
    let cc = normalizeAddresses(message.cc)
    let bcc = normalizeAddresses(message.bcc)
    const headers = { ...message.headers }
    const alwaysTo = normalizeAddresses(this.config.alwaysTo)
    if (alwaysTo.length) {
      headers['X-Original-To'] = [
        ...to,
        ...cc,
        ...bcc,
      ].map(formatAddress).join(', ')
      to = alwaysTo
      cc = []
      bcc = []
    }
    const attachments = await Promise.all((message.attachments ?? []).map(item => this.#attachment(item)))
    return {
      from,
      to,
      cc,
      bcc,
      replyTo: normalizeAddresses(message.replyTo),
      subject: message.subject,
      html: message.html,
      text: message.text ?? (message.html
        ? htmlToText(message.html)
        : undefined),
      attachments,
      headers,
      tags: message.tags ?? {},
    }
  }

  async #attachment(item: Attachment): Promise<ResolvedAttachment> {
    let content: Uint8Array | undefined
    if (item.content !== undefined) {
      content = typeof item.content === 'string'
        ? new TextEncoder().encode(item.content)
        : item.content
    }
    else if (item.path) {
      content = await this.app.make(StorageManager).disk(item.disk).get(item.path)
      if (!content)
        throw new Error(`Mail attachment not found: ${item.disk ?? 'default'}:${item.path}`)
    }
    if (!content)
      throw new Error(`Mail attachment "${item.filename}" has no content or path`)
    return {
      filename: item.filename,
      content,
      contentType: item.contentType ?? contentTypeOf(item.filename),
      ...(item.cid && { cid: item.cid }),
    }
  }
}

/** 链式构建：`Mail.to(user.email).cc(admin).send(WelcomeMail, { name })` */
export class PendingMail {
  readonly #envelope: Envelope = {}

  constructor(private readonly manager: MailManager) {}

  to(address: AddressInput): this {
    this.#envelope.to = address
    return this
  }

  cc(address: AddressInput): this {
    this.#envelope.cc = address
    return this
  }

  bcc(address: AddressInput): this {
    this.#envelope.bcc = address
    return this
  }

  replyTo(address: AddressInput): this {
    this.#envelope.replyTo = address
    return this
  }

  from(address: AddressInput): this {
    this.#envelope.from = address
    return this
  }

  mailer(name: string): this {
    this.#envelope.mailer = name
    return this
  }

  /** 按指定语言渲染：`Mail.to(user.email).locale('zh-CN').send(WelcomeMail, payload)` */
  locale(locale: string): this {
    this.#envelope.locale = locale
    return this
  }

  send<P>(mail: MailDefinition<P>, ...payload: P extends void ? [] : [payload: P]): Promise<SentMessage>
  send(message: MailContent): Promise<SentMessage>
  send(mail: MailDefinition<any> | MailContent, payload?: unknown): Promise<SentMessage> {
    return this.manager.send(mail as MailMessage, payload, this.#envelope)
  }

  /** 排队发送 */
  queue<P>(mail: MailDefinition<P>, ...payload: P extends void ? [] : [payload: P]): Promise<string>
  queue(message: MailContent): Promise<string>
  queue(mail: MailDefinition<any> | MailContent, payload?: unknown): Promise<string> {
    return this.manager.queue(mail as MailMessage, payload, this.#envelope)
  }

  /** 延迟发送：`later('10m', ReminderMail, payload)` */
  later<P>(delay: string | number, mail: MailDefinition<P>, ...payload: P extends void ? [] : [payload: P]): Promise<string>
  later(delay: string | number, message: MailContent): Promise<string>
  later(delay: string | number, mail: MailDefinition<any> | MailContent, payload?: unknown): Promise<string> {
    return this.manager.queue(mail as MailMessage, payload, this.#envelope, { delay })
  }
}

let fallback: MailManager | undefined

/** @internal */
export function setMailManager(manager: MailManager | undefined): void {
  fallback = manager
}

export function useMailManager(): MailManager {
  const manager = getRequestStore()?.container.make(MailManager) ?? fallback
  if (!manager)
    throw new Error('Mail is not available: the application has not booted')
  return manager
}

/**
 * 邮件门面：
 *
 * ```ts
 * await Mail.to(user.email).send(WelcomeMail, { name: user.name })
 * await Mail.to(user.email).queue(WelcomeMail, { name: user.name })
 * await Mail.send({ to: 'ops@example.com', subject: 'Report', text: '...' })
 * const fake = Mail.fake()
 * fake.assertQueued(WelcomeMail, mail => MailFake.hasRecipient(mail, 'ada@example.com'))
 * ```
 */
export const Mail = {
  to: (address: AddressInput): PendingMail => useMailManager().to(address),
  mailer: (name: string): PendingMail => useMailManager().mailer(name),
  send: (message: MailMessage): Promise<SentMessage> => useMailManager().send(message),
  queue: (message: MailMessage, options?: DispatchOptions): Promise<string> => useMailManager().queue(message, undefined, {}, options),
  fake: (): MailFake => useMailManager().fake(),
  restore: (): void => useMailManager().restore(),
  transport: (name?: string): MailTransport => useMailManager().transport(name),
}
