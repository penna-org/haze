import type { MaybePromise } from '../utils'

export type Credentials = Record<string, unknown>

/**
 * 用户来源：按 ID / 凭据查找用户并校验凭据。
 * `@hazejs/orm` 的 `modelUserProvider()` 基于模型实现，也可以自己实现（调用远程服务、LDAP 等）。
 */
export interface UserProvider<U = unknown> {
  retrieveById: (id: string | number) => MaybePromise<U | null | undefined>
  /** 按凭据中除密码外的字段查找用户（如 email） */
  retrieveByCredentials: (credentials: Credentials) => MaybePromise<U | null | undefined>
  /** 校验凭据（如比对密码哈希） */
  validateCredentials: (user: U, credentials: Credentials) => MaybePromise<boolean>
  /** 用户的唯一标识（写入 Session / JWT 的 sub） */
  getId: (user: U) => string | number
}

export function defineUserProvider<U>(provider: UserProvider<U>): UserProvider<U> {
  return provider
}
