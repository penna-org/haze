import type { Application, ConfigInput, ServerExtension, ServiceProvider } from '@hazejs/core'
import type { Namespace, Server, ServerOptions, Socket } from 'socket.io'
import { BroadcastManager, createToken, definePersistent, registerServerExtension, subscribeEnvelope, unregisterServerExtension } from '@hazejs/core'

export type { Namespace, Server, Socket }

const kNamespace = Symbol.for('hazejs.socket.namespace')

export interface SocketIOConfig {
  /** 路径，默认 `/socket.io/`（与 socket.io-client 的默认值一致） */
  path?: string
  /** CORS，默认沿用 config/cors.ts 的 origin；false 关闭（同源） */
  cors?: ServerOptions['cors'] | false
  /** 多实例：官方 @socket.io/redis-adapter（需要 ioredis） */
  adapter?: { driver: 'redis', url?: string, key?: string }
  /** 透传给 socket.io Server 的其它选项（pingInterval、connectionStateRecovery 等） */
  options?: Partial<ServerOptions>
  /**
   * 广播（Broadcasting）的 Socket.IO 传输：true 或 `{ namespace }`（默认 `/broadcasting`）。
   * 前端 `createEcho({ transport: 'socket.io', io })` 连接；频道授权与 WebSocket / SSE 相同。
   */
  broadcasting?: boolean | { namespace?: string }
}

/** `config/socketio.ts` 的默认导出 */
export function defineSocketIOConfig(config: SocketIOConfig | (() => SocketIOConfig)): ConfigInput<SocketIOConfig> {
  return config
}

export type SocketMiddleware = (socket: Socket, next: (error?: Error) => void) => unknown

export interface NamespaceDefinition {
  readonly [kNamespace]: true
  /** 命名空间，默认由文件名决定：index → `/`，chat → `/chat` */
  readonly name?: string
  readonly middleware: SocketMiddleware[]
  readonly connection: (socket: Socket, io: Server, namespace: Namespace) => unknown
}

/**
 * 定义命名空间（app/socket/*.ts 的默认导出，自动注册）：
 *
 * ```ts
 * export default defineNamespace({
 *   middleware: [authenticate()],
 *   connection(socket, io) {
 *     socket.on('chat:send', (text, ack) => { io.of('/chat').emit('chat:message', text); ack?.('ok') })
 *   },
 * })
 * ```
 */
export function defineNamespace(definition: { name?: string, middleware?: SocketMiddleware[], connection: NamespaceDefinition['connection'] }): NamespaceDefinition {
  return { [kNamespace]: true, middleware: [], ...definition }
}

export function isNamespace(value: unknown): value is NamespaceDefinition {
  return typeof value === 'object' && value !== null && kNamespace in value
}

/** 注入令牌：`inject(SocketIOServer)` 取得 socket.io 的 Server */
export const SocketIOServer = createToken<Server>('socket.io')

interface State {
  io: Server | undefined
  starting: Promise<Server> | undefined
  app: Application | undefined
  /** 命名空间 → 当前（最新应用的）定义 */
  definitions: Map<string, NamespaceDefinition>
  wired: Set<string>
  close: Array<() => Promise<unknown> | unknown>
}

function state(): State {
  return definePersistent<State>('socket.io', () => ({
    io: undefined,
    starting: undefined,
    app: undefined,
    definitions: new Map(),
    wired: new Set(),
    close: [],
  }), {
    dispose: async (value) => {
      await closeServer(value.io)
      for (const close of value.close.splice(0))
        await close()
      value.io = undefined
      value.starting = undefined
      value.wired.clear()
    },
  })
}

/** 关闭 socket.io：未挂到任何 HTTP 服务器（如测试中）时 io.close() 会抛错，只断开连接 */
async function closeServer(io: Server | undefined): Promise<void> {
  if (!io)
    return
  if (!(io as unknown as { engine?: unknown }).engine) {
    io.disconnectSockets(true)
    return
  }
  await new Promise<void>((resolve) => {
    io.close(() => resolve()).catch(() => resolve())
  })
}

function namespaceName(file: string | undefined, definition: NamespaceDefinition): string {
  if (definition.name) {
    return definition.name.startsWith('/')
      ? definition.name
      : `/${definition.name}`
  }
  if (!file || file === 'index')
    return '/'
  return `/${file.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`
}

/** 按顺序执行中间件链 */
function runMiddleware(middleware: SocketMiddleware[], socket: Socket, done: (error?: Error) => void): void {
  let index = 0
  const next = (error?: Error): void => {
    if (error || index >= middleware.length)
      return done(error)
    const current = middleware[index++]
    Promise.resolve(current(socket, next)).catch(next)
  }
  next()
}

function isWorkers(): boolean {
  return typeof navigator !== 'undefined' && navigator.userAgent === 'Cloudflare-Workers'
}

async function createServer(app: Application, current: State): Promise<Server> {
  const config = app.config.get<SocketIOConfig>('socketio', {})
  const { Server } = await import('socket.io')
  const path = config.path ?? '/socket.io/'
  const cors = config.cors === false
    ? undefined
    : config.cors ?? { origin: app.config.get<unknown>('cors.origin', undefined) as never ?? true, credentials: true }
  const io = new Server({
    path,
    serveClient: false,
    // 不销毁未处理的升级请求：同一个 http 服务器上还有 r.ws() 与 Vite 的 HMR
    destroyUpgrade: false,
    ...(cors && { cors }),
    ...config.options,
  })
  if (config.adapter?.driver === 'redis') {
    const [{ createAdapter }, ioredis] = await Promise.all([import('@socket.io/redis-adapter'), import('ioredis')])
    const Redis = (ioredis as unknown as { Redis?: new (url: string) => any }).Redis ?? (ioredis as unknown as { default: new (url: string) => any }).default
    const pub = new Redis(config.adapter.url ?? 'redis://127.0.0.1:6379')
    const sub = pub.duplicate()
    io.adapter(createAdapter(pub, sub, { key: config.adapter.key ?? 'socket.io' }))
    current.close.push(() => pub.quit(), () => sub.quit())
  }

  const prefix = path.replace(/\/$/, '')
  const extension = {
    name: 'socket.io',
    matches: (pathname: string) => pathname === prefix || pathname.startsWith(`${prefix}/`),
    // Node：engine.io 挂到框架创建的 http 服务器（产物、haze dev、Vite 开发服务器）
    node: (server: import('node:http').Server) => void io.attach(server),
  }
  const runtime = globalThis as { Bun?: unknown }
  if (runtime.Bun) {
    // Bun：官方 Bun 引擎，长轮询与 WebSocket 都在 Bun.serve 中处理
    const { Server: Engine } = await import('@socket.io/bun-engine')
    const engine = new Engine({
      path,
      ...(cors && { cors: cors as never }),
    })
    io.bind(engine as never)
    const handler = engine.handler()
    const registered: ServerExtension = {
      ...extension,
      bun: {
        handle: (request, server) => engine.handleRequest(request, server as never),
        owns: ws => typeof ws.data === 'object' && ws.data !== null && 'transport' in ws.data,
        websocket: handler.websocket as never,
        idleTimeout: handler.idleTimeout,
      },
    }
    registerServerExtension(registered)
    current.close.push(() => unregisterServerExtension('socket.io', registered))
  }
  else {
    registerServerExtension(extension)
    // 实例关闭时从 HTTP 服务器卸载（Vite 重启、测试中重建应用）
    current.close.push(() => unregisterServerExtension('socket.io', extension))
  }
  return io
}

/**
 * Socket.IO 服务提供者（app/provider/SocketProvider.ts：`export default socketIoProvider()`）：
 * 创建 socket.io Server（跨热更新保留），注册 app/socket 下的命名空间，挂到框架的 HTTP 服务器。
 * 新连接总是使用最新的命名空间定义；Edge / Serverless 运行时上不启动。
 */
export function socketIoProvider(): ServiceProvider {
  return {
    async register(container, app) {
      if (isWorkers()) {
        app.logger.warn('socket.io is not supported on Cloudflare Workers (use r.ws() with Durable Objects); socketIoProvider() is skipped')
        return
      }
      const current = state()
      current.app = app
      current.starting ??= createServer(app, current).then(io => (current.io = io))
      const io = await current.starting
      container.instance(SocketIOServer, io)

      for (const [file, definition] of app.discovered<unknown>('sockets')) {
        if (!isNamespace(definition))
          throw new TypeError('app/socket/*.ts must export default defineNamespace(...)')
        const name = namespaceName(file, definition)
        current.definitions.set(name, definition)
        if (current.wired.has(name))
          continue
        current.wired.add(name)
        const namespace = io.of(name)
        // 只挂一次，每次从 definitions 取最新定义（热替换后新连接使用新代码）
        namespace.use((socket, next) => runMiddleware(current.definitions.get(name)?.middleware ?? [], socket, next))
        namespace.on('connection', (socket) => {
          Promise.resolve(current.definitions.get(name)?.connection(socket, io, namespace)).catch((error) => {
            current.app?.logger.error(`socket.io ${name} connection handler failed`, error)
          })
        })
      }

      const broadcasting = app.config.get<SocketIOConfig['broadcasting']>('socketio.broadcasting', undefined)
      if (broadcasting) {
        const name = typeof broadcasting === 'object' && broadcasting.namespace
          ? broadcasting.namespace
          : '/broadcasting'
        if (!current.wired.has(`broadcasting:${name}`)) {
          current.wired.add(`broadcasting:${name}`)
          wireBroadcasting(io.of(name), current)
        }
      }
    },
  }
}

/**
 * 广播命名空间：每个 socket 接入 BroadcastManager（订阅时加入同名房间）。
 * 客户端事件：`subscribe`（{ channel, auth?, channel_data? }，ack 返回订阅结果）、`unsubscribe`、`whisper`；
 * 服务端推送 `broadcast` 事件（与 WebSocket / SSE 相同的消息格式）。
 * 投递经广播总线（config/broadcasting.ts 的 bus），多实例请配置 Redis 总线。
 */
function wireBroadcasting(namespace: Namespace, current: State): void {
  namespace.on('connection', (socket) => {
    const app = current.app
    if (!app?.container.has(BroadcastManager)) {
      socket.disconnect(true)
      return
    }
    // 没有签名时按握手请求（Cookie / auth.token）直接授权
    const request = handshakeRequest(socket)
    const handle = app.make(BroadcastManager).connect({
      id: socket.id,
      transport: 'socket.io',
      send: envelope => socket.emit('broadcast', envelope),
    }, {
      request: () => request,
    })
    const input = (value: unknown): Record<string, unknown> => typeof value === 'object' && value !== null
      ? value as Record<string, unknown>
      : {}
    socket.on('subscribe', async (raw: unknown, ack?: (envelope: unknown) => void) => {
      const { channel, auth, channel_data } = input(raw)
      const name = String(channel ?? '')
      const result = await handle.subscribe({
        channel: name,
        auth: typeof auth === 'string'
          ? auth
          : undefined,
        channelData: typeof channel_data === 'string'
          ? channel_data
          : undefined,
      })
      if (result.ok)
        await socket.join(name)
      const envelope = subscribeEnvelope(name, result)
      if (typeof ack === 'function')
        ack(envelope)
      else
        socket.emit('broadcast', envelope)
    })
    socket.on('unsubscribe', async (raw: unknown) => {
      const name = String(input(raw).channel ?? '')
      await handle.unsubscribe(name)
      await socket.leave(name)
    })
    socket.on('whisper', async (raw: unknown) => {
      const { channel, name, data } = input(raw)
      await handle.whisper(String(channel ?? ''), String(name ?? ''), data)
    })
    socket.on('disconnect', () => {
      handle.close().catch(error => current.app?.logger.error('socket.io broadcasting disconnect failed', error))
    })
  })
}

/** 由握手信息构造 Request：请求头（含 Cookie），`auth.token` 作为 Bearer 令牌 */
function handshakeRequest(socket: Socket): Request {
  const { headers, url, auth } = socket.handshake
  const requestHeaders = new Headers()
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      requestHeaders.set(key, Array.isArray(value)
        ? value.join(', ')
        : String(value))
    }
  }
  if (typeof auth?.token === 'string')
    requestHeaders.set('authorization', `Bearer ${auth.token}`)
  // Node 的握手 url 为路径，Bun 引擎为完整 URL
  const target = /^https?:\/\//.test(url)
    ? url
    : `http://${headers.host ?? 'localhost'}${url}`
  return new Request(target, { headers: requestHeaders })
}

/**
 * 握手鉴权：按 config/auth.ts 的 Guard 识别用户，存入 `socket.data.user`。
 * 令牌取 `io({ auth: { token } })` 或 Authorization 头；Session Guard 读握手请求的 Cookie。
 * 未登录时拒绝连接，客户端收到 connect_error（message 为 unauthorized）。
 */
export function authenticate(options: { guard?: string, optional?: boolean } = {}): SocketMiddleware {
  return async (socket, next) => {
    const app = state().app
    if (!app)
      return next(new Error('socket.io is not configured'))
    const ctx = app.contextFor(handshakeRequest(socket))
    const user = await ctx.auth.guard(options.guard).user().catch(() => undefined)
    if (user === undefined && !options.optional) {
      return next(Object.assign(new Error('unauthorized'), {
        data: { code: 401 },
      }))
    }
    socket.data.user = user
    next()
  }
}

function server(): Server {
  const io = state().io
  if (!io)
    throw new Error('socket.io is not running: add socketIoProvider() in app/provider')
  return io
}

/**
 * 服务端推送（HTTP 接口、任务、事件监听器中）：
 *
 * ```ts
 * SocketIO.to(`user:${id}`).emit('notice', data)
 * SocketIO.of('/chat').emit('chat:message', text)
 * ```
 */
export interface SocketIOFacade {
  readonly server: Server
  emit: (event: string, ...args: unknown[]) => boolean
  to: (room: string | string[]) => ReturnType<Server['to']>
  except: (room: string | string[]) => ReturnType<Server['except']>
  of: (namespace: string) => Namespace
}

export const SocketIO: SocketIOFacade = {
  get server(): Server {
    return server()
  },
  emit: (event, ...args) => server().emit(event, ...args),
  to: room => server().to(room),
  except: room => server().except(room),
  of: namespace => server().of(namespace),
}

/** 测试中释放（通常随 app.dispose() 自动释放） */
export async function closeSocketIO(): Promise<void> {
  const current = state()
  await closeServer(current.io)
  current.io = undefined
  current.starting = undefined
  current.wired.clear()
}
