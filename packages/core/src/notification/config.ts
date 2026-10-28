import type { Backoff } from '../queue/job'
import type { NotificationStore } from './store'

export interface WebhookChannelConfig {
  /** 默认地址（通知对象没有 routeNotificationFor 时使用） */
  url?: string
  /** 签名密钥 */
  secret?: string
  headers?: Record<string, string>
  /** 请求超时（毫秒），默认 10000 */
  timeout?: number
}

export interface NotificationConfig {
  /** 各渠道的配置：默认地址、密钥等 */
  channels?: {
    mail?: { mailer?: string }
    database?: {
      /** 存储：`databaseNotificationStore(notifications)`（@hazejs/orm），或返回存储的函数 */
      store?: NotificationStore | (() => NotificationStore)
    }
    broadcast?: {
      /** 客户端收到的事件名，默认 notification */
      event?: string
    }
    slack?: WebhookChannelConfig
    webhook?: WebhookChannelConfig & {
      /** 签名请求头，默认 X-Haze-Signature */
      signatureHeader?: string
      /** 时间戳请求头，默认 X-Haze-Timestamp */
      timestampHeader?: string
    }
    /** 企业微信群机器人：url 或 key */
    wecom?: WebhookChannelConfig & { key?: string }
    /** 钉钉机器人：url 或 key（access_token），secret 为加签密钥 */
    dingtalk?: WebhookChannelConfig & { key?: string }
    /** 飞书机器人：url 或 key（hook ID），secret 为签名校验密钥 */
    feishu?: WebhookChannelConfig & { key?: string }
    [channel: string]: Record<string, any> | undefined
  }
  /** 排队发送（defineNotification 的 queue）使用的队列与重试 */
  queue?: {
    connection?: string
    queue?: string
    /** 最多尝试次数，默认 3 */
    tries?: number
    /** 重试等待，默认 [10, 60] 秒 */
    backoff?: Backoff
  }
}

/** `config/notification.ts` 的默认导出 */
export function defineNotificationConfig(config: NotificationConfig | (() => NotificationConfig)): NotificationConfig | (() => NotificationConfig) {
  return config
}
