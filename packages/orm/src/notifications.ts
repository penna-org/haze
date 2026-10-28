import type { Table } from 'drizzle-orm'
import { QueryBuilder } from './query/builder'

// 与 @hazejs/core 的 NotificationStore / DatabaseNotification 结构一致（结构类型，避免依赖 core 的导出顺序）

interface NotifiableKey {
  type: string
  id: string
}

export interface StoredNotification {
  id: string
  type: string
  notifiableType: string
  notifiableId: string
  data: Record<string, unknown>
  readAt: Date | null
  createdAt: Date
}

interface Query {
  unread?: boolean
  type?: string
  limit?: number
  offset?: number
}

export interface DatabaseNotificationStore {
  insert: (notification: StoredNotification) => Promise<void>
  list: (notifiable: NotifiableKey, query?: Query) => Promise<StoredNotification[]>
  count: (notifiable: NotifiableKey, query?: Omit<Query, 'limit' | 'offset'>) => Promise<number>
  markAsRead: (ids: string[]) => Promise<number>
  markAsUnread: (ids: string[]) => Promise<number>
  markAllAsRead: (notifiable: NotifiableKey) => Promise<number>
  delete: (ids: string[]) => Promise<number>
}

export interface DatabaseNotificationStoreOptions {
  /** 数据库连接名，默认 config/database.ts 的 default */
  connection?: string
}

function toDate(value: unknown): Date | null {
  if (value === null || value === undefined)
    return null
  return value instanceof Date
    ? value
    : new Date(value as string | number)
}

function normalize(row: Record<string, unknown>): StoredNotification {
  return {
    id: String(row.id),
    type: String(row.type),
    notifiableType: String(row.notifiableType),
    notifiableId: String(row.notifiableId),
    data: typeof row.data === 'string'
      ? JSON.parse(row.data)
      : row.data as Record<string, unknown> ?? {},
    readAt: toDate(row.readAt),
    createdAt: toDate(row.createdAt) ?? new Date(0),
  }
}

/**
 * 通知的 database 渠道存储（config/notification.ts）：
 *
 * ```ts
 * import { databaseNotificationStore } from '@hazejs/orm'
 * import { notifications } from '../database/schema/notifications'
 *
 * export default defineNotificationConfig({
 *   channels: { database: { store: () => databaseNotificationStore(notifications) } },
 * })
 * ```
 *
 * 表结构用 `haze make:notifications-table` 生成（字段：id、type、notifiableType、notifiableId、data、readAt、createdAt）。
 */
export function databaseNotificationStore(table: Table, options: DatabaseNotificationStoreOptions = {}): DatabaseNotificationStore {
  const query = (): QueryBuilder<any> => new QueryBuilder(table as any, { connection: options.connection })
  const scoped = (notifiable: NotifiableKey, filter: Query = {}): QueryBuilder<any> => {
    const builder = query().where('notifiableType', notifiable.type).where('notifiableId', notifiable.id)
    if (filter.unread === true)
      builder.whereNull('readAt')
    else if (filter.unread === false)
      builder.whereNotNull('readAt')
    if (filter.type !== undefined)
      builder.where('type', filter.type)
    return builder
  }
  return {
    async insert(notification) {
      await query().insert({ ...notification })
    },
    async list(notifiable, filter = {}) {
      const builder = scoped(notifiable, filter).order('createdAt', 'desc')
      if (filter.limit !== undefined)
        builder.limit(filter.limit)
      if (filter.offset !== undefined)
        builder.offset(filter.offset)
      return (await builder.select() as Array<Record<string, unknown>>).map(normalize)
    },
    count(notifiable, filter = {}) {
      return scoped(notifiable, filter).count()
    },
    async markAsRead(ids) {
      return ids.length
        ? query().whereIn('id', ids).whereNull('readAt').update({
            readAt: new Date(),
          })
        : 0
    },
    async markAsUnread(ids) {
      return ids.length
        ? query().whereIn('id', ids).whereNotNull('readAt').update({ readAt: null })
        : 0
    },
    markAllAsRead(notifiable) {
      return scoped(notifiable, { unread: true }).update({
        readAt: new Date(),
      })
    },
    async delete(ids) {
      return ids.length
        ? query().whereIn('id', ids).delete()
        : 0
    },
  }
}
