import type { H3Event } from 'h3'
import type { Application } from './application'
import type { Container } from './container/container'
import type { HttpContext } from './http/context'
import { AsyncLocalStorage } from 'node:async_hooks'
import { globalStore } from './utils'

export interface RequestStore {
  app: Application
  event: H3Event
  ctx: HttpContext
  /** 当前请求的子容器（Request 作用域实例挂在这里） */
  container: Container
}

// 挂在 globalThis 上：开发时应用代码在每次热重载后重新求值（以及开发服务器进程）各有一份 core，
// 跨重载保留的对象（如开发面板的记录）需要读到同一个请求上下文
const storage = globalStore('request:context', () => new AsyncLocalStorage<RequestStore>())

export function runInRequest<T>(store: RequestStore, fn: () => T): T {
  return storage.run(store, fn)
}

export function getRequestStore(): RequestStore | undefined {
  return storage.getStore()
}

/** runInApp() 建立的应用上下文；request 为进入时所处的请求（之后又进入的请求优先） */
interface AppScope {
  app: Application
  request: RequestStore | undefined
}

/** 挂在 globalThis 上：同一进程中 core 的多份模块实例（开发服务器的 runner 与 Node 原生加载）共用 */
const kAppScope = Symbol.for('hazejs.app-scope')
const appScopes: AsyncLocalStorage<AppScope> = ((globalThis as { [kAppScope]?: AsyncLocalStorage<AppScope> })[kAppScope] ??= new AsyncLocalStorage<AppScope>())

/**
 * 在应用上下文中执行回调（含其中创建的 Promise 与定时器）：门面（`Queue`、`Events`、`Cache`、`Db`、`useApp()`、
 * `config()`、`inject()` 等）解析到这个应用，而不是最近启动的应用。队列任务、定时任务与事件监听器由框架自动包裹；
 * 同一进程中有多个应用时，脚本与测试也可以用它固定应用
 */
export function runInApp<T>(app: Application, fn: () => T): T {
  return appScopes.run({
    app,
    request: storage.getStore(),
  }, fn)
}

/** runInApp() 指定的应用（进入之后又进入了请求时为 undefined，由请求决定） */
function scopedApp(): { app: Application, request: RequestStore | undefined } | undefined {
  const scope = appScopes.getStore()
  const request = storage.getStore()
  if (scope && scope.request === request && scope.app !== request?.app)
    return { app: scope.app, request: undefined }
  return request
    ? { app: request.app, request }
    : scope && { app: scope.app, request: undefined }
}

/**
 * 当前上下文所属的应用：请求所属的应用，或 runInApp() 指定的应用（队列任务、定时任务、事件监听器）；
 * 两者都没有时为 undefined（门面再退回最近启动的应用）
 */
export function getContextApp(): Application | undefined {
  return scopedApp()?.app
}

/** 当前上下文的容器：请求内为请求的子容器，应用上下文中为应用的容器 */
export function getContextContainer(): Container | undefined {
  const scope = scopedApp()
  return scope?.request?.container ?? scope?.app.container
}

function requireStore(caller: string): RequestStore {
  const store = storage.getStore()
  if (!store)
    throw new Error(`${caller}() can only be called within a request`)
  return store
}

/** 在任意深度的调用中获取当前请求的 HttpContext */
export function useContext(): HttpContext {
  return requireStore('useContext').ctx
}

/** 在任意深度的调用中获取当前请求的 H3Event */
export function useEvent(): H3Event {
  return requireStore('useEvent').event
}
