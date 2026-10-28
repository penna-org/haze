import type { FetchFunction } from './http'
import type { Provider } from './registry'
import type { LanguageModel } from './types'
import { AIError } from './errors'

/** 各厂商通用的连接设置 */
export interface ProviderSettings {
  /** 省略时读取厂商默认的环境变量（如 OPENAI_API_KEY） */
  apiKey?: string
  /** 接口地址（代理、私有部署、兼容服务） */
  baseURL?: string
  /** 每个请求附带的请求头 */
  headers?: Record<string, string>
  /** 自定义 fetch（代理、测试、Workers service binding） */
  fetch?: FetchFunction
}

/** 厂商实例：可直接调用得到对话模型，`openai('gpt-5')` */
export type ProviderInstance<P extends Omit<Provider, 'name'> = Omit<Provider, 'name'>> = P & Provider & ((modelId: string) => LanguageModel)

export function createProvider<P extends Omit<Provider, 'name'>>(name: string, implementation: P): ProviderInstance<P> {
  const instance = ((modelId: string) => implementation.languageModel(modelId)) as ProviderInstance<P>
  Object.defineProperty(instance, 'name', { value: name })
  return Object.assign(instance, implementation)
}

function readEnv(name: string): string | undefined {
  // 不导入 node:process：同一份代码也运行在没有 process 的 Edge / 浏览器环境
  // eslint-disable-next-line node/prefer-global/process
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env
  return env?.[name] || undefined
}

/** 取 API Key：显式设置优先，其次环境变量；都没有时在发请求时报错（便于在未配置时先创建实例） */
export function apiKeyLoader(provider: string, value: string | undefined, envName: string | undefined): () => string {
  return () => {
    const key = value ?? (envName
      ? readEnv(envName)
      : undefined)
    if (!key)
      throw new AIError(`${provider} API key is missing. Pass apiKey or set ${envName ?? 'the apiKey option'}.`)
    return key
  }
}

export function optionalEnv(name: string): string | undefined {
  return readEnv(name)
}

export function withoutTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '')
}
