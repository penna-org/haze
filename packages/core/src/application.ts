import type { ConfigInput } from './config/config'
import type { InjectionKey } from './container/token'
import type { StaticOptions } from './http/static'
import type { MiddlewareConfig } from './middleware/types'
import type { ProviderInput, ServiceProvider } from './provider'
import type { RouteModule, RouteRegistrar } from './routing/builder'
import type { Constructor, MaybePromise, ModuleRecord } from './utils'
import process from 'node:process'
import { H3, serve } from 'h3'
import { Config, defaultConfig, resolveConfigInput } from './config/config'
import { loadEnv } from './config/env'
import { Container } from './container/container'
import { NotFoundException } from './exception/exceptions'
import { ExceptionHandler } from './exception/handler'
import { getHttpContext, HttpContext, setHttpContext } from './http/context'
import { createStaticMiddleware } from './http/static'
import { Logger } from './logger'
import { MiddlewareRegistry } from './middleware/registry'
import { disposePersistent } from './persistent'
import { getRequestStore, runInRequest } from './request'
import { Router } from './routing/router'
import { isClass, isModuleRecord, normalizeModules } from './utils'

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

    // 4. 提供者 register → setup → boot
    for (const [, Provider] of normalizeModules<ProviderInput>(options.providers)) {
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

  /** 启动 HTTP 服务（生产环境入口使用） */
  serve(options: ServeOptions = {}): ReturnType<typeof serve> {
    // 关闭 srvx 自带的信号处理，由下方统一执行：停止监听 → 等待在途请求 → 释放资源
    const server = serve(this.h3, { port: Number(process.env.PORT) || 3000, gracefulShutdown: false, ...options })
    const shutdown = async (): Promise<void> => {
      await server.close()
      await this.dispose({ reason: 'shutdown' })
      process.exit(0)
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    return server
  }

  async dispose(options: DisposeOptions = {}): Promise<void> {
    for (const provider of [...this.#providers].reverse())
      await provider.shutdown?.(this)
    await this.container.dispose()
    if (options.reason !== 'hmr')
      await disposePersistent()
    if (currentApp === this)
      currentApp = undefined
  }

  #loadConfig(): void {
    const defaults = defaultConfig(this.mode === 'development')
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
      const handler = this.container.make(ExceptionHandler)
      try {
        await handler.report(error, ctx)
      }
      catch (reportError) {
        this.logger.error('ExceptionHandler.report() failed', reportError)
      }
      return handler.render(error, ctx)
    }

    const h3 = new H3({
      debug: this.config.get('app.debug'),
      silent: true,
      // 兜底：请求作用域建立之前的错误（如非法 URL）或异常处理器自身出错
      onError: (error, event) => {
        const ctx = getHttpContext(event) ?? new HttpContext(event, this.container.createChild())
        return handleError(error, ctx)
      },
    })

    // 请求作用域：子容器 + HttpContext + AsyncLocalStorage
    h3.use(async (event, next) => {
      const container = this.container.createChild()
      const ctx = new HttpContext(event, container)
      container.instance(HttpContext, ctx)
      setHttpContext(event, ctx)
      try {
        return await runInRequest({ app: this, event, ctx, container }, () => next())
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
        return result
      }
      catch (error) {
        return handleError(error, ctx)
      }
    })

    // 静态资源：在业务中间件之前，避免鉴权等逻辑作用于前端资源
    if (this.#options.static)
      h3.use(createStaticMiddleware(this.#options.static))

    const registry = new MiddlewareRegistry(this.config.get('middleware') as MiddlewareConfig)
    for (const item of registry.resolve(this.config.get('middleware.global') ?? []))
      h3.use(registry.toH3(item))

    for (const [, module] of normalizeModules<RouteModule | RouteRegistrar>(this.#options.routes))
      this.router.load(module)
    this.router.compile({
      h3,
      container: this.container,
      middleware: registry,
      response: this.config.get('app.response'),
    })

    return h3
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
export function config<T = unknown>(key: string, defaultValue?: T): T {
  return useApp().config.get(key, defaultValue)
}

function resolveMode(nodeEnv: string | undefined): AppMode {
  if (nodeEnv === 'production' || nodeEnv === 'test')
    return nodeEnv
  return 'development'
}
