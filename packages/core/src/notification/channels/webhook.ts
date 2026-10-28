import type { NotificationChannel, WebhookRoute } from '../channel'
import type { SlackMessage } from '../notification'
import { hmacHex, postJson, webhookRoute } from '../channel'

/** slack：Incoming Webhook（地址取 routeNotificationFor('slack') 或 config 的 channels.slack.url） */
export const slackChannel: NotificationChannel<WebhookRoute, Exclude<SlackMessage, string>> = {
  async prepare(ctx) {
    const message = await ctx.render('toSlack') as SlackMessage | undefined
    const route = webhookRoute(await ctx.route(), ctx.config)
    if (message === undefined || !route)
      return undefined
    return {
      route,
      message: typeof message === 'string'
        ? { text: message }
        : message,
    }
  },
  async send({ route, message }, { config }) {
    await postJson('slack', route.url, JSON.stringify(message), { headers: route.headers, timeout: config.timeout })
  },
}

const SIGNATURE_HEADER = 'x-haze-signature'
const TIMESTAMP_HEADER = 'x-haze-timestamp'

/** 签名内容：`<timestamp>.<body>` */
function signedPayload(timestamp: string | number, body: string): string {
  return `${timestamp}.${body}`
}

/**
 * webhook：把 toWebhook() 的返回值作为 JSON 请求体 POST 到地址。
 * 设置 secret 时附带签名：`X-Haze-Timestamp: <秒>`、`X-Haze-Signature: sha256=<hex(HMAC-SHA256(secret, "<timestamp>.<body>"))>`；
 * 另附 `X-Haze-Notification`（类型）与 `X-Haze-Notification-Id`。
 */
export const webhookChannel: NotificationChannel<WebhookRoute, unknown> = {
  async prepare(ctx) {
    const message = await ctx.render('toWebhook')
    const route = webhookRoute(await ctx.route(), ctx.config)
    if (message === undefined || !route)
      return undefined
    return { route, message }
  },
  async send({ route, message, notification }, { config }) {
    const body = JSON.stringify(message)
    const headers: Record<string, string> = {
      'x-haze-notification': notification.type,
      'x-haze-notification-id': notification.id,
      ...config.headers,
      ...route.headers,
    }
    if (route.secret) {
      const timestamp = String(Math.floor(Date.now() / 1000))
      headers[config.timestampHeader ?? TIMESTAMP_HEADER] = timestamp
      headers[config.signatureHeader ?? SIGNATURE_HEADER] = `sha256=${await hmacHex(route.secret, signedPayload(timestamp, body))}`
    }
    await postJson('webhook', route.url, body, { headers, timeout: config.timeout })
  },
}

export interface VerifyWebhookOptions {
  /** 原始请求体（不要先解析再序列化） */
  body: string
  /** X-Haze-Signature 的值 */
  signature: string | null | undefined
  /** X-Haze-Timestamp 的值 */
  timestamp: string | null | undefined
  secret: string
  /** 允许的时间差（秒），默认 300；0 表示不检查 */
  tolerance?: number
}

/** 接收方校验 webhook 渠道的签名 */
export async function verifyWebhookSignature(options: VerifyWebhookOptions): Promise<boolean> {
  const { body, signature, timestamp, secret, tolerance = 300 } = options
  if (!signature || !timestamp || !/^\d+$/.test(timestamp))
    return false
  if (tolerance > 0 && Math.abs(Date.now() / 1000 - Number(timestamp)) > tolerance)
    return false
  const expected = `sha256=${await hmacHex(secret, signedPayload(timestamp, body))}`
  if (expected.length !== signature.length)
    return false
  let diff = 0
  for (let index = 0; index < expected.length; index++)
    diff |= expected.charCodeAt(index) ^ signature.charCodeAt(index)
  return diff === 0
}
