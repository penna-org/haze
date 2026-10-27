import type { AbstractConstructor } from '../utils'

/** 非类依赖的注入令牌，例如数据库连接、第三方客户端 */
export interface Token<T> {
  readonly description: string
  /** 仅用于类型推导 */
  readonly __type?: T
}

export type InjectionKey<T = unknown> = Token<T> | AbstractConstructor<T>

export function createToken<T>(description: string): Token<T> {
  return Object.freeze({ description }) as Token<T>
}

export function keyName(key: InjectionKey<any>): string {
  return typeof key === 'function'
    ? key.name || 'AnonymousClass'
    : `Token(${key.description})`
}
