import type { Middleware as H3Middleware } from 'h3'
import type { Application } from '../application'
import type { CacheRepository } from '../cache/repository'
import type { HttpContext } from '../http/context'
import type { DownOptions, MaintenanceConfig, MaintenanceState, ResolvedMaintenanceConfig } from './config'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import process from 'node:process'
import { CacheManager } from '../cache/manager'
import { EventManager } from '../events/manager'
import { getHttpContext } from '../http/context'
import { ResponseFormatter } from '../http/formatter'
import { raw } from '../http/response'
import { localizeHttpMessage } from '../i18n/http'
import { i18nEnabled, useI18n } from '../i18n/manager'
import { matchesPath } from '../observability/config'
import { healthPaths, resolveHealthConfig } from '../observability/health'
import { resolveDashboardConfig } from '../observability/observability'
import { getRequestStore } from '../request'
import { safeEqual, toBase64Url } from '../security/key'
import { jsx } from '../view/jsx'
import { renderViewResponse, resolveView } from '../view/view'
import { defaultMaintenanceConfig } from './config'
import { MaintenanceModeDisabled, MaintenanceModeEnabled } from './events'
import { maintenancePage } from './page'

/** 默认提示（配置了 config/i18n.ts 时按 `http.maintenance` 翻译） */
export const MAINTENANCE_MESSAGE = 'The application is down for maintenance. Please check back soon.'
const MAINTENANCE_TITLE = 'Down for maintenance'
const SECRET_RE = /^[\w-]{1,128}$/

/** 状态的读写（缓存存储或本地文件） */
export interface MaintenanceDriver {
  readonly name: string
  /** 便于提示的位置描述，如 `cache store "redis"` / `storage/framework/down` */
  readonly location: string
  get: () => Promise<MaintenanceState | undefined>
  put: (state: MaintenanceState) => Promise<void>
  forget: () => Promise<boolean>
}

function cacheDriver(cache: CacheRepository, key: string): MaintenanceDriver {
  // 直接读写底层存储：不加租户前缀（维护状态是全局的），也不产生缓存遥测（每个进程定期轮询）
  const storageKey = cache.basePrefix + key
  return {
    name: 'cache',
    location: `cache store "${cache.name}" (${cache.store.driver}), key "${storageKey}"`,
    async get() {
      const raw = await cache.store.get(storageKey)
      return raw === undefined
        ? undefined
        : normalizeState(cache.serializer.deserialize(raw))
    },
    put: state => cache.store.set(storageKey, cache.serializer.serialize(state)),
    forget: () => cache.store.delete(storageKey),
  }
}

function fileDriver(path: string, label: string): MaintenanceDriver {
  return {
    name: 'file',
    location: label,
    async get() {
      try {
        return normalizeState(JSON.parse(await readFile(path, 'utf8')))
      }
      catch {
        // 文件不存在（或无文件系统、内容损坏）都视为未维护
        return undefined
      }
    },
    async put(state) {
      await mkdir(dirname(path), { recursive: true })
      // 先写临时文件再改名，读取方不会读到半个文件
      const temp = `${path}.${process.pid}.tmp`
      await writeFile(temp, JSON.stringify(state, null, 2))
      await rename(temp, path)
    },
    async forget() {
      try {
        await rm(path)
        return true
      }
      catch {
        return false
      }
    },
  }
}

function normalizeState(value: unknown): MaintenanceState | undefined {
  if (!value || typeof value !== 'object')
    return undefined
  const state = value as Partial<MaintenanceState>
  return {
    ...state,
    time: Number(state.time) || 0,
    status: Number(state.status) || 503,
  } as MaintenanceState
}

/** 是否可以使用本地文件系统（Workers 中没有可写的项目目录） */
function hasFileSystem(): boolean {
  return Boolean(process.versions?.node)
    && (globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent !== 'Cloudflare-Workers'
}

export async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret))
  return [
    ...new Uint8Array(digest),
  ].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/** `/api/webhooks/*` 风格的通配匹配 */
function matchesPattern(path: string, pattern: string): boolean {
  if (!pattern.includes('*'))
    return path === pattern || path === pattern.replace(/\/+$/, '')
  const regex = new RegExp(`^${pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`)
  return regex.test(path)
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

export interface DownResult {
  state: MaintenanceState
  /** 绕过密钥的明文（传入或生成的），只在此时可见 */
  secret?: string
  driver: MaintenanceDriver
}

/**
 * 维护模式（应用内单例，`inject(MaintenanceManager)`）：
 * - `down()` / `up()` 写入 / 删除状态（缓存存储或本地文件），各进程在 `interval` 毫秒内生效；
 * - `middleware()` 安装在请求作用域与异常边界之后、静态资源 / OpenAPI / 健康检查 / 全局中间件之前；
 * - `waitUntilUp()` 供队列 worker 在任务之间暂停。
 */
export class MaintenanceManager {
  #cached: { state: MaintenanceState | undefined, at: number } | undefined
  #pending: Promise<MaintenanceState | undefined> | undefined
  #driver: MaintenanceDriver | undefined
  #fallback = false
  /** 状态保存在进程内的 memory 缓存存储中（测试模式） */
  #memory = false

  constructor(readonly app: Application) {}

  #config: ResolvedMaintenanceConfig | undefined

  /** config/maintenance.ts 与默认值合并后的配置（应用启动后不变，缓存起来避免每个请求重复合并） */
  get config(): ResolvedMaintenanceConfig {
    return this.#config ??= this.#resolveConfig()
  }

  #resolveConfig(): ResolvedMaintenanceConfig {
    const config = this.app.config.get<MaintenanceConfig>('maintenance', {})
    return {
      ...defaultMaintenanceConfig,
      ...Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined)),
    } as ResolvedMaintenanceConfig
  }

  /** 当前使用的存储；cache 驱动遇到进程内 memory 存储时（测试模式除外）改用 file */
  driver(): MaintenanceDriver {
    if (this.#driver)
      return this.#driver
    const config = this.config
    const filePath = isAbsolute(config.file)
      ? config.file
      : join(this.app.rootDir, config.file)
    if (config.driver === 'file') {
      this.#driver = fileDriver(filePath, config.file)
      return this.#driver
    }
    const cache = this.app.make(CacheManager)
    const name = config.store ?? cache.defaultStore
    const storeConfig = cache.config.stores[name]
    if (storeConfig?.driver === 'memory' && this.app.mode !== 'test' && hasFileSystem()) {
      this.#fallback = true
      this.#driver = fileDriver(filePath, config.file)
      return this.#driver
    }
    this.#memory = storeConfig?.driver === 'memory'
    this.#driver = cacheDriver(cache.store(name), config.key)
    return this.#driver
  }

  /**
   * 使用 cache 驱动但缓存存储只在本进程内（memory）时的提示：状态无法跨进程共享，
   * 非测试模式下已改用文件；建议显式设置 driver: 'file' 或使用 redis 等共享存储
   */
  warning(): string | undefined {
    const driver = this.driver()
    if (this.#fallback) {
      return `The cache store is the in-process memory store, which other processes cannot see; maintenance state is kept in ${driver.location} instead. Set driver: 'file' or a shared cache store (redis, upstash, kv) in config/maintenance.ts.`
    }
    if (this.#memory)
      return 'The cache store is the in-process memory store: maintenance mode only affects the current process. Use driver: \'file\' or a shared cache store (redis, upstash, kv) in config/maintenance.ts.'
    return undefined
  }

  /** 当前状态（进程内缓存 interval 毫秒；fresh 时直接读取存储） */
  async state(options: { fresh?: boolean } = {}): Promise<MaintenanceState | undefined> {
    const interval = this.config.interval
    const cached = this.#cached
    if (!options.fresh && cached && Date.now() - cached.at < interval)
      return cached.state
    // 并发请求共用同一次读取
    this.#pending ??= this.driver().get().catch((error: unknown) => {
      this.app.logger.warn('Failed to read the maintenance state', error)
      return cached?.state
    }).then((state) => {
      this.#cached = {
        state,
        at: Date.now(),
      }
      return state
    }).finally(() => (this.#pending = undefined))
    return this.#pending
  }

  async isDown(options: { fresh?: boolean } = {}): Promise<boolean> {
    return Boolean(await this.state(options))
  }

  /** 进入维护模式 */
  async down(options: DownOptions = {}): Promise<DownResult> {
    const secret = options.secret ?? (options.withSecret
      ? toBase64Url(crypto.getRandomValues(new Uint8Array(18)))
      : undefined)
    if (secret !== undefined && !SECRET_RE.test(secret))
      throw new Error('The maintenance secret may only contain letters, digits, "-" and "_"')
    const state: MaintenanceState = {
      time: Date.now(),
      status: options.status ?? 503,
      retry: options.retry ?? 60,
      ...(options.refresh !== undefined && { refresh: options.refresh }),
      ...(secret !== undefined && { secret: await hashSecret(secret) }),
      ...(options.redirect && { redirect: `/${options.redirect.replace(/^\/+/, '')}` }),
      ...(options.render && { render: options.render }),
      ...(options.except?.length && { except: options.except }),
      ...(options.message && { message: options.message }),
    }
    const driver = this.driver()
    await driver.put(state)
    this.#cached = {
      state,
      at: Date.now(),
    }
    await this.#emit(MaintenanceModeEnabled, { state })
    return { state, secret, driver }
  }

  /** 退出维护模式，返回之前是否处于维护中 */
  async up(): Promise<boolean> {
    const driver = this.driver()
    const wasDown = Boolean(await driver.get())
    await driver.forget()
    this.#cached = {
      state: undefined,
      at: Date.now(),
    }
    if (wasDown) {
      await this.#emit(MaintenanceModeDisabled, {
        time: Date.now(),
      })
    }
    return wasDown
  }

  /** 队列 worker：维护期间（pauseWorkers 时）每隔 workerSleep 毫秒检查一次，恢复后返回 */
  async waitUntilUp(signal?: AbortSignal): Promise<void> {
    const { pauseWorkers, workerSleep } = this.config
    if (!pauseWorkers)
      return
    let logged = false
    while (!signal?.aborted && await this.isDown()) {
      if (!logged) {
        this.app.logger.info('Application is in maintenance mode, workers are paused')
        logged = true
      }
      await sleep(workerSleep, signal)
    }
    if (logged)
      this.app.logger.info('Application is up, workers resumed')
  }

  /** 定时任务是否应当跳过（维护中且 pauseWorkers） */
  async pausesScheduler(): Promise<boolean> {
    return this.config.pauseWorkers && await this.isDown()
  }

  /** 请求是否不受维护影响：except、健康检查、开发面板 */
  passes(path: string, state: MaintenanceState): boolean {
    const except = [
      ...this.config.except,
      ...(state.except ?? []),
    ]
    if (except.some(pattern => matchesPattern(path, pattern)))
      return true
    if (matchesPath(path, healthPaths(resolveHealthConfig(this.app))))
      return true
    const dashboard = resolveDashboardConfig(this.app)
    return dashboard.enabled && matchesPath(path, [dashboard.path])
  }

  /** HTTP 中间件 */
  middleware(): H3Middleware {
    return async (event, next) => {
      const state = await this.state()
      if (!state)
        return next()
      const ctx = getHttpContext(event)!
      const path = event.url.pathname
      if (this.passes(path, state))
        return next()
      // 访问 /<secret>：设置绕过 Cookie 后跳转到首页
      if (state.secret && path.length > 1 && safeEqual(await hashSecret(decodeURIComponent(path.slice(1))), state.secret)) {
        if (await this.#setBypassCookie(ctx, state))
          return ctx.redirect('/', 302)
      }
      if (await this.#hasBypassCookie(ctx, state))
        return next()
      return this.#respond(ctx, state)
    }
  }

  async #setBypassCookie(ctx: HttpContext, state: MaintenanceState): Promise<boolean> {
    const { cookie, bypassTtl } = this.config
    try {
      await ctx.setSignedCookie(cookie, `${Date.now() + bypassTtl * 1000}:${state.secret!.slice(0, 16)}`, {
        httpOnly: true,
        path: '/',
        maxAge: bypassTtl,
      })
      return true
    }
    catch (error) {
      // 没有 APP_KEY 时无法签名
      ctx.logger.warn('Cannot set the maintenance bypass cookie', error)
      return false
    }
  }

  /** 绕过 Cookie：签名有效、未过期，且属于当前这次维护的密钥 */
  async #hasBypassCookie(ctx: HttpContext, state: MaintenanceState): Promise<boolean> {
    if (!state.secret || !ctx.cookie(this.config.cookie))
      return false
    try {
      const value = await ctx.signedCookie(this.config.cookie)
      const [expires, prefix] = value?.split(':') ?? []
      return Number(expires) > Date.now() && prefix === state.secret.slice(0, 16)
    }
    catch {
      return false
    }
  }

  async #respond(ctx: HttpContext, state: MaintenanceState): Promise<unknown> {
    const status = state.status || 503
    const headers = new Headers()
    if (state.retry)
      headers.set('retry-after', String(state.retry))
    if (state.refresh)
      headers.set('refresh', String(state.refresh))
    headers.set('cache-control', 'no-store')
    const message = localizeHttpMessage(status, state.message ?? MAINTENANCE_MESSAGE)
    const accept = ctx.header('accept') ?? ''
    const api = ctx.path === '/api' || ctx.path.startsWith('/api/')
    const html = accept.includes('text/html') && !api

    if (!html) {
      // JSON：与异常处理相同的错误格式（不经过异常上报）
      ctx.status(status)
      headers.forEach((value, key) => ctx.setHeader(key, value))
      return raw(ctx.make(ResponseFormatter).error({ status, code: status, message }, ctx))
    }
    if (state.redirect && ctx.path !== state.redirect) {
      headers.set('location', state.redirect)
      return new Response(null, { status: 302, headers })
    }

    const props = {
      status,
      message,
      title: i18nEnabled() && useI18n().has('http.maintenance_title')
        ? useI18n().translate('http.maintenance_title', undefined, ctx.locale)
        : MAINTENANCE_TITLE,
      lang: i18nEnabled()
        ? ctx.locale
        : 'en',
      retry: state.retry,
      refresh: state.refresh,
      state,
    }
    if (state.render) {
      try {
        const component = await resolveView(this.app, state.render)
        return await renderViewResponse(jsx(component, props), ctx, { status, headers })
      }
      catch (error) {
        ctx.logger.warn(`Failed to render the maintenance view "${state.render}", using the built-in page`, error)
      }
    }
    return renderViewResponse(maintenancePage(props), ctx, { status, headers })
  }

  async #emit<P>(event: { name?: string }, payload: P): Promise<void> {
    try {
      await this.app.make(EventManager).emit(event as never, payload as never)
    }
    catch (error) {
      this.app.logger.warn('A maintenance mode listener failed', error)
    }
  }
}

let fallback: MaintenanceManager | undefined

/** 设置请求之外使用的维护模式管理器（应用启动时设置） */
export function setMaintenanceManager(manager: MaintenanceManager | undefined): void {
  fallback = manager
}

export function useMaintenance(): MaintenanceManager {
  const manager = getRequestStore()?.app.make(MaintenanceManager) ?? fallback
  if (!manager)
    throw new Error('Maintenance mode is not available: the application has not booted')
  return manager
}

/** 维护模式门面：`await Maintenance.down({ secret })`、`await Maintenance.up()`、`await Maintenance.isDown()` */
export const Maintenance = {
  down: (options?: DownOptions): Promise<DownResult> => useMaintenance().down(options),
  up: (): Promise<boolean> => useMaintenance().up(),
  state: (options?: { fresh?: boolean }): Promise<MaintenanceState | undefined> => useMaintenance().state(options),
  isDown: (options?: { fresh?: boolean }): Promise<boolean> => useMaintenance().isDown(options),
}
