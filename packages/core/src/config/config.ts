import type { LoggerConfig } from '../logger'
import type { MiddlewareConfig } from '../middleware/types'
import { deepMerge, isPlainObject } from '../utils'

export interface ResponseConfig {
  /** 是否把成功响应包装为 `{ code, message, data }` */
  envelope: boolean
  successCode: number | string
  successMessage: string
}

export interface AppConfig {
  name: string
  /** 调试模式：错误响应携带堆栈，默认 development 下开启 */
  debug: boolean
  response: ResponseConfig
}

/** 框架内置的配置项 */
export interface CoreConfig {
  app: AppConfig
  logger: LoggerConfig
  middleware: MiddlewareConfig
}

/**
 * 配置结构。业务项目可通过声明合并扩展：
 *
 * ```ts
 * declare module '@think-h3/core' {
 *   interface ConfigSchema { database: { url: string } }
 * }
 * ```
 */
export interface ConfigSchema extends CoreConfig {}

export type ConfigInput<T> = T | (() => T)

/**
 * 定义配置文件。读取环境变量时请使用函数形式，保证在 `.env` 加载之后才求值：
 *
 * ```ts
 * export default defineConfig(() => ({ debug: env('APP_DEBUG', false) }))
 * ```
 */
export function defineConfig<T extends Record<string, any>>(config: ConfigInput<T>): ConfigInput<T> {
  return config
}

export function resolveConfigInput<T>(input: ConfigInput<T>): T {
  return typeof input === 'function'
    ? (input as () => T)()
    : input
}

export function defaultConfig(debug: boolean): CoreConfig {
  return {
    app: {
      name: 'think-h3',
      debug,
      response: {
        envelope: true,
        successCode: 0,
        successMessage: 'ok',
      },
    },
    logger: {
      level: 'info',
    },
    middleware: {
      global: [],
      alias: {},
      groups: {},
    },
  }
}

type DotPath<T, Prefix extends string = ''> = {
  [K in keyof T & string]: T[K] extends Record<string, any>
    ? T[K] extends readonly any[] | ((...args: any[]) => any)
      ? `${Prefix}${K}`
      : `${Prefix}${K}` | DotPath<T[K], `${Prefix}${K}.`>
    : `${Prefix}${K}`
}[keyof T & string]

type PathValue<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T ? PathValue<T[Head], Rest> : unknown
  : P extends keyof T ? T[P] : unknown

export type ConfigKey = DotPath<ConfigSchema>

export class Config {
  #data: Record<string, any>

  constructor(data: Record<string, any> = {}) {
    this.#data = data
  }

  get<P extends ConfigKey>(key: P): PathValue<ConfigSchema, P>
  get<T = unknown>(key: string, defaultValue?: T): T
  get(key: string, defaultValue?: unknown): unknown {
    let current: any = this.#data
    for (const segment of key.split('.')) {
      if (current === null || typeof current !== 'object' || !(segment in current))
        return defaultValue
      current = current[segment]
    }
    return current === undefined
      ? defaultValue
      : current
  }

  has(key: string): boolean {
    return this.get(key, undefined) !== undefined
  }

  set(key: string, value: unknown): this {
    const segments = key.split('.')
    const last = segments.pop()!
    let current = this.#data
    for (const segment of segments) {
      if (!isPlainObject(current[segment]))
        current[segment] = {}
      current = current[segment]
    }
    current[last] = value
    return this
  }

  /** 把配置项深合并到指定顶层键下 */
  merge(name: string, value: Record<string, any>): this {
    this.#data[name] = isPlainObject(this.#data[name])
      ? deepMerge(this.#data[name], value)
      : value
    return this
  }

  all(): Readonly<Record<string, any>> {
    return this.#data
  }
}
