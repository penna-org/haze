import type { Application } from './application'
import type { Container } from './container/container'
import type { MaybePromise } from './utils'

/**
 * 服务提供者（对应 ThinkPHP 的系统服务）。生命周期：
 * 1. 所有提供者 `register()`：只做绑定，不要解析其它服务
 * 2. 所有提供者 `boot()`：此时全部绑定可用
 * 3. 应用关闭时逆序 `shutdown()`
 */
export interface ServiceProvider {
  register?: (container: Container, app: Application) => MaybePromise<void>
  boot?: (app: Application) => MaybePromise<void>
  shutdown?: (app: Application) => MaybePromise<void>
}

export type ProviderInput = ServiceProvider | (new () => ServiceProvider)

export function defineProvider(provider: ServiceProvider): ServiceProvider {
  return provider
}
