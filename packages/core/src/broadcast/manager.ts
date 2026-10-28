import type { Application } from '../application'
import type { EventDefinition } from '../events/event'
import type { HttpContext } from '../http/context'
import type { RouteRegistrar } from '../routing/builder'
import type { Peer } from '../websocket/handler'
import type { BroadcastBus } from './bus'
import type { PresenceMember } from './channels'
import type { BroadcastingConfig } from './config'
import type { BroadcastEnvelope, BroadcastMessage, HubConnection } from './hub'
import { BadRequestException, ForbiddenException, UnauthorizedException } from '../exception/exceptions'
import { getRequestStore } from '../request'
import { appKey, sign, verify } from '../security/key'
import { parseDuration } from '../utils'
import { defineWebSocket } from '../websocket/handler'
import { memoryBus, redisBus } from './bus'
import { ChannelRegistry, isValidChannel, parseChannel } from './channels'
import { localHub } from './hub'

/** 授权结果：在线频道附带成员信息 */
export type AuthorizeResult
  = | { ok: true, member?: PresenceMember }
    | { ok: false, status: 400 | 401 | 403, message: string }

export type SubscribeResult
  = | { ok: true, members?: PresenceMember[] }
    | { ok: false, status: 400 | 401 | 403, message: string }

export interface SubscribeOptions {
  channel: string
  /** POST /broadcasting/auth 返回的签名 */
  auth?: string
  /** 在线频道：POST /broadcasting/auth 返回的 channel_data */
  channelData?: string
  /** 已在别处完成授权（如 SSE 在请求内直接授权） */
  authorized?: AuthorizeResult
}

/** 传输层的一个连接（WebSocket / SSE / Socket.IO 共用的订阅逻辑） */
export interface BroadcastConnection {
  readonly id: string
  subscribe: (options: SubscribeOptions) => Promise<SubscribeResult>
  unsubscribe: (channel: string) => Promise<void>
  /** 客户端事件（只能发到已订阅的私有 / 在线频道，事件名为 `client-<name>`，不发给自己） */
  whisper: (channel: string, name: string, data: unknown) => Promise<boolean>
  /** 断开：退出所有频道（在线频道通知其他成员） */
  close: () => Promise<void>
}

export interface ConnectOptions {
  /** 没有签名时直接授权所用的请求（握手 / 升级请求的头，含 Cookie 与 Authorization） */
  request?: () => Request
}

export interface BroadcastInput {
  /** 频道名（`news`、`private-orders.1`、`presence-chat.1`） */
  channel: string | string[]
  event: string
  data?: unknown
  /** 不发给该连接（socket_id） */
  except?: string
  /** 不发给当前请求的发起者（读取请求头 X-Socket-ID） */
  toOthers?: boolean
}

export interface RecordedBroadcast {
  channels: string[]
  event: string
  data: unknown
  except?: string
  /** 由 defineEvent 触发时的事件定义 */
  definition?: EventDefinition<any>
}

type BroadcastMatcher = string | EventDefinition<any>

/** Broadcast.fake()：记录广播而不投递 */
export class BroadcastFake {
  readonly broadcasts: RecordedBroadcast[] = []

  #filter(matcher: BroadcastMatcher, predicate?: (item: RecordedBroadcast) => boolean): RecordedBroadcast[] {
    return this.broadcasts.filter(item => (typeof matcher === 'string'
      ? item.event === matcher
      : item.definition === matcher) && (!predicate || predicate(item)))
  }

  #describe(matcher: BroadcastMatcher): string {
    return typeof matcher === 'string'
      ? `"${matcher}"`
      : `"${matcher.name ?? 'event'}"`
  }

  assertBroadcast(matcher: BroadcastMatcher, predicate?: (item: RecordedBroadcast) => boolean): void {
    if (!this.#filter(matcher, predicate).length)
      throw new Error(`Expected ${this.#describe(matcher)} to be broadcast${predicate ? ' with matching data' : ''}`)
  }

  /** 断言广播到了某个频道 */
  assertBroadcastOn(channel: string, matcher?: BroadcastMatcher, predicate?: (item: RecordedBroadcast) => boolean): void {
    const found = this.broadcasts.some(item => item.channels.includes(channel)
      && (matcher === undefined || (typeof matcher === 'string'
        ? item.event === matcher
        : item.definition === matcher))
      && (!predicate || predicate(item)))
    if (!found) {
      throw new Error(`Expected a broadcast on channel "${channel}"${matcher === undefined
        ? ''
        : ` of ${this.#describe(matcher)}`}`)
    }
  }

  assertNotBroadcast(matcher: BroadcastMatcher, predicate?: (item: RecordedBroadcast) => boolean): void {
    if (this.#filter(matcher, predicate).length)
      throw new Error(`Unexpected broadcast of ${this.#describe(matcher)}`)
  }

  assertBroadcastTimes(matcher: BroadcastMatcher, times: number): void {
    const count = this.#filter(matcher).length
    if (count !== times)
      throw new Error(`Expected ${this.#describe(matcher)} to be broadcast ${times} time(s), got ${count}`)
  }

  assertNothingBroadcast(): void {
    if (this.broadcasts.length)
      throw new Error(`Expected nothing to be broadcast, got ${this.broadcasts.length}`)
  }
}

const SOCKET_ID_RE = /^[\w.:-]{1,128}$/
const WHISPER_RE = /^[\w.:-]{1,100}$/

/** 广播管理（应用单例，`inject(BroadcastManager)`）：频道授权、服务端广播、内置的 WebSocket / SSE 接口 */
export class BroadcastManager {
  readonly channels = new ChannelRegistry()
  #bus: BroadcastBus | undefined
  #fake: BroadcastFake | undefined

  constructor(readonly app: Application) {
    // app/channel/*.ts
    for (const [, definition] of app.discovered<unknown>('channels'))
      this.channels.register(definition)
  }

  get config(): BroadcastingConfig {
    return this.app.config.get<BroadcastingConfig>('broadcasting', {})
  }

  /** 有 config/broadcasting.ts 或 app/channel 下的频道定义时启用内置接口 */
  get enabled(): boolean {
    return this.app.config.get<BroadcastingConfig | undefined>('broadcasting', undefined) !== undefined || this.channels.size > 0
  }

  /** 多实例总线：config.broadcasting.bus，缺省沿用 config/websocket.ts 的 Redis，否则为进程内 */
  bus(): BroadcastBus {
    if (!this.#bus) {
      const config = this.config.bus
      const ws = this.app.config.get<{ broadcast?: { driver: 'redis', url?: string, channel?: string } } | undefined>('websocket', undefined)?.broadcast
      if (config && 'publish' in config)
        this.#bus = config
      else if (config?.driver === 'redis')
        this.#bus = redisBus(config)
      else if (!config && ws?.driver === 'redis')
        this.#bus = redisBus({ url: ws.url, prefix: `${ws.channel ?? 'haze:ws'}:broadcast` })
      else
        this.#bus = memoryBus()
    }
    return this.#bus
  }

  /** 服务端广播：发给订阅了这些频道的所有连接（所有实例） */
  async broadcast(input: BroadcastInput, definition?: EventDefinition<any>): Promise<void> {
    const channels = [
      ...new Set([input.channel].flat()),
    ]
    for (const channel of channels) {
      if (!isValidChannel(channel))
        throw new Error(`Invalid broadcast channel "${channel}"`)
    }
    if (!channels.length)
      return
    const except = input.except ?? (input.toOthers
      ? getRequestStore()?.ctx.header('x-socket-id')
      : undefined)
    if (this.#fake) {
      this.#fake.broadcasts.push({
        channels,
        event: input.event,
        data: input.data,
        except,
        definition,
      })
      return
    }
    await this.#publish({
      channels,
      event: input.event,
      data: input.data === undefined
        ? undefined
        : JSON.parse(JSON.stringify(input.data)),
      ...(except && { except }),
    })
  }

  /** defineEvent 声明了 broadcastOn 的事件（Events.emit 时调用） */
  async broadcastEvent<P>(event: EventDefinition<P>, payload: P, name: string = event.name ?? 'event'): Promise<void> {
    if (!event.broadcastOn || event.broadcastWhen?.(payload) === false)
      return
    const channels = [event.broadcastOn(payload) ?? []].flat()
    if (!channels.length)
      return
    await this.broadcast({
      channel: channels,
      event: typeof event.broadcastAs === 'function'
        ? event.broadcastAs(payload)
        : event.broadcastAs ?? name,
      data: event.broadcastWith
        ? event.broadcastWith(payload)
        : payload,
    }, event)
  }

  /** 在线频道当前的成员（所有实例） */
  members(channel: string): Promise<PresenceMember[]> {
    return this.bus().presence.members(channel)
  }

  /** 本进程的连接数 */
  connections(transport?: string): number {
    return localHub.count(transport)
  }

  fake(): BroadcastFake {
    this.#fake = new BroadcastFake()
    return this.#fake
  }

  restore(): void {
    this.#fake = undefined
  }

  async #publish(message: Omit<BroadcastMessage, 'id'>): Promise<void> {
    await this.bus().publish({
      id: crypto.randomUUID(),
      ...message,
    })
  }

  /**
   * 按 app/channel 的定义授权：公共频道直接通过；私有 / 在线频道需要登录且回调返回真值。
   * 在线频道的成员信息缺少 id 时取 Guard 的用户 ID。
   */
  async authorize(ctx: HttpContext, channel: string): Promise<AuthorizeResult> {
    if (!isValidChannel(channel))
      return { ok: false, status: 400, message: 'Invalid channel name' }
    const { type, name } = parseChannel(channel)
    if (type === 'public')
      return { ok: true }
    const match = this.channels.match(type, name)
    if (!match)
      return { ok: false, status: 403, message: `No authorization callback for channel "${channel}"` }
    const identity = await resolveUser(ctx, match.definition.options.guards)
    if (!identity)
      return { ok: false, status: 401, message: 'Unauthenticated' }
    let result: unknown
    try {
      result = await match.definition.authorize(identity.user, match.params, ctx)
    }
    catch (error) {
      this.app.logger.error(`Broadcast channel "${channel}" authorization failed`, error)
      return { ok: false, status: 403, message: 'Forbidden' }
    }
    if (!result)
      return { ok: false, status: 403, message: 'Forbidden' }
    if (type === 'private')
      return { ok: true }
    const member: PresenceMember = typeof result === 'object'
      ? { ...result as PresenceMember }
      : {}
    member.id ??= identity.id
    return { ok: true, member }
  }

  /** 为请求之外的 Request 授权（WebSocket 升级请求、Socket.IO 握手） */
  async authorizeRequest(request: Request, channel: string): Promise<AuthorizeResult> {
    const ctx = this.app.contextFor(request)
    try {
      return await this.authorize(ctx, channel)
    }
    finally {
      await ctx.container.dispose().catch(() => {})
    }
  }

  /** 订阅签名：HMAC(APP_KEY, `socketId:channel[:channelData]`) */
  signature(socketId: string, channel: string, channelData?: string): Promise<string> {
    return sign(signedValue(socketId, channel, channelData), appKey(this.app.config))
  }

  async #verify(socketId: string, channel: string, auth: string, channelData?: string): Promise<AuthorizeResult> {
    if (!await verify(signedValue(socketId, channel, channelData), auth, appKey(this.app.config)))
      return { ok: false, status: 403, message: 'Invalid signature' }
    if (parseChannel(channel).type !== 'presence')
      return { ok: true }
    try {
      const member = JSON.parse(channelData ?? '') as PresenceMember
      if (typeof member !== 'object' || member === null || member.id === undefined)
        throw new Error('missing id')
      return { ok: true, member }
    }
    catch {
      return { ok: false, status: 400, message: 'Invalid channel_data' }
    }
  }

  /**
   * POST /broadcasting/auth（`socket_id`、`channel_name`）：授权后返回签名，
   * 客户端带着签名经 WebSocket / Socket.IO 订阅。在线频道同时返回 `channel_data`（成员信息）。
   */
  async authEndpoint(ctx: HttpContext): Promise<Response> {
    const body = await ctx.body<Record<string, unknown> | undefined>() ?? {}
    const socketId = body.socket_id
    const channel = body.channel_name
    if (typeof socketId !== 'string' || !SOCKET_ID_RE.test(socketId))
      throw new BadRequestException('Invalid socket_id')
    if (!isValidChannel(channel))
      throw new BadRequestException('Invalid channel_name')
    const result = await this.authorize(ctx, channel)
    if (!result.ok) {
      if (result.status === 401)
        throw new UnauthorizedException(result.message)
      if (result.status === 400)
        throw new BadRequestException(result.message)
      throw new ForbiddenException(result.message)
    }
    const channelData = result.member
      ? JSON.stringify(result.member)
      : undefined
    return Response.json({
      auth: await this.signature(socketId, channel, channelData),
      ...(channelData && { channel_data: channelData }),
    })
  }

  /**
   * 接入一个传输层连接，返回订阅句柄（供内置的 WebSocket / SSE 与 @hazejs/socket.io 使用）。
   * 私有 / 在线频道的订阅：有签名时校验签名，否则用 `request` 直接授权。
   */
  connect(connection: HubConnection, options: ConnectOptions = {}): BroadcastConnection {
    localHub.add(connection)
    const { id } = connection
    const presence = this.bus().presence
    const leavePresence = async (channel: string): Promise<void> => {
      if (parseChannel(channel).type !== 'presence')
        return
      const { last, member } = await presence.leave(channel, id)
      if (last && member) {
        await this.#publish({
          channels: [channel],
          event: 'haze:member_removed',
          data: member,
        })
      }
    }
    return {
      id,
      subscribe: async ({ channel, auth, channelData, authorized }) => {
        if (!isValidChannel(channel))
          return { ok: false, status: 400, message: 'Invalid channel name' }
        const { type } = parseChannel(channel)
        if (localHub.subscribed(id, channel)) {
          return type === 'presence'
            ? { ok: true, members: await presence.members(channel) }
            : { ok: true }
        }
        let result: AuthorizeResult = { ok: true }
        if (type !== 'public') {
          if (authorized)
            result = authorized
          else if (auth)
            result = await this.#verify(id, channel, auth, channelData)
          else if (options.request)
            result = await this.authorizeRequest(options.request(), channel)
          else
            result = { ok: false, status: 401, message: 'Unauthenticated' }
        }
        if (!result.ok)
          return result
        if (!localHub.join(id, channel))
          return { ok: false, status: 400, message: 'Connection is closed' }
        if (type === 'presence' && result.member) {
          const { first, members } = await presence.join(channel, id, result.member)
          if (first) {
            await this.#publish({
              channels: [channel],
              event: 'haze:member_added',
              data: result.member,
              except: id,
            })
          }
          return { ok: true, members }
        }
        return { ok: true }
      },
      unsubscribe: async (channel) => {
        if (localHub.leave(id, channel))
          await leavePresence(channel)
      },
      whisper: async (channel, name, data) => {
        if (parseChannel(channel).type === 'public' || !localHub.subscribed(id, channel) || !WHISPER_RE.test(name))
          return false
        await this.#publish({
          channels: [channel],
          event: `client-${name}`,
          data,
          except: id,
        })
        return true
      },
      close: async () => {
        for (const channel of localHub.remove(id))
          await leavePresence(channel).catch(error => this.app.logger.error('Failed to leave presence channel', error))
      },
    }
  }

  /** 内置接口（application 在编译路由前加载）：POST /auth、GET /sse、/ws */
  routes(): RouteRegistrar {
    return (r) => {
      const config = this.config
      if (!this.enabled || config.routes === false)
        return
      r.group({ prefix: config.path ?? '/broadcasting', middleware: config.middleware ?? [] }, (r) => {
        r.post('/auth', ctx => this.authEndpoint(ctx)).doc({ hidden: true })
        if (config.transports?.sse !== false)
          r.get('/sse', ctx => this.sse(ctx)).doc({ hidden: true })
        if (config.transports?.ws !== false)
          r.ws('/ws', this.#webSocket())
      })
    }
  }

  /**
   * SSE：`GET /broadcasting/sse?channels=news,private-orders.1`，在请求内按当前用户逐个授权；
   * 推送 `data: <BroadcastEnvelope JSON>`，定期发送注释行保持连接。变更订阅需重新连接。
   */
  async sse(ctx: HttpContext): Promise<Response> {
    const channels = [
      ...new Set((ctx.query('channels') ?? '').split(',').map(item => item.trim()).filter(Boolean)),
    ]
    if (channels.length > (this.config.maxChannels ?? 100))
      throw new BadRequestException('Too many channels')
    const results = await Promise.all(channels.map(async channel => [channel, await this.authorize(ctx, channel)] as const))
    const id = crypto.randomUUID()
    const encoder = new TextEncoder()
    const heartbeat = parseDuration(this.config.heartbeat ?? 25) * 1000
    let handle: BroadcastConnection | undefined
    let timer: ReturnType<typeof setInterval> | undefined
    let closed = false
    const close = (): void => {
      if (closed)
        return
      closed = true
      clearInterval(timer)
      void handle?.close()
    }
    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const write = (text: string): void => {
          if (closed)
            return
          try {
            controller.enqueue(encoder.encode(text))
          }
          catch {
            close()
          }
        }
        const send = (envelope: BroadcastEnvelope): void => write(`data: ${JSON.stringify(envelope)}\n\n`)
        handle = this.connect({ id, transport: 'sse', send })
        send({
          event: 'haze:connected',
          data: { socket_id: id },
        })
        for (const [channel, authorized] of results)
          send(subscribeEnvelope(channel, await handle.subscribe({ channel, authorized })))
        timer = setInterval(write, heartbeat, ': ping\n\n')
      },
      cancel: close,
    })
    ctx.req.signal?.addEventListener('abort', close, { once: true })
    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        // 关闭 Nginx 的响应缓冲
        'x-accel-buffering': 'no',
      },
    })
  }

  /**
   * WebSocket（/broadcasting/ws）。客户端消息：
   * `{ event: 'subscribe', channel, auth?, channel_data? }`、`{ event: 'unsubscribe', channel }`、
   * `{ event: 'whisper', channel, name, data }`、`{ event: 'ping' }`
   */
  #webSocket(): ReturnType<typeof defineWebSocket> {
    const handles = new WeakMap<Peer, BroadcastConnection>()
    const send = (peer: Peer, envelope: BroadcastEnvelope): void => {
      peer.send(JSON.stringify(envelope))
    }
    return defineWebSocket({
      open: (peer, ctx) => {
        // 升级请求结束后请求容器已释放：保存请求头，订阅时按需重建上下文授权
        const url = ctx.url.href
        const headers = new Headers(ctx.req.headers)
        handles.set(peer, this.connect({
          id: peer.id,
          transport: 'ws',
          send: envelope => send(peer, envelope),
        }, {
          request: () => new Request(url, { headers }),
        }))
        send(peer, {
          event: 'haze:connected',
          data: { socket_id: peer.id },
        })
      },
      message: async (peer, message) => {
        const handle = handles.get(peer)
        let input: Record<string, unknown>
        try {
          input = message.json<Record<string, unknown>>()
        }
        catch {
          return
        }
        if (!handle || typeof input !== 'object' || input === null)
          return
        const channel = String(input.channel ?? '')
        switch (input.event) {
          case 'subscribe':
            send(peer, subscribeEnvelope(channel, await handle.subscribe({
              channel,
              auth: typeof input.auth === 'string'
                ? input.auth
                : undefined,
              channelData: typeof input.channel_data === 'string'
                ? input.channel_data
                : undefined,
            })))
            break
          case 'unsubscribe':
            await handle.unsubscribe(channel)
            break
          case 'whisper':
            await handle.whisper(channel, String(input.name ?? ''), input.data)
            break
          case 'ping':
            send(peer, { event: 'haze:pong' })
            break
        }
      },
      close: async (peer) => {
        await handles.get(peer)?.close()
        handles.delete(peer)
      },
    })
  }
}

function signedValue(socketId: string, channel: string, channelData?: string): string {
  return channelData === undefined
    ? `${socketId}:${channel}`
    : `${socketId}:${channel}:${channelData}`
}

/** 订阅结果对应的客户端消息 */
export function subscribeEnvelope(channel: string, result: SubscribeResult): BroadcastEnvelope {
  return result.ok
    ? {
        event: 'haze:subscribed',
        channel,
        data: result.members
          ? { members: result.members }
          : {},
      }
    : {
        event: 'haze:subscription_error',
        channel,
        data: { status: result.status, message: result.message },
      }
}

/** 按频道的 guards（任一通过）或默认 Guard 取用户；未配置认证时视为未登录 */
async function resolveUser(ctx: HttpContext, guards: string | string[] | undefined): Promise<{ user: unknown, id: string | number | undefined } | undefined> {
  const names = guards === undefined
    ? [undefined]
    : [guards].flat()
  for (const name of names) {
    try {
      const guard = ctx.auth.guard(name)
      const user = await guard.user()
      if (user !== undefined) {
        ctx.auth.shouldUse(guard.name)
        return { user, id: await guard.id() }
      }
    }
    catch {}
  }
  return undefined
}
