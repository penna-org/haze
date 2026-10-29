import type { Config } from '../config/config'
import type { HttpFakeDefinition } from './fake'
import type { HttpClientOptions } from './options'
import { getRequestStore } from '../request'
import { HttpFake } from './fake'
import { SENSITIVE_HEADERS } from './redact'

/** `config/http.ts` 的结构 */
export interface HttpConfig {
  /** 所有经 `Http` 发出的请求的默认选项（`Http.create()` 创建的客户端不使用） */
  defaults?: HttpClientOptions
  /** 命名客户端：`Http.client('github')` */
  clients?: Record<string, HttpClientOptions>
  /** 遥测中额外隐藏的请求 / 响应头（默认已隐藏 authorization、cookie、x-api-key 等） */
  redactHeaders?: string[]
}

/** `config/http.ts` 的默认导出 */
export function defineHttpConfig<const T extends HttpConfig>(config: T | (() => T)): T | (() => T) {
  return config
}

/**
 * 出站 HTTP 客户端的应用级状态（`inject(HttpManager)`）：读取 config/http.ts，
 * 持有 `Http.fake()` 的假响应与记录。每个应用一份，测试中随 `useTestApp()` 的应用重建。
 */
export class HttpManager {
  #fake: HttpFake | undefined
  #redact: { source: string[] | undefined, set: ReadonlySet<string> } | undefined

  constructor(readonly appConfig?: Config) {}

  get config(): HttpConfig {
    return this.appConfig?.get<HttpConfig | undefined>('http', undefined) ?? {}
  }

  /** 命名客户端的选项 */
  clientOptions(name: string): HttpClientOptions {
    const options = this.config.clients?.[name]
    if (!options)
      throw new Error(`HTTP client "${name}" is not defined in config/http.ts`)
    return options
  }

  /** 遥测中隐藏的头（小写） */
  get redactHeaders(): ReadonlySet<string> {
    const source = this.config.redactHeaders
    if (!this.#redact || this.#redact.source !== source) {
      this.#redact = {
        source,
        set: new Set([
          ...SENSITIVE_HEADERS,
          ...source ?? [],
        ].map(name => name.toLowerCase())),
      }
    }
    return this.#redact.set
  }

  /** 当前的假响应状态（未调用 fake() / preventStrayRequests() 时为 undefined） */
  get faking(): HttpFake | undefined {
    return this.#fake
  }

  /** 拦截请求返回假响应并记录；可多次调用追加规则 */
  fake(definition?: HttpFakeDefinition): HttpFake {
    this.#fake ??= new HttpFake()
    return this.#fake.stub(definition)
  }

  preventStrayRequests(prevent = true): HttpFake {
    this.#fake ??= new HttpFake()
    return this.#fake.preventStrayRequests(prevent)
  }

  allowStrayRequests(patterns: string[]): HttpFake {
    this.#fake ??= new HttpFake()
    return this.#fake.allowStrayRequests(patterns)
  }

  /** 断言要求先调用 Http.fake() */
  requireFake(): HttpFake {
    if (!this.#fake)
      throw new Error('Http.fake() has not been called: requests are only recorded while faking')
    return this.#fake
  }

  /** 取消假响应与记录 */
  restore(): void {
    this.#fake = undefined
  }
}

let fallback: HttpManager | undefined
let standalone: HttpManager | undefined

/** @internal */
export function setHttpManager(manager: HttpManager | undefined): void {
  fallback = manager
}

/** 当前应用的 HTTP 客户端状态：请求内取请求容器，否则取最近启动的应用；没有应用时为独立的实例 */
export function useHttpManager(): HttpManager {
  const container = getRequestStore()?.container
  if (container?.has(HttpManager))
    return container.make(HttpManager)
  return fallback ?? (standalone ??= new HttpManager())
}
