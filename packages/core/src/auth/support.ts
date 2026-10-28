import type { Config } from '../config/config'
import type { AuthConfig } from './config'
import type { UserProvider } from './provider'
import { useApp } from '../application'
import { getRequestStore } from '../request'
import { toBase64Url } from '../security/key'

const encoder = new TextEncoder()

/** 当前生效的配置：请求内为请求（应用）的配置，否则为最近启动的应用 */
export function currentConfig(): Config {
  return getRequestStore()?.ctx.config ?? useApp().config
}

/** config/auth.ts（未配置时报错） */
export function authConfigOf(config: Config = currentConfig()): AuthConfig {
  const auth = config.get<AuthConfig | undefined>('auth', undefined)
  if (!auth?.guards)
    throw new Error('Auth is not configured: create config/auth.ts with defineAuthConfig()')
  return auth
}

/** 用户在各类存储中的标识：type 默认为 provider 名，id 统一为字符串 */
export interface UserRef {
  type: string
  id: string
}

export interface ResolvedProvider<U = unknown> {
  name: string
  /** 写入存储的用户类型 */
  type: string
  provider: UserProvider<U>
  ref: (user: U) => UserRef
}

/**
 * 解析功能使用的用户来源：显式指定的 provider 名，否则取默认 Guard 的 provider。
 * `type` 写入存储（tokenable_type 等），默认为 provider 名。
 */
export function resolveProvider<U = unknown>(auth: AuthConfig, name?: string, type?: string): ResolvedProvider<U> {
  const providerName = name ?? auth.guards[auth.default]?.provider
  if (!providerName)
    throw new Error(`Auth guard "${auth.default}" is not defined in config/auth.ts`)
  const provider = auth.providers[providerName] as UserProvider<U> | undefined
  if (!provider)
    throw new Error(`Auth provider "${providerName}" is not defined in config/auth.ts`)
  return {
    name: providerName,
    type: type ?? providerName,
    provider,
    ref: user => ({
      type: type ?? providerName,
      id: String(provider.getId(user)),
    }),
  }
}

/** SHA-256 十六进制摘要（令牌只保存摘要） */
export async function sha256(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value)))
  let hex = ''
  for (const byte of digest)
    hex += byte.toString(16).padStart(2, '0')
  return hex
}

/** 随机令牌（base64url） */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

/** 读取模型 / 普通对象上的字段 */
export function fieldOf(user: unknown, field: string): unknown {
  return (user as Record<string, unknown> | null | undefined)?.[field]
}

/** 写入字段并保存（ORM 模型有 save()；普通对象只修改内存中的值） */
export async function saveFields(user: unknown, values: Record<string, unknown>): Promise<void> {
  const target = user as Record<string, unknown> & { save?: () => Promise<unknown> }
  Object.assign(target, values)
  if (typeof target.save === 'function')
    await target.save()
}
