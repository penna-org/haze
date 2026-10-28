import type { TenancyConfig, Tenant } from './config'
import { AsyncLocalStorage } from 'node:async_hooks'

/** 当前租户上下文（请求、任务、命令中由 Tenancy.run() 建立） */
export interface TenantScope<T = Tenant> {
  tenant: T
  /** 租户 ID 原值（写入 tenant_id 列） */
  id: string | number
  /** 租户 ID 的字符串形式（缓存前缀、存储路径、连接名、Cookie 名） */
  key: string
  /** 生效的多租户配置 */
  config: TenancyConfig
}

/** null 表示显式的中央上下文（Tenancy.central()），与“未设置”一样没有租户 */
const storage = new AsyncLocalStorage<TenantScope | null>()

const KEY_RE = /^[\w.-]{1,128}$/

/** 租户 ID 会用于缓存键、存储路径与连接名：只允许安全字符 */
export function tenantKeyOf(id: string | number): string {
  const key = String(id)
  if (!KEY_RE.test(key) || key === '.' || key === '..')
    throw new Error(`Invalid tenant id "${key}": only letters, digits, "_", "-" and "." are allowed`)
  return key
}

/** 当前租户上下文；没有租户时为 undefined */
export function currentTenancy<T = Tenant>(): TenantScope<T> | undefined {
  return (storage.getStore() ?? undefined) as TenantScope<T> | undefined
}

/** 当前租户；没有租户时为 undefined */
export function currentTenant<T = Tenant>(): T | undefined {
  return currentTenancy<T>()?.tenant
}

/** 当前租户；没有租户时抛错（只能在租户上下文中调用） */
export function useTenant<T = Tenant>(): T {
  const scope = currentTenancy<T>()
  if (!scope)
    throw new Error('useTenant() called outside of a tenant context (resolve it with the tenancy middleware or Tenancy.run())')
  return scope.tenant
}

/** 在租户上下文中执行（Tenancy.run() 使用） */
export function runInTenantScope<R>(scope: TenantScope, fn: () => R): R {
  return storage.run(scope, fn)
}

/** 在没有租户的上下文中执行 */
export function runWithoutTenant<R>(fn: () => R): R {
  return storage.run(null, fn)
}

function enabledFor(option: boolean | { [key: string]: unknown } | undefined, list: 'stores' | 'disks', name: string): boolean {
  if (option === false)
    return false
  const names = typeof option === 'object'
    ? option[list] as string[] | undefined
    : undefined
  return !names || names.includes(name)
}

/** 缓存键的租户前缀（`tenant:<id>:`），没有租户或未开启时为空 */
export function tenantCachePrefix(store: string): string {
  const scope = currentTenancy()
  if (!scope || !enabledFor(scope.config.cache, 'stores', store))
    return ''
  const custom = typeof scope.config.cache === 'object'
    ? scope.config.cache.prefix
    : undefined
  return custom?.(scope.key) ?? `tenant:${scope.key}:`
}

/** 存储路径的租户前缀（`tenants/<id>`，不含结尾的 `/`），没有租户或未开启时为空 */
export function tenantStoragePrefix(disk: string): string {
  const scope = currentTenancy()
  if (!scope || !enabledFor(scope.config.storage, 'disks', disk))
    return ''
  const custom = typeof scope.config.storage === 'object'
    ? scope.config.storage.prefix
    : undefined
  return (custom?.(scope.key) ?? `tenants/${scope.key}`).replace(/^\/+|\/+$/g, '')
}

/** Session 的租户标识（Cookie 名后缀与密钥派生），没有租户或未开启时为 undefined */
export function tenantSessionKey(): string | undefined {
  const scope = currentTenancy()
  return scope && scope.config.session !== false
    ? scope.key
    : undefined
}

/** 投递任务时随消息携带的租户 ID */
export function tenantQueueKey(): string | undefined {
  const scope = currentTenancy()
  return scope && scope.config.queue !== false
    ? scope.key
    : undefined
}
