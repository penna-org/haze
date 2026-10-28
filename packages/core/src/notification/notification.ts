import type { AddressInput, MailContent } from '../mail/types'
import type { MaybePromise } from '../utils'

const kNotification = Symbol.for('hazejs.notification')
const kPending = Symbol.for('hazejs.notification.pending')

/** 邮件渠道的内容：defineMail 的返回值格式，可另指定收件人与邮件驱动 */
export type NotificationMail = MailContent & {
  /** 收件人，默认取 `routeNotificationFor('mail')` 或通知对象的 email */
  to?: AddressInput
  /** 使用的邮件驱动（config/mail.ts 的 mailers） */
  mailer?: string
}

/** Slack 的 Incoming Webhook 消息（字符串即 text） */
export type SlackMessage = string | {
  text?: string
  blocks?: unknown[]
  attachments?: unknown[]
  thread_ts?: string
  username?: string
  icon_emoji?: string
  icon_url?: string
  [key: string]: unknown
}

/** 群机器人的 @：企业微信 / 钉钉支持手机号与用户 ID，飞书支持用户 ID（open_id） */
export interface RobotMentions {
  atAll?: boolean
  atMobiles?: string[]
  atUserIds?: string[]
}

/**
 * 群机器人消息（企业微信、钉钉、飞书通用）：
 * - 字符串或 `{ text }`：文本消息；
 * - `{ markdown, title? }`：Markdown（飞书为带 markdown 元素的消息卡片）；
 * - `{ raw }`：原样发送的厂商消息体（如钉钉的 actionCard、飞书的 interactive）。
 */
export type RobotMessage
  = | string
    | (RobotMentions & { text: string })
    | (RobotMentions & { markdown: string, title?: string })
    | { raw: Record<string, unknown> }

export interface NotificationQueueOptions {
  connection?: string
  queue?: string
  /** 延迟发送：秒数 / '10m' */
  delay?: string | number
}

type Render<N, P, R> = (notifiable: N, payload: P) => MaybePromise<R>

export interface NotificationOptions<P = void, N = any> {
  /** 类型名（数据库的 type 列、广播的 type 字段），默认 app/notification 下的文件名 */
  name?: string
  /** 发送的渠道：`['mail', 'database', 'broadcast', 'slack', 'webhook', 'wecom', 'dingtalk', 'feishu']` 或自定义渠道 */
  via: (notifiable: N, payload: P) => MaybePromise<string[]>
  toMail?: Render<N, P, NotificationMail | undefined>
  /** 写入 notifications 表的 data（缺省时用 toArray） */
  toDatabase?: Render<N, P, Record<string, unknown>>
  /** 推送到用户私有频道的数据（缺省时用 toArray / toDatabase） */
  toBroadcast?: Render<N, P, unknown>
  toSlack?: Render<N, P, SlackMessage | undefined>
  /** 通用 Webhook 的 JSON 请求体 */
  toWebhook?: Render<N, P, unknown>
  toWecom?: Render<N, P, RobotMessage | undefined>
  toDingtalk?: Render<N, P, RobotMessage | undefined>
  toFeishu?: Render<N, P, RobotMessage | undefined>
  /** database / broadcast 共用的数据 */
  toArray?: Render<N, P, Record<string, unknown>>
  /** 排队发送（经 config/queue.ts 的队列，每个渠道一个任务，失败按 config/notification.ts 的 queue 重试） */
  queue?: boolean | NotificationQueueOptions
  /** 自定义渠道：`toSms` 对应 `registerNotificationChannel('sms', ...)` */
  [method: `to${Capitalize<string>}`]: Render<N, P, unknown> | undefined
}

/** 一次待发送的通知：`InvoicePaid({ amount: 10 })` */
export interface PendingNotification<P = any, N = any> {
  readonly [kPending]: true
  readonly definition: NotificationDefinition<P, N>
  readonly payload: P
}

export interface NotificationDefinition<P = void, N = any> {
  readonly [kNotification]: true
  readonly name?: string
  readonly options: NotificationOptions<P, N>
  /** 带上数据，得到可发送的通知 */
  (...payload: P extends void ? [] : [payload: P]): PendingNotification<P, N>
}

/**
 * 定义通知（app/notification/*.ts，文件名即类型名）：
 *
 * ```ts
 * export default defineNotification<{ amount: number }>({
 *   via: user => ['mail', 'database', 'broadcast'],
 *   toMail: (user, { amount }) => ({ subject: '付款成功', html: html`<p>已收到 ${amount} 元</p>` }),
 *   toDatabase: (user, { amount }) => ({ amount }),
 * })
 *
 * await Notification.send(user, InvoicePaid({ amount: 10 }))
 * await notify(user, InvoicePaid({ amount: 10 }))
 * ```
 */
export function defineNotification<P = void, N = any>(options: NotificationOptions<P, N>): NotificationDefinition<P, N> {
  const definition = ((...args: [P?]) => ({
    [kPending]: true,
    definition,
    payload: args[0] as P,
  })) as unknown as NotificationDefinition<P, N>
  Object.defineProperties(definition, {
    [kNotification]: { value: true },
    name: { value: options.name, configurable: true },
    options: { value: options },
  })
  return definition
}

export function isNotification(value: unknown): value is NotificationDefinition<any> {
  return typeof value === 'function' && kNotification in value
}

export function isPendingNotification(value: unknown): value is PendingNotification {
  return typeof value === 'object' && value !== null && kPending in value
}

/**
 * 可接收通知的对象（模型或普通对象）。都是可选的：
 * - `routeNotificationFor(channel)`：该渠道的地址（邮箱、Webhook URL、频道名……）；
 * - `notifiableType`：数据库与广播使用的类型名，默认为类名（如 User）。
 */
export interface Notifiable {
  routeNotificationFor?: (channel: string, notification: PendingNotification) => unknown
  notifiableType?: string
  [key: string]: any
}

/** 通知对象的类型与 ID（数据库的 notifiable_type / notifiable_id） */
export interface NotifiableKey {
  type: string
  id: string
}

/** 按需发送的对象：只有路由，没有 ID（不写数据库） */
export class AnonymousNotifiable implements Notifiable {
  readonly routes = new Map<string, unknown>()

  constructor(private readonly send?: (notifiable: AnonymousNotifiable, notification: PendingNotification, now: boolean) => Promise<void>) {}

  /** 指定某个渠道的地址：`.route('mail', 'a@b.com').route('slack', url)` */
  route(channel: string, route: unknown): this {
    this.routes.set(channel, route)
    return this
  }

  routeNotificationFor(channel: string): unknown {
    return this.routes.get(channel)
  }

  /** 发送（按通知的 queue 设置排队） */
  notify(notification: PendingNotification): Promise<void> {
    if (!this.send)
      throw new Error('AnonymousNotifiable is not bound to a NotificationManager')
    return this.send(this, notification, false)
  }

  /** 立即发送（忽略 queue） */
  notifyNow(notification: PendingNotification): Promise<void> {
    if (!this.send)
      throw new Error('AnonymousNotifiable is not bound to a NotificationManager')
    return this.send(this, notification, true)
  }
}

/** 通知对象的类型与 ID：模型取主键（getKey()），否则取 id；类型取 notifiableType 或类名（普通对象为 User） */
export function notifiableKey(notifiable: unknown): NotifiableKey | undefined {
  if (typeof notifiable !== 'object' || notifiable === null || notifiable instanceof AnonymousNotifiable)
    return undefined
  const target = notifiable as Notifiable & { getKey?: () => unknown, constructor: { notifiableType?: string, name?: string } }
  const id = typeof target.getKey === 'function'
    ? target.getKey()
    : target.id
  if (id === undefined || id === null)
    return undefined
  const ctor = target.constructor
  const type = target.notifiableType
    ?? ctor?.notifiableType
    ?? (ctor && ctor !== Object && ctor.name
      ? ctor.name
      : 'User')
  return {
    type,
    id: String(id),
  }
}
