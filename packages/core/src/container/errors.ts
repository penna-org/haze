import type { InjectionKey } from './token'
import { keyName } from './token'

export class ContainerError extends Error {
  override name = 'ContainerError'
}

export class ResolutionError extends ContainerError {
  override name = 'ResolutionError'

  constructor(key: InjectionKey<any>, chain: InjectionKey<any>[]) {
    super(`No binding found for ${keyName(key)}${formatChain(chain, key)}`)
  }
}

export class CircularDependencyError extends ContainerError {
  override name = 'CircularDependencyError'

  constructor(key: InjectionKey<any>, chain: InjectionKey<any>[]) {
    super(`Circular dependency detected: ${[...chain, key].map(keyName).join(' -> ')}`)
  }
}

export class ScopeError extends ContainerError {
  override name = 'ScopeError'
}

function formatChain(chain: InjectionKey<any>[], key: InjectionKey<any>): string {
  return chain.length
    ? ` (resolving ${[...chain, key].map(keyName).join(' -> ')})`
    : ''
}
