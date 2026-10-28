import type { AddressInput, Attachment, MailContent } from '../../mail/types'
import type { NotificationChannel } from '../channel'
import type { NotifiableKey, NotificationMail } from '../notification'
import type { NotificationStore } from '../store'
import { BroadcastManager } from '../../broadcast/manager'
import { MailManager } from '../../mail/manager'
import { fromBase64, toBase64 } from '../../storage/content'
import { isPlainObject } from '../../utils'

type QueuedAttachment = Omit<Attachment, 'content'> & { content?: string, base64?: string }
type MailPayload = Omit<MailContent, 'attachments'> & { mailer?: string, attachments?: QueuedAttachment[] }

/** 通知对象的默认邮箱：email（有 name 时带上名字） */
function defaultAddress(notifiable: unknown): AddressInput | undefined {
  const target = notifiable as { email?: unknown, name?: unknown } | undefined
  if (typeof target?.email !== 'string' || !target.email)
    return undefined
  return typeof target.name === 'string' && target.name
    ? { address: target.email, name: target.name }
    : target.email
}

/** mail：toMail() 的内容经 config/mail.ts 的驱动发送（Mail.fake() 同样会记录） */
export const mailChannel: NotificationChannel<AddressInput, MailPayload> = {
  async prepare(ctx) {
    const content = await ctx.render('toMail') as NotificationMail | undefined
    if (!content)
      return undefined
    const { to, mailer, attachments, ...rest } = content
    const route = to ?? await ctx.route() as AddressInput | undefined ?? defaultAddress(ctx.notifiable)
    if (!route || (Array.isArray(route) && !route.length))
      return undefined
    return {
      route,
      message: {
        ...rest,
        mailer: mailer ?? ctx.config.mailer,
        // 字节内容以 base64 传递，排队时可以 JSON 序列化
        ...(attachments && {
          attachments: attachments.map(({ content: data, ...item }) => data instanceof Uint8Array
            ? {
                ...item,
                base64: toBase64(data),
              }
            : {
                ...item,
                ...(data !== undefined && { content: data }),
              }),
        }),
      },
    }
  },
  async send({ route, message }, { app }) {
    const { mailer, attachments, ...content } = message
    await app.make(MailManager).send({
      ...content,
      to: route,
      ...(attachments && {
        attachments: attachments.map(({ base64, ...item }) => base64 === undefined
          ? item
          : {
              ...item,
              content: fromBase64(base64),
            }),
      }),
    }, undefined, { mailer })
  },
}

/** database：写入 notifications 表（存储由 config/notification.ts 的 channels.database.store 提供） */
export function databaseChannel(store: () => NotificationStore): NotificationChannel<NotifiableKey, Record<string, unknown>> {
  return {
    async prepare(ctx) {
      const data = await ctx.render(['toDatabase', 'toArray']) as Record<string, unknown> | undefined
      if (data === undefined || !ctx.meta.notifiable)
        return undefined
      return { route: ctx.meta.notifiable, message: data }
    },
    async send({ route, message, notification }) {
      await store().insert({
        id: notification.id,
        type: notification.type,
        notifiableType: route.type,
        notifiableId: route.id,
        data: message,
        readAt: null,
        createdAt: new Date(),
      })
    },
  }
}

/**
 * broadcast：推送到通知对象的私有频道（默认 `private-<类型>.<ID>`，如 `private-User.1`），
 * 事件名为 `notification`（前端 `echo.private('User.1').notification(cb)`），数据带 id 与 type。
 */
export const broadcastChannel: NotificationChannel<string | string[], unknown> = {
  async prepare(ctx) {
    const data = await ctx.render(['toBroadcast', 'toArray', 'toDatabase'])
    if (data === undefined)
      return undefined
    const key = ctx.meta.notifiable
    const route = await ctx.route() as string | string[] | undefined ?? (key && `private-${key.type}.${key.id}`)
    if (!route || (Array.isArray(route) && !route.length))
      return undefined
    return { route, message: data }
  },
  async send({ route, message, notification }, { app, config }) {
    if (!app.container.has(BroadcastManager))
      throw new Error('The broadcast notification channel requires broadcasting (BroadcastManager is not registered)')
    await app.make(BroadcastManager).broadcast({
      channel: route,
      event: config.event ?? 'notification',
      data: {
        id: notification.id,
        type: notification.type,
        ...(isPlainObject(message)
          ? message
          : { data: message }),
      },
    })
  },
}
