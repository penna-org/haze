import type { ModelKind, Provider } from './registry'
import { defineAgent } from './agent'
import { configureAI } from './configure'
import { cosineSimilarity, embed, embedMany } from './embed'
import { AIError } from './errors'
import { fakeAI, restoreAI } from './fake'
import { generateObject, streamObject } from './generate-object'
import { generateText } from './generate-text'
import { generateImage, generateSpeech, transcribe } from './media'
import { createAnthropic } from './providers/anthropic'
import { createAzure } from './providers/azure'
import { createBedrock } from './providers/bedrock'
import { createWorkersAI } from './providers/cloudflare'
import { createGoogle } from './providers/google'
import { createOpenAI } from './providers/openai'
import { COMPATIBLE_PRESETS, createOpenAICompatible } from './providers/openai-compatible'
import { getModelRegistry, resolveModel } from './registry'
import { streamText } from './stream-text'
import { defineTool } from './tool'

/** 按配置创建厂商的工厂（driver 名 → 工厂） */
export type AIDriverFactory = (settings: Record<string, any>, name: string) => Provider

const drivers = new Map<string, AIDriverFactory>([
  [
    'openai',
    settings => createOpenAI(settings),
  ],
  [
    'anthropic',
    settings => createAnthropic(settings),
  ],
  [
    'azure',
    settings => createAzure(settings),
  ],
  [
    'google',
    settings => createGoogle(settings),
  ],
  [
    'bedrock',
    settings => createBedrock(settings),
  ],
  [
    'cloudflare',
    settings => createWorkersAI(typeof settings.binding === 'string'
      ? {
          ...settings,
          binding: platformBinding(settings.binding),
        }
      : settings),
  ],
  [
    'openai-compatible',
    (settings, name) => createOpenAICompatible({ name, ...settings } as Parameters<typeof createOpenAICompatible>[0]),
  ],
  ...Object.entries(COMPATIBLE_PRESETS).map(([driver, create]): [string, AIDriverFactory] => [
    driver,
    settings => create(settings),
  ]),
])

/**
 * 按名称取 Workers 绑定（config/ai.ts 中 `binding: 'AI'`）：调用时从 @hazejs/core 的平台绑定读取，
 * 因为绑定只在 Worker 处理请求时才注入
 */
function platformBinding(name: string): { run: (...args: any[]) => Promise<any> } {
  return {
    async run(...args) {
      const { usePlatformBinding } = await import('@hazejs/core')
      const binding = usePlatformBinding<{ run: (...args: any[]) => Promise<any> }>(name)
      if (!binding)
        throw new AIError(`Workers AI binding "${name}" not found. Bindings are only available on Cloudflare Workers (wrangler.json: "ai": { "binding": "${name}" })`)
      return binding.run(...args)
    },
  }
}

/** 注册自定义 driver（第三方厂商包、私有网关） */
export function registerAIDriver(driver: string, factory: AIDriverFactory): void {
  drivers.set(driver, factory)
}

export function aiDrivers(): string[] {
  return [
    ...drivers.keys(),
  ]
}

/** config/ai.ts 中一个厂商的配置：driver + 该厂商的设置，或直接给出厂商实例 */
export type AIProviderConfig = Provider | ({ driver: string } & Record<string, unknown>)

export interface AIConfig {
  /** 默认对话模型，如 `openai:gpt-5` 或别名 */
  default?: string
  /** 其它类型的默认模型 */
  defaults?: Partial<Record<Exclude<ModelKind, 'language'>, string>>
  /** 别名：`{ fast: 'deepseek:deepseek-chat', smart: 'anthropic:claude-opus-5-5' }` */
  aliases?: Record<string, string>
  /** 键为厂商名（模型字符串 `厂商名:模型` 的前缀） */
  providers: Record<string, AIProviderConfig>
}

/** `config/ai.ts` 的默认导出 */
export function defineAIConfig(config: AIConfig | (() => AIConfig)): AIConfig | (() => AIConfig) {
  return config
}

function isProvider(value: AIProviderConfig): value is Provider {
  return typeof (value as Provider).languageModel === 'function'
}

/** 按配置创建厂商并设置全局注册表 */
export function configureAIFromConfig(config: AIConfig): void {
  const providers: Record<string, Provider> = {}
  for (const [name, entry] of Object.entries(config.providers ?? {})) {
    if (isProvider(entry)) {
      providers[name] = entry
      continue
    }
    const { driver, ...settings } = entry
    const factory = drivers.get(driver)
    if (!factory)
      throw new AIError(`AI provider "${name}": unknown driver "${driver}" (available: ${aiDrivers().join(', ')})`)
    providers[name] = factory(settings, name)
  }
  configureAI({
    providers,
    aliases: config.aliases,
    defaults: {
      ...config.defaults,
      ...(config.default && { language: config.default }),
    },
  })
}

/** 服务提供者所需的最小应用接口（与 @hazejs/core 的 Application 兼容，避免对 core 的硬依赖） */
export interface AIAppLike {
  config: { get: <T>(key: string, fallback?: T) => T }
}

/**
 * hazejs 服务提供者（app/provider/AIProvider.ts：`export default aiProvider()`）：
 * 读取 config/ai.ts，注册厂商与别名，之后可用字符串引用模型。
 */
/** aiProvider() 的返回值（与 @hazejs/core 的 ServiceProvider 结构兼容） */
export interface AIServiceProvider {
  register: (container: unknown, app: AIAppLike) => void
}

export function aiProvider(): AIServiceProvider {
  return {
    register(_container, app) {
      const config = app.config.get<AIConfig | undefined>('ai', undefined)
      if (config)
        configureAIFromConfig(config)
    },
  }
}

/**
 * AI 门面：
 *
 * ```ts
 * const { text } = await AI.generateText({ prompt: 'Hello' })           // 使用 config/ai.ts 的默认模型
 * return AI.streamText({ model: 'fast', messages }).toResponse()        // 控制器中直接返回流式响应
 * const fake = AI.fake(['Hi!'])                                         // 测试
 * ```
 */
export const AI = {
  generateText,
  streamText,
  generateObject,
  streamObject,
  embed,
  embedMany,
  cosineSimilarity,
  generateImage,
  generateSpeech,
  transcribe,
  agent: defineAgent,
  tool: defineTool,
  /** 解析模型（字符串、别名或默认） */
  model: (ref?: string) => resolveModel('language', ref),
  /** 是否已配置厂商 */
  get configured(): boolean {
    return Boolean(getModelRegistry())
  },
  /** 测试替身：不访问网络，按 replies 依次回复，并记录请求 */
  fake: fakeAI,
  restore: restoreAI,
}
