import type { H3Event } from 'h3'
import type { AppMatcher, SubAppConfig, SubAppModules } from './apps'
import type { ConfigInput, ConfigPath, ConfigPathValue } from './config/config'
import type { InjectionKey } from './container/token'
import type { Interceptor } from './http/interceptor'
import type { StaticOptions } from './http/static'
import type { LangInput } from './i18n/manager'
import type { MiddlewareConfig } from './middleware/types'
import type { ProviderInput, ServiceProvider } from './provider'
import type { RouteModule, RouteRegistrar } from './routing/builder'
import type { RouteMeta } from './routing/route'
import type { Constructor, MaybePromise, ModuleRecord } from './utils'
import process from 'node:process'
import { H3, mockEvent, serve, toResponse } from 'h3'
import { assertNoConflicts, groupAppModules, matchApp, normalizeAppConfig } from './apps'
import { Gate } from './auth/gate'
import { setBroadcastManager } from './broadcast/broadcast'
import { BroadcastManager } from './broadcast/manager'
import { CacheManager, setCacheManager } from './cache/manager'
import { Config, defaultConfig, resolveConfigInput } from './config/config'
import { loadEnv } from './config/env'
import { Container } from './container/container'
import { setEventManager } from './events/context'
import { EventManager } from './events/manager'
import { NotFoundException } from './exception/exceptions'
import { ExceptionHandler } from './exception/handler'
import { getHttpContext, HttpContext, setHttpContext } from './http/context'
import { mutableResponse } from './http/cookie'
import { ResponseFormatter } from './http/formatter'
import { isRaw } from './http/response'
import { createStaticMiddleware } from './http/static'
import { I18nManager, setI18nManager } from './i18n/manager'
import { Logger } from './logger'
import { MailManager, setMailManager } from './mail/manager'
import { MiddlewareRegistry } from './middleware/registry'
import { NotificationManager, setNotificationManager } from './notification/manager'
import { Observability } from './observability/observability'
import { openAPIMiddleware } from './openapi/middleware'
import { disposePersistent } from './persistent'
import { setQueueManager } from './queue/context'
import { QueueManager } from './queue/manager'
import { getRequestStore, runInRequest } from './request'
import { Router } from './routing/router'
import { Scheduler } from './schedule/scheduler'
import { setStorageManager, StorageManager } from './storage/manager'
import { tenancyMiddleware } from './tenancy/manager'
import { isClass, isModuleRecord, normalizeModules, toJsonSafe } from './utils'
import { webSocketConfig, webSocketPlugin } from './websocket/server'

export type AppMode = 'development' | 'production' | 'test'

export interface ApplicationOptions {
  mode?: AppMode
  /** 项目根目录，用于加载 .env，默认 `process.cwd()` */
  rootDir?: string
  /** false 跳过 .env 加载；传对象则直接注入环境变量 */
  env?: boolean | Record<string, string>
  /** `{ app: {...}, database: {...} }` 或 `import.meta.glob('/config/*.ts', { eager: true })` */
  config?: Record<string, ConfigInput<Record<string, any>>> | ModuleRecord
  /** 路由模块数组或 `import.meta.glob('/route/*.ts', { eager: true })` */
  routes?: Array<RouteModule | RouteRegistrar> | ModuleRecord
  providers?: ProviderInput[] | ModuleRecord
  exceptionHandler?: Constructor<ExceptionHandler>
  /** 统一响应格式（`app/response/Formatter.ts`） */
  responseFormatter?: Constructor<ResponseFormatter>
  /** 出站拦截器（`app/interceptor/*.ts`），按顺序处理最终 Response */
  interceptors?: Interceptor[] | ModuleRecord
  /** 授权策略与能力（app/policy/*.ts：definePolicy / defineAbilities） */
  policies?: unknown[] | ModuleRecord
  /** 队列任务（app/job/*.ts：defineJob，文件名为任务名） */
  jobs?: unknown[] | ModuleRecord
  /** 定时任务（schedule/*.ts：defineSchedule） */
  schedules?: unknown[] | ModuleRecord
  /** 事件（app/event/*.ts：defineEvent，文件名为事件名） */
  events?: unknown[] | ModuleRecord
  /** 监听器（app/listener/*.ts：defineListener） */
  listeners?: unknown[] | ModuleRecord
  /** 翻译文件：import.meta.glob('/lang/**\/*.{ts,json}', { eager: true })，或 { 'zh-CN': { messages: {...} } } */
  lang?: LangInput
  /** 其它按目录发现的模块，供扩展包读取（如 @hazejs/socket.io 的 app/socket/*.ts） */
  discovered?: Record<string, unknown[] | ModuleRecord>
  /**
   * 多应用模块：`import.meta.glob('/app/*\/{route,config,provider,exception,response}/*')`。
   * 只有在 `config/app.ts` 的 `apps` 中声明的应用才会启用。
   */
  apps?: ModuleRecord
  /** 托管静态资源（全栈项目的前端构建产物） */
  static?: StaticOptions
  /** 在提供者 register 之后、boot 之前执行，常用于测试中替换绑定 */
  setup?: (app: Application) => MaybePromise<void>
}

export interface DisposeOptions {
  /** `hmr` 时不释放持久资源 */
  reason?: 'hmr' | 'shutdown'
}

type ServeOptions = NonNullable<Parameters<typeof serve>[1]>

const kNotFound = Symbol.for('h3.notFound')

let currentApp: Application | undefined

export class Application {
  readonly mode: AppMode
  readonly rootDir: string
  readonly container = new Container()
  readonly router = new Router()
  readonly config = new Config()
  logger: Logger = new Logger()

  readonly #options: ApplicationOptions
  readonly #providers: ServiceProvider[] = []
  readonly #interceptors: Interceptor[] = []
  readonly #apps: SubApp[] = []
  #appModules = new Map<string, EnabledApp>()
  #h3: H3 | undefined
  #booted = false

  constructor(options: ApplicationOptions = {}) {
    this.#options = options
    this.mode = options.mode ?? resolveMode(process.env.NODE_ENV)
    this.rootDir = options.rootDir ?? process.cwd()
    this.fetch = this.fetch.bind(this)
  }

  get h3(): H3 {
    if (!this.#h3)
      throw new Error('Application has not been booted. Call `await app.boot()` first.')
    return this.#h3
  }

  get booted(): boolean {
    return this.#booted
  }

  fetch(request: Request): Promise<Response> {
    return Promise.resolve(this.h3.fetch(request))
  }

  /** 无需监听端口即可发起请求，适用于测试 */
  request(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    return Promise.resolve(this.h3.request(input, init))
  }

  make<T>(key: InjectionKey<T>): T {
    return this.container.make(key)
  }

  async boot(): Promise<this> {
    if (this.#booted)
      return this
    const options = this.#options

    // 1. 环境变量
    if (typeof options.env === 'object')
      Object.assign(process.env, options.env)
    else if (options.env !== false)
      loadEnv({ cwd: this.rootDir, mode: this.mode })

    // 2. 配置（函数形式的配置在此时求值，保证能读到 .env）
    this.#loadConfig()
    this.logger = new Logger(this.config.get('logger'))

    // 3. 内核绑定
    this.container
      .instance(Application, this)
      .instance(Container, this.container)
      .instance(Config, this.config)
      .instance(Logger, this.logger)
      .instance(Router, this.router)
      .singleton(ExceptionHandler, options.exceptionHandler ?? ExceptionHandler)
      .singleton(ResponseFormatter, options.responseFormatter ?? ResponseFormatter)
    // 可观测性：OpenTelemetry（可选）与开发面板的记录器
    this.container.instance(Observability, await Observability.setup(this))
    for (const [, interceptor] of normalizeModules<Interceptor>(options.interceptors))
      this.intercept(interceptor)
    // 授权：提供者可在 register / boot 中继续 app.make(Gate).define(...)
    const gate = new Gate()
    for (const [, policy] of normalizeModules<unknown>(options.policies))
      gate.register(policy)
    this.container.instance(Gate, gate)
    // 缓存：config/cache.ts，缺省为内存缓存
    const cache = new CacheManager(this.config)
    this.container.instance(CacheManager, cache)
    setCacheManager(cache)
    // 文件存储：config/filesystem.ts，缺省为 local / public 两个本地磁盘
    const storage = new StorageManager(this.config)
    this.container.instance(StorageManager, storage)
    setStorageManager(storage)
    // 队列与定时任务
    const queue = new QueueManager(this)
    for (const [name, job] of normalizeModules<unknown>(options.jobs))
      queue.register(job as never, name)
    this.container.instance(QueueManager, queue)
    setQueueManager(queue, QueueManager)
    // 多语言：config/i18n.ts + lang/<locale>/*.ts（邮件渲染会用到，先于邮件创建）
    const i18n = new I18nManager(this.config, options.lang)
    this.container.instance(I18nManager, i18n)
    setI18nManager(i18n)
    // 邮件：config/mail.ts，缺省为 log 驱动；排队发送注册为任务 mail:send
    const mail = new MailManager(this)
    this.container.instance(MailManager, mail)
    setMailManager(mail)
    const scheduler = new Scheduler(this)
    for (const [, schedule] of normalizeModules<unknown>(options.schedules))
      scheduler.register(schedule)
    this.container.instance(Scheduler, scheduler)
    // 事件与监听器（排队监听器注册为队列任务）
    const events = new EventManager(this)
    this.container.instance(EventManager, events)
    setEventManager(events, EventManager)
    for (const [name, event] of normalizeModules<unknown>(options.events))
      events.registerEvent(event, name)
    for (const [name, listener] of normalizeModules<unknown>(options.listeners))
      events.registerListener(listener, name)
    // 广播：app/channel 的频道授权，内置接口位于 /broadcasting
    const broadcast = new BroadcastManager(this)
    this.container.instance(BroadcastManager, broadcast)
    setBroadcastManager(broadcast, BroadcastManager)
    // 通知：config/notification.ts；排队发送注册为任务 notification:send
    const notifications = new NotificationManager(this)
    this.container.instance(NotificationManager, notifications)
    setNotificationManager(notifications, NotificationManager)

    // 4. 提供者 register → setup → boot（已启用应用目录下的提供者同样全局生效）
    this.#appModules = this.#enabledApps()
    const providers = [
      ...normalizeModules<ProviderInput>(options.providers).map(([, provider]) => provider),
      ...[
        ...this.#appModules.values(),
      ].flatMap(({ modules }) => modules.providers),
    ]
    for (const Provider of providers) {
      const provider = isClass(Provider)
        ? new Provider()
        : Provider
      this.#providers.push(provider)
      await provider.register?.(this.container, this)
    }
    await options.setup?.(this)
    for (const provider of this.#providers)
      await provider.boot?.(this)

    // 5. HTTP 内核
    this.#h3 = this.#createH3()
    this.#booted = true
    // 记录最近启动的应用，供请求之外的 useApp() / config() 使用
    // eslint-disable-next-line ts/no-this-alias
    currentApp = this
    return this
  }

  /**
   * 注册出站拦截器：拿到最终的 Response（统一格式、异常渲染之后），可修改响应头 / 状态，
   * 或返回新的 Response 替换。常在服务提供者的 boot() 中调用。
   */
  intercept(interceptor: Interceptor): this {
    this.#interceptors.push(interceptor)
    return this
  }

  /** 启动 HTTP 服务（生产环境入口使用） */
  serve(options: ServeOptions = {}): ReturnType<typeof serve> {
    // 关闭 srvx 自带的信号处理，由下方统一执行：停止监听 → 等待在途请求 → 释放资源
    // WebSocket（crossws）：升级请求经应用的 fetch 解析到 r.ws() 的钩子
    const server = serve(this.h3, {
      port: Number(process.env.PORT) || 3000,
      gracefulShutdown: false,
      ...options,
      plugins: [
        webSocketPlugin(request => this.fetch(request), webSocketConfig(this.config)),
        ...(options.plugins ?? []),
      ],
    })
    const shutdown = async (): Promise<void> => {
      await server.close()
      await this.dispose({ reason: 'shutdown' })
      process.exit(0)
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    return server
  }

  /** 按目录发现的模块：`[文件名, 默认导出]`（如 discovered('sockets')） */
  discovered<T = unknown>(name: string): Array<[name: string | undefined, value: T]> {
    return normalizeModules<T>(this.#options.discovered?.[name] as T[] | ModuleRecord | undefined)
  }

  /**
   * 为请求之外的 Request 创建上下文（不经过路由与中间件），可读 ctx.auth 等：
   * 如 Socket.IO 握手时按 Authorization / Cookie 鉴权
   */
  contextFor(request: Request): HttpContext {
    const ctx = new HttpContext(mockEvent(request), this.container.createChild(), { config: this.config, logger: this.logger })
    ctx.container.instance(HttpContext, ctx)
    return ctx
  }

  async dispose(options: DisposeOptions = {}): Promise<void> {
    for (const provider of [...this.#providers].reverse())
      await provider.shutdown?.(this)
    // 队列连接（BullMQ 的 Queue / Worker）随应用关闭
    if (this.container.has(QueueManager))
      await this.container.make(QueueManager).close().catch(error => this.logger.error('Failed to close queue connections', error))
    if (this.container.has(MailManager))
      await this.container.make(MailManager).close().catch(error => this.logger.error('Failed to close mail transports', error))
    await this.container.dispose()
    // 写出并关闭 http / file 日志通道
    await this.logger.close()
    if (options.reason !== 'hmr')
      await disposePersistent()
    if (currentApp === this)
      currentApp = undefined
  }

  async #runInterceptors(result: unknown, event: H3Event, ctx: HttpContext): Promise<Response> {
    // 先按 h3 的规则转换为 Response（不触发 onResponse，访问日志仍只记录一次）
    let response = mutableResponse(result instanceof Response
      ? result
      : await toResponse(result, event, {
          debug: this.config.get('app.debug'),
        }))
    for (const interceptor of this.#interceptors)
      response = (await interceptor(response, ctx)) ?? response
    // 请求级钩子（ctx.onResponse）：后注册的先执行
    for (const hook of [...ctx.responseHooks].reverse())
      response = (await hook(response)) ?? response
    return response
  }

  #loadConfig(): void {
    const defaults = defaultConfig(this.mode)
    for (const [name, value] of Object.entries(defaults))
      this.config.merge(name, value)

    const input = this.#options.config ?? {}
    const entries = isModuleRecord(input)
      ? normalizeModules<ConfigInput<Record<string, any>>>(input)
      : Object.entries(input)
    for (const [name, value] of entries)
      this.config.merge(name!, resolveConfigInput(value as ConfigInput<Record<string, any>>))
  }

  #createH3(): H3 {
    const handleError = async (error: unknown, ctx: HttpContext): Promise<unknown> => {
      // 从请求容器解析：多应用时为应用自己的异常处理器
      const handler = ctx.make(ExceptionHandler)
      try {
        await handler.report(error, ctx)
      }
      catch (reportError) {
        this.logger.error('ExceptionHandler.report() failed', reportError)
      }
      return handler.render(error, ctx)
    }

    const observability = this.container.make(Observability)
    const requestIdHeader = this.config.get('app.requestIdHeader')
    const logRequests = this.config.get('logger.requests') ?? false
    const createContext = (event: H3Event, container: Container): HttpContext => {
      const requestId = resolveRequestId(event, requestIdHeader)
      // 从容器取 Logger，测试中替换的日志器同样生效
      const logger = this.container.make(Logger).child({ requestId })
      return new HttpContext(event, container, { requestId, logger, config: this.config })
    }

    // 出站：处理器 / 中间件返回的数据交给 ResponseFormatter 统一格式
    const formatOutbound = (result: unknown, event: H3Event, ctx: HttpContext): unknown => {
      // BigInt（雪花 ID 等）输出为字符串，避免 JSON 序列化报错与前端精度丢失
      if (isRaw(result))
        return toJsonSafe(result.value)
      const meta = event.context.matchedRoute?.meta as RouteMeta | undefined
      if (meta?.envelope === false)
        return toJsonSafe(result)
      const formatter = ctx.make(ResponseFormatter)
      return formatter.shouldFormat(result, ctx)
        ? toJsonSafe(formatter.success(result, ctx))
        : result
    }

    const h3 = new H3({
      debug: this.config.get('app.debug'),
      silent: true,
      // 兜底：请求作用域建立之前的错误（如非法 URL）或异常处理器自身出错
      onError: (error, event) => {
        const ctx = getHttpContext(event) ?? createContext(event, this.container.createChild())
        return handleError(error, ctx)
      },
      // 访问日志在响应生成之后记录，状态码包含异常渲染后的结果
      onResponse: (response, event) => {
        observability.onResponse(response, event)
        const ctx = getHttpContext(event)
        if (logRequests && ctx && !observability.isInternal(ctx.path)) {
          ctx.logger.access({
            method: ctx.method,
            path: ctx.path,
            status: response.status,
            duration: performance.now() - ctx.startedAt,
          })
        }
      },
    })

    // 请求 span 包住整个请求（未开启 OpenTelemetry 时直接放行）
    h3.use(observability.middleware())
    // 请求作用域：子容器 + HttpContext + AsyncLocalStorage
    h3.use(async (event, next) => {
      const container = this.container.createChild()
      const ctx = createContext(event, container)
      if (requestIdHeader)
        event.res.headers.set(requestIdHeader, ctx.requestId)
      container.instance(HttpContext, ctx)
      setHttpContext(event, ctx)
      const store = { app: this, event, ctx, container }
      try {
        const result = await runInRequest(store, () => next())
        return this.#interceptors.length || ctx.responseHooks.length
          ? await runInRequest(store, () => this.#runInterceptors(result, event, ctx))
          : result
      }
      finally {
        await container.dispose()
      }
    })

    // 异常边界：捕获路由、中间件、控制器抛出的所有异常并统一渲染
    h3.use(async (event, next) => {
      const ctx = getHttpContext(event)!
      try {
        const result = await next()
        if (result === kNotFound)
          throw new NotFoundException(`Cannot find any route matching [${ctx.method}] ${ctx.path}`)
        return formatOutbound(result, event, ctx)
      }
      catch (error) {
        return handleError(error, ctx)
      }
    })

    // 静态资源：在业务中间件之前，避免鉴权等逻辑作用于前端资源
    if (this.#options.static)
      h3.use(createStaticMiddleware(this.#options.static))
    // 文件存储：签名临时链接与 serve: true 的本地磁盘
    h3.use(this.container.make(StorageManager).middleware())
    // OpenAPI 文档（/openapi.json、/docs），在全局中间件之前，不受 CSP / 鉴权影响
    h3.use(openAPIMiddleware(this))
    // 健康检查（/health）与开发面板（/__haze，仅开发模式）
    h3.use(observability.routes())
    // 多租户：按域名 / 请求头 / 路径识别租户（未配置 config/tenancy.ts 时直接放行）
    h3.use(tenancyMiddleware(this))

    const registry = new MiddlewareRegistry(this.config.get('middleware') as MiddlewareConfig)
    for (const item of registry.resolve(this.config.get('middleware.global') ?? []))
      h3.use(registry.toH3(item))

    // 多应用分发：按域名 / 前缀进入应用自己的路由表（在全局中间件之后、全局路由之前）
    this.#apps.push(...this.#createApps(this.#appModules, registry))
    if (this.#apps.length) {
      h3.use(async (event, next) => {
        const app = matchApp(this.#apps, event.url.hostname, event.url.pathname)
        if (!app)
          return next()
        const ctx = getHttpContext(event)!
        ctx.appName = app.name
        ctx.config = app.config
        ctx.logger = ctx.logger.child({ app: app.name })
        ctx.container.instance(Config, app.config)
        if (app.handler)
          ctx.container.instance(ExceptionHandler, app.handler)
        if (app.formatter)
          ctx.container.instance(ResponseFormatter, app.formatter)

        const original = event.url.pathname
        if (app.prefix !== '/')
          event.url.pathname = original.slice(app.prefix.length) || '/'
        try {
          return await app.h3.handler(event)
        }
        finally {
          event.url.pathname = original
        }
      })
    }

    this.router.load(this.container.make(BroadcastManager).routes())
    for (const [, module] of normalizeModules<RouteModule | RouteRegistrar>(this.#options.routes))
      this.router.load(module)
    this.router.compile({
      h3,
      container: this.container,
      middleware: registry,
    })
    for (const app of this.#apps) {
      this.router.mount(app.router, {
        app: app.name,
        prefix: app.prefix,
        domain: app.domains.length ? app.domains : undefined,
      })
    }

    return h3
  }

  /** 已在 config/app.ts 的 apps 中声明的应用及其目录模块 */
  #enabledApps(): Map<string, EnabledApp> {
    const declared = this.config.get<Record<string, SubAppConfig>>('app.apps', {})
    const discovered = groupAppModules(this.#options.apps)
    const enabled = new Map<string, EnabledApp>()
    for (const [name, config] of Object.entries(declared)) {
      enabled.set(name, {
        matcher: normalizeAppConfig(name, config),
        modules: discovered.get(name) ?? { routes: [], config: [], providers: [] },
      })
    }
    assertNoConflicts([
      ...enabled.values(),
    ].map(({ matcher }) => matcher))
    return enabled
  }

  #createApps(apps: Map<string, EnabledApp>, globalRegistry: MiddlewareRegistry): SubApp[] {
    return [
      ...apps.values(),
    ].map(({ matcher, modules }) => {
      // 应用配置 = 全局配置 + app/<name>/config/*.ts（深合并，不影响全局）
      const config = new Config({
        ...this.config.all(),
      })
      const own: Record<string, any> = {}
      for (const [name, value] of modules.config) {
        own[name] = resolveConfigInput(value)
        config.merge(name, own[name])
      }

      // 应用中间件：可引用全局别名，全局中间件已在分发前执行，这里只注册应用自己的 global
      const registry = own.middleware
        ? new MiddlewareRegistry(config.get('middleware') as MiddlewareConfig)
        : globalRegistry
      const h3 = new H3()
      for (const item of registry.resolve(own.middleware?.global ?? []))
        h3.use(registry.toH3(item))

      const router = new Router()
      for (const module of modules.routes)
        router.load(module, { as: `${matcher.name}.` })
      router.compile({ h3, container: this.container, middleware: registry })

      const make = <T>(Ctor: Constructor<T> | undefined): T | undefined =>
        Ctor
          ? this.container.call(() => new Ctor())
          : undefined
      return {
        ...matcher,
        config,
        h3,
        router,
        handler: make(modules.exceptionHandler),
        formatter: make(modules.responseFormatter),
      }
    })
  }
}

/** 创建并启动应用（不监听端口） */
export function createApplication(options: ApplicationOptions = {}): Promise<Application> {
  return new Application(options).boot()
}

/** 当前应用：请求内取请求所属应用，否则取最近启动的应用 */
export function useApp(): Application {
  const app = getRequestStore()?.app ?? currentApp
  if (!app)
    throw new Error('No application is running. Did you call createApplication()?')
  return app
}

/** 读取配置的快捷函数：`config('app.name')` */
export function config<P extends ConfigPath>(key: P): ConfigPathValue<P>
export function config<T>(key: string, defaultValue: T): T
export function config(key: string, defaultValue?: unknown): unknown {
  // 请求内读取当前应用的配置（多应用时为应用级配置）
  const config = getRequestStore()?.ctx.config ?? useApp().config
  return config.get(key, defaultValue)
}

function resolveMode(nodeEnv: string | undefined): AppMode {
  if (nodeEnv === 'production' || nodeEnv === 'test')
    return nodeEnv
  return 'development'
}

interface EnabledApp {
  matcher: AppMatcher
  modules: SubAppModules
}

interface SubApp extends AppMatcher {
  config: Config
  h3: H3
  router: Router
  handler?: ExceptionHandler
  formatter?: ResponseFormatter
}

const REQUEST_ID_RE = /^[\w.:-]{1,128}$/

/** 沿用上游传入的请求 ID（仅接受安全字符，防止日志注入），否则生成新的 */
function resolveRequestId(event: H3Event, header: string | false): string {
  const incoming = header
    ? event.req.headers.get(header)
    : null
  return incoming && REQUEST_ID_RE.test(incoming)
    ? incoming
    : crypto.randomUUID()
}
