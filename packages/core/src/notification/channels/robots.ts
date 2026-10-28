import type { NotificationChannel, PrepareContext, WebhookRoute } from '../channel'
import type { RobotMentions, RobotMessage } from '../notification'
import { hmacBase64, NotificationDeliveryError, postJson, webhookRoute } from '../channel'

/** 群机器人的地址：完整 URL，或只给 key / access_token / hook ID（不以 http 开头的字符串） */
async function robotRoute(ctx: PrepareContext, base: string): Promise<WebhookRoute | undefined> {
  const expand = (value: unknown): unknown => typeof value === 'string' && value && !/^https?:\/\//.test(value)
    ? `${base}${encodeURIComponent(value)}`
    : value
  const config = !ctx.config.url && ctx.config.key
    ? {
        ...ctx.config,
        url: expand(ctx.config.key),
      }
    : ctx.config
  return webhookRoute(expand(await ctx.route()), config)
}

async function prepareRobot(ctx: PrepareContext, method: string, base: string): Promise<{ route: WebhookRoute, message: RobotMessage } | undefined> {
  const message = await ctx.render(method) as RobotMessage | undefined
  const route = await robotRoute(ctx, base)
  if (message === undefined || !route)
    return undefined
  return { route, message }
}

type Normalized
  = | (RobotMentions & { kind: 'text', text: string })
    | (RobotMentions & { kind: 'markdown', markdown: string, title?: string })
    | { kind: 'raw', raw: Record<string, unknown> }

function normalize(message: RobotMessage): Normalized {
  if (typeof message === 'string')
    return { kind: 'text', text: message }
  if ('raw' in message)
    return { kind: 'raw', raw: message.raw }
  if ('markdown' in message)
    return { kind: 'markdown', ...message }
  return { kind: 'text', ...message }
}

/** 厂商返回的错误码（HTTP 200 但 errcode / code 非 0） */
function assertVendorOk(channel: string, result: unknown): void {
  const body = result as { errcode?: number, errmsg?: string, code?: number, msg?: string, StatusCode?: number, StatusMessage?: string } | undefined
  const code = body?.errcode ?? body?.code ?? body?.StatusCode
  if (code !== undefined && code !== 0)
    throw new NotificationDeliveryError(`${channel} notification failed: ${body?.errmsg ?? body?.msg ?? body?.StatusMessage ?? code}`, 200, body)
}

/** 第一行（去掉 Markdown 标记）作为钉钉 Markdown 的标题 */
function firstLine(markdown: string): string {
  return markdown.split('\n').find(line => line.trim())?.replace(/^[#>*\-\s]+/, '').slice(0, 64) || '通知'
}

const WECOM = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key='
const DINGTALK = 'https://oapi.dingtalk.com/robot/send?access_token='
const FEISHU = 'https://open.feishu.cn/open-apis/bot/v2/hook/'

/** 企业微信群机器人的消息体 */
export function wecomPayload(message: RobotMessage): Record<string, unknown> {
  const item = normalize(message)
  if (item.kind === 'raw')
    return item.raw
  if (item.kind === 'markdown') {
    return {
      msgtype: 'markdown',
      markdown: { content: item.markdown },
    }
  }
  const mentioned = [
    ...item.atUserIds ?? [],
    ...item.atAll
      ? ['@all']
      : [],
  ]
  return {
    msgtype: 'text',
    text: {
      content: item.text,
      ...(mentioned.length && { mentioned_list: mentioned }),
      ...(item.atMobiles?.length && { mentioned_mobile_list: item.atMobiles }),
    },
  }
}

/** 钉钉自定义机器人的消息体 */
export function dingtalkPayload(message: RobotMessage): Record<string, unknown> {
  const item = normalize(message)
  if (item.kind === 'raw')
    return item.raw
  const at = {
    ...(item.atMobiles?.length && { atMobiles: item.atMobiles }),
    ...(item.atUserIds?.length && { atUserIds: item.atUserIds }),
    ...(item.atAll && { isAtAll: true }),
  }
  const mentions = Object.keys(at).length
    ? { at }
    : {}
  if (item.kind === 'markdown') {
    return {
      msgtype: 'markdown',
      markdown: { title: item.title ?? firstLine(item.markdown), text: item.markdown },
      ...mentions,
    }
  }
  return {
    msgtype: 'text',
    text: { content: item.text },
    ...mentions,
  }
}

/** 飞书自定义机器人的消息体（Markdown 以消息卡片的 markdown 元素发送） */
export function feishuPayload(message: RobotMessage): Record<string, unknown> {
  const item = normalize(message)
  if (item.kind === 'raw')
    return item.raw
  if (item.kind === 'markdown') {
    const mentions = [
      ...item.atAll
        ? ['<at id=all></at>']
        : [],
      ...(item.atUserIds ?? []).map(id => `<at id=${id}></at>`),
    ].join(' ')
    return {
      msg_type: 'interactive',
      card: {
        ...(item.title && {
          header: {
            title: { tag: 'plain_text', content: item.title },
          },
        }),
        elements: [
          {
            tag: 'markdown',
            content: mentions
              ? `${mentions}\n${item.markdown}`
              : item.markdown,
          },
        ],
      },
    }
  }
  const mentions = [
    ...item.atAll
      ? ['<at user_id="all">所有人</at>']
      : [],
    ...(item.atUserIds ?? []).map(id => `<at user_id="${id}"></at>`),
  ].join(' ')
  return {
    msg_type: 'text',
    content: {
      text: mentions
        ? `${mentions} ${item.text}`
        : item.text,
    },
  }
}

/** wecom：企业微信群机器人（地址或 key；不支持签名） */
export const wecomChannel: NotificationChannel<WebhookRoute, RobotMessage> = {
  prepare: ctx => prepareRobot(ctx, 'toWecom', WECOM),
  async send({ route, message }, { config }) {
    assertVendorOk('wecom', await postJson('wecom', route.url, JSON.stringify(wecomPayload(message)), { headers: route.headers, timeout: config.timeout }))
  },
}

/** dingtalk：钉钉自定义机器人（地址或 access_token；有 secret 时按加签方式附带 timestamp 与 sign） */
export const dingtalkChannel: NotificationChannel<WebhookRoute, RobotMessage> = {
  prepare: ctx => prepareRobot(ctx, 'toDingtalk', DINGTALK),
  async send({ route, message }, { config }) {
    let url = route.url
    if (route.secret) {
      const timestamp = Date.now()
      const sign = await hmacBase64(route.secret, `${timestamp}\n${route.secret}`)
      url += `${url.includes('?')
        ? '&'
        : '?'}timestamp=${timestamp}&sign=${encodeURIComponent(sign)}`
    }
    assertVendorOk('dingtalk', await postJson('dingtalk', url, JSON.stringify(dingtalkPayload(message)), { headers: route.headers, timeout: config.timeout }))
  },
}

/** feishu：飞书自定义机器人（地址或 hook ID；有 secret 时在请求体中附带 timestamp 与 sign） */
export const feishuChannel: NotificationChannel<WebhookRoute, RobotMessage> = {
  prepare: ctx => prepareRobot(ctx, 'toFeishu', FEISHU),
  async send({ route, message }, { config }) {
    const body = feishuPayload(message)
    if (route.secret) {
      const timestamp = String(Math.floor(Date.now() / 1000))
      // 飞书的签名以 "timestamp\nsecret" 为密钥，对空字符串做 HMAC-SHA256
      body.timestamp = timestamp
      body.sign = await hmacBase64(`${timestamp}\n${route.secret}`, '')
    }
    assertVendorOk('feishu', await postJson('feishu', route.url, JSON.stringify(body), { headers: route.headers, timeout: config.timeout }))
  },
}
