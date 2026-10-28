import type { Application } from '../application'
import type { MaybePromise } from '../utils'
import type { NotifiableKey, PendingNotification } from './notification'
import { toBase64 } from '../storage/content'
import { globalStore } from '../utils'

/** 发送中的通知的元信息（排队时随任务传递） */
export interface NotificationMeta {
  /** 本次通知的 ID（同一通知对象的各渠道共用） */
  id: string
  /** 通知类型名 */
  type: string
  notifiable?: NotifiableKey
}

/** 一次渠道投递：地址 + 内容（排队时以 JSON 写入任务载荷） */
export interface Delivery<R = any, M = any> {
  channel: string
  route: R
  message: M
  notification: NotificationMeta
}

export interface PrepareContext<N = any> {
  /** 渠道名 */
  channel: string
  notifiable: N
  notification: PendingNotification
  meta: NotificationMeta
  app: Application
  /** config/notification.ts 中该渠道的配置 */
  config: Record<string, any>
  /** 调用通知的 `to<Channel>()`（或依次尝试指定的方法），一个都没有定义时报错 */
  render: (method?: string | string[]) => Promise<unknown>
  /** 通知对象在该渠道的地址：`routeNotificationFor(channel)` */
  route: () => Promise<unknown>
}

export interface DeliverContext {
  app: Application
  config: Record<string, any>
}

/**
 * 通知渠道：
 * - `prepare`：从通知取出内容与地址（立即发送与排队发送都在投递端执行），返回 undefined 时跳过；
 *   缺省时调用 `to<Channel>()`，地址取 `routeNotificationFor(channel)`；
 * - `send`：发送（排队时在 worker 中执行），抛错时按队列设置重试。
 */
export interface NotificationChannel<R = any, M = any> {
  prepare?: (ctx: PrepareContext) => MaybePromise<{ route: R, message: M } | undefined>
  send: (delivery: Delivery<R, M>, ctx: DeliverContext) => MaybePromise<unknown>
}

export function defineNotificationChannel<R = any, M = any>(channel: NotificationChannel<R, M>): NotificationChannel<R, M> {
  return channel
}

/** 进程级的自定义渠道（服务提供者中注册，所有应用可用） */
const registry = globalStore('notification:channels', () => new Map<string, NotificationChannel>())

/** 注册自定义渠道：`registerNotificationChannel('sms', { send: ({ route, message }) => ... })` */
export function registerNotificationChannel(name: string, channel: NotificationChannel): void {
  registry.set(name, channel)
}

/** @internal */
export function registeredChannel(name: string): NotificationChannel | undefined {
  return registry.get(name)
}

/** 渠道名对应的方法名：slack → toSlack，sms-gateway → toSmsGateway */
export function renderMethod(channel: string): string {
  return `to${channel.replace(/(?:^|[-_:.])(\w)/g, (_, char: string) => char.toUpperCase())}`
}

/** 缺省的 prepare：内容必需（没有对应方法时报错），地址可为 null */
export async function defaultPrepare(ctx: PrepareContext): Promise<{ route: unknown, message: unknown } | undefined> {
  const message = await ctx.render()
  if (message === undefined)
    return undefined
  return { route: await ctx.route() ?? null, message }
}

/** Webhook 地址：字符串或 `{ url, secret, headers }` */
export interface WebhookRoute {
  url: string
  secret?: string
  headers?: Record<string, string>
}

/** 地址统一为对象：通知对象的地址优先，否则取渠道配置中的 url / secret */
export function webhookRoute(route: unknown, config: Record<string, any>): WebhookRoute | undefined {
  if (typeof route === 'string' && route)
    return { url: route }
  if (typeof route === 'object' && route !== null && typeof (route as WebhookRoute).url === 'string')
    return route as WebhookRoute
  if (typeof config.url === 'string' && config.url)
    return { url: config.url, secret: config.secret, headers: config.headers }
  return undefined
}

export class NotificationDeliveryError extends Error {
  constructor(message: string, readonly status?: number, readonly body?: unknown) {
    super(message)
    this.name = 'NotificationDeliveryError'
  }
}

/** POST JSON，返回解析后的响应（JSON 或文本）；非 2xx 时抛出 NotificationDeliveryError */
export async function postJson(channel: string, url: string, body: string, options: { headers?: Record<string, string>, timeout?: number } = {}): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8', ...options.headers },
    body,
    signal: AbortSignal.timeout(options.timeout ?? 10_000),
  })
  const text = await response.text()
  let parsed: unknown = text
  try {
    parsed = text
      ? JSON.parse(text)
      : undefined
  }
  catch {}
  if (!response.ok)
    throw new NotificationDeliveryError(`${channel} notification failed with HTTP ${response.status}: ${text.slice(0, 200)}`, response.status, parsed)
  return parsed
}

const encoder = new TextEncoder()

/** HMAC-SHA256 */
export async function hmacSha256(key: string, message: string): Promise<Uint8Array> {
  const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)))
}

export async function hmacBase64(key: string, message: string): Promise<string> {
  return toBase64(await hmacSha256(key, message))
}

export async function hmacHex(key: string, message: string): Promise<string> {
  return [
    ...await hmacSha256(key, message),
  ].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
