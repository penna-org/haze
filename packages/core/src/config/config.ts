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
  /** 读取 / 回写请求 ID 的请求头，false 关闭（仍会生成 ID 用于日志） */
  requestIdHeader: string | false
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

/**
 * 由 `think-h3 typegen`（开发服务器自动执行）根据 config/*.ts 生成，勿手动扩展。
 * 与 ConfigSchema 深合并，同名配置以配置文件推导出的类型为准。
 */
export interface GeneratedConfig {}

export type ConfigInput<T> = T | (() => T)

/** 配置文件默认导出的值类型（展开函数形式） */
export type ConfigValue<T> = T extends (...args: any[]) => infer R ? R : T

type IsLeaf<T> = T extends readonly any[] | ((...args: any[]) => any) ? true : T extends Record<string, any> ? false : true

type DeepMerge<A, B> = {
  [K in keyof A | keyof B]: K extends keyof B
    ? K extends keyof A
      ? IsLeaf<A[K]> extends true ? B[K] : IsLeaf<B[K]> extends true ? B[K] : DeepMerge<A[K], B[K]>
      : B[K]
    : K extends keyof A ? A[K] : never
}

/** 实际生效的配置结构：手动声明（ConfigSchema）+ 自动生成（GeneratedConfig） */
export type ResolvedConfigSchema = DeepMerge<ConfigSchema, GeneratedConfig>

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

export function defaultConfig(mode: 'development' | 'production' | 'test'): CoreConfig {
  return {
    app: {
      name: 'think-h3',
      debug: mode === 'development',
      requestIdHeader: 'x-request-id',
      response: {
        envelope: true,
        successCode: 0,
        successMessage: 'ok',
      },
    },
    logger: {
      // 测试时只输出警告与错误，避免访问日志刷屏
      level: mode === 'test'
        ? 'warn'
        : 'info',
      format: mode === 'production'
        ? 'json'
        : 'pretty',
      requests: mode !== 'test',
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

export type PathValue<T, P extends string> = P extends `${infer Head}.${infer Rest}`
  ? Head extends keyof T ? PathValue<T[Head], Rest> : unknown
  : P extends keyof T ? T[P] : unknown

export type ConfigKey = DotPath<ResolvedConfigSchema>

/**
 * 生成过配置类型后只接受已知键（读取其它键需传默认值）；未生成时允许任意字符串。
 * `string & {}` 保留已知键的自动补全。
 */
export type ConfigPath = [keyof GeneratedConfig] extends [never] ? ConfigKey | (string & {}) : ConfigKey

export type ConfigPathValue<P extends string> = P extends ConfigKey ? PathValue<ResolvedConfigSchema, P> : unknown

export class Config {
  #data: Record<string, any>

  constructor(data: Record<string, any> = {}) {
    this.#data = data
  }

  get<P extends ConfigPath>(key: P): ConfigPathValue<P>
  get<T>(key: string, defaultValue: T): T
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
    return this.get<unknown>(key, undefined) !== undefined
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
