import type { EventManager } from './manager'
import { getContextContainer } from '../request'

let fallback: EventManager | undefined
let token: unknown

/** @internal */
export function setEventManager(manager: EventManager | undefined, key: unknown): void {
  fallback = manager
  token = key
}

export function useEventManager(): EventManager {
  const manager = (token && getContextContainer()?.make(token as never)) as EventManager | undefined ?? fallback
  if (!manager)
    throw new Error('Events are not available: the application has not booted')
  return manager
}
