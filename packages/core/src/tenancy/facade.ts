import type { MiddlewareHandler } from '../middleware/types'
import type { Tenant } from './config'
import type { TenancyManager } from './manager'
import { useApp } from '../application'
import { getRequestStore } from '../request'
import { currentTenancy, runWithoutTenant } from './context'
import { tenancyOf, TenantNotFoundException } from './manager'

/** 当前应用的多租户管理器：请求内取请求所属应用，否则取最近启动的应用 */
export function useTenancy(): TenancyManager {
  return tenancyOf(getRequestStore()?.app ?? useApp())
}

/**
 * 多租户门面：
 *
 * ```ts
 * // 任务 / 命令 / 脚本中切换租户（传入租户对象，或按标识查找，找不到时抛出 404 异常）
 * await Tenancy.run('acme', async () => {
 *   await Post.create({ title: 'Hello' }) // 写入 acme 的数据库 / tenant_id
 * })
 * ```
 */
export const Tenancy = {
  /** 在租户上下文中执行 fn；tenant 为租户对象，或按标识（config/tenancy.ts 的 find）查找 */
  async run<R>(tenant: Tenant | string | number, fn: () => R | Promise<R>): Promise<R> {
    const manager = useTenancy()
    const resolved = typeof tenant === 'object'
      ? tenant
      : await manager.find(String(tenant))
    if (!resolved)
      throw new TenantNotFoundException(String(tenant))
    return manager.run(resolved, async () => fn())
  },

  /** 在没有租户的（中央）上下文中执行 */
  central<R>(fn: () => R): R {
    return runWithoutTenant(fn)
  },

  /** 当前租户，没有时为 undefined */
  current<T = Tenant>(): T | undefined {
    return currentTenancy<T>()?.tenant
  },

  /** 当前租户 ID 的字符串形式，没有时为 undefined */
  key(): string | undefined {
    return currentTenancy()?.key
  },

  /** 当前是否处于租户上下文 */
  check(): boolean {
    return currentTenancy() !== undefined
  },

  /** 按标识查找租户 */
  find(key: string): Promise<Tenant | undefined> {
    return useTenancy().find(key)
  },
}

/**
 * 多租户的路由 / 全局中间件形式（`middleware.global` 或路由别名中使用）。
 * 框架内置安装的 h3 中间件位于全局中间件之前；只需要部分路由识别租户时使用本中间件。
 */
export const tenancy: MiddlewareHandler = (ctx, next) => useTenancy().handle(ctx, next)
