import type { Middleware as H3Middleware } from 'h3'
import type { Config } from '../config/config'
import type { HttpContext } from '../http/context'
import type { JobMessage } from '../queue/job'
import type { TenancyConfig, Tenant, TenantResolver } from './config'
import { matchDomain } from '../apps'
import { NotFoundException } from '../exception/exceptions'
import { getHttpContext } from '../http/context'
import { parseDuration } from '../utils'
import { currentTenancy, runInTenantScope, runWithoutTenant, tenantKeyOf } from './context'

/** 未识别出租户 / 租户不存在（404） */
export class TenantNotFoundException extends NotFoundException {
  constructor(key?: string) {
    super(key === undefined
      ? 'Tenant could not be identified'
      : 'Tenant not found')
  }
}

const defaultConfig: TenancyConfig = {
  find: () => undefined,
}

/**
 * 多租户管理（每个应用一个，`tenancyOf(app)`）：识别租户、查找、建立租户上下文。
 * 配置来自 config/tenancy.ts；没有配置时只能用 Tenancy.run() 传入租户对象。
 */
export class TenancyManager {
  readonly #lookups = new Map<string, { tenant: Tenant, expiresAt: number }>()

  constructor(readonly appConfig: Pick<Config, 'get'>) {}

  get config(): TenancyConfig {
    return this.appConfig.get<TenancyConfig | undefined>('tenancy', undefined) ?? defaultConfig
  }

  /** 是否有 config/tenancy.ts */
  get configured(): boolean {
    return this.appConfig.get<TenancyConfig | undefined>('tenancy', undefined) !== undefined
  }

  /** 按标识查找租户（remember 时在进程内缓存） */
  async find(key: string): Promise<Tenant | undefined> {
    const config = this.config
    const ttl = config.remember === undefined
      ? 0
      : parseDuration(config.remember)
    const cached = this.#lookups.get(key)
    if (cached && cached.expiresAt > Date.now())
      return cached.tenant
    const tenant = (await config.find(key)) ?? undefined
    if (tenant && ttl > 0)
      this.#lookups.set(key, { tenant, expiresAt: Date.now() + ttl * 1000 })
    return tenant
  }

  /** 清除查找缓存（租户资料修改后） */
  forget(key?: string): void {
    if (key === undefined)
      this.#lookups.clear()
    else
      this.#lookups.delete(key)
  }

  /** 租户 ID 原值 */
  idOf(tenant: Tenant): string | number {
    const id = this.config.id?.(tenant) ?? tenant.id
    if (id === undefined || id === null)
      throw new Error('Tenant has no id (set `id` in config/tenancy.ts)')
    return id
  }

  /** 在租户上下文中执行：缓存 / 存储 / Session / 队列 / 数据库都按该租户隔离 */
  run<R>(tenant: Tenant, fn: () => R): R {
    const id = this.idOf(tenant)
    return runInTenantScope({
      tenant,
      id,
      key: tenantKeyOf(id),
      config: this.config,
    }, fn)
  }

  /** 是否跳过租户识别（中央域名 / except 路径） */
  isCentral(ctx: Pick<HttpContext, 'url'>): boolean {
    const config = this.config
    const host = ctx.url.hostname.toLowerCase()
    const central = [
      ...(config.centralDomains ?? []),
      ...(config.domain && config.resolvers?.includes('subdomain')
        ? [config.domain]
        : []),
    ]
    if (central.some(domain => matchDomain(domain.toLowerCase(), host)))
      return true
    const path = ctx.url.pathname
    return (config.except ?? []).some(pattern => pattern.endsWith('*')
      ? path.startsWith(pattern.slice(0, -1))
      : path === pattern || path === `${pattern}/`)
  }

  /** 从请求中识别租户标识（按 resolvers 顺序，第一个有结果的生效） */
  async identify(ctx: HttpContext): Promise<string | undefined> {
    for (const resolver of this.config.resolvers ?? ['header']) {
      const key = await this.#resolve(resolver, ctx)
      if (key)
        return key
    }
    return undefined
  }

  /**
   * 中间件逻辑：识别 → 查找 → 在租户上下文中继续。
   * 标识存在但租户不存在时 404；未识别出标识时按 required（默认 404）。
   */
  async handle(ctx: HttpContext, next: () => Promise<unknown>): Promise<unknown> {
    if (this.isCentral(ctx))
      return runWithoutTenant(next)
    const key = await this.identify(ctx)
    if (key === undefined) {
      if (this.config.required === false)
        return runWithoutTenant(next)
      throw new TenantNotFoundException()
    }
    const tenant = await this.find(key)
    if (!tenant)
      throw new TenantNotFoundException(key)
    return this.run(tenant, next)
  }

  /** 队列：按消息携带的租户 ID 恢复租户上下文（没有时以无租户执行） */
  async runForMessage<R>(message: JobMessage, fn: () => Promise<R>): Promise<R> {
    const key = message.context?.tenant
    if (!key)
      return runWithoutTenant(fn)
    // sync 驱动在投递处直接执行：已处于同一租户时不再查找
    if (currentTenancy()?.key === key)
      return fn()
    const tenant = await this.find(key)
    if (!tenant)
      throw new TenantNotFoundException(key)
    return this.run(tenant, fn)
  }

  async #resolve(resolver: TenantResolver, ctx: HttpContext): Promise<string | undefined> {
    const config = this.config
    switch (resolver) {
      case 'domain':
        return ctx.url.hostname.toLowerCase() || undefined
      case 'subdomain': {
        if (!config.domain)
          throw new Error('Tenancy: the subdomain resolver needs `domain` in config/tenancy.ts')
        const host = ctx.url.hostname.toLowerCase()
        const suffix = `.${config.domain.toLowerCase()}`
        if (!host.endsWith(suffix))
          return undefined
        const sub = host.slice(0, -suffix.length)
        // 只取一级子域名：a.b.example.com 不视为租户
        return sub && !sub.includes('.')
          ? sub
          : undefined
      }
      case 'header':
        return ctx.header(config.header ?? 'x-tenant')?.trim() || undefined
      case 'path': {
        const prefix = `/${(config.path ?? '/t').replace(/^\/+|\/+$/g, '')}/`
        const path = ctx.url.pathname
        if (!path.startsWith(prefix))
          return undefined
        const segment = path.slice(prefix.length).split('/')[0]
        try {
          return decodeURIComponent(segment) || undefined
        }
        catch {
          return undefined
        }
      }
      default:
        return (await resolver(ctx)) || undefined
    }
  }
}

const managers = new WeakMap<object, TenancyManager>()

/** 应用的多租户管理器（按应用缓存） */
export function tenancyOf(app: { config: Pick<Config, 'get'> }): TenancyManager {
  let manager = managers.get(app)
  if (!manager) {
    manager = new TenancyManager(app.config)
    managers.set(app, manager)
  }
  return manager
}

/**
 * 多租户 HTTP 中间件（h3 层，由框架安装在请求作用域与异常边界之后、全局中间件之前）：
 * 识别租户后，后续的中间件、路由与控制器都运行在租户上下文中。
 */
export function tenancyMiddleware(app: { config: Pick<Config, 'get'> }): H3Middleware {
  const manager = tenancyOf(app)
  return (event, next) => {
    const ctx = getHttpContext(event)
    // 没有 config/tenancy.ts，或只在部分路由上使用 tenancy 中间件
    if (!ctx || manager.config.global === false || !manager.configured)
      return next()
    return manager.handle(ctx, async () => next())
  }
}
