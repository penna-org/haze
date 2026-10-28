import type { NotifiableKey } from './notification'

/** notifications 表中的一条通知 */
export interface DatabaseNotification<D = Record<string, unknown>> {
  id: string
  /** 通知类型名（defineNotification 的 name 或 app/notification 下的文件名） */
  type: string
  notifiableType: string
  notifiableId: string
  data: D
  readAt: Date | null
  createdAt: Date
}

export interface NotificationQuery {
  /** true 只取未读，false 只取已读 */
  unread?: boolean
  /** 只取某种类型 */
  type?: string
  limit?: number
  offset?: number
}

/**
 * database 渠道的存储。`@hazejs/orm` 的 `databaseNotificationStore(notifications)` 基于 drizzle 表实现，
 * 测试中可用 `memoryNotificationStore()`。
 */
export interface NotificationStore {
  insert: (notification: DatabaseNotification) => Promise<void>
  /** 按创建时间倒序 */
  list: (notifiable: NotifiableKey, query?: NotificationQuery) => Promise<DatabaseNotification[]>
  count: (notifiable: NotifiableKey, query?: Omit<NotificationQuery, 'limit' | 'offset'>) => Promise<number>
  /** 标记已读（只更新未读的），返回更新数量 */
  markAsRead: (ids: string[]) => Promise<number>
  markAsUnread: (ids: string[]) => Promise<number>
  markAllAsRead: (notifiable: NotifiableKey) => Promise<number>
  delete: (ids: string[]) => Promise<number>
}

/** 内存存储（测试、示例） */
export function memoryNotificationStore(): NotificationStore & { readonly records: DatabaseNotification[] } {
  const records: DatabaseNotification[] = []
  const matches = (record: DatabaseNotification, notifiable: NotifiableKey, query: NotificationQuery = {}): boolean =>
    record.notifiableType === notifiable.type
    && record.notifiableId === notifiable.id
    && (query.unread === undefined || (record.readAt === null) === query.unread)
    && (query.type === undefined || record.type === query.type)
  const update = (ids: string[], apply: (record: DatabaseNotification) => boolean): number =>
    records.filter(record => ids.includes(record.id) && apply(record)).length
  return {
    records,
    async insert(notification) {
      records.push(structuredClone(notification))
    },
    async list(notifiable, query = {}) {
      const offset = query.offset ?? 0
      // 后写入的在前（同一毫秒内写入的也按写入顺序倒序）
      return [...records].reverse().filter(record => matches(record, notifiable, query)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(offset, query.limit === undefined
        ? undefined
        : offset + query.limit).map(record => structuredClone(record))
    },
    async count(notifiable, query = {}) {
      return records.filter(record => matches(record, notifiable, query)).length
    },
    async markAsRead(ids) {
      const now = new Date()
      return update(ids, record => record.readAt === null && Boolean(record.readAt = now))
    },
    async markAsUnread(ids) {
      return update(ids, record => record.readAt !== null && (record.readAt = null) === null)
    },
    async markAllAsRead(notifiable) {
      const now = new Date()
      return records.filter(record => matches(record, notifiable, { unread: true }) && Boolean(record.readAt = now)).length
    },
    async delete(ids) {
      let removed = 0
      for (let index = records.length - 1; index >= 0; index--) {
        if (ids.includes(records[index].id)) {
          records.splice(index, 1)
          removed++
        }
      }
      return removed
    },
  }
}
