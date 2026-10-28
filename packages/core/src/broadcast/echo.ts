/**
 * 广播的前端客户端（`@hazejs/core/echo`）：零依赖，API 与 Laravel Echo 相近。
 *
 * ```ts
 * import { createEcho } from '@hazejs/core/echo'
 *
 * const echo = createEcho({ transport: 'ws' })   // 'ws' | 'sse' | 'socket.io'
 * echo.private('orders.1').listen('OrderShipped', order => console.log(order))
 * echo.join('chat.lobby').here(members => ...).joining(member => ...).leaving(member => ...)
 * ```
 *
 * 私有 / 在线频道：ws 与 socket.io 先请求 `POST /broadcasting/auth` 取得签名再订阅；
 * sse 在连接请求中直接授权（请求可带自定义请求头，例如 Authorization）。
 */

export type EchoTransport = 'ws' | 'sse' | 'socket.io'

export interface EchoEnvelope {
  event: string
  channel?: string
  data?: any
}

export type EchoHeaders = Record<string, string>

/** socket.io-client 的 Socket（只用到的部分） */
export interface EchoSocketIOSocket {
  id?: string
  connected: boolean
  on: (event: string, listener: (...args: any[]) => void) => unknown
  emit: (event: string, ...args: any[]) => unknown
  disconnect: () => unknown
}

export interface EchoOptions {
  /** 传输方式，默认 ws */
  transport?: EchoTransport
  /** 服务端地址，默认当前页面的 origin */
  url?: string
  /** 内置接口的前缀，默认 `/broadcasting` */
  path?: string
  /** 授权接口，默认 `<path>/auth` */
  authEndpoint?: string
  /** 授权请求与 SSE 请求附带的请求头（如 Authorization），可以是函数（每次请求时读取） */
  headers?: EchoHeaders | (() => EchoHeaders | Promise<EchoHeaders>)
  /** fetch 的 credentials，默认 same-origin（跨域携带 Cookie 时设为 include） */
  credentials?: 'omit' | 'same-origin' | 'include'
  /** 断线自动重连，默认 true */
  reconnect?: boolean
  /** socket.io：传入 socket.io-client 的 `io` 函数 */
  io?: (url: string, options?: Record<string, unknown>) => EchoSocketIOSocket
  /** socket.io：命名空间，默认 `/broadcasting` */
  namespace?: string
  /** socket.io：透传给 io() 的选项（path、auth、transports 等） */
  ioOptions?: Record<string, unknown>
  /** 自定义 WebSocket 构造函数（非浏览器环境） */
  WebSocket?: typeof WebSocket
  /** 自定义 fetch */
  fetch?: typeof fetch
}

type Callback = (data: any, envelope: EchoEnvelope) => void

/** 一个频道的订阅：listen / stopListening / whisper 等 */
export class EchoChannel {
  readonly #listeners = new Map<string, Set<Callback>>()
  readonly #subscribed = new Set<() => void>()
  readonly #errors = new Set<(error: { status: number, message: string }) => void>()

  constructor(protected readonly echo: Echo, readonly name: string) {}

  /** 监听事件（事件名可带前导 `.`，与 Laravel Echo 兼容） */
  listen(event: string, callback: Callback): this {
    const name = normalizeEvent(event)
    let set = this.#listeners.get(name)
    if (!set)
      this.#listeners.set(name, set = new Set())
    set.add(callback)
    return this
  }

  stopListening(event: string, callback?: Callback): this {
    const name = normalizeEvent(event)
    if (callback)
      this.#listeners.get(name)?.delete(callback)
    else
      this.#listeners.delete(name)
    return this
  }

  /** 通知（Notification 的 broadcast 渠道）：事件名为 `notification` */
  notification(callback: Callback): this {
    return this.listen('notification', callback)
  }

  /** 客户端事件：发给同一频道的其他连接（仅私有 / 在线频道，sse 不支持） */
  whisper(name: string, data: unknown): this {
    this.echo.connector.whisper(this.name, name, data)
    return this
  }

  listenForWhisper(name: string, callback: Callback): this {
    return this.listen(`client-${name}`, callback)
  }

  stopListeningForWhisper(name: string, callback?: Callback): this {
    return this.stopListening(`client-${name}`, callback)
  }

  /** 订阅成功（每次重新连接后都会触发） */
  subscribed(callback: () => void): this {
    this.#subscribed.add(callback)
    return this
  }

  /** 订阅失败（如 403） */
  error(callback: (error: { status: number, message: string }) => void): this {
    this.#errors.add(callback)
    return this
  }

  /** @internal */
  handle(envelope: EchoEnvelope): void {
    switch (envelope.event) {
      case 'haze:subscribed':
        this.onSubscribed(envelope.data?.members)
        this.#subscribed.forEach(callback => callback())
        return
      case 'haze:subscription_error':
        this.#errors.forEach(callback => callback(envelope.data ?? { status: 0, message: 'Subscription failed' }))
        return
    }
    this.onEvent(envelope)
    this.#listeners.get(envelope.event)?.forEach(callback => callback(envelope.data, envelope))
  }

  protected onSubscribed(_members: unknown[] | undefined): void {}
  protected onEvent(_envelope: EchoEnvelope): void {}
}

export type PresenceMember = Record<string, any> & { id: string | number }

/** 在线频道：here / joining / leaving */
export class EchoPresenceChannel extends EchoChannel {
  #members: PresenceMember[] = []
  readonly #here = new Set<(members: PresenceMember[]) => void>()
  readonly #joining = new Set<(member: PresenceMember) => void>()
  readonly #leaving = new Set<(member: PresenceMember) => void>()

  /** 当前成员列表（订阅成功时，以及每次重新连接后） */
  here(callback: (members: PresenceMember[]) => void): this {
    this.#here.add(callback)
    return this
  }

  joining(callback: (member: PresenceMember) => void): this {
    this.#joining.add(callback)
    return this
  }

  leaving(callback: (member: PresenceMember) => void): this {
    this.#leaving.add(callback)
    return this
  }

  get members(): PresenceMember[] {
    return [...this.#members]
  }

  protected override onSubscribed(members: unknown[] | undefined): void {
    this.#members = (members ?? []) as PresenceMember[]
    this.#here.forEach(callback => callback(this.members))
  }

  protected override onEvent(envelope: EchoEnvelope): void {
    const member = envelope.data as PresenceMember
    if (envelope.event === 'haze:member_added') {
      this.#members = [
        ...this.#members.filter(item => String(item.id) !== String(member.id)),
        member,
      ]
      this.#joining.forEach(callback => callback(member))
    }
    else if (envelope.event === 'haze:member_removed') {
      this.#members = this.#members.filter(item => String(item.id) !== String(member.id))
      this.#leaving.forEach(callback => callback(member))
    }
  }
}

/** 传输层 */
export interface EchoConnector {
  subscribe: (channel: string) => void
  unsubscribe: (channel: string) => void
  whisper: (channel: string, name: string, data: unknown) => void
  socketId: () => string | undefined
  disconnect: () => void
}

export class Echo {
  readonly options: Required<Pick<EchoOptions, 'transport' | 'path' | 'reconnect'>> & EchoOptions
  readonly connector: EchoConnector
  readonly #channels = new Map<string, EchoChannel>()
  #socketId: string | undefined
  readonly #connected = new Set<(socketId: string) => void>()

  constructor(options: EchoOptions = {}) {
    this.options = {
      transport: 'ws',
      path: '/broadcasting',
      reconnect: true,
      ...options,
    }
    switch (this.options.transport) {
      case 'sse':
        this.connector = new SseConnector(this)
        break
      case 'socket.io':
        this.connector = new SocketIOConnector(this)
        break
      default:
        this.connector = new WebSocketConnector(this)
    }
  }

  /** 公共频道 */
  channel(name: string): EchoChannel {
    return this.#subscribe(name, () => new EchoChannel(this, name))
  }

  /** 私有频道：`private-<name>` */
  private(name: string): EchoChannel {
    const channel = `private-${name}`
    return this.#subscribe(channel, () => new EchoChannel(this, channel))
  }

  /** 在线频道：`presence-<name>` */
  join(name: string): EchoPresenceChannel {
    const channel = `presence-${name}`
    return this.#subscribe(channel, () => new EchoPresenceChannel(this, channel)) as EchoPresenceChannel
  }

  /** join() 的别名 */
  presence(name: string): EchoPresenceChannel {
    return this.join(name)
  }

  /** 退出频道（同名的公共、私有、在线频道都退出） */
  leave(name: string): void {
    for (const channel of [name, `private-${name}`, `presence-${name}`])
      this.leaveChannel(channel)
  }

  /** 按完整名称退出频道 */
  leaveChannel(channel: string): void {
    if (this.#channels.delete(channel))
      this.connector.unsubscribe(channel)
  }

  /** 当前连接的 socket_id：放在自己的请求头 X-Socket-ID 中，服务端的 toOthers 广播会跳过本连接 */
  socketId(): string | undefined {
    return this.#socketId
  }

  /** 连接建立（含重新连接）时回调 */
  connected(callback: (socketId: string) => void): this {
    this.#connected.add(callback)
    return this
  }

  disconnect(): void {
    this.connector.disconnect()
    this.#channels.clear()
  }

  /** @internal */
  channelNames(): string[] {
    return [
      ...this.#channels.keys(),
    ]
  }

  /** @internal */
  dispatch(envelope: EchoEnvelope): void {
    if (envelope.event === 'haze:connected') {
      this.#socketId = envelope.data?.socket_id
      this.#connected.forEach(callback => callback(this.#socketId!))
      return
    }
    if (envelope.channel)
      this.#channels.get(envelope.channel)?.handle(envelope)
  }

  /** @internal */
  async authorize(socketId: string, channel: string): Promise<{ auth: string, channel_data?: string }> {
    const fetcher = this.options.fetch ?? globalThis.fetch
    const headers: EchoHeaders = {
      'content-type': 'application/json',
      'accept': 'application/json',
      'x-socket-id': socketId,
      ...await this.headers(),
    }
    // 与 config/csrf 配合：带上 XSRF-TOKEN Cookie 中的令牌
    const xsrf = readCookie('XSRF-TOKEN')
    if (xsrf && !Object.keys(headers).some(key => key.toLowerCase() === 'x-xsrf-token'))
      headers['x-xsrf-token'] = xsrf
    const response = await fetcher(this.options.authEndpoint ?? this.url(`${this.options.path}/auth`), {
      method: 'POST',
      headers,
      credentials: this.options.credentials ?? 'same-origin',
      body: JSON.stringify({ socket_id: socketId, channel_name: channel }),
    })
    if (!response.ok)
      throw Object.assign(new Error(`Authorization failed for ${channel}`), { status: response.status })
    return response.json() as Promise<{ auth: string, channel_data?: string }>
  }

  /** @internal */
  async headers(): Promise<EchoHeaders> {
    const headers = this.options.headers
    return typeof headers === 'function'
      ? await headers()
      : headers ?? {}
  }

  /** @internal */
  url(path: string): string {
    const base = this.options.url ?? (globalThis as { location?: { origin: string } }).location?.origin ?? ''
    return `${base.replace(/\/$/, '')}${path}`
  }

  #subscribe(name: string, create: () => EchoChannel): EchoChannel {
    let channel = this.#channels.get(name)
    if (!channel) {
      channel = create()
      this.#channels.set(name, channel)
      this.connector.subscribe(name)
    }
    return channel
  }
}

/** 创建客户端 */
export function createEcho(options: EchoOptions = {}): Echo {
  return new Echo(options)
}

function normalizeEvent(event: string): string {
  return event.startsWith('.')
    ? event.slice(1)
    : event
}

function readCookie(name: string): string | undefined {
  const cookie = (globalThis as { document?: { cookie?: string } }).document?.cookie
  const match = cookie?.split('; ').find(item => item.startsWith(`${name}=`))
  return match
    ? decodeURIComponent(match.slice(name.length + 1))
    : undefined
}

const needsAuth = (channel: string): boolean => channel.startsWith('private-') || channel.startsWith('presence-')

/** 断线重连的等待时间：1s、2s、4s……最多 30s */
function backoff(attempt: number): number {
  return Math.min(30_000, 1000 * 2 ** attempt)
}

/** 订阅失败时转为 subscription_error */
function authError(channel: string, error: unknown): EchoEnvelope {
  return {
    event: 'haze:subscription_error',
    channel,
    data: {
      status: (error as { status?: number }).status ?? 0,
      message: error instanceof Error
        ? error.message
        : String(error),
    },
  }
}

class WebSocketConnector implements EchoConnector {
  #socket: WebSocket | undefined
  #socketId: string | undefined
  #attempt = 0
  #closed = false
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly echo: Echo) {
    this.#connect()
  }

  socketId(): string | undefined {
    return this.#socketId
  }

  subscribe(channel: string): void {
    if (this.#socketId)
      void this.#join(channel, this.#socketId)
  }

  unsubscribe(channel: string): void {
    this.#send({ event: 'unsubscribe', channel })
  }

  whisper(channel: string, name: string, data: unknown): void {
    this.#send({
      event: 'whisper',
      channel,
      name,
      data,
    })
  }

  disconnect(): void {
    this.#closed = true
    clearTimeout(this.#timer)
    this.#socket?.close()
  }

  #connect(): void {
    const Ctor = this.echo.options.WebSocket ?? globalThis.WebSocket
    const socket = new Ctor(this.echo.url(`${this.echo.options.path}/ws`).replace(/^http/, 'ws'))
    this.#socket = socket
    socket.addEventListener('message', (event) => {
      let envelope: EchoEnvelope
      try {
        envelope = JSON.parse(String(event.data))
      }
      catch {
        return
      }
      if (envelope.event === 'haze:connected') {
        this.#attempt = 0
        this.#socketId = envelope.data?.socket_id
        this.echo.dispatch(envelope)
        for (const channel of this.echo.channelNames())
          void this.#join(channel, this.#socketId!)
        return
      }
      this.echo.dispatch(envelope)
    })
    socket.addEventListener('close', () => {
      this.#socketId = undefined
      if (this.#closed || !this.echo.options.reconnect)
        return
      this.#timer = setTimeout(() => this.#connect(), backoff(this.#attempt++))
    })
  }

  async #join(channel: string, socketId: string): Promise<void> {
    if (!needsAuth(channel))
      return this.#send({ event: 'subscribe', channel })
    try {
      const { auth, channel_data } = await this.echo.authorize(socketId, channel)
      // 授权期间连接已更换：由新连接重新订阅
      if (this.#socketId === socketId) {
        this.#send({
          event: 'subscribe',
          channel,
          auth,
          channel_data,
        })
      }
    }
    catch (error) {
      this.echo.dispatch(authError(channel, error))
    }
  }

  #send(message: Record<string, unknown>): void {
    if (this.#socket?.readyState === 1)
      this.#socket.send(JSON.stringify(message))
  }
}

class SseConnector implements EchoConnector {
  /** 最新的连接 */
  #current: AbortController | undefined
  /** 所有未关闭的连接（新连接就绪后关闭其余的） */
  readonly #streams = new Set<AbortController>()
  #socketId: string | undefined
  #scheduled = false
  #closed = false
  #attempt = 0
  #timer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly echo: Echo) {}

  socketId(): string | undefined {
    return this.#socketId
  }

  subscribe(): void {
    this.#schedule()
  }

  unsubscribe(): void {
    this.#schedule()
  }

  whisper(): void {
    throw new Error('whisper() is not supported by the sse transport; use ws or socket.io')
  }

  disconnect(): void {
    this.#closed = true
    clearTimeout(this.#timer)
    this.#abortExcept()
    this.#current = undefined
  }

  #abortExcept(keep?: AbortController): void {
    for (const stream of this.#streams) {
      if (stream !== keep) {
        stream.abort()
        this.#streams.delete(stream)
      }
    }
  }

  /** 订阅变化后重新连接（同一轮的多次变化合并为一次）；新连接建立后才断开旧连接 */
  #schedule(): void {
    if (this.#scheduled || this.#closed)
      return
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      void this.#open()
    })
  }

  async #open(): Promise<void> {
    clearTimeout(this.#timer)
    const channels = this.echo.channelNames()
    if (!channels.length) {
      this.#abortExcept()
      this.#current = undefined
      return
    }
    const controller = new AbortController()
    this.#current = controller
    this.#streams.add(controller)
    try {
      const fetcher = this.echo.options.fetch ?? globalThis.fetch
      const response = await fetcher(this.echo.url(`${this.echo.options.path}/sse?channels=${encodeURIComponent(channels.join(','))}`), {
        headers: {
          accept: 'text/event-stream',
          ...await this.echo.headers(),
        },
        credentials: this.echo.options.credentials ?? 'same-origin',
        signal: controller.signal,
      })
      if (!response.ok || !response.body)
        throw Object.assign(new Error(`SSE connection failed (${response.status})`), { status: response.status })
      const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
      let buffer = ''
      while (true) {
        const { value, done } = await reader.read()
        if (done)
          break
        buffer += value
        let index = buffer.indexOf('\n\n')
        while (index !== -1) {
          const frame = buffer.slice(0, index)
          buffer = buffer.slice(index + 2)
          index = buffer.indexOf('\n\n')
          const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
          if (!data)
            continue
          const envelope = JSON.parse(data) as EchoEnvelope
          if (envelope.event === 'haze:connected') {
            this.#attempt = 0
            this.#socketId = envelope.data?.socket_id
            this.#abortExcept(controller)
          }
          this.echo.dispatch(envelope)
        }
      }
    }
    catch (error) {
      if (controller.signal.aborted)
        return
      if ((error as { status?: number }).status === 401 || (error as { status?: number }).status === 403) {
        this.#streams.delete(controller)
        for (const channel of channels)
          this.echo.dispatch(authError(channel, error))
        return
      }
    }
    this.#streams.delete(controller)
    // 服务端关闭或网络错误：当前连接仍是最新的才重连
    if (this.#current === controller && !this.#closed && this.echo.options.reconnect)
      this.#timer = setTimeout(() => void this.#open(), backoff(this.#attempt++))
  }
}

class SocketIOConnector implements EchoConnector {
  readonly #socket: EchoSocketIOSocket

  constructor(private readonly echo: Echo) {
    const io = echo.options.io
    if (!io)
      throw new Error('The socket.io transport needs the io function: createEcho({ transport: \'socket.io\', io })')
    this.#socket = io(echo.url(echo.options.namespace ?? '/broadcasting'), {
      withCredentials: echo.options.credentials === 'include',
      reconnection: echo.options.reconnect,
      ...echo.options.ioOptions,
    })
    this.#socket.on('connect', () => {
      echo.dispatch({
        event: 'haze:connected',
        data: { socket_id: this.#socket.id },
      })
      for (const channel of echo.channelNames())
        void this.#join(channel)
    })
    this.#socket.on('broadcast', (envelope: EchoEnvelope) => echo.dispatch(envelope))
  }

  socketId(): string | undefined {
    return this.#socket.id
  }

  subscribe(channel: string): void {
    if (this.#socket.connected)
      void this.#join(channel)
  }

  unsubscribe(channel: string): void {
    this.#socket.emit('unsubscribe', { channel })
  }

  whisper(channel: string, name: string, data: unknown): void {
    this.#socket.emit('whisper', { channel, name, data })
  }

  disconnect(): void {
    this.#socket.disconnect()
  }

  async #join(channel: string): Promise<void> {
    const socketId = this.#socket.id!
    let auth: { auth?: string, channel_data?: string } = {}
    if (needsAuth(channel)) {
      try {
        auth = await this.echo.authorize(socketId, channel)
      }
      catch (error) {
        this.echo.dispatch(authError(channel, error))
        return
      }
    }
    this.#socket.emit('subscribe', { channel, ...auth }, (envelope: EchoEnvelope) => this.echo.dispatch(envelope))
  }
}
