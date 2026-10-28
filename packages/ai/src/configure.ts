import type { RegistryOptions } from './registry'
import { ModelRegistry, setModelRegistry } from './registry'

/**
 * 注册厂商与别名，之后可以用字符串引用模型（hazejs 应用中由 config/ai.ts 自动完成）：
 *
 * ```ts
 * configureAI({
 *   providers: { openai: createOpenAI(), deepseek: createDeepSeek() },
 *   aliases: { fast: 'deepseek:deepseek-chat' },
 *   defaults: { language: 'openai:gpt-5' },
 * })
 * await generateText({ model: 'fast', prompt })
 * ```
 */
export function configureAI(options: RegistryOptions): ModelRegistry {
  const registry = new ModelRegistry(options)
  setModelRegistry(registry)
  return registry
}
