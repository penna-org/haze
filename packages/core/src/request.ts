import type { H3Event } from 'h3'
import type { Application } from './application'
import type { Container } from './container/container'
import type { HttpContext } from './http/context'
import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestStore {
  app: Application
  event: H3Event
  ctx: HttpContext
  /** 当前请求的子容器（Request 作用域实例挂在这里） */
  container: Container
}

const storage = new AsyncLocalStorage<RequestStore>()

export function runInRequest<T>(store: RequestStore, fn: () => T): T {
  return storage.run(store, fn)
}

export function getRequestStore(): RequestStore | undefined {
  return storage.getStore()
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
