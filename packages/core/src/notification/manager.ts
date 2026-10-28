import type { Application } from '../application'
import type { Delivery, NotificationChannel, NotificationMeta, PrepareContext } from './channel'
import type { NotificationConfig } from './config'
import type { NotifiableKey, NotificationDefinition, PendingNotification } from './notification'
import type { DatabaseNotification, NotificationQuery, NotificationStore } from './store'
import { defineJob } from '../queue/job'
import { QueueManager } from '../queue/manager'
import { getRequestStore } from '../request'
import { defaultPrepare, registeredChannel, renderMethod } from './channel'
import { broadcastChannel, databaseChannel, mailChannel } from './channels/basic'
import { dingtalkChannel, feishuChannel, wecomChannel } from './channels/robots'
import { slackChannel, webhookChannel } from './channels/webhook'
import { AnonymousNotifiable, isNotification, isPendingNotification, notifiableKey } from './notification'

const JOB = 'notification:send'

/** Notification.fake() 记录的一次发送（每个通知对象一条） */
export interface SentNotification<P = any> {
  notifiable: unknown
  definition: NotificationDefinition<P, any>
  payload: P
  channels: string[]
  /** 是否会排队发送 */
  queued: boolean
  /** 渲染某个渠道的内容（如 `await sent.message('mail')`），用于断言内容 */
  message: (channel: string) => Promise<unknown>
}

type NotifiableInput = unknown

/** Notification.fake()：记录发送而不投递 */
export class NotificationFake {
  readonly sent: SentNotification[] = []

  constructor(private readonly manager: NotificationManager) {}

  #same(a: unknown, b: unknown): boolean {
    if (a === b)
      return true
    const left = notifiableKey(a)
    const right = notifiableKey(b)
    return Boolean(left && right && left.type === right.type && left.id === right.id)
  }

  /** 发给某个通知对象的记录 */
  sentTo<P>(notifiable: NotifiableInput, definition: NotificationDefinition<P, any>, predicate?: (sent: SentNotification<P>) => boolean): SentNotification<P>[] {
    return this.sent.filter(item => item.definition === definition && this.#same(item.notifiable, notifiable) && (!predicate || predicate(item))) as SentNotification<P>[]
  }

  assertSentTo<P>(notifiable: NotifiableInput | NotifiableInput[], definition: NotificationDefinition<P, any>, predicate?: (sent: SentNotification<P>) => boolean): void {
    for (const target of [notifiable].flat()) {
      if (!this.sentTo(target, definition, predicate).length)
        throw new Error(`Expected notification "${this.manager.nameOf(definition)}" to be sent to ${describe(target)}${predicate ? ' with matching data' : ''}`)
    }
  }

  assertNotSentTo<P>(notifiable: NotifiableInput | NotifiableInput[], definition: NotificationDefinition<P, any>, predicate?: (sent: SentNotification<P>) => boolean): void {
    for (const target of [notifiable].flat()) {
      if (this.sentTo(target, definition, predicate).length)
        throw new Error(`Unexpected notification "${this.manager.nameOf(definition)}" sent to ${describe(target)}`)
    }
  }

  /** 按需发送（Notification.route(...)）的断言，predicate 中 `sent.notifiable.routes` 为各渠道地址 */
  assertSentOnDemand<P>(definition: NotificationDefinition<P, any>, predicate?: (sent: SentNotification<P> & { notifiable: AnonymousNotifiable }) => boolean): void {
    const found = this.sent.some(item => item.definition === definition && item.notifiable instanceof AnonymousNotifiable && (!predicate || predicate(item as never)))
    if (!found)
      throw new Error(`Expected notification "${this.manager.nameOf(definition)}" to be sent on demand${predicate ? ' with matching data' : ''}`)
  }

  assertSentTimes<P>(definition: NotificationDefinition<P, any>, times: number): void {
    const count = this.sent.filter(item => item.definition === definition).length
    if (count !== times)
      throw new Error(`Expected notification "${this.manager.nameOf(definition)}" to be sent ${times} time(s), got ${count}`)
  }

  assertNothingSentTo(notifiable: NotifiableInput): void {
    const count = this.sent.filter(item => this.#same(item.notifiable, notifiable)).length
    if (count)
      throw new Error(`Expected no notifications to be sent to ${describe(notifiable)}, got ${count}`)
  }

  assertNothingSent(): void {
    if (this.sent.length)
      throw new Error(`Expected no notifications to be sent, got ${this.sent.length}`)
  }

  assertCount(count: number): void {
    if (this.sent.length !== count)
      throw new Error(`Expected ${count} notification(s), got ${this.sent.length}`)
  }
}

function describe(notifiable: unknown): string {
  const key = notifiableKey(notifiable)
  return key
    ? `${key.type}#${key.id}`
    : 'the notifiable'
}

/** 通知管理（应用单例，`inject(NotificationManager)`） */
export class NotificationManager {
  readonly #names = new WeakMap<NotificationDefinition<any, any>, string>()
  readonly #channels = new Map<string, NotificationChannel>()
  #store: NotificationStore | undefined
  #fake: NotificationFake | undefined

  constructor(readonly app: Application) {
    // app/notification/*.ts：文件名即类型名
    for (const [name, definition] of app.discovered<unknown>('notifications'))
      this.register(definition, name)
    // 排队发送：每个渠道一个任务，载荷为已渲染的内容与地址
    const queue = this.config.queue ?? {}
    app.make(QueueManager).register(defineJob({
      name: JOB,
      tries: queue.tries ?? 3,
      backoff: queue.backoff ?? [10, 60],
      queue: queue.queue,
      connection: queue.connection,
      handle: (delivery: Delivery) => this.deliver(delivery),
    }))
  }

  get config(): NotificationConfig {
    return this.app.config.get<NotificationConfig>('notification', {})
  }

  /** 登记通知的类型名（app/notification 自动登记） */
  register(definition: unknown, name?: string): this {
    if (!isNotification(definition))
      throw new TypeError('app/notification/*.ts must export default defineNotification(...)')
    const type = definition.name ?? name
    if (type)
      this.#names.set(definition, type)
    return this
  }

  nameOf(definition: NotificationDefinition<any, any>): string {
    return this.#names.get(definition) ?? definition.name ?? 'Notification'
  }

  /** 注册本应用的渠道（覆盖同名的内置渠道与 registerNotificationChannel） */
  extend(name: string, channel: NotificationChannel): this {
    this.#channels.set(name, channel)
    return this
  }

  channel(name: string): NotificationChannel {
    const channel = this.#channels.get(name) ?? registeredChannel(name) ?? this.#builtin(name)
    if (!channel)
      throw new Error(`Notification channel "${name}" is not registered (use registerNotificationChannel())`)
    return channel
  }

  #builtin(name: string): NotificationChannel | undefined {
    switch (name) {
      case 'mail':
        return mailChannel
      case 'database':
        return databaseChannel(() => this.store())
      case 'broadcast':
        return broadcastChannel
      case 'slack':
        return slackChannel
      case 'webhook':
        return webhookChannel
      case 'wecom':
        return wecomChannel
      case 'dingtalk':
        return dingtalkChannel
      case 'feishu':
        return feishuChannel
      default:
        return undefined
    }
  }

  /** database 渠道的存储（config/notification.ts 的 channels.database.store，或 useStore() 指定） */
  store(): NotificationStore {
    if (!this.#store) {
      const input = this.config.channels?.database?.store
      const store = typeof input === 'function'
        ? input()
        : input
      if (!store)
        throw new Error('The database notification channel needs a store: set channels.database.store in config/notification.ts (databaseNotificationStore() from @hazejs/orm)')
      this.#store = store
    }
    return this.#store
  }

  useStore(store: NotificationStore): this {
    this.#store = store
    return this
  }

  /** 发送（defineNotification 设置了 queue 时排队） */
  send(notifiables: NotifiableInput | NotifiableInput[], notification: PendingNotification): Promise<void> {
    return this.#send(notifiables, notification, false)
  }

  /** 立即发送（忽略 queue），可只发指定的渠道 */
  sendNow(notifiables: NotifiableInput | NotifiableInput[], notification: PendingNotification, channels?: string[]): Promise<void> {
    return this.#send(notifiables, notification, true, channels)
  }

  /** 按需发送：`Notification.route('mail', 'a@b.com').route('slack', url).notify(InvoicePaid(...))` */
  route(channel: string, route: unknown): AnonymousNotifiable {
    return new AnonymousNotifiable((notifiable, notification, now) => this.#send(notifiable, notification, now)).route(channel, route)
  }

  /** 执行一次渠道投递（排队任务 notification:send 调用） */
  async deliver(delivery: Delivery): Promise<void> {
    await this.channel(delivery.channel).send(delivery, {
      app: this.app,
      config: this.#channelConfig(delivery.channel),
    })
  }

  fake(): NotificationFake {
    this.#fake = new NotificationFake(this)
    return this.#fake
  }

  restore(): void {
    this.#fake = undefined
  }

  // ---- database 渠道的读取与标记 ----

  /** 通知对象的通知（按时间倒序） */
  notifications(notifiable: unknown, query: NotificationQuery = {}): Promise<DatabaseNotification[]> {
    return this.store().list(requireKey(notifiable), query)
  }

  unreadNotifications(notifiable: unknown, query: Omit<NotificationQuery, 'unread'> = {}): Promise<DatabaseNotification[]> {
    return this.store().list(requireKey(notifiable), { ...query, unread: true })
  }

  unreadCount(notifiable: unknown): Promise<number> {
    return this.store().count(requireKey(notifiable), { unread: true })
  }

  /** 标记已读：ID、通知记录或它们的数组 */
  markAsRead(notifications: string | DatabaseNotification | Array<string | DatabaseNotification>): Promise<number> {
    return this.store().markAsRead(ids(notifications))
  }

  markAsUnread(notifications: string | DatabaseNotification | Array<string | DatabaseNotification>): Promise<number> {
    return this.store().markAsUnread(ids(notifications))
  }

  markAllAsRead(notifiable: unknown): Promise<number> {
    return this.store().markAllAsRead(requireKey(notifiable))
  }

  #channelConfig(name: string): Record<string, any> {
    return this.config.channels?.[name] ?? {}
  }

  async #send(notifiables: NotifiableInput | NotifiableInput[], notification: PendingNotification, now: boolean, only?: string[]): Promise<void> {
    if (!isPendingNotification(notification))
      throw new TypeError('Notification.send() expects a notification such as InvoicePaid(payload)')
    const { definition, payload } = notification
    const { options } = definition
    const type = this.nameOf(definition)
    const queue = !now && options.queue
      ? (options.queue === true
          ? {}
          : options.queue)
      : undefined
    for (const notifiable of [notifiables].flat()) {
      const channels = only ?? [
        ...new Set(await options.via(notifiable, payload)),
      ]
      const meta: NotificationMeta = {
        id: crypto.randomUUID(),
        type,
        ...withKey(notifiable),
      }
      if (this.#fake) {
        this.#fake.sent.push({
          notifiable,
          definition,
          payload,
          channels,
          queued: Boolean(queue),
          message: async (channel) => {
            const prepared = await this.#prepare(channel, notifiable, notification, meta)
            return prepared?.message
          },
        })
        continue
      }
      for (const channel of channels) {
        const prepared = await this.#prepare(channel, notifiable, notification, meta)
        // 没有地址（如按需发送时未指定该渠道）或内容为空：跳过
        if (!prepared)
          continue
        const delivery: Delivery = {
          channel,
          route: prepared.route,
          message: prepared.message,
          notification: meta,
        }
        if (queue)
          await this.app.make(QueueManager).dispatch(JOB, delivery, queue)
        else
          await this.deliver(delivery)
      }
    }
  }

  async #prepare(channel: string, notifiable: unknown, notification: PendingNotification, meta: NotificationMeta): Promise<{ route: unknown, message: unknown } | undefined> {
    const implementation = this.channel(channel)
    const { definition, payload } = notification
    const ctx: PrepareContext = {
      channel,
      notifiable,
      notification,
      meta,
      app: this.app,
      config: this.#channelConfig(channel),
      render: async (methods = renderMethod(channel)) => {
        const names = [methods].flat()
        const renderers = definition.options as unknown as Record<string, ((notifiable: unknown, payload: unknown) => unknown) | undefined>
        const render = names.map(item => renderers[item]).find(item => typeof item === 'function')
        if (!render)
          throw new Error(`Notification "${meta.type}" is sent via "${channel}" but defines none of ${names.join(' / ')}()`)
        return render(notifiable, payload)
      },
      route: async () => (notifiable as { routeNotificationFor?: (channel: string, notification: PendingNotification) => unknown } | undefined)?.routeNotificationFor?.(channel, notification),
    }
    return (implementation.prepare ?? defaultPrepare)(ctx)
  }
}

function withKey(notifiable: unknown): { notifiable?: NotifiableKey } {
  const key = notifiableKey(notifiable)
  return key
    ? { notifiable: key }
    : {}
}

function requireKey(notifiable: unknown): NotifiableKey {
  const key = notifiableKey(notifiable)
  if (!key)
    throw new TypeError('Expected a notifiable with an id (a model or { id })')
  return key
}

function ids(input: string | DatabaseNotification | Array<string | DatabaseNotification>): string[] {
  return [input].flat().map(item => typeof item === 'string'
    ? item
    : item.id)
}

let fallback: NotificationManager | undefined
let token: unknown

/** @internal */
export function setNotificationManager(manager: NotificationManager | undefined, key: unknown): void {
  fallback = manager
  token = key
}

/** 当前应用的通知管理器：请求内取请求容器，否则取最近启动的应用 */
export function useNotificationManager(): NotificationManager {
  const manager = (token && getRequestStore()?.container.make(token as never)) as NotificationManager | undefined ?? fallback
  if (!manager)
    throw new Error('Notifications are not available: the application has not booted')
  return manager
}

/** 发送通知：`await notify(user, InvoicePaid({ amount: 10 }))`（可传数组） */
export function notify(notifiables: NotifiableInput | NotifiableInput[], notification: PendingNotification): Promise<void> {
  return useNotificationManager().send(notifiables, notification)
}

/** 立即发送（忽略 queue） */
export function notifyNow(notifiables: NotifiableInput | NotifiableInput[], notification: PendingNotification, channels?: string[]): Promise<void> {
  return useNotificationManager().sendNow(notifiables, notification, channels)
}

/** 通知对象的通知（database 渠道），按时间倒序 */
export function notificationsOf(notifiable: unknown, query?: NotificationQuery): Promise<DatabaseNotification[]> {
  return useNotificationManager().notifications(notifiable, query)
}

/** 通知对象的未读通知 */
export function unreadNotifications(notifiable: unknown, query?: Omit<NotificationQuery, 'unread'>): Promise<DatabaseNotification[]> {
  return useNotificationManager().unreadNotifications(notifiable, query)
}

/** 标记已读 */
export function markAsRead(notifications: string | DatabaseNotification | Array<string | DatabaseNotification>): Promise<number> {
  return useNotificationManager().markAsRead(notifications)
}

/** 标记通知对象的全部通知为已读 */
export function markAllAsRead(notifiable: unknown): Promise<number> {
  return useNotificationManager().markAllAsRead(notifiable)
}

/**
 * 通知门面：
 *
 * ```ts
 * await Notification.send(user, InvoicePaid({ amount: 10 }))
 * await Notification.route('mail', 'ops@example.com').route('dingtalk', url).notify(Alert({ text }))
 * const fake = Notification.fake()
 * fake.assertSentTo(user, InvoicePaid)
 * ```
 */
export const Notification = {
  send: (notifiables: NotifiableInput | NotifiableInput[], notification: PendingNotification): Promise<void> => useNotificationManager().send(notifiables, notification),
  sendNow: (notifiables: NotifiableInput | NotifiableInput[], notification: PendingNotification, channels?: string[]): Promise<void> => useNotificationManager().sendNow(notifiables, notification, channels),
  route: (channel: string, route: unknown): AnonymousNotifiable => useNotificationManager().route(channel, route),
  fake: (): NotificationFake => useNotificationManager().fake(),
  restore: (): void => useNotificationManager().restore(),
  notifications: (notifiable: unknown, query?: NotificationQuery): Promise<DatabaseNotification[]> => useNotificationManager().notifications(notifiable, query),
  unread: (notifiable: unknown, query?: Omit<NotificationQuery, 'unread'>): Promise<DatabaseNotification[]> => useNotificationManager().unreadNotifications(notifiable, query),
  unreadCount: (notifiable: unknown): Promise<number> => useNotificationManager().unreadCount(notifiable),
  markAsRead: (notifications: string | DatabaseNotification | Array<string | DatabaseNotification>): Promise<number> => useNotificationManager().markAsRead(notifications),
  markAllAsRead: (notifiable: unknown): Promise<number> => useNotificationManager().markAllAsRead(notifiable),
  manager: (): NotificationManager => useNotificationManager(),
}
